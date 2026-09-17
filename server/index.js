import express from 'express';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { query, queryOne, run, initDatabase, DB_DRIVER } from './config/db.js';
import { supabase, SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_PUBLISHABLE_KEY } from './config/supabase.js';
import { upload, saveUpload, UPLOADS_DIR } from './config/storage.js';
import { hashPassword, verifyPassword } from './middleware/auth.js';
import cors from 'cors';
import dotenv from 'dotenv';
dotenv.config();
import { signValue, verifyValue, rateLimit, asyncRoute, errorHandler, clientIp } from './session-hardening.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const IS_PROD = process.env.NODE_ENV === 'production';
const app = express();

// Express 4 does not catch rejected promises from async handlers — one bad
// request used to become an unhandled rejection that KILLED the process.
// Wrap every route handler so rejections flow to the global error handler.
for (const method of ['get', 'post', 'put', 'delete', 'patch']) {
  const orig = app[method].bind(app);
  app[method] = (path, ...handlers) =>
    orig(path, ...handlers.map((h) => (typeof h === 'function' ? asyncRoute(h) : h)));
}
// "0" (or empty) PORT strings are truthy but not a usable port — fall back.
const PORT = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 5050;

// Top-level await: schema must exist before any request/test touches the DB.
await initDatabase();

app.use(cors({ origin: false, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Local/static mode serves the storefront + uploads from this process.
// On Vercel, static files come from the CDN instead.
if (DB_DRIVER === 'sqlite') {
  app.get('/admin', (req, res) => { res.sendFile(join(__dirname, '..', 'public', 'admin', 'index.html')); });
  app.use('/uploads', express.static(UPLOADS_DIR));
  app.use(express.static(join(__dirname, '..', 'public'), { maxAge: '1d' }));
}

// Cookie-based sessions. Both cookies are HMAC-signed (payload.signature) —
// an unsigned/forged cookie fails verification and is treated as absent.
app.use((req, res, next) => {
  const cookie = req.headers.cookie;
  if (cookie) {
    const match = cookie.match(/(?:^|;\s*)session=([^;]+)/);
    if (match) {
      try {
        const data = verifyValue(decodeURIComponent(match[1]));
        // data.token marks a Supabase-authenticated admin login; userId marks
        // a local admin_users login. Either satisfies requireAuth.
        if (data && (data.userId || data.token)) {
          req.session = data;
          // Legacy marker: customer sessions briefly lived in `session`.
          if (data.customerId) req.account = { customerId: data.customerId };
        }
      } catch {}
    }
  }
  // Customer sessions use their own cookie so signing into the storefront
  // never overwrites the admin session (and vice versa).
  const custMatch = cookie && cookie.match(/(?:^|;\s*)customer_session=([^;]+)/);
  if (custMatch) {
    try {
      const cdata = verifyValue(decodeURIComponent(custMatch[1]));
      if (cdata && cdata.customerId) {
        req.account = { customerId: cdata.customerId };
      }
    } catch {}
  }
  next();
});

const requireAuth = asyncRoute(async (req, res, next) => {
  if (!req.session) return res.status(401).json({ error: 'Unauthorized. Please login.' });
  if (req.session.userId) return next(); // local admin — HMAC already verified
  if (req.session.token) {
    // Supabase-issued JWT — verify it against Supabase (cached). Access tokens
    // expire after ~1h; when the stored token is expired, use the saved
    // refresh_token to mint a fresh one and re-issue the session cookie, so an
    // admin mid-work never gets bounced to login by an expired JWT.
    let token = req.session.token;
    if (!(await supabaseTokenValid(token))) {
      const refreshed = await refreshSession(req, res);
      if (!refreshed) return res.status(401).json({ error: 'Unauthorized. Please login.' });
      token = refreshed;
    }
    if (await supabaseTokenValid(token)) return next();
    return res.status(401).json({ error: 'Unauthorized. Please login.' });
  }
  return res.status(401).json({ error: 'Unauthorized. Please login.' });
});

// Supabase JWT verification with a 1h positive cache (avoids a Supabase
// round-trip on every admin request). Fails closed on any error.
const supabaseTokenCache = new Map(); // token -> { ok, until }
async function supabaseTokenValid(token) {
  const hit = supabaseTokenCache.get(token);
  if (hit && hit.until > Date.now()) return hit.ok;
  let ok = false;
  try {
    const { data, error } = await supabase.auth.getUser(token);
    ok = !error && !!data?.user;
  } catch {
    ok = false; // fail closed: unverifiable token grants nothing
  }
  // Cache ONLY verified-good tokens. Caching a failure would pin a transient
  // network blip (or a momentarily unreachable Supabase) for an hour and
  // reject perfectly valid tokens — the intermittent-401 class of bug.
  if (ok) {
    supabaseTokenCache.set(token, { ok: true, until: Date.now() + 3600_000 });
    if (supabaseTokenCache.size > 500) supabaseTokenCache.clear();
  }
  return ok;
}

// Exchange the session's refresh_token for a new access token via the Supabase
// Auth token endpoint, then re-sign and re-issue the session cookie so the
// browser keeps a valid session without another manual login. Returns the new
// access token, or null when there is no refresh token or the refresh fails
// (revoked / signed out → caller rejects with 401 and the UI shows login).
const SESSION_COOKIE = 'session';
const SESSION_TTL_MS = 86400000;
async function refreshSession(req, res) {
  const refreshToken = req.session.refreshToken;
  if (!refreshToken) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_PUBLISHABLE_KEY || SUPABASE_SERVICE_KEY },
      body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d.access_token || !d.refresh_token) return null;
    res.cookie(SESSION_COOKIE, signValue({ token: d.access_token, refreshToken: d.refresh_token, expiry: Date.now() + SESSION_TTL_MS }), {
      httpOnly: true, maxAge: SESSION_TTL_MS, ...(IS_PROD ? { secure: true, sameSite: 'lax' } : {}),
    });
    return d.access_token;
  } catch {
    return null;
  }
}

// Guard for customer-account routes (storefront, not admin).
function requireCustomer(req, res, next) {
  if (req.account && req.account.customerId) return next();
  res.status(401).json({ error: 'Please sign in to continue.' });
}

// Signed-session variant for handlers that need the raw token (JWT) or
// payload — shared by /api/admin/me and change-password.
function getSession(req) {
  const match = (req.headers.cookie || '').match(/(?:^|;\s*)session=([^;]+)/);
  if (!match) return null;
  try {
    const data = verifyValue(decodeURIComponent(match[1]));
    if (!data) return null;
    return { raw: data.token || Buffer.from(JSON.stringify(data)).toString(), payload: data };
  } catch {
    return null;
  }
}

// Diagnostic endpoint: reports driver + exact DB connectivity error details.
app.get('/api/health', async (req, res) => {
  try {
    const rows = await query('SELECT 1 as ok');
    res.json({ ok: true, driver: DB_DRIVER, db: rows[0] });
  } catch (e) {
    // Detailed diagnostics only outside production; prod returns a minimal body
    res.status(500).json(
      IS_PROD
        ? { ok: false, driver: DB_DRIVER, code: e.code }
        : { ok: false, driver: DB_DRIVER, error: e.message, code: e.code, detail: e.detail, hint: e.hint }
    );
  }
});

// ==========================================
// RATE LIMITING (public endpoints — spam orders, credential stuffing)
// ==========================================
// TRUST_PROXY=1 is set in vercel.json; behind it Express's req.ip is already
// the real client, but clientIp() reads the forwarded header directly anyway.
const strictLimit = rateLimit({ windowMs: 60_000, max: 5, keyBy: (req) => String(req.body?.phone ?? req.body?.username ?? '') });
const orderLimit = rateLimit({ windowMs: 60_000, max: 5, keyBy: (req) => String(req.body?.phone ?? ''), methods: ['POST'] });
app.use('/api/admin/login', strictLimit);
app.use('/api/admin/forgot-password', rateLimit({ windowMs: 60_000, max: 3 }));
app.use('/api/account/register', strictLimit);
app.use('/api/account/login', strictLimit);
app.use('/api/account/logout', rateLimit({ windowMs: 60_000, max: 20 }));
app.use('/api/orders', orderLimit);

// ==========================================
// AUTH
// ==========================================
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body || {};
  // Primary: Supabase auth
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email: username, password });
    if (!error && data?.session) {
      const token = data.session.access_token;
      const refreshToken = data.session.refresh_token || undefined;
      res.cookie(SESSION_COOKIE, signValue({ token, refreshToken, expiry: Date.now() + SESSION_TTL_MS }), { httpOnly: true, maxAge: SESSION_TTL_MS, ...(IS_PROD ? { secure: true, sameSite: 'lax' } : {}) });
      return res.json({ success: true, user: { email: data.user.email } });
    }
  } catch {}
  // Fallback: local admin_users table
  const admin = await queryOne('SELECT * FROM admin_users WHERE username = ?', [username]);
  if (admin && verifyPassword(password, admin.password_hash)) {
    res.cookie('session', signValue({ userId: admin.id, expiry: Date.now() + 86400000 }), { httpOnly: true, maxAge: 86400000, ...(IS_PROD ? { secure: true, sameSite: 'lax' } : {}) });
    return res.json({ success: true, user: { email: admin.username } });
  }
  return res.status(401).json({ error: 'Invalid credentials' });
});

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('session');
  res.json({ success: true });
});

app.get('/api/admin/me', asyncRoute(async (req, res) => {
  const sess = getSession(req);
  if (!sess) return res.status(401).json({ loggedIn: false });
  const token = sess.raw;
  // Signed local-admin cookies carry a JSON payload with userId.
  if (sess.payload?.userId && sess.payload.expiry > Date.now()) {
    const admin = await queryOne('SELECT username FROM admin_users WHERE id = ?', [sess.payload.userId]);
    if (admin) return res.json({ loggedIn: true, user: { email: admin.username } });
  }
  // Supabase JWT — must verify server-side (a fabricated token grants nothing).
  if (typeof token === 'string' && token.includes('.') && (await supabaseTokenValid(token))) {
    const { data } = await supabase.auth.getUser(token);
    if (data?.user) return res.json({ loggedIn: true, user: { email: data.user.email } });
  }
  return res.status(401).json({ loggedIn: false });
}));

app.post('/api/admin/forgot-password', async (req, res) => {
  const { email } = req.body || {};
  const { error } = await supabase.auth.resetPasswordForEmail(email || '');
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

app.post('/api/admin/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Both current and new password required.' });
  }
  if (!req.session.userId) return res.status(400).json({ error: 'Password change requires local admin login.' });
  const user = await queryOne('SELECT * FROM admin_users WHERE id = ?', [req.session.userId]);
  if (!user || !verifyPassword(currentPassword, user.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }
  await run('UPDATE admin_users SET password_hash = ? WHERE id = ?', [hashPassword(newPassword), user.id]);
  res.json({ success: true, message: 'Password changed successfully.' });
});

// ==========================================
// DASHBOARD
// ==========================================
// ==========================================
// CUSTOMER ACCOUNTS (storefront sign-in)
// ==========================================
// Normalize a phone to its bare international digits for storage/matching.
// India equivalence: '+91 98765 43210', '09876543210' and '9876543210' all
// collapse to '9876543210' so order history matches across formats.
function phoneKey(raw) {
  let d = String(raw ?? '').replace(/[^0-9]/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d;
}

// International matching: the same number is written with the country code
// ('447700900777'), with a national 0 ('07700900777') or bare ('7700900777').
// True equivalence needs country knowledge we don't have, so treat numbers as
// matching when one is a suffix of the other (>= 7 digits), which is exactly
// how national dialing disambiguates. 91/0-prefix variants collapse first.
function phoneMatches(orderPhone, key) {
  const d = String(orderPhone ?? '').replace(/[^0-9]/g, '');
  const candidates = new Set([d]);
  if (d.length === 11 && d.startsWith('0')) candidates.add(d.slice(1));
  if (d.length === 12 && d.startsWith('91')) candidates.add(d.slice(2));
  return [...candidates].some(c =>
    c === key || (c.length >= 7 && key.length >= 7 && (key.endsWith(c) || c.endsWith(key))));
}

app.post('/api/account/register', async (req, res) => {
  const b = req.body || {};
  const text = (v, max) => String(v ?? '').trim().slice(0, max);
  const key = phoneKey(b.phone);
  const password = String(b.password ?? '');
  const full_name = text(b.full_name, 120);
  if (!/^\d{7,15}$/.test(key)) return res.status(400).json({ success: false, message: 'A valid phone number with country code is required (7-15 digits).' });
  if (password.length < 8) return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
  if (full_name.length < 2) return res.status(400).json({ success: false, message: 'Please enter your name.' });
  const existing = await queryOne('SELECT id FROM customers WHERE phone_digits = ?', [key]);
  if (existing) return res.status(409).json({ success: false, message: 'An account with this phone number already exists — please sign in.' });
  const r = await run(
    'INSERT INTO customers (phone_digits, password_hash, full_name, email) VALUES (?, ?, ?, ?)',
    [key, hashPassword(password), full_name, text(b.email, 160)]
  );
  const encoded = signValue({ customerId: r.lastId, expiry: Date.now() + 30 * 86400000 });
  res.cookie('customer_session', encoded, { httpOnly: true, maxAge: 30 * 86400000, ...(IS_PROD ? { secure: true, sameSite: 'lax' } : {}) });
  res.json({ success: true, customer: { id: r.lastId, phone: key, full_name } });
});

app.post('/api/account/login', async (req, res) => {
  const { phone, password } = req.body || {};
  const key = phoneKey(phone);
  const customer = await queryOne('SELECT * FROM customers WHERE phone_digits = ?', [key]);
  if (!customer || !verifyPassword(String(password ?? ''), customer.password_hash)) {
    return res.status(401).json({ success: false, message: 'Phone number or password is incorrect.' });
  }
  const encoded = signValue({ customerId: customer.id, expiry: Date.now() + 30 * 86400000 });
  res.cookie('customer_session', encoded, { httpOnly: true, maxAge: 30 * 86400000, ...(IS_PROD ? { secure: true, sameSite: 'lax' } : {}) });
  res.json({ success: true, customer: { id: customer.id, phone: customer.phone_digits, full_name: customer.full_name } });
});

app.post('/api/account/logout', (req, res) => {
  res.clearCookie('customer_session');
  res.json({ success: true });
});

app.get('/api/account/me', async (req, res) => {
  if (!req.account?.customerId) return res.json({ signedIn: false });
  const c = await queryOne(
    'SELECT id, phone_digits, full_name, email, address, landmark, city, state, postal_code, country, notes FROM customers WHERE id = ?',
    [req.account.customerId]
  );
  if (!c) return res.json({ signedIn: false });
  res.json({ signedIn: true, customer: c });
});

app.put('/api/account/profile', requireCustomer, async (req, res) => {
  const b = req.body || {};
  const text = (v, max) => String(v ?? '').trim().slice(0, max);
  const full_name = text(b.full_name, 120);
  if (full_name.length < 2) return res.status(400).json({ success: false, message: 'Please enter your name.' });
  if (b.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(b.email).trim())) {
    return res.status(400).json({ success: false, message: 'Email address is not valid.' });
  }
  await run(
    `UPDATE customers SET full_name = ?, email = ?, address = ?, landmark = ?, city = ?, state = ?, postal_code = ?, country = ?, notes = ? WHERE id = ?`,
    [full_name, text(b.email, 160), text(b.address, 400), text(b.landmark, 200), text(b.city, 100),
     text(b.state, 100), text(b.postal_code, 16), text(b.country, 80), text(b.notes, 500), req.account.customerId]
  );
  const c = await queryOne(
    'SELECT id, phone_digits, full_name, email, address, landmark, city, state, postal_code, country, notes FROM customers WHERE id = ?',
    [req.account.customerId]
  );
  res.json({ success: true, customer: c });
});

app.get('/api/account/orders', requireCustomer, async (req, res) => {
  const me = await queryOne('SELECT id, phone_digits FROM customers WHERE id = ?', [req.account.customerId]);
  if (!me) return res.json([]);
  const key = me.phone_digits;
  // Orders placed while signed in, plus every guest order whose phone matches
  // this account (phoneKey on both sides so +91/0-prefixed variants match).
  const orders = await query(
    `SELECT * FROM orders WHERE customer_id = ? OR phone = ? ORDER BY created_at DESC, id DESC LIMIT 200`,
    [me.id, key]
  );
  // Phone match needs normalization per row (orders may store any national
  // or international variant); filter in JS over a modest set.
  const rows = orders.length >= 200 ? orders : await query('SELECT * FROM orders ORDER BY created_at DESC, id DESC LIMIT 1000');
  const matched = rows.filter(o => o.customer_id === me.id || phoneMatches(o.phone, key));
  const withItems = await Promise.all(matched.map(async o => ({
    id: o.id,
    created_at: o.created_at,
    total_price: o.total_price,
    is_paid: o.is_paid,
    status: o.status,
    items: await query('SELECT product_name, weight, quantity, price FROM order_items WHERE order_id = ?', [o.id]),
  })));
  res.json(withItems);
});

app.get('/api/dashboard/stats', requireAuth, async (req, res) => {
  const totalRevenue = (await queryOne('SELECT COALESCE(SUM(total_price), 0) as total FROM orders WHERE is_paid = 1')).total;
  const totalSales = (await queryOne('SELECT COUNT(*) as count FROM orders')).count;
  const paidSales = (await queryOne('SELECT COUNT(*) as count FROM orders WHERE is_paid = 1')).count;
  const stockCount = (await queryOne('SELECT COUNT(*) as count FROM products WHERE active = 1 AND is_archived = 0')).count;
  const categoriesCount = (await queryOne('SELECT COUNT(*) as count FROM categories WHERE active = 1')).count;
  const recentOrders = await query('SELECT * FROM orders ORDER BY created_at DESC LIMIT 5');
  res.json({ totalRevenue, totalSales, paidSales, stockCount, categoriesCount, recentOrders });
});

app.get('/api/dashboard/graph', requireAuth, async (req, res) => {
  const orders = await query(
    `SELECT substr(created_at, 1, 7) as month, SUM(total_price) as revenue, COUNT(*) as orders
     FROM orders GROUP BY substr(created_at, 1, 7) ORDER BY month ASC LIMIT 12`
  );
  if (orders.length === 0) {
    return res.json([
      { name: 'May', total: 4200 },
      { name: 'Jun', total: 6800 },
      { name: 'Jul', total: 9100 },
      { name: 'Aug', total: 12400 },
      { name: 'Sep', total: 15800 },
    ]);
  }
  res.json(orders.map(o => ({ name: o.month, total: o.revenue || 0, orders: o.orders })));
});

// ==========================================
// UPLOAD (generic, admin)
// ==========================================
app.post('/api/upload', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
  try {
    const url = await saveUpload(req.file);
    res.json({ success: true, url, filename: req.file.originalname });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ==========================================
// SITE SETTINGS
// ==========================================
app.get('/api/settings', async (req, res) => {
  const settings = await queryOne('SELECT * FROM site_settings WHERE id = 1');
  res.json(settings || {});
});

app.put('/api/settings', requireAuth, async (req, res) => {
  const s = req.body || {};
  await run(
    `UPDATE site_settings SET hero_title=?, hero_subtitle=?, hero_description=?, announcement_text=?,
     whatsapp_number=?, email=?, footer_description=?, copyright_text=?, ga4_measurement_id=?, fb_pixel_id=? WHERE id=1`,
    [s.hero_title, s.hero_subtitle, s.hero_description, s.announcement_text,
     s.whatsapp_number, s.email, s.footer_description, s.copyright_text,
     s.ga4_measurement_id, s.fb_pixel_id]
  );
  res.json({ success: true, message: 'Settings saved.' });
});

// ==========================================
// CATEGORIES
// ==========================================
app.get('/api/categories', async (req, res) => {
  const cats = await query(
    `SELECT c.*, b.label as billboard_label FROM categories c
     LEFT JOIN billboards b ON c.billboard_id = b.id
     WHERE c.active = 1 ORDER BY c.sort_order ASC, c.id ASC`
  );
  res.json(cats);
});

app.post('/api/categories', requireAuth, upload.single('image'), async (req, res) => {
  const { name, slug, icon, description, billboard_id, sort_order } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const cleanSlug = (slug || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  // Slug is UNIQUE in the schema, so re-creating a category whose name/slug was
  // used before (including a soft-deleted one) must not leak a raw Postgres
  // error. A soft-deleted owner is transparently revived with the new details;
  // an active owner is reported in plain language.
  const owner = await queryOne('SELECT id, name, active FROM categories WHERE slug = ?', [cleanSlug]);
  let imageUrl = req.body.image_url || '';
  try { if (req.file) imageUrl = await saveUpload(req.file); } catch (e) {
    return res.status(500).json({ error: `Image upload failed: ${e.message}` });
  }
  if (owner) {
    if (!owner.active) {
      await run(
        `UPDATE categories SET name=?, icon=?, image_url=?, description=?, billboard_id=?, sort_order=?, active=1 WHERE id=?`,
        [name, icon || '📦', imageUrl, description || '', billboard_id ? parseInt(billboard_id) : null, parseInt(sort_order) || 0, owner.id]
      );
      return res.json({ success: true, id: owner.id, message: 'Category added (restored a previously deleted category with the same slug).' });
    }
    return res.status(400).json({ error: `The slug "${cleanSlug}" is already used by the category "${owner.name}". Pick a different slug.` });
  }
  const r = await run(
    `INSERT INTO categories (name, slug, icon, image_url, description, billboard_id, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [name, cleanSlug, icon || '📦', imageUrl, description || '', billboard_id ? parseInt(billboard_id) : null, parseInt(sort_order) || 0]
  );
  res.json({ success: true, id: r.lastId, message: 'Category added.' });
});

app.put('/api/categories/:id', requireAuth, upload.single('image'), async (req, res) => {
  const { name, slug, icon, description, billboard_id, sort_order } = req.body || {};
  const current = await queryOne('SELECT * FROM categories WHERE id = ?', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'Category not found' });
  let imageUrl = current.image_url ?? '';
  if (req.body.image_url !== undefined) imageUrl = req.body.image_url;
  try { if (req.file) imageUrl = await saveUpload(req.file); } catch (e) {
    return res.status(500).json({ error: `Image upload failed: ${e.message}` });
  }
  await run(
    `UPDATE categories SET name=?, slug=?, icon=?, image_url=?, description=?, billboard_id=?, sort_order=? WHERE id=?`,
    [name ?? current.name, slug ?? current.slug, icon ?? current.icon, imageUrl, description ?? current.description,
     billboard_id !== undefined ? (billboard_id ? parseInt(billboard_id) : null) : current.billboard_id,
     sort_order !== undefined ? parseInt(sort_order) : current.sort_order,
     req.params.id]
  );
  res.json({ success: true, message: 'Category updated.' });
});

app.delete('/api/categories/:id', requireAuth, async (req, res) => {
  await run('UPDATE categories SET active=0 WHERE id=?', [req.params.id]);
  res.json({ success: true, message: 'Category deleted.' });
});

// ==========================================
// SIZES & COLORS
// ==========================================
app.get('/api/sizes', async (req, res) => {
  res.json(await query('SELECT * FROM sizes ORDER BY id ASC'));
});
app.post('/api/sizes', requireAuth, async (req, res) => {
  const { name, value } = req.body || {};
  const r = await run('INSERT INTO sizes (name, value) VALUES (?, ?)', [name, value]);
  res.json({ success: true, id: r.lastId });
});
app.delete('/api/sizes/:id', requireAuth, async (req, res) => {
  await run('DELETE FROM sizes WHERE id=?', [req.params.id]);
  res.json({ success: true });
});

app.get('/api/colors', async (req, res) => {
  res.json(await query('SELECT * FROM colors ORDER BY id ASC'));
});
app.post('/api/colors', requireAuth, async (req, res) => {
  const { name, value, hex } = req.body || {};
  const r = await run('INSERT INTO colors (name, value, hex) VALUES (?, ?, ?)', [name, value, hex || '#C4943D']);
  res.json({ success: true, id: r.lastId });
});
app.delete('/api/colors/:id', requireAuth, async (req, res) => {
  await run('DELETE FROM colors WHERE id=?', [req.params.id]);
  res.json({ success: true });
});

// ==========================================
// PRODUCTS
// ==========================================
app.get('/api/products', async (req, res) => {
  const { category, search, sort, featured, includeArchived } = req.query;
  let sql = `
    SELECT p.*, c.name as category_name, c.slug as category_slug
    FROM products p LEFT JOIN categories c ON p.category_id = c.id
    WHERE p.active = 1`;
  const params = [];
  if (!includeArchived) sql += ' AND p.is_archived = 0';
  if (category && category !== 'all') { sql += ' AND (c.slug = ? OR c.id = ?)'; params.push(category, category); }
  if (search) { sql += ' AND (p.name LIKE ? OR p.description LIKE ? OR p.short_desc LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  if (featured === '1' || featured === 'true') sql += ' AND p.is_featured = 1';
  if (sort === 'price-asc') sql += ' ORDER BY p.price ASC';
  else if (sort === 'price-desc') sql += ' ORDER BY p.price DESC';
  else if (sort === 'name') sql += ' ORDER BY p.name ASC';
  else sql += ' ORDER BY p.is_featured DESC, p.sort_order ASC, p.id DESC';

  const products = await query(sql, params);
  res.json(products.map(p => {
    let variants = [];
    try { variants = p.variants ? JSON.parse(p.variants) : []; } catch { variants = []; }
    return { ...p, variants };
  }));
});

app.get('/api/products/:id', async (req, res) => {
  const product = await queryOne(
    `SELECT p.*, c.name as category_name FROM products p
     LEFT JOIN categories c ON p.category_id = c.id
     WHERE p.id = ? AND p.active = 1`,
    [req.params.id]
  );
  if (!product) return res.status(404).json({ error: 'Product not found.' });
  try { product.variants = product.variants ? JSON.parse(product.variants) : []; } catch { product.variants = []; }
  product.images = await query('SELECT * FROM images WHERE product_id = ?', [product.id]);
  res.json(product);
});

function parseProductBody(body) {
  const b = body || {};
  return {
    name: b.name,
    slug: b.slug,
    description: b.description,
    short_desc: b.short_desc,
    price: b.price !== undefined ? parseFloat(b.price) || 0 : undefined,
    mrp: b.mrp !== undefined ? parseFloat(b.mrp) || 0 : undefined,
    category_id: b.category_id !== undefined ? (b.category_id ? parseInt(b.category_id) : null) : undefined,
    badge: b.badge,
    featuredFlag: b.featured !== undefined ? (b.featured === '1' || b.featured === true ? 1 : 0)
      : b.is_featured !== undefined ? (b.is_featured === '1' || b.is_featured === true || b.is_featured === 1 ? 1 : 0)
      : undefined,
    archivedFlag: b.is_archived !== undefined ? (b.is_archived === '1' || b.is_archived === true || b.is_archived === 1 ? 1 : 0) : undefined,
    variants: b.variants !== undefined ? (typeof b.variants === 'string' ? b.variants : JSON.stringify(b.variants || [])) : undefined,
    imageUrl: b.image_url,
    sortOrder: b.sort_order !== undefined ? parseInt(b.sort_order) || 0 : undefined,
  };
}

app.post('/api/products', requireAuth, upload.single('image'), async (req, res) => {
  const b = parseProductBody(req.body);
  if (!b.name || b.price === undefined) {
    return res.status(400).json({ error: 'Name and price are required.' });
  }
  try {
    let imageUrl = b.imageUrl || '';
    if (req.file) imageUrl = await saveUpload(req.file);
    const cleanSlug = (b.slug || b.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Math.floor(Math.random() * 1000);
    const r = await run(
      `INSERT INTO products (name, slug, description, short_desc, price, mrp, category_id, image_url, badge, is_featured, is_archived, variants, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [b.name, cleanSlug, b.description || '', b.short_desc || '', b.price, b.mrp ?? b.price,
       b.category_id ?? null, imageUrl, b.badge || '', b.featuredFlag ?? 0, b.archivedFlag ?? 0,
       b.variants ?? '[]', b.sortOrder ?? 0]
    );
    res.json({ success: true, id: r.lastId, message: 'Product created successfully.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/products/:id', requireAuth, upload.single('image'), async (req, res) => {
  const b = parseProductBody(req.body);
  try {
    const current = await queryOne('SELECT * FROM products WHERE id = ?', [req.params.id]);
    if (!current) return res.status(404).json({ error: 'Product not found.' });

    let imgToSave = current.image_url;
    if (req.file) imgToSave = await saveUpload(req.file);
    else if (b.imageUrl !== undefined) imgToSave = b.imageUrl;

    await run(
      `UPDATE products SET name=?, slug=?, description=?, short_desc=?, price=?, mrp=?, category_id=?,
       image_url=?, badge=?, is_featured=?, is_archived=?, variants=?, sort_order=?, updated_at=CURRENT_TIMESTAMP
       WHERE id=?`,
      [b.name ?? current.name, b.slug ?? current.slug, b.description ?? current.description,
       b.short_desc ?? current.short_desc, b.price ?? current.price, b.mrp ?? current.mrp,
       b.category_id !== undefined ? b.category_id : current.category_id,
       imgToSave, b.badge ?? current.badge,
       b.featuredFlag !== undefined ? b.featuredFlag : current.is_featured,
       b.archivedFlag !== undefined ? b.archivedFlag : current.is_archived,
       b.variants ?? current.variants, b.sortOrder ?? current.sort_order, req.params.id]
    );
    res.json({ success: true, message: 'Product updated successfully.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/products/:id', requireAuth, async (req, res) => {
  await run('UPDATE products SET active=0 WHERE id=?', [req.params.id]);
  res.json({ success: true, message: 'Product deleted.' });
});

app.post('/api/products/:id/toggle-featured', requireAuth, async (req, res) => {
  const current = await queryOne('SELECT is_featured FROM products WHERE id = ?', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'Not found' });
  const newVal = current.is_featured ? 0 : 1;
  await run('UPDATE products SET is_featured = ? WHERE id = ?', [newVal, req.params.id]);
  res.json({ success: true, is_featured: newVal });
});

app.post('/api/products/:id/toggle-archived', requireAuth, async (req, res) => {
  const current = await queryOne('SELECT is_archived FROM products WHERE id = ?', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'Not found' });
  const newVal = current.is_archived ? 0 : 1;
  await run('UPDATE products SET is_archived = ? WHERE id = ?', [newVal, req.params.id]);
  res.json({ success: true, is_archived: newVal });
});

// ==========================================
// BILLBOARDS (served at /api/banners AND /api/billboards —
// the admin UI mutates via /api/banners/:id)
// ==========================================
const BANNER_PATHS = ['/api/banners', '/api/billboards'];

app.get(BANNER_PATHS, async (req, res) => {
  res.json(await query('SELECT * FROM billboards WHERE active = 1 ORDER BY sort_order ASC, id ASC'));
});

app.post(BANNER_PATHS, requireAuth, upload.single('image'), async (req, res) => {
  const b = req.body || {};
  let imageUrl = b.image_url || '';
  if (req.file) imageUrl = await saveUpload(req.file);
  const r = await run(
    `INSERT INTO billboards (label, image_url, heading, badge, subtitle, link, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [b.label || b.heading || 'Ad Banner', imageUrl, b.heading || '', b.badge || '🔥 Special',
     b.subtitle || '', b.link || '/shop.html', parseInt(b.sort_order) || 0]
  );
  res.json({ success: true, id: r.lastId, message: 'Advertisement banner created.' });
});

app.put([...BANNER_PATHS.map(p => `${p}/:id`)], requireAuth, upload.single('image'), async (req, res) => {
  const b = req.body || {};
  const current = await queryOne('SELECT * FROM billboards WHERE id = ?', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'Billboard not found' });

  let imageUrl = current.image_url;
  if (req.file) imageUrl = await saveUpload(req.file);
  else if (b.image_url !== undefined) imageUrl = b.image_url;

  await run(
    `UPDATE billboards SET label=?, image_url=?, heading=?, badge=?, subtitle=?, link=?, sort_order=?, active=? WHERE id=?`,
    [b.label ?? current.label, imageUrl, b.heading ?? current.heading, b.badge ?? current.badge,
     b.subtitle ?? current.subtitle, b.link ?? current.link,
     b.sort_order !== undefined ? parseInt(b.sort_order) : current.sort_order,
     b.active !== undefined ? (b.active === '1' || b.active === true || b.active === 1 ? 1 : 0) : current.active,
     req.params.id]
  );
  res.json({ success: true, message: 'Advertisement banner updated.' });
});

app.delete([...BANNER_PATHS.map(p => `${p}/:id`)], requireAuth, async (req, res) => {
  await run('DELETE FROM billboards WHERE id=?', [req.params.id]);
  res.json({ success: true, message: 'Banner removed.' });
});

// ==========================================
// ORDERS
// ==========================================
app.get('/api/orders', requireAuth, async (req, res) => {
  const orders = await query('SELECT * FROM orders ORDER BY created_at DESC');
  const withItems = await Promise.all(orders.map(async o => ({
    ...o,
    items: await query('SELECT * FROM order_items WHERE order_id = ?', [o.id]),
  })));
  res.json(withItems);
});

// COD checkout: the storefront form posts the customer's details here (no auth).
// Only COD is supported today; payment_method is forced server-side.
app.post('/api/orders', async (req, res) => {
  const b = req.body || {};
  const items = Array.isArray(b.items) ? b.items : [];

  const text = (v, max) => String(v ?? '').trim().slice(0, max);
  const order = {
    customer_name: text(b.customer_name, 120),
    phone: text(b.phone, 24),
    email: text(b.email, 160),
    address: text(b.address, 400),
    landmark: text(b.landmark, 200),
    city: text(b.city, 100),
    state: text(b.state, 100),
    pincode: text(b.postal_code ?? b.pincode, 16).replace(/\s+/g, ''),
    notes: text(b.notes, 500),
    map_link: text(b.map_link, 500),
  };

  // The map link is optional and rendered as a clickable href in the admin
  // panel — only accept http(s) URLs, drop anything else (e.g. javascript:).
  if (order.map_link && !/^https?:\/\//i.test(order.map_link)) {
    order.map_link = '';
  }

  // --- Validation (server-side, mirrors the client form) ---
  // International: any country dialing. Phones keep their digits (E.164 is
  // 7-15 digits); postal codes are alphanumeric (US ZIP, UK "SW1A 1AA", etc.).
  const errors = [];
  if (order.customer_name.length < 2) errors.push('Full name is required.');
  const phoneDigits = order.phone.replace(/[^0-9]/g, '');
  if (!/^\d{7,15}$/.test(phoneDigits)) errors.push('A valid phone number with country code is required (7-15 digits).');
  if (order.address.length < 6) errors.push('Full address is required.');
  if (!order.city) errors.push('City is required.');
  if (!/^[A-Za-z0-9][A-Za-z0-9 -]{1,14}$/.test(order.pincode)) errors.push('A valid postal / ZIP code is required.');
  if (order.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(order.email)) errors.push('Email address is not valid.');
  const latitude = b.latitude === undefined || b.latitude === null || b.latitude === '' ? null : Number(b.latitude);
  const longitude = b.longitude === undefined || b.longitude === null || b.longitude === '' ? null : Number(b.longitude);
  const hasCoords = latitude !== null && longitude !== null;
  if (hasCoords && (!(Number.isFinite(latitude) && Math.abs(latitude) <= 90) || !(Number.isFinite(longitude) && Math.abs(longitude) <= 180))) {
    errors.push('Location coordinates are not valid.');
  }
  if (errors.length) {
    return res.status(400).json({ success: false, errors, message: errors[0] });
  }

  const total = Math.max(0, Math.round((parseFloat(b.total_price) || 0) * 100) / 100);
  const r = await run(
    `INSERT INTO orders (customer_name, phone, email, address, landmark, city, state, pincode, notes, latitude, longitude, map_link, payment_method, total_price, is_paid, status, customer_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'cod', ?, 0, 'pending', ?)`,
    [order.customer_name, phoneDigits, order.email, order.address, order.landmark, order.city, order.state, order.pincode, order.notes,
     hasCoords ? latitude : null, hasCoords ? longitude : null, order.map_link, total, req.account?.customerId ?? null]
  );
  const orderId = r.lastId;
  try {
    for (const item of items.slice(0, 50)) {
      const it = item && typeof item === 'object' ? item : {};
      const n = it.product_id === undefined || it.product_id === null || it.product_id === '' ? NaN : Number(it.product_id);
      const product_id = Number.isInteger(n) && n > 0 ? n : null;
      await run(
        `INSERT INTO order_items (order_id, product_id, product_name, weight, quantity, price) VALUES (?, ?, ?, ?, ?, ?)`,
        [orderId, product_id, text(it.name, 200), text(it.weight, 60), Math.max(1, Math.min(999, parseInt(it.quantity, 10) || 1)), Math.max(0, parseFloat(it.price) || 0)]
      );
    }
  } catch (e) {
    console.error('order item insert failed:', e);
    return res.status(500).json({ success: false, message: 'Could not save order items. Please try again.' });
  }
  res.json({ success: true, orderId, message: 'Order created successfully.' });
});

app.put('/api/orders/:id/status', requireAuth, async (req, res) => {
  const { status, is_paid } = req.body || {};
  if (status !== undefined) await run('UPDATE orders SET status = ? WHERE id = ?', [status, req.params.id]);
  if (is_paid !== undefined) await run('UPDATE orders SET is_paid = ? WHERE id = ?', [is_paid ? 1 : 0, req.params.id]);
  res.json({ success: true, message: 'Order updated.' });
});

app.delete('/api/orders/:id', requireAuth, async (req, res) => {
  await run('DELETE FROM order_items WHERE order_id = ?', [req.params.id]);
  await run('DELETE FROM orders WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

// ==========================================
// TESTIMONIALS
// ==========================================
app.get('/api/testimonials', async (req, res) => {
  res.json(await query('SELECT * FROM testimonials WHERE active = 1 ORDER BY sort_order ASC, id ASC'));
});

app.post('/api/testimonials', requireAuth, async (req, res) => {
  const { name, location, text, avatar, rating, sort_order } = req.body || {};
  const r = await run(
    'INSERT INTO testimonials (name, location, text, avatar, rating, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
    [name, location || '', text, avatar || String(name || '?').charAt(0).toUpperCase(), parseInt(rating) || 5, parseInt(sort_order) || 0]
  );
  res.json({ success: true, id: r.lastId });
});

app.put('/api/testimonials/:id', requireAuth, async (req, res) => {
  const b = req.body || {};
  const current = await queryOne('SELECT * FROM testimonials WHERE id = ?', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'Testimonial not found' });
  await run(
    'UPDATE testimonials SET name=?, location=?, text=?, avatar=?, rating=?, sort_order=? WHERE id=?',
    [b.name ?? current.name, b.location ?? current.location, b.text ?? current.text,
     b.avatar ?? current.avatar, b.rating !== undefined ? (parseInt(b.rating) || current.rating) : current.rating,
     b.sort_order !== undefined ? (parseInt(b.sort_order) || 0) : current.sort_order, req.params.id]
  );
  res.json({ success: true });
});

app.delete('/api/testimonials/:id', requireAuth, async (req, res) => {
  await run('DELETE FROM testimonials WHERE id=?', [req.params.id]);
  res.json({ success: true });
});

// ==========================================
// FAQ
// ==========================================
app.get('/api/faq', async (req, res) => {
  res.json(await query('SELECT * FROM faq WHERE active = 1 ORDER BY sort_order ASC, id ASC'));
});

app.post('/api/faq', requireAuth, async (req, res) => {
  const { question, answer, sort_order } = req.body || {};
  const r = await run('INSERT INTO faq (question, answer, sort_order) VALUES (?, ?, ?)', [question, answer, parseInt(sort_order) || 0]);
  res.json({ success: true, id: r.lastId });
});

app.put('/api/faq/:id', requireAuth, async (req, res) => {
  const b = req.body || {};
  const current = await queryOne('SELECT * FROM faq WHERE id = ?', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'FAQ item not found' });
  await run(
    'UPDATE faq SET question=?, answer=?, sort_order=? WHERE id=?',
    [b.question ?? current.question, b.answer ?? current.answer,
     b.sort_order !== undefined ? (parseInt(b.sort_order) || 0) : current.sort_order, req.params.id]
  );
  res.json({ success: true });
});

app.delete('/api/faq/:id', requireAuth, async (req, res) => {
  await run('DELETE FROM faq WHERE id=?', [req.params.id]);
  res.json({ success: true });
});

// ==========================================
// PAGE ROUTES (local/static mode only)
// ==========================================
if (DB_DRIVER === 'sqlite') {
  app.get('/', (req, res) => { res.sendFile(join(__dirname, '..', 'public', 'index.html')); });
  app.get('/shop', (req, res) => { res.sendFile(join(__dirname, '..', 'public', 'shop.html')); });
  app.use((req, res) => {
    res.status(404).sendFile(join(__dirname, '..', 'public', '404.html'));
  });
}

// Global error handler — must be registered AFTER all routes/middleware so it
// receives errors forwarded by the asyncRoute wrapper above.
app.use(errorHandler);

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`Celestial Good server running at http://localhost:${PORT} (${DB_DRIVER} mode)`);
    console.log(`Admin panel at http://localhost:${PORT}/admin`);
  });
}

export default app;
