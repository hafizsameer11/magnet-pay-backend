# Seed media (committed to Git)

Static images and videos used by `prisma/seed.ts`. Served at:

```
GET /files/seed/<filename>
```

## Populate files

From repo root:

```bash
cd magnetpay-api
npm run seed:media
```

This downloads catalog/avatar assets into this folder. Commit the results so production/staging can seed without external URLs.

## Server env

Set public API base for seed URLs (optional, default `http://127.0.0.1:4000`):

```
API_PUBLIC_URL=https://api.yourdomain.com
```

## Adding video

Drop `.mp4` files here and reference them in `prisma/seed.ts` via `seedAsset("demo.mp4")`.
