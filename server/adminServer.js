import express from 'express';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import cors from 'cors';
import multer from 'multer';
import { existsSync, mkdirSync } from 'fs';
import { db, initDatabase } from './config/db.js';
import { hashPassword, verifyPassword } from './middleware/auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.ADMIN_PORT || 5050;

// Initialize DB schema
initDatabase();

// Ensure uploads folder exists
const uploadsDir = join(__dirname, '..', 'public', 'uploads');
if (!existsSync(uploadsDir)) {
  mkdirSync(uploadsDir, { recursive: true });
}

// Multer Storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = file.originalname.split('.').pop();
    const cleanName = file.originalname.replace(/[^a-zA-Z0-9]/g, '_');
    cb(null, `${Date.now()}-${cleanName}.${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// Middleware
app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve uploaded images and static assets
app.use('/uploads', express.static(uploadsDir));
app.use('/assets', express.static(join(__dirname, '..', 'dist', 'assets')));

// Cookie-based session decoder
app.use((req, res, next) => {
  const cookie = req.headers.cookie;
  if (cookie) {
    try {
      const match = cookie.match(/admin_session=([^;]+)/);
      if (match) {
        const decoded = Buffer.from(match[1], 'base64').toString();
        const data = JSON.parse(decoded);
        if (data && data.expiry > Date.now()) {
          req.session = data;
        }
      }
    } catch (e) {
      // invalid session cookie
    }
  }
  next();
});

// Auth Guard Middleware
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  // If requesting API, return 401
  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized. Please login.' });
  }
  // Otherwise allow for login page to render
  next();
}

// ==========================================
// AUTH ROUTES
// ==========================================
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required.' });
  }

  const user = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
  if (user && verifyPassword(password, user.password_hash)) {
    const sessionData = {
      userId: user.id,
      username: user.username,
      expiry: Date.now() + 7 * 24 * 60 * 60 * 1000 // 7 days
    };
    const encoded = Buffer.from(JSON.stringify(sessionData)).toString('base64');
    res.setHeader('Set-Cookie', `admin_session=${encoded}; Path=/; HttpOnly; Max-Age=${7 * 24 * 60 * 60}; SameSite=Lax`);
    return res.json({ success: true, user: { username: user.username } });
  }

  return res.status(401).json({ error: 'Invalid username or password.' });
});

app.post('/api/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'admin_session=; Path=/; HttpOnly; Max-Age=0');
  res.json({ success: true });
});

app.get('/api/admin/me', (req, res) => {
  if (req.session && req.session.userId) {
    return res.json({ loggedIn: true, user: { username: req.session.username } });
  }
  res.status(401).json({ loggedIn: false });
});

app.post('/api/admin/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Both current and new password required.' });
  }
  const user = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(req.session.userId);
  if (!user || !verifyPassword(currentPassword, user.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }
  const newHash = hashPassword(newPassword);
  db.prepare('UPDATE admin_users SET password_hash = ? WHERE id = ?').run(newHash, user.id);
  res.json({ success: true, message: 'Password changed successfully.' });
});

// ==========================================
// DASHBOARD ANALYTICS
// ==========================================
app.get('/api/dashboard/stats', requireAuth, (req, res) => {
  const totalRevenue = db.prepare('SELECT COALESCE(SUM(total_price), 0) as total FROM orders WHERE is_paid = 1').get().total;
  const totalSales = db.prepare('SELECT COUNT(*) as count FROM orders').get().count;
  const paidSales = db.prepare('SELECT COUNT(*) as count FROM orders WHERE is_paid = 1').get().count;
  const stockCount = db.prepare('SELECT COUNT(*) as count FROM products WHERE active = 1 AND is_archived = 0').get().count;
  const categoriesCount = db.prepare('SELECT COUNT(*) as count FROM categories WHERE active = 1').get().count;
  const recentOrders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 5').all();

  res.json({
    totalRevenue,
    totalSales,
    paidSales,
    stockCount,
    categoriesCount,
    recentOrders
  });
});

app.get('/api/dashboard/graph', requireAuth, (req, res) => {
  const orders = db.prepare(`
    SELECT strftime('%Y-%m', created_at) as month, SUM(total_price) as revenue, COUNT(*) as orders
    FROM orders
    GROUP BY strftime('%Y-%m', created_at)
    ORDER BY month ASC
    LIMIT 12
  `).all();

  // If no monthly history, provide sample graph data
  if (orders.length === 0) {
    return res.json([
      { name: 'May', total: 4200 },
      { name: 'Jun', total: 6800 },
      { name: 'Jul', total: 9100 },
      { name: 'Aug', total: 12400 },
      { name: 'Sep', total: 15800 }
    ]);
  }

  res.json(orders.map(o => ({ name: o.month, total: o.revenue || 0, orders: o.orders })));
});

// ==========================================
// FILE UPLOAD ENDPOINT
// ==========================================
app.post('/api/upload', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded.' });
  }
  const fileUrl = `/uploads/${req.file.filename}`;
  res.json({ success: true, url: fileUrl, filename: req.file.filename });
});

// ==========================================
// PRODUCTS CRUD
// ==========================================
app.get('/api/products', (req, res) => {
  const { category, search, sort, includeArchived } = req.query;
  let query = `
    SELECT p.*, c.name as category_name, c.slug as category_slug,
           s.name as size_name, cl.name as color_name, cl.hex as color_hex
    FROM products p
    LEFT JOIN categories c ON p.category_id = c.id
    LEFT JOIN sizes s ON p.size_id = s.id
    LEFT JOIN colors cl ON p.color_id = cl.id
    WHERE p.active = 1
  `;
  const params = [];

  if (!includeArchived) {
    query += ' AND p.is_archived = 0';
  }
  if (category && category !== 'all') {
    query += ' AND (c.slug = ? OR c.id = ?)';
    params.push(category, category);
  }
  if (search) {
    query += ' AND (p.name LIKE ? OR p.description LIKE ? OR p.short_desc LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  if (sort === 'price-asc') query += ' ORDER BY p.price ASC';
  else if (sort === 'price-desc') query += ' ORDER BY p.price DESC';
  else if (sort === 'name') query += ' ORDER BY p.name ASC';
  else query += ' ORDER BY p.is_featured DESC, p.sort_order ASC, p.id DESC';

  const products = db.prepare(query).all(...params);

  // Parse variants JSON safely
  const formatted = products.map(p => {
    let variants = [];
    try {
      variants = p.variants ? JSON.parse(p.variants) : [];
    } catch (e) {
      variants = [];
    }
    return { ...p, variants };
  });

  res.json(formatted);
});

app.get('/api/products/:id', (req, res) => {
  const product = db.prepare(`
    SELECT p.*, c.name as category_name, s.name as size_name, cl.name as color_name
    FROM products p
    LEFT JOIN categories c ON p.category_id = c.id
    LEFT JOIN sizes s ON p.size_id = s.id
    LEFT JOIN colors cl ON p.color_id = cl.id
    WHERE p.id = ? AND p.active = 1
  `).get(req.params.id);

  if (!product) {
    return res.status(404).json({ error: 'Product not found.' });
  }

  try {
    product.variants = product.variants ? JSON.parse(product.variants) : [];
  } catch (e) {
    product.variants = [];
  }

  // Get additional images
  product.images = db.prepare('SELECT * FROM images WHERE product_id = ?').all(product.id);

  res.json(product);
});

app.post('/api/products', requireAuth, upload.single('image'), (req, res) => {
  try {
    const {
      name,
      slug,
      description,
      short_desc,
      price,
      mrp,
      category_id,
      size_id,
      color_id,
      badge,
      is_featured,
      is_archived,
      variants,
      image_url,
      sort_order
    } = req.body;

    if (!name || !price) {
      return res.status(400).json({ error: 'Name and price are required.' });
    }

    const cleanSlug = (slug || name)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') + '-' + Math.floor(Math.random() * 1000);

    const finalImage = req.file ? `/uploads/${req.file.filename}` : (image_url || '');

    const insert = db.prepare(`
      INSERT INTO products (
        name, slug, description, short_desc, price, mrp, category_id, size_id, color_id,
        image_url, badge, is_featured, is_archived, variants, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = insert.run(
      name,
      cleanSlug,
      description || '',
      short_desc || '',
      parseFloat(price) || 0,
      parseFloat(mrp) || parseFloat(price) || 0,
      category_id ? parseInt(category_id) : null,
      size_id ? parseInt(size_id) : null,
      color_id ? parseInt(color_id) : null,
      finalImage,
      badge || '',
      is_featured === '1' || is_featured === true || is_featured === 1 ? 1 : 0,
      is_archived === '1' || is_archived === true || is_archived === 1 ? 1 : 0,
      typeof variants === 'string' ? variants : JSON.stringify(variants || []),
      parseInt(sort_order) || 0
    );

    res.json({ success: true, id: result.lastInsertRowid, message: 'Product created successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/products/:id', requireAuth, upload.single('image'), (req, res) => {
  try {
    const id = req.params.id;
    const {
      name,
      slug,
      description,
      short_desc,
      price,
      mrp,
      category_id,
      size_id,
      color_id,
      badge,
      is_featured,
      is_archived,
      variants,
      image_url,
      sort_order
    } = req.body;

    let finalImage = req.file ? `/uploads/${req.file.filename}` : undefined;
    if (!finalImage && image_url !== undefined) {
      finalImage = image_url;
    }

    const current = db.prepare('SELECT * FROM products WHERE id = ?').get(id);
    if (!current) {
      return res.status(404).json({ error: 'Product not found.' });
    }

    const imgToSave = finalImage !== undefined ? finalImage : current.image_url;

    db.prepare(`
      UPDATE products SET
        name = ?,
        slug = COALESCE(?, slug),
        description = ?,
        short_desc = ?,
        price = ?,
        mrp = ?,
        category_id = ?,
        size_id = ?,
        color_id = ?,
        image_url = ?,
        badge = ?,
        is_featured = ?,
        is_archived = ?,
        variants = ?,
        sort_order = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      name || current.name,
      slug || current.slug,
      description !== undefined ? description : current.description,
      short_desc !== undefined ? short_desc : current.short_desc,
      price !== undefined ? parseFloat(price) : current.price,
      mrp !== undefined ? parseFloat(mrp) : current.mrp,
      category_id !== undefined ? (category_id ? parseInt(category_id) : null) : current.category_id,
      size_id !== undefined ? (size_id ? parseInt(size_id) : null) : current.size_id,
      color_id !== undefined ? (color_id ? parseInt(color_id) : null) : current.color_id,
      imgToSave,
      badge !== undefined ? badge : current.badge,
      is_featured !== undefined ? (is_featured === '1' || is_featured === true || is_featured === 1 ? 1 : 0) : current.is_featured,
      is_archived !== undefined ? (is_archived === '1' || is_archived === true || is_archived === 1 ? 1 : 0) : current.is_archived,
      variants !== undefined ? (typeof variants === 'string' ? variants : JSON.stringify(variants)) : current.variants,
      sort_order !== undefined ? parseInt(sort_order) : current.sort_order,
      id
    );

    res.json({ success: true, message: 'Product updated successfully.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/products/:id', requireAuth, (req, res) => {
  db.prepare('UPDATE products SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ success: true, message: 'Product deleted.' });
});

app.post('/api/products/:id/toggle-featured', requireAuth, (req, res) => {
  const current = db.prepare('SELECT is_featured FROM products WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'Not found' });
  const newVal = current.is_featured ? 0 : 1;
  db.prepare('UPDATE products SET is_featured = ? WHERE id = ?').run(newVal, req.params.id);
  res.json({ success: true, is_featured: newVal });
});

app.post('/api/products/:id/toggle-archived', requireAuth, (req, res) => {
  const current = db.prepare('SELECT is_archived FROM products WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'Not found' });
  const newVal = current.is_archived ? 0 : 1;
  db.prepare('UPDATE products SET is_archived = ? WHERE id = ?').run(newVal, req.params.id);
  res.json({ success: true, is_archived: newVal });
});

// ==========================================
// ADVERTISEMENTS / BILLBOARDS CRUD
// ==========================================
app.get('/api/billboards', (req, res) => {
  const billboards = db.prepare('SELECT * FROM billboards WHERE active = 1 ORDER BY sort_order ASC, id ASC').all();
  res.json(billboards);
});

app.post('/api/billboards', requireAuth, upload.single('image'), (req, res) => {
  const { label, heading, badge, subtitle, link, sort_order, image_url } = req.body;
  const finalImage = req.file ? `/uploads/${req.file.filename}` : (image_url || '');

  const result = db.prepare(`
    INSERT INTO billboards (label, image_url, heading, badge, subtitle, link, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    label || heading || 'Ad Banner',
    finalImage,
    heading || '',
    badge || '🔥 Special',
    subtitle || '',
    link || '/shop.html',
    parseInt(sort_order) || 0
  );

  res.json({ success: true, id: result.lastInsertRowid, message: 'Advertisement banner created.' });
});

app.put('/api/billboards/:id', requireAuth, upload.single('image'), (req, res) => {
  const id = req.params.id;
  const { label, heading, badge, subtitle, link, sort_order, image_url, active } = req.body;
  const current = db.prepare('SELECT * FROM billboards WHERE id = ?').get(id);
  if (!current) return res.status(404).json({ error: 'Billboard not found' });

  const finalImage = req.file ? `/uploads/${req.file.filename}` : (image_url !== undefined ? image_url : current.image_url);

  db.prepare(`
    UPDATE billboards SET
      label = ?,
      image_url = ?,
      heading = ?,
      badge = ?,
      subtitle = ?,
      link = ?,
      sort_order = ?,
      active = ?
    WHERE id = ?
  `).run(
    label !== undefined ? label : current.label,
    finalImage,
    heading !== undefined ? heading : current.heading,
    badge !== undefined ? badge : current.badge,
    subtitle !== undefined ? subtitle : current.subtitle,
    link !== undefined ? link : current.link,
    sort_order !== undefined ? parseInt(sort_order) : current.sort_order,
    active !== undefined ? (active === '1' || active === true || active === 1 ? 1 : 0) : current.active,
    id
  );

  res.json({ success: true, message: 'Advertisement banner updated.' });
});

app.delete('/api/billboards/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM billboards WHERE id = ?').run(req.params.id);
  res.json({ success: true, message: 'Banner removed.' });
});

// ==========================================
// CATEGORIES CRUD
// ==========================================
app.get('/api/categories', (req, res) => {
  const cats = db.prepare(`
    SELECT c.*, b.label as billboard_label
    FROM categories c
    LEFT JOIN billboards b ON c.billboard_id = b.id
    WHERE c.active = 1
    ORDER BY c.sort_order ASC, c.id ASC
  `).all();
  res.json(cats);
});

app.post('/api/categories', requireAuth, (req, res) => {
  const { name, slug, icon, description, billboard_id, sort_order } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  const cleanSlug = (slug || name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  const result = db.prepare(`
    INSERT INTO categories (name, slug, icon, description, billboard_id, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    name,
    cleanSlug,
    icon || '📦',
    description || '',
    billboard_id ? parseInt(billboard_id) : null,
    parseInt(sort_order) || 0
  );

  res.json({ success: true, id: result.lastInsertRowid, message: 'Category added.' });
});

app.put('/api/categories/:id', requireAuth, (req, res) => {
  const id = req.params.id;
  const { name, slug, icon, description, billboard_id, sort_order } = req.body;
  const current = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
  if (!current) return res.status(404).json({ error: 'Category not found' });

  db.prepare(`
    UPDATE categories SET
      name = COALESCE(?, name),
      slug = COALESCE(?, slug),
      icon = COALESCE(?, icon),
      description = COALESCE(?, description),
      billboard_id = ?,
      sort_order = COALESCE(?, sort_order)
    WHERE id = ?
  `).run(
    name,
    slug,
    icon,
    description,
    billboard_id !== undefined ? (billboard_id ? parseInt(billboard_id) : null) : current.billboard_id,
    sort_order !== undefined ? parseInt(sort_order) : current.sort_order,
    id
  );

  res.json({ success: true, message: 'Category updated.' });
});

app.delete('/api/categories/:id', requireAuth, (req, res) => {
  db.prepare('UPDATE categories SET active = 0 WHERE id = ?').run(req.params.id);
  res.json({ success: true, message: 'Category deleted.' });
});

// ==========================================
// SIZES & COLORS CRUD
// ==========================================
app.get('/api/sizes', (req, res) => {
  res.json(db.prepare('SELECT * FROM sizes ORDER BY id ASC').all());
});

app.post('/api/sizes', requireAuth, (req, res) => {
  const { name, value } = req.body;
  const r = db.prepare('INSERT INTO sizes (name, value) VALUES (?, ?)').run(name, value);
  res.json({ success: true, id: r.lastInsertRowid });
});

app.delete('/api/sizes/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM sizes WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/colors', (req, res) => {
  res.json(db.prepare('SELECT * FROM colors ORDER BY id ASC').all());
});

app.post('/api/colors', requireAuth, (req, res) => {
  const { name, value, hex } = req.body;
  const r = db.prepare('INSERT INTO colors (name, value, hex) VALUES (?, ?, ?)').run(name, value, hex || '#C4943D');
  res.json({ success: true, id: r.lastInsertRowid });
});

app.delete('/api/colors/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM colors WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ==========================================
// ORDERS CRUD
// ==========================================
app.get('/api/orders', requireAuth, (req, res) => {
  const orders = db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
  const withItems = orders.map(o => {
    const items = db.prepare('SELECT * FROM order_items WHERE order_id = ?').all(o.id);
    return { ...o, items };
  });
  res.json(withItems);
});

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

  res.json({ success: true, orderId, message: 'Order created.' });
});

app.put('/api/orders/:id/status', requireAuth, (req, res) => {
  const { status, is_paid } = req.body;
  if (status !== undefined) {
    db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(status, req.params.id);
  }
  if (is_paid !== undefined) {
    db.prepare('UPDATE orders SET is_paid = ? WHERE id = ?').run(is_paid ? 1 : 0, req.params.id);
  }
  res.json({ success: true, message: 'Order updated.' });
});

app.delete('/api/orders/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM order_items WHERE order_id = ?').run(req.params.id);
  db.prepare('DELETE FROM orders WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ==========================================
// SITE SETTINGS
// ==========================================
app.get('/api/settings', (req, res) => {
  const s = db.prepare('SELECT * FROM site_settings WHERE id = 1').get() || {};
  res.json(s);
});

app.put('/api/settings', requireAuth, (req, res) => {
  const {
    hero_title,
    hero_subtitle,
    hero_description,
    announcement_text,
    whatsapp_number,
    email,
    footer_description,
    copyright_text
  } = req.body;

  db.prepare(`
    UPDATE site_settings SET
      hero_title = ?,
      hero_subtitle = ?,
      hero_description = ?,
      announcement_text = ?,
      whatsapp_number = ?,
      email = ?,
      footer_description = ?,
      copyright_text = ?
    WHERE id = 1
  `).run(
    hero_title,
    hero_subtitle,
    hero_description,
    announcement_text,
    whatsapp_number,
    email,
    footer_description,
    copyright_text
  );

  res.json({ success: true, message: 'Settings saved.' });
});

// ==========================================
// TESTIMONIALS & FAQ
// ==========================================
app.get('/api/testimonials', (req, res) => {
  res.json(db.prepare('SELECT * FROM testimonials WHERE active = 1 ORDER BY sort_order ASC, id ASC').all());
});

app.post('/api/testimonials', requireAuth, (req, res) => {
  const { name, location, text, avatar, rating, sort_order } = req.body;
  const r = db.prepare('INSERT INTO testimonials (name, location, text, avatar, rating, sort_order) VALUES (?, ?, ?, ?, ?, ?)').run(
    name, location || '', text, avatar || name.charAt(0).toUpperCase(), parseInt(rating) || 5, parseInt(sort_order) || 0
  );
  res.json({ success: true, id: r.lastInsertRowid });
});

app.put('/api/testimonials/:id', requireAuth, (req, res) => {
  const { name, location, text, avatar, rating, sort_order } = req.body;
  const current = db.prepare('SELECT * FROM testimonials WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'Testimonial not found' });

  db.prepare('UPDATE testimonials SET name = ?, location = ?, text = ?, avatar = ?, rating = ?, sort_order = ? WHERE id = ?').run(
    name !== undefined ? name : current.name,
    location !== undefined ? location : current.location,
    text !== undefined ? text : current.text,
    avatar !== undefined ? avatar : current.avatar,
    rating !== undefined ? (parseInt(rating) || current.rating) : current.rating,
    sort_order !== undefined ? (parseInt(sort_order) || 0) : current.sort_order,
    req.params.id
  );
  res.json({ success: true });
});

app.delete('/api/testimonials/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM testimonials WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/faq', (req, res) => {
  res.json(db.prepare('SELECT * FROM faq WHERE active = 1 ORDER BY sort_order ASC, id ASC').all());
});

app.post('/api/faq', requireAuth, (req, res) => {
  const { question, answer, sort_order } = req.body;
  const r = db.prepare('INSERT INTO faq (question, answer, sort_order) VALUES (?, ?, ?)').run(
    question, answer, parseInt(sort_order) || 0
  );
  res.json({ success: true, id: r.lastInsertRowid });
});

app.put('/api/faq/:id', requireAuth, (req, res) => {
  const { question, answer, sort_order } = req.body;
  const current = db.prepare('SELECT * FROM faq WHERE id = ?').get(req.params.id);
  if (!current) return res.status(404).json({ error: 'FAQ item not found' });

  db.prepare('UPDATE faq SET question = ?, answer = ?, sort_order = ? WHERE id = ?').run(
    question !== undefined ? question : current.question,
    answer !== undefined ? answer : current.answer,
    sort_order !== undefined ? (parseInt(sort_order) || 0) : current.sort_order,
    req.params.id
  );
  res.json({ success: true });
});

app.delete('/api/faq/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM faq WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ==========================================
// SERVE ADMIN DASHBOARD UI
// ==========================================
app.get(['/', '/admin', '/admin/*'], (req, res) => {
  res.sendFile(join(__dirname, 'views', 'admin.html'));
});

// Start Admin Server
app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🛡️  Celestial Good — ADMIN SERVER RUNNING`);
  console.log(`📍 URL: http://localhost:${PORT}`);
  console.log(`🔑 Login: admin / admin`);
  console.log(`=======================================================`);
});
