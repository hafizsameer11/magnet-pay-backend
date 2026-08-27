# MagnetPay API

Express + Prisma + MySQL backend for MagnetPay (auth, wallets, transfers, escrow, logistics, marketplace, admin, push notifications).

**Repository:** [github.com/hafizsameer11/magnet-pay-backend](https://github.com/hafizsameer11/magnet-pay-backend)

## Quick start (local)

```bash
# 1. Start MySQL
docker compose up -d

# 2. Install
npm install

# 3. Env
cp .env.example .env
# Edit .env — at minimum DATABASE_URL and JWT secrets

# 4. Schema + seed
npx prisma db push
npm run seed:media   # optional first time — downloads catalog images into seed-media/
npm run db:seed

# 5. Run API
npm run dev
```

- API: `http://127.0.0.1:4000`
- **Production:** [https://magnetpay.amctraders.online](https://magnetpay.amctraders.online) — health: [`/health`](https://magnetpay.amctraders.online/health)
- Health: `GET /health`
- Adminer (local Docker): `http://127.0.0.1:8080`

## Demo accounts (after seed)

| Role | Phone | Passcode |
|------|-------|----------|
| Buyer | `+2348123456789` | `123456` |
| Seller | `+8613800138000` | `123456` |
| Admin | `+2348000000001` | `123456` |

## Environment variables

Copy `.env.example` → `.env`.

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | MySQL connection string |
| `JWT_SECRET` / `JWT_REFRESH_SECRET` | Auth tokens — use strong random values in production |
| `PORT` | Default `4000` |
| `CORS_ORIGIN` | `*` for dev, or your app origins in prod |
| `NOMBA_MODE` | `mock` (default) or live when wired |
| `API_PUBLIC_URL` | Public base URL for seed asset links, e.g. `https://api.yourdomain.com` |
| `SMTP_*` / `EMAIL_FROM` | Hostinger (or other) SMTP for OTP + transactional email |

Push notifications use **Expo Push** (`expo-server-sdk`). FCM/APNs credentials live on [Expo](https://expo.dev) — not in this repo.

## Seed media (Git)

Catalog images live in `seed-media/` and are served at `/files/seed/*` so seeding works offline on any server:

```bash
npm run seed:media   # download images (first time)
npm run db:seed      # populate DB referencing /files/seed/...
```

Commit `seed-media/` to Git. Set `API_PUBLIC_URL` on the server so product URLs resolve correctly.

## Deploy to a server

### 1. Clone

```bash
git clone https://github.com/hafizsameer11/magnet-pay-backend.git
cd magnet-pay-backend
npm install
cp .env.example .env
# edit .env for production DB, secrets, SMTP, API_PUBLIC_URL
```

### 2. Database

Use managed MySQL or self-hosted. Then:

```bash
npx prisma db push
npm run db:seed
```

For migrations in CI/prod prefer:

```bash
npm run db:migrate
```

### 3. Run

```bash
npm run build   # if you add a build step
npm start       # tsx src/index.ts
```

Use **PM2**, **systemd**, or Docker behind nginx/Caddy with HTTPS.

Example PM2:

```bash
npm install -g pm2
pm2 start npm --name magnetpay-api -- start
pm2 save
```

### 4. Reverse proxy

Point `https://api.yourdomain.com` → `127.0.0.1:4000`. Set:

```
API_PUBLIC_URL=https://api.yourdomain.com
CORS_ORIGIN=https://your-admin-domain.com
```

### 5. Mobile / admin clients

- Mobile: `EXPO_PUBLIC_API_URL=https://api.yourdomain.com`
- Admin: `VITE_API_URL=https://api.yourdomain.com`

## Push notifications (backend side)

1. Mobile app registers `ExponentPushToken[...]` via `POST /me/devices`
2. Events call `deliverUserNotification()` — in-app row + Expo push + optional email
3. Test as admin: `POST /admin/push/test` (Bearer admin JWT)

Expo dashboard must have **FCM v1 service account key** (Android) and **APNs** (iOS) configured.

## Useful scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | Dev server with watch |
| `npm start` | Production start |
| `npm run db:seed` | Reset + seed demo data |
| `npm run seed:media` | Download seed images into `seed-media/` |
| `npm run db:studio` | Prisma Studio |

## Git workflow

```bash
git add .
git commit -m "Describe your change"
git push origin main
```

Never commit `.env`, Firebase admin JSON, or runtime files under `uploads/` (except `.gitkeep`).

## Project layout

```
magnetpay-api/
├── prisma/          schema, migrations, seed.ts
├── seed-media/      committed catalog images (+ README)
├── src/
│   ├── routes/      HTTP handlers
│   └── services/    ledger, email, push, notify
├── scripts/         smoke tests, fetch-seed-media
└── uploads/         runtime user uploads (gitignored)
```
