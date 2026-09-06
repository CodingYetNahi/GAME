# Neon Flux

A Phaser game with a local Express backend, Razorpay checkout flow, and GitHub Pages-ready static frontend.

## Local development

1. Copy the example environment file:
   ```bash
   cp .env.example .env
   ```
2. Update the environment variables for your local PostgreSQL and Razorpay keys.
3. Start the app:
   ```bash
   npm run dev
   ```
4. Open the game at http://localhost:8080

The backend runs on http://localhost:3000.

## Production build

```bash
npm run build:game
npm run build:server
```

## GitHub Pages deploy

```bash
npm run deploy:pages
```

This publishes the static frontend from the `dist` directory.

> GitHub Pages cannot host the Express API, PostgreSQL database, or Razorpay webhook processing. Those pieces must run on a server or locally while developing.
