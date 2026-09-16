import express from 'express';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { query, queryOne, run, initDatabase, DB_DRIVER } from './config/db.js';
import { supabase } from './config/supabase.js';
import { upload, saveUpload, UPLOADS_DIR } from './config/storage.js';
import { hashPassword, verifyPassword } from './middleware/auth.js';
import cors from 'cors';
import dotenv from 'dotenv';
dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const IS_PROD = process.env.NODE_ENV === 'production';
const app = express();
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

// Cookie-based session (stateless: payload + expiry encoded in the cookie)
app.use((req, res, next) => {
  const cookie = req.headers.cookie;
  if (cookie) {
    try {
      const match = cookie.match(/session=([^;]+)/);
      if (match) {
        // res.cookie percent-encodes base64 padding — decode before parsing
        const data = JSON.parse(Buffer.from(decodeURIComponent(match[1]), 'base64').toString());
        if (data && data.expiry > Date.now()) {
          req.session = data;
        }
      }
    } catch {}
  }
  next();
});

function requireAuth(req, res, next) {
  if (req.session && (req.session.userId || req.session.token)) return next();
  res.status(401).json({ error: 'Unauthorized. Please login.' });
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
// AUTH
// ==========================================
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body || {};
  // Primary: Supabase auth
  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email: username, password });
    if (!error && data?.session) {
      const token = data.session.access_token;
      const encoded = Buffer.from(token).toString('base64');
      res.cookie('session', encoded, { httpOnly: true, maxAge: 86400000, ...(IS_PROD ? { secure: true, sameSite: 'lax' } : {}) });
      return res.json({ success: true, user: { email: data.user.email } });
    }
  } catch {}
  // Fallback: local admin_users table
  const admin = await queryOne('SELECT * FROM admin_users WHERE username = ?', [username]);
  if (admin && verifyPassword(password, admin.password_hash)) {
    const sessionObj = { userId: admin.id, expiry: Date.now() + 86400000 };
    const encoded = Buffer.from(JSON.stringify(sessionObj)).toString('base64');
    res.cookie('session', encoded, { httpOnly: true, maxAge: 86400000, ...(IS_PROD ? { secure: true, sameSite: 'lax' } : {}) });
    return res.json({ success: true, user: { email: admin.username } });
  }
  return res.status(401).json({ error: 'Invalid credentials' });
});

app.post('/api/admin/logout', (req, res) => {
  res.clearCookie('session');
  res.json({ success: true });
});

app.get('/api/admin/me', async (req, res) => {
  const cookie = req.headers.cookie;
  if (!cookie) return res.status(401).json({ loggedIn: false });
  const match = cookie.match(/session=([^;]+)/);
  if (!match) return res.status(401).json({ loggedIn: false });
  const token = Buffer.from(decodeURIComponent(match[1]), 'base64').toString();
  // Local-admin cookies carry a JSON payload; Supabase cookies carry a JWT.
  try {
    const payload = JSON.parse(token);
    if (payload && payload.userId && payload.expiry > Date.now()) {
      const admin = await queryOne('SELECT username FROM admin_users WHERE id = ?', [payload.userId]);
      if (admin) return res.json({ loggedIn: true, user: { email: admin.username } });
    }
  } catch {}
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return res.status(401).json({ loggedIn: false });
  res.json({ loggedIn: true, user: { email: data.user.email } });
});

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
     whatsapp_number=?, email=?, footer_description=?, copyright_text=? WHERE id=1`,
    [s.hero_title, s.hero_subtitle, s.hero_description, s.announcement_text,
     s.whatsapp_number, s.email, s.footer_description, s.copyright_text]
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

app.post('/api/categories', requireAuth, async (req, res) => {
  const { name, slug, icon, description, billboard_id, sort_order } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name is required' });
  const cleanSlug = (slug || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  try {
    const r = await run(
      `INSERT INTO categories (name, slug, icon, description, billboard_id, sort_order) VALUES (?, ?, ?, ?, ?, ?)`,
      [name, cleanSlug, icon || '📦', description || '', billboard_id ? parseInt(billboard_id) : null, parseInt(sort_order) || 0]
    );
    res.json({ success: true, id: r.lastId, message: 'Category added.' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/api/categories/:id', requireAuth, async (req, res) => {
  const { name, slug, icon, description, billboard_id, sort_order } = req.body || {};
  const current = await queryOne('SELECT * FROM categories WHERE id = ?', [req.params.id]);
  if (!current) return res.status(404).json({ error: 'Category not found' });
  await run(
    `UPDATE categories SET name=?, slug=?, icon=?, description=?, billboard_id=?, sort_order=? WHERE id=?`,
    [name ?? current.name, slug ?? current.slug, icon ?? current.icon, description ?? current.description,
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
    phone: text(b.phone, 20),
    email: text(b.email, 160),
    address: text(b.address, 400),
    landmark: text(b.landmark, 200),
    city: text(b.city, 100),
    state: text(b.state, 100),
    pincode: text(b.pincode, 10).replace(/\s+/g, ''),
    notes: text(b.notes, 500),
    map_link: text(b.map_link, 500),
  };

  // --- Validation (server-side, mirrors the client form) ---
  const errors = [];
  if (order.customer_name.length < 2) errors.push('Full name is required.');
  const phoneDigits = order.phone.replace(/[^0-9]/g, '').replace(/^91(?=[6-9])/, '');
  if (!/^[6-9]\d{9}$/.test(phoneDigits)) errors.push('A valid 10-digit Indian mobile number is required.');
  if (order.address.length < 6) errors.push('Full address is required.');
  if (!order.city) errors.push('City is required.');
  if (!order.state) errors.push('State is required.');
  if (!/^\d{6}$/.test(order.pincode)) errors.push('A valid 6-digit pincode is required.');
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
    `INSERT INTO orders (customer_name, phone, email, address, landmark, city, state, pincode, notes, latitude, longitude, map_link, payment_method, total_price, is_paid, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'cod', ?, 0, 'pending')`,
    [order.customer_name, phoneDigits, order.email, order.address, order.landmark, order.city, order.state, order.pincode, order.notes,
     hasCoords ? latitude : null, hasCoords ? longitude : null, order.map_link, total]
  );
  const orderId = r.lastId;
  if (Array.isArray(items)) {
    for (const item of items.slice(0, 50)) {
      await run(
        `INSERT INTO order_items (order_id, product_id, product_name, weight, quantity, price) VALUES (?, ?, ?, ?, ?, ?)`,
        [orderId, item.product_id || null, text(item.name, 200), text(item.weight, 60), Math.max(1, Math.min(999, parseInt(item.quantity, 10) || 1)), Math.max(0, parseFloat(item.price) || 0)]
      );
    }
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

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`Celestial Good server running at http://localhost:${PORT} (${DB_DRIVER} mode)`);
    console.log(`Admin panel at http://localhost:${PORT}/admin`);
  });
}

export default app;
