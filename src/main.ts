import Phaser from 'phaser';

declare global {
    interface Window {
        Razorpay?: new (options: any) => { open: () => void };
        __APP_API_URL__?: string;
    }
}

// ============================================
// TYPE DEFINITIONS (Security through types)
// ============================================
interface Player {
    x: number;
    y: number;
    vy: number;
    size: number;
}

interface Obstacle {
    x: number;
    gapY: number;
    gap: number;
    width: number;
    passed: boolean;
}

interface GameState {
    score: number;
    level: number;
    isUnlocked: boolean;
    sessionId: string;
}

const MAX_SCORE = 5;
const SCENE_KEY = 'GameScene';
const GAME_TICK_RATE = 0.6;
const JUMP_FORCE = -12;
const PLAYER_SIZE = 20;
const OBSTACLE_WIDTH = 60;
const GAP_SIZE = 170;

class GameScene extends Phaser.Scene {
    private player!: Player;
    private obstacles: Obstacle[] = [];
    private score: number = 0;
    private level: number = 1;
    private gameSpeed: number = 5;
    private isGameOver: boolean = false;
    private isLevelComplete: boolean = false;
    private graphics!: Phaser.GameObjects.Graphics;
    private textScore!: Phaser.GameObjects.Text;
    private sessionId: string = '';
    private isUnlocked: boolean = false;

    constructor() {
        super({ key: SCENE_KEY });
    }

    private generateSessionId(): string {
        const cryptoRef = globalThis.crypto;
        if (cryptoRef && typeof cryptoRef.randomUUID === 'function') {
            return cryptoRef.randomUUID();
        }
        return `session-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    private sanitizeSessionId(value?: string): string {
        const raw = value?.trim() ?? '';
        return raw.length > 0 && /^[a-zA-Z0-9-_.~]+$/.test(raw) ? raw : this.generateSessionId();
    }

    private getApiBaseUrl(): string {
        const configuredBase = window.__APP_API_URL__?.trim();
        if (configuredBase) {
            return configuredBase.replace(/\/$/, '');
        }

        const hostname = window.location.hostname;
        if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0') {
            return `${window.location.protocol}//localhost:3000`;
        }

        return '';
    }

    private async requestJson(path: string, options: RequestInit): Promise<any> {
        const apiBaseUrl = this.getApiBaseUrl();
        if (!apiBaseUrl) {
            alert('This GitHub Pages deployment is static, so the payment and invite APIs are unavailable. Run the app locally to use the unlock flow.');
            return null;
        }

        const response = await fetch(`${apiBaseUrl}${path}`, options);
        if (!response.ok) {
            throw new Error(`Request failed: ${response.status}`);
        }

        return response.json();
    }

    init(data?: Partial<GameState>) {
        this.sessionId = this.sanitizeSessionId(data?.sessionId);
        this.isUnlocked = Boolean(data?.isUnlocked);
    }

    create() {
        this.obstacles = [];
        this.score = 0;
        this.level = 1;
        this.gameSpeed = 5;
        this.isGameOver = false;
        this.isLevelComplete = false;

        this.graphics = this.add.graphics();

        this.player = {
            x: 100,
            y: this.cameras.main.height / 2,
            vy: 0,
            size: PLAYER_SIZE
        };

        this.textScore = this.add.text(20, 20, `Score: 0 / ${MAX_SCORE}`, {
            fontSize: '24px',
            color: '#ffffff',
            fontFamily: 'Arial'
        });

        this.input.on('pointerdown', () => this.jump());
        this.input.keyboard?.on('keydown-SPACE', () => this.jump());

        this.spawnObstacle();
        void this.checkInviteLink();
    }

    private jump() {
        if (!this.isGameOver && !this.isLevelComplete) {
            this.player.vy = JUMP_FORCE;
        }
    }

    private spawnObstacle() {
        const gap = GAP_SIZE;
        const gapY = Phaser.Math.Between(60, this.cameras.main.height - gap - 60);

        this.obstacles.push({
            x: this.cameras.main.width,
            gapY,
            gap,
            width: OBSTACLE_WIDTH,
            passed: false
        });
    }

    update(_time: number, _delta: number) {
        if (this.isGameOver || this.isLevelComplete) return;

        this.player.vy += GAME_TICK_RATE;
        this.player.y += this.player.vy;

        if (this.player.y < 0 || this.player.y + this.player.size > this.cameras.main.height) {
            this.endGame(false);
        }

        for (let i = this.obstacles.length - 1; i >= 0; i--) {
            const obs = this.obstacles[i];
            obs.x -= this.gameSpeed;

            const playerLeft = this.player.x;
            const playerRight = this.player.x + this.player.size;
            const playerTop = this.player.y;
            const playerBottom = this.player.y + this.player.size;

            if (playerRight > obs.x && playerLeft < obs.x + obs.width) {
                if (playerTop < obs.gapY || playerBottom > obs.gapY + obs.gap) {
                    this.endGame(false);
                    break;
                }
            }

            if (!obs.passed && obs.x + obs.width < this.player.x) {
                obs.passed = true;
                this.score++;
                this.textScore.setText(`Score: ${this.score} / ${MAX_SCORE}`);

                if (this.score >= MAX_SCORE) {
                    this.endGame(true);
                    break;
                }
            }

            if (obs.x + obs.width < 0) {
                this.obstacles.splice(i, 1);
            }
        }

        if (this.obstacles.length === 0 || this.obstacles[this.obstacles.length - 1].x < this.cameras.main.width - 300) {
            this.spawnObstacle();
        }

        this.render();
    }

    private render() {
        this.graphics.clear();

        this.graphics.fillStyle(0x0a0a12, 1);
        this.graphics.fillRect(0, 0, this.cameras.main.width, this.cameras.main.height);

        this.graphics.lineStyle(1, 0x00f3ff, 0.1);
        for (let i = 0; i < this.cameras.main.width; i += 40) {
            this.graphics.lineBetween(i, 0, i, this.cameras.main.height);
        }

        this.graphics.fillStyle(0x00f3ff, 1);
        this.graphics.fillCircle(
            this.player.x + this.player.size / 2,
            this.player.y + this.player.size / 2,
            this.player.size / 2
        );

        this.graphics.fillStyle(0xff00ff, 1);
        for (const obs of this.obstacles) {
            this.graphics.fillRect(obs.x, 0, obs.width, obs.gapY);
            this.graphics.fillRect(obs.x, obs.gapY + obs.gap, obs.width, this.cameras.main.height - (obs.gapY + obs.gap));
        }
    }

    private restartGame() {
        this.removePaywall();
        this.scene.restart({ 
            sessionId: this.sessionId, 
            isUnlocked: this.isUnlocked });
    }

    private endGame(won: boolean) {
        if (won) {
            this.isLevelComplete = true;
            void this.showPaywall();
            return;
        }

        if (this.isGameOver) return;
        this.isGameOver = true;
        this.time.delayedCall(500, () => {
            if (window.confirm('Game Over! Restart?')) {
                this.restartGame();
            }
        });
    }

    private removePaywall() {
        const overlay = document.getElementById('paywall-overlay');
        overlay?.remove();
    }

    private async showPaywall() {
        if (this.isUnlocked) {
            alert('Level 2 loading...');
            this.restartGame();
            return;
        }

        if (document.getElementById('paywall-overlay')) {
            return;
        }

        const overlay = document.createElement('div');
        overlay.id = 'paywall-overlay';
        overlay.innerHTML = `
            <div style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.9); display: flex; justify-content: center; align-items: center; z-index: 9999;">
                <div style="background: #1a1a2e; padding: 40px; border-radius: 15px; text-align: center; border: 2px solid #00f3ff; max-width: 400px;">
                    <h1 style="color: #00f3ff; margin-top: 0;">LEVEL 1 CLEARED!</h1>
                    <p style="color: white;">Unlock the full game:</p>
                    <button id="btn-pay" style="width: 100%; padding: 15px; margin: 10px 0; background: linear-gradient(45deg, #00f3ff, #0066ff); color: white; border: none; border-radius: 8px; font-size: 16px; cursor: pointer;">Pay ₹9 via Razorpay</button>
                    <button id="btn-invite" style="width: 100%; padding: 15px; margin: 10px 0; background: linear-gradient(45deg, #ff00ff, #ff0066); color: white; border: none; border-radius: 8px; font-size: 16px; cursor: pointer;">Invite 1 Friend</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        document.getElementById('btn-pay')?.addEventListener('click', async () => {
            await this.initiatePayment();
        });

        document.getElementById('btn-invite')?.addEventListener('click', async () => {
            const inviteLink = `${window.location.origin}${window.location.pathname}?invite=${encodeURIComponent(this.sessionId)}`;
            try {
                if (navigator.clipboard && window.isSecureContext) {
                    await navigator.clipboard.writeText(inviteLink);
                } else {
                    const tempInput = document.createElement('input');
                    tempInput.value = inviteLink;
                    document.body.appendChild(tempInput);
                    tempInput.select();
                    document.execCommand('copy');
                    tempInput.remove();
                }
                alert('Invite link copied! Share it with a friend.');
            } catch (error) {
                console.error('Copy invite link failed:', error);
                alert(`Invite link: ${inviteLink}`);
            }
        });
    }

    private async initiatePayment() {
        try {
            const response = await this.requestJson('/api/create-order', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ sessionId: this.sessionId })
            });

            if (!response) {
                return;
            }

            if (!response || !response.id || !response.amount) {
                throw new Error('Invalid order response from server');
            }

            const RazorpayCtor = window.Razorpay;
            if (!RazorpayCtor) {
                alert('Razorpay script is not loaded.');
                return;
            }

            const options = {
                key: 'rzp_test_YourPublicKeyHere',
                amount: response.amount,
                currency: 'INR',
                name: 'Neon Flux',
                description: 'Full Game Unlock',
                order_id: response.id,
                handler: async (response: any) => {
                    const verifyResponse = await this.requestJson('/api/verify-payment', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        credentials: 'include',
                        body: JSON.stringify({
                            razorpay_order_id: response.razorpay_order_id,
                            razorpay_payment_id: response.razorpay_payment_id,
                            razorpay_signature: response.razorpay_signature
                        })
                    });

                    if (!verifyResponse) {
                        return;
                    }

                    if (verifyResponse.success) {
                        this.isUnlocked = true;
                        this.removePaywall();
                        alert('Payment successful! Full game unlocked.');
                        this.restartGame();
                    } else {
                        alert('Payment verification failed.');
                    }
                },
                theme: { color: '#00f3ff' }
            };

            const rzp = new RazorpayCtor(options);
            rzp.open();
        } catch (error) {
            console.error('Payment error:', error);
            alert('Failed to initiate payment.');
        }
    }

    private async checkInviteLink() {
        const urlParams = new URLSearchParams(window.location.search);
        const inviterId = urlParams.get('invite');

        if (!inviterId || inviterId === this.sessionId) {
            return;
        }

        if (!/^[a-zA-Z0-9-_.~]+$/.test(inviterId)) {
            return;
        }

        try {
            await this.requestJson('/api/register-invite', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ inviterId, inviteeId: this.sessionId })
            });
        } catch (error) {
            console.error('Invite registration error:', error);
        }
    }
}

const config: Phaser.Types.Core.GameConfig = {
    type: Phaser.AUTO,
    width: 800,
    height: 600,
    parent: 'game-container',
    scene: [GameScene],
    backgroundColor: '#0a0a12'
};

new Phaser.Game(config);