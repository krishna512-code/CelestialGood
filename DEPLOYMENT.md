# Production Deployment Guide — Hybrid Setup

**Architecture:** Vercel serves the static site (fast CDN, security headers) and proxies
`/api`, `/uploads`, `/admin` to an Express API on Railway (persistent SQLite volume).

```
Browser → celestialgood.com (Vercel)
              ├──  /, /shop, /assets/*        → static files from dist/
              └──  /api/*, /uploads/*, /admin → Railway (Express + SQLite)
```

## 1. Deploy the API to Railway

1. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** → select `krishna512-code/CelestialGood`.
2. Railway auto-detects `railway.json` (nixpacks builder, `npm start`).
3. Add a **volume**: Service → **Variables/Settings → Volumes** → mount at `/data`.
4. Set these **Variables**:

   | Variable | Value |
   |---|---|
   | `NEXT_PUBLIC_SUPABASE_URL` | (copy from your local `.env`) |
   | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | (copy from your local `.env`) |
   | `SQLITE_PATH` | `/data/celestial-goods.db` |
   | `UPLOADS_DIR` | `/data/uploads` |
   | `OWNER_USERNAME` / `OWNER_PASSWORD` | optional strong admin bootstrap |

5. Under **Settings → Networking → Generate Domain**: create the public domain.
   You'll get something like `celestial-good-api.up.railway.app`.
6. **Important:** put that URL into `vercel.json` (replace all 4 occurrences of
   `https://celestial-good-api.up.railway.app`), commit, and push so Vercel proxies to it.

## 2. Vercel (static frontend)

- If not connected yet: [vercel.com](https://vercel.com) → **Add New Project** → import `krishna512-code/CelestialGood`.
- Framework: **Other** (static). Output directory: `dist`. No build command.
- Every push to `main` redeploys automatically.

## 3. Point the domain (GoDaddy)

In GoDaddy → **My Products → Domain → DNS → Manage Zones**:

1. **Delete** any existing Forwarding (it's currently parking the apex!).
2. Delete the old apex `A` records pointing at GoDaddy (`3.33.130.190`, `15.197.148.33`).
3. Add:
   - `A` record — name `@` — value `76.76.21.21` — TTL 600
   - `CNAME` — name `www` — value `cname.vercel-dns.com` — TTL 600
4. In Vercel → Project → **Settings → Domains**: add both `celestialgood.com` and
   `www.celestialgood.com`; set `www` as primary and apex → redirect to `www`.

DNS propagation: usually minutes, up to 48h worst case. Check with
`dig +short celestialgood.com` — it should return `76.76.21.21`.

## 4. Verify

```bash
curl -s https://www.celestialgood.com/api/products | head -c 200   # JSON products
curl -sI https://www.celestialgood.com/assets/celestial-good-logo.png  # 200 image/png
curl -sI https://www.celestialgood.com/admin                        # 200
```

Then browse https://celestialgood.com — hero, logo, products, and the admin
dashboard at `/admin` should all work.

## Local development

```bash
npm install
npm run start:all   # storefront+API :5050, admin server :5051
npm test            # 4 auth tests
```

Note: your shell exports `PORT=0`; the server now falls back to 5050 when `PORT`
is `0`/empty, so no local workaround is needed anymore.
