# Production Deployment — Vercel + Supabase (₹0/month, no Railway)

**Architecture:** Vercel serves the static site from `dist/` and runs the Express
backend as serverless Functions (`api/index.js`). Data lives in Supabase Postgres
(free 500 MB), product images in Supabase Storage (free 1 GB). No second server,
no volume, nothing sleeping.

```
Browser → celestialgood.com (Vercel)
             ├──  /, /shop, /assets/*      → static files (CDN)
             ├──  /api/*                   → Vercel Function (Express app)
             │        └── Postgres (Supabase) + Storage (Supabase)
             └──  /admin, /admin/*         → static admin page
                   (its fetch calls hit /api/* on the same origin)
```

Local development and `npm test` keep using SQLite automatically — no
`DATABASE_URL` needed. The dual-driver in `server/config/db.js` picks Postgres
the moment `DATABASE_URL` is set (that's what Vercel will have).

---

## 1. Create the Supabase schema + seed (one-time)

Get two things from your Supabase dashboard:

| What | Where |
|---|---|
| `DATABASE_URL` | Project Settings → Database → Connection string → **URI**, choose the **Pooler** string (port `6543`); it looks like `postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres` |
| `SUPABASE_SERVICE_KEY` | Project Settings → API → `service_role` **secret** |

Add both to `.env` locally (never commit), then run:

> **Env naming:** the code accepts both schemes — the Supabase dashboard's
> current names (`SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`)
> and the classic ones (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
> `SUPABASE_SERVICE_KEY`). Use either, just be consistent in Vercel.

```bash
npm run migrate:pg
```

It creates the 12 tables, indexes, RLS lockdown (service_role-only), seeds the
same catalog as the SQLite DB (categories, 8 products, billboards, testimonials,
FAQ, sample orders), and creates the public `product-images` storage bucket.

## 2. Vercel project settings

Import the repo in Vercel (or use the existing project). Framework preset:
**Other**. Then set **Environment Variables** (Production + Preview):

```
SUPABASE_URL                      = https://<ref>.supabase.co
SUPABASE_PUBLISHABLE_KEY          = (publishable key)
SUPABASE_SECRET_KEY               = (secret/service key — enables image uploads)
DATABASE_URL                      = (the pooler URI from step 1)
OWNER_USERNAME / OWNER_PASSWORD   = (optional local-admin bootstrap)
```

(The classic names `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
`SUPABASE_SERVICE_KEY` also work.)

No build command needed; `vercel.json` wires everything:

- `/api/*` → the serverless function (`api/index.js`)
- `/admin` → static `admin/index.html` (rewrite already configured)
- `/shop` → rewrite to `/shop.html`
- unknown paths → `/404.html`
- security headers + long-lived asset caching (kept from the earlier hardening)

## 3. DNS at GoDaddy (fixes the hijacked apex)

`celestialgood.com` currently points at GoDaddy forwarding/parking IPs. In
GoDaddy → DNS records:

1. **Delete** any "Forwarding" / "Parking" entries for the apex.
2. `A` record: `@` → `76.76.21.21`
3. `CNAME`: `www` → `cname.vercel-dns.com` (already correct)

Then add both `celestialgood.com` and `www.celestialgood.com` as domains in the
Vercel project. TLS is automatic.

## 4. Verify the deployment

```bash
curl -s https://celestialgood.com/api/products | head -c 300      # JSON, 8 products
curl -s -o /dev/null -w '%{http_code}' https://celestialgood.com/admin   # 200
```

Log in at `https://celestialgood.com/admin`, edit a product, and confirm the
image lands in Supabase Storage (`product-images` bucket).

---

## Notes & gotchas

- **Admin login:** primary path is Supabase Auth (email + password users). The
  `admin_users` table is a local fallback — bootstrap it via `OWNER_USERNAME` /
  `OWNER_PASSWORD` before `npm run migrate:pg`, or insert a row manually
  (hash with bcrypt).
- **Password reset email** (`/api/admin/forgot-password`): works once you add
  SMTP/custom domain settings in Supabase Auth; by default Supabase rate-limits
  to its built-in email service.
- **Free-tier limits:** Supabase pauses projects after 1 week of inactivity on
  the free plan — real traffic prevents that. Vercel Hobby is technically
  non-commercial per ToS; fine to launch on, move to Pro ($20/mo) or an
  always-free VM (e.g. Oracle) if the store becomes a registered business.
- **SQLite mode** remains the default locally: `npm start`, `npm test`, and the
  preview all work with zero cloud dependencies.
