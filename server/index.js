import express from 'express';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import { db, initDatabase } from './config/db.js';
import { supabase } from './config/supabase.js';
import cors from 'cors';
import multer from 'multer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
// "0" (or empty) PORT strings are truthy but not a usable port — fall back.
const PORT = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 5050;

// UPLOADS_DIR: point at a persistent volume in production (e.g. /data/uploads).
const UPLOADS_DIR = process.env.UPLOADS_DIR
  ? resolve(process.env.UPLOADS_DIR)
  : join(__dirname, '..', 'public', 'uploads');
mkdirSync(UPLOADS_DIR, { recursive: true });
app.use('/uploads', express.static(UPLOADS_DIR));

initDatabase();

app.use(cors({ origin: false, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.get('/admin', (req, res) => { res.sendFile(join(__dirname, '..', 'public', 'admin', 'index.html')); });
app.use(express.static(join(__dirname, '..', 'public'), { maxAge: '1d' }));

const sessions = {};

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
    } catch (e) {}
  }
  next();
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

// Auth
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  const { data, error } = await supabase.auth.signInWithPassword({ email: username, password });
  if (error || !data.session) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = data.session.access_token;
  const encoded = Buffer.from(token).toString('base64');
  res.cookie('session', encoded, { httpOnly: true, maxAge: 86400000 });
  res.json({ success: true, user: { email: data.user.email } });
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
  const token = Buffer.from(match[1], 'base64').toString();
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return res.status(401).json({ loggedIn: false });
  res.json({ loggedIn: true, user: { email: data.user.email } });
});

// Site Settings
app.get('/api/settings', (req, res) => {
  const settings = db.prepare('SELECT * FROM site_settings WHERE id = 1').get();
  res.json(settings);
});

app.put('/api/settings', (req, res) => {
  const { hero_title, hero_subtitle, hero_description, announcement_text, whatsapp_number, email, footer_description, copyright_text } = req.body;
  db.prepare('UPDATE site_settings SET hero_title=?, hero_subtitle=?, hero_description=?, announcement_text=?, whatsapp_number=?, email=?, footer_description=?, copyright_text=? WHERE id=1').run(hero_title, hero_subtitle, hero_description, announcement_text, whatsapp_number, email, footer_description, copyright_text);
  res.json({ success: true });
});

// Categories
app.get('/api/categories', (req, res) => {
  const cats = db.prepare('SELECT * FROM categories WHERE active = 1 ORDER BY sort_order').all();
  res.json(cats);
});

app.post('/api/categories', (req, res) => {
  const { name, slug, icon, description } = req.body;
  try { db.prepare('INSERT INTO categories (name, slug, icon, description) VALUES (?, ?, ?, ?)').run(name, slug, icon || '📦', description || ''); res.json({ success: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/categories/:id', (req, res) => {
  const { name, slug, icon, description, sort_order } = req.body;
  db.prepare('UPDATE categories SET name=?, slug=?, icon=?, description=?, sort_order=? WHERE id=?').run(name, slug, icon, description, sort_order, req.params.id);
  res.json({ success: true });
});

app.delete('/api/categories/:id', (req, res) => {
  db.prepare('UPDATE categories SET active=0 WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// Products
app.get('/api/products', (req, res) => {
  const { category, search, sort, featured } = req.query;
  let query = 'SELECT p.*, c.name as category_name, c.slug as category_slug FROM products p LEFT JOIN categories c ON p.category_id = c.id WHERE p.active = 1 AND p.is_archived = 0';
  const params = [];
  if (category && category !== 'all') { query += ' AND (c.slug = ? OR c.id = ?)'; params.push(category, category); }
  if (search) { query += ' AND (p.name LIKE ? OR p.description LIKE ? OR p.short_desc LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  if (featured === '1' || featured === 'true') { query += ' AND p.is_featured = 1'; }
  if (sort === 'price-asc') query += ' ORDER BY p.price ASC';
  else if (sort === 'price-desc') query += ' ORDER BY p.price DESC';
  else if (sort === 'name') query += ' ORDER BY p.name ASC';
  else query += ' ORDER BY p.is_featured DESC, p.sort_order ASC, p.id DESC';
  const products = db.prepare(query).all(...params);
  const formatted = products.map(p => {
    let variants = [];
    try { variants = p.variants ? JSON.parse(p.variants) : []; } catch (e) { variants = []; }
    return { ...p, variants };
  });
  res.json(formatted);
});

app.get('/api/products/:id', (req, res) => {
  const product = db.prepare('SELECT p.*, c.name as category_name FROM products p LEFT JOIN categories c ON p.category_id = c.id WHERE p.id = ? AND p.active = 1').get(req.params.id);
  if (product) {
    try { product.variants = product.variants ? JSON.parse(product.variants) : []; } catch (e) { product.variants = []; }
    res.json(product);
  } else res.status(404).json({ error: 'Not found' });
});

app.post('/api/products', upload.single('image'), (req, res) => {
  const { name, slug, description, short_desc, price, mrp, category_id, badge, featured, variants } = req.body;
  const imageUrl = req.file ? `/uploads/${req.file.filename}` : '';
  try {
    db.prepare('INSERT INTO products (name, slug, description, short_desc, price, mrp, category_id, image_url, badge, is_featured, variants) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(name, slug, description, short_desc, price, mrp, category_id, imageUrl, badge, featured ? 1 : 0, variants);
    res.json({ success: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.put('/api/products/:id', upload.single('image'), (req, res) => {
  const { name, slug, description, short_desc, price, mrp, category_id, badge, featured, variants } = req.body;
  const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;
  if (imageUrl) {
    db.prepare('UPDATE products SET name=?, slug=?, description=?, short_desc=?, price=?, mrp=?, category_id=?, image_url=?, badge=?, is_featured=?, variants=? WHERE id=?').run(name, slug, description, short_desc, price, mrp, category_id, imageUrl, badge, featured ? 1 : 0, variants, req.params.id);
  } else {
    db.prepare('UPDATE products SET name=?, slug=?, description=?, short_desc=?, price=?, mrp=?, category_id=?, badge=?, is_featured=?, variants=? WHERE id=?').run(name, slug, description, short_desc, price, mrp, category_id, badge, featured ? 1 : 0, variants, req.params.id);
  }
  res.json({ success: true });
});

app.delete('/api/products/:id', (req, res) => {
  db.prepare('UPDATE products SET active=0 WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// Billboards / Banners
app.get(['/api/banners', '/api/billboards'], (req, res) => {
  const banners = db.prepare('SELECT * FROM billboards WHERE active = 1 ORDER BY sort_order ASC, id ASC').all();
  res.json(banners);
});

// Orders (Storefront Checkout)
app.post('/api/orders', (req, res) => {
  const { customer_name, phone, address, items, total_price } = req.body;
  const r = db.prepare(`
    INSERT INTO orders (customer_name, phone, address, total_price, is_paid, status)
    VALUES (?, ?, ?, ?, 0, 'pending')
  `).run(customer_name || 'Customer', phone || '', address || '', parseFloat(total_price) || 0);

  const orderId = r.lastInsertRowid;
  if (Array.isArray(items)) {
    const insertItem = db.prepare(`
      INSERT INTO order_items (order_id, product_id, product_name, weight, quantity, price)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    for (const item of items) {
      insertItem.run(orderId, item.product_id || null, item.name || '', item.weight || '', item.quantity || 1, item.price || 0);
    }
  }

  res.json({ success: true, orderId, message: 'Order created successfully.' });
});

app.post('/api/banners', upload.single('image'), (req, res) => {
  const { heading, badge, subtitle, link, sort_order } = req.body;
  const imageUrl = req.file ? `/uploads/${req.file.filename}` : '';
  db.prepare('INSERT INTO banners (image_url, heading, badge, subtitle, link, sort_order) VALUES (?, ?, ?, ?, ?, ?)').run(imageUrl, heading, badge, subtitle, link, sort_order || 0);
  res.json({ success: true });
});

app.put('/api/banners/:id', upload.single('image'), (req, res) => {
  const { heading, badge, subtitle, link, sort_order } = req.body;
  const imageUrl = req.file ? `/uploads/${req.file.filename}` : null;
  if (imageUrl) { db.prepare('UPDATE banners SET image_url=?, heading=?, badge=?, subtitle=?, link=?, sort_order=? WHERE id=?').run(imageUrl, heading, badge, subtitle, link, sort_order, req.params.id); }
  else { db.prepare('UPDATE banners SET heading=?, badge=?, subtitle=?, link=?, sort_order=? WHERE id=?').run(heading, badge, subtitle, link, sort_order, req.params.id); }
  res.json({ success: true });
});

app.delete('/api/banners/:id', (req, res) => {
  db.prepare('UPDATE banners SET active=0 WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// Testimonials
app.get('/api/testimonials', (req, res) => {
  const testimonials = db.prepare('SELECT * FROM testimonials WHERE active = 1 ORDER BY sort_order').all();
  res.json(testimonials);
});

app.post('/api/testimonials', (req, res) => {
  const { name, location, text, avatar } = req.body;
  db.prepare('INSERT INTO testimonials (name, location, text, avatar) VALUES (?, ?, ?, ?)').run(name, location, text, avatar || '');
  res.json({ success: true });
});

app.put('/api/testimonials/:id', (req, res) => {
  const { name, location, text, avatar } = req.body;
  db.prepare('UPDATE testimonials SET name=?, location=?, text=?, avatar=? WHERE id=?').run(name, location, text, avatar, req.params.id);
  res.json({ success: true });
});

app.delete('/api/testimonials/:id', (req, res) => {
  db.prepare('UPDATE testimonials SET active=0 WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// FAQ
app.get('/api/faq', (req, res) => {
  const faq = db.prepare('SELECT * FROM faq WHERE active = 1 ORDER BY sort_order').all();
  res.json(faq);
});

app.post('/api/faq', (req, res) => {
  const { question, answer } = req.body;
  db.prepare('INSERT INTO faq (question, answer) VALUES (?, ?)').run(question, answer);
  res.json({ success: true });
});

app.put('/api/faq/:id', (req, res) => {
  const { question, answer } = req.body;
  db.prepare('UPDATE faq SET question=?, answer=? WHERE id=?').run(question, answer, req.params.id);
  res.json({ success: true });
});

app.delete('/api/faq/:id', (req, res) => {
  db.prepare('UPDATE faq SET active=0 WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

app.get('/', (req, res) => { res.sendFile(join(__dirname, '..', 'public', 'index.html')); });
app.get('/shop', (req, res) => { res.sendFile(join(__dirname, '..', 'public', 'shop.html')); });

app.use((req, res) => {
  res.status(404).sendFile(join(__dirname, '..', 'public', '404.html'));
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`Celestial Good server running at http://localhost:${PORT}`);
    console.log(`Admin panel at http://localhost:${PORT}/admin`);
  });
}

export default app;
