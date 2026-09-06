import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import Razorpay from 'razorpay';
import { Pool } from 'pg';
import { z } from 'zod';
import jwt from 'jsonwebtoken';

type RawBodyRequest = express.Request & { rawBody?: Buffer };

const app = express();

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
    if (!cookieHeader) return {};

    return Object.fromEntries(
        cookieHeader.split(';').flatMap(cookie => {
            const separatorIndex = cookie.indexOf('=');
            if (separatorIndex < 0) return [];

            const name = cookie.slice(0, separatorIndex).trim();
            const value = cookie.slice(separatorIndex + 1).trim();
            try {
                return [[name, decodeURIComponent(value)]];
            } catch {
                return [[name, value]];
            }
        })
    );
}

// ============================================
// MIDDLEWARE (Security layers)
// ============================================
app.use(cors({
    origin: 'http://localhost:8080', // Your game URL
    credentials: true
}));
app.use(express.json({
    verify: (req, _res, buffer) => {
        (req as express.Request & { rawBody?: Buffer }).rawBody = Buffer.from(buffer);
    }
}));

// ============================================
// DATABASE SETUP (PostgreSQL)
// ============================================
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://user:password@localhost:5432/neonflux'
});

let dbReady = false;

async function initDatabase() {
    try {
        await pool.query('SELECT 1');
        await pool.query(`
            CREATE TABLE IF NOT EXISTS sessions (
                id VARCHAR(255) PRIMARY KEY,
                is_unlocked BOOLEAN DEFAULT FALSE,
                invite_count INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS invites (
                invitee_id VARCHAR(255) PRIMARY KEY,
                inviter_id VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS payments (
                id SERIAL PRIMARY KEY,
                session_id VARCHAR(255) NOT NULL,
                razorpay_order_id VARCHAR(255) UNIQUE NOT NULL,
                razorpay_payment_id VARCHAR(255),
                amount INTEGER NOT NULL,
                status VARCHAR(50) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);
        dbReady = true;
        console.log('Database initialized successfully');
    } catch (error) {
        dbReady = false;
        console.warn('Database unavailable. Starting app without persistence. Set DATABASE_URL to enable the payment/invite features.');
        console.warn(error);
    }
}

function requireDatabase(res: express.Response) {
    if (!dbReady) {
        res.status(503).json({ success: false, error: 'Database unavailable' });
        return false;
    }

    return true;
}

// ============================================
// RAZORPAY INITIALIZATION
// ============================================
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'YourSuperSecretKey';
const razorpay: Razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID || 'rzp_test_YourPublicKeyHere',
    key_secret: RAZORPAY_KEY_SECRET
}) as Razorpay;

const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-this';

// ============================================
// VALIDATION SCHEMAS (Zod - Runtime type checking)
// ============================================
const createOrderSchema = z.object({
    sessionId: z.string().uuid()
});

const verifyPaymentSchema = z.object({
    razorpay_order_id: z.string(),
    razorpay_payment_id: z.string(),
    razorpay_signature: z.string()
});

const registerInviteSchema = z.object({
    inviterId: z.string().uuid(),
    inviteeId: z.string().uuid()
});

// ============================================
// API ENDPOINTS
// ============================================

// 1. Create Razorpay Order
app.post('/api/create-order', async (req, res) => {
    try {
        if (!requireDatabase(res)) {
            return;
        }

        const validation = createOrderSchema.safeParse(req.body);
        if (!validation.success) {
            return res.status(400).json({ error: 'Invalid request data' });
        }

        const { sessionId } = validation.data;

        // Ensure session exists
        await pool.query(
            'INSERT INTO sessions (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
            [sessionId]
        );

        // Create Razorpay order
        const order = await razorpay.orders.create({
            amount: 900, // ₹9 in paise
            currency: 'INR',
            receipt: `receipt_${sessionId}`,
            notes: { sessionId }
        });

        // Store order in database
        await pool.query(
            'INSERT INTO payments (session_id, razorpay_order_id, amount) VALUES ($1, $2, $3)',
            [sessionId, order.id, 900]
        );

        res.json(order);
    } catch (error) {
        console.error('Create order error:', error);
        res.status(500).json({ error: 'Failed to create order' });
    }
});

// 2. Verify Payment (called after Razorpay checkout)
app.post('/api/verify-payment', async (req, res) => {
    try {
        if (!requireDatabase(res)) {
            return;
        }

        const validation = verifyPaymentSchema.safeParse(req.body);
        if (!validation.success) {
            return res.status(400).json({ error: 'Invalid request data' });
        }

        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = validation.data;

        // Cryptographic verification
        const body = razorpay_order_id + '|' + razorpay_payment_id;
        const expectedSignature = crypto
            .createHmac('sha256', RAZORPAY_KEY_SECRET)
            .update(body)
            .digest('hex');

        if (expectedSignature !== razorpay_signature) {
            return res.status(400).json({ success: false, error: 'Invalid signature' });
        }

        // Get session ID from payment record
        const paymentResult = await pool.query(
            'SELECT session_id, amount, status FROM payments WHERE razorpay_order_id = $1',
            [razorpay_order_id]
        );

        if (paymentResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Order not found' });
        }

        const sessionId = paymentResult.rows[0].session_id;

        if (paymentResult.rows[0].status === 'completed') {
            return res.json({ success: true });
        }

        if (paymentResult.rows[0].amount !== 900) {
            return res.status(400).json({ success: false, error: 'Invalid payment amount' });
        }

        // Update payment status
        await pool.query(
            'UPDATE payments SET razorpay_payment_id = $1, status = $2 WHERE razorpay_order_id = $3',
            [razorpay_payment_id, 'completed', razorpay_order_id]
        );

        // Unlock session
        await pool.query(
            'UPDATE sessions SET is_unlocked = TRUE WHERE id = $1',
            [sessionId]
        );

        // Generate JWT token
        const token = jwt.sign({ sessionId, unlocked: true }, JWT_SECRET, { expiresIn: '30d' });

        // Set secure HTTP-only cookie
        res.cookie('auth_token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'strict',
            maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
        });

        res.json({ success: true });
    } catch (error) {
        console.error('Verify payment error:', error);
        res.status(500).json({ success: false, error: 'Verification failed' });
    }
});

// 3. Register Invite
app.post('/api/register-invite', async (req, res) => {
    try {
        if (!requireDatabase(res)) {
            return;
        }

        const validation = registerInviteSchema.safeParse(req.body);
        if (!validation.success) {
            return res.status(400).json({ error: 'Invalid request data' });
        }

        const { inviterId, inviteeId } = validation.data;

        // Prevent self-invites
        if (inviterId === inviteeId) {
            return res.status(400).json({ success: false, error: 'Cannot invite yourself' });
        }

        // Check if invitee already used an invite
        const existingInvite = await pool.query(
            'SELECT 1 FROM invites WHERE invitee_id = $1',
            [inviteeId]
        );

        if (existingInvite.rows.length > 0) {
            return res.status(400).json({ success: false, error: 'Invite already used' });
        }

        // Register invite
        const inviterResult = await pool.query(
            'UPDATE sessions SET invite_count = invite_count + 1 WHERE id = $1 RETURNING invite_count',
            [inviterId]
        );

        if (inviterResult.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Inviter session not found' });
        }

        await pool.query(
            'INSERT INTO invites (invitee_id, inviter_id) VALUES ($1, $2)',
            [inviteeId, inviterId]
        );

        // Check if inviter has enough invites to unlock
        if (inviterResult.rows[0].invite_count >= 1) {
            await pool.query(
                'UPDATE sessions SET is_unlocked = TRUE WHERE id = $1',
                [inviterId]
            );
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Register invite error:', error);
        res.status(500).json({ success: false, error: 'Failed to register invite' });
    }
});

// 4. Check Session Status (for game to verify unlock)
app.get('/api/session-status', async (req, res) => {
    try {
        if (!requireDatabase(res)) {
            return;
        }

        const token = parseCookies(req.headers.cookie).auth_token;
        
        if (!token) {
            return res.json({ isUnlocked: false });
        }

        try {
            const decoded = jwt.verify(token, JWT_SECRET) as { sessionId: string };
            const result = await pool.query(
                'SELECT is_unlocked FROM sessions WHERE id = $1',
                [decoded.sessionId]
            );

            if (result.rows.length === 0) {
                return res.json({ isUnlocked: false });
            }

            res.json({ isUnlocked: result.rows[0].is_unlocked });
        } catch (error) {
            res.json({ isUnlocked: false });
        }
    } catch (error) {
        res.status(500).json({ error: 'Failed to check status' });
    }
});

// 5. Razorpay Webhook (Server-to-server verification - MOST SECURE)
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    try {
        const signature = req.headers['x-razorpay-signature'];
        const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || 'your_webhook_secret';
        const rawBody = (req as express.Request & { rawBody?: Buffer }).rawBody;
        if (typeof signature !== 'string' || !rawBody) {
            return res.status(400).json({ error: 'Invalid webhook request' });
        }

        const expectedSignature = crypto
            .createHmac('sha256', webhookSecret)
            .update(rawBody)
            .digest('hex');

        const signaturesMatch = signature.length === expectedSignature.length &&
            crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
        if (!signaturesMatch) {
            return res.status(400).json({ error: 'Invalid webhook signature' });
        }

        const event = req.body;

        if (event.event === 'payment.captured') {
            const payment = event.payload.payment.entity;
            const sessionId = payment.notes?.sessionId;
            if (typeof sessionId !== 'string') {
                return res.status(400).json({ error: 'Missing session ID' });
            }

            // Update payment and unlock session
            await pool.query(
                'UPDATE payments SET razorpay_payment_id = $1, status = $2 WHERE razorpay_order_id = $3',
                [payment.id, 'completed', payment.order_id]
            );

            await pool.query(
                'UPDATE sessions SET is_unlocked = TRUE WHERE id = $1',
                [sessionId]
            );
        }

        res.json({ status: 'ok' });
    } catch (error) {
        console.error('Webhook error:', error);
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});

// ============================================
// START SERVER
// ============================================
const PORT = process.env.PORT || 3000;

void initDatabase();

app.listen(PORT, () => {
    console.log(`Secure backend running on port ${PORT}`);
});