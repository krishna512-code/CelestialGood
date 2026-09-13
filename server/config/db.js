import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));

// Dual-driver data layer:
//  - DATABASE_URL set  → Postgres (Supabase) — used in production (Vercel Functions)
//  - otherwise         → local SQLite — used for local dev and tests (zero setup)
export const DB_DRIVER = process.env.DATABASE_URL ? 'postgres' : 'sqlite';

let sqlite = null;
let pool = null;

if (DB_DRIVER === 'postgres') {
  const { Pool } = await import('pg');
  const needsSsl = !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
    ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });
} else {
  // SQLITE_PATH lets hosts point the DB at a persistent volume;
  // defaults to the bundled dev DB for local use.
  const dbPath = process.env.SQLITE_PATH
    ? resolve(process.env.SQLITE_PATH)
    : join(__dirname, '..', 'celestial-goods.db');
  const d = dirname(dbPath);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });

  sqlite = new DatabaseSync(dbPath);
  try {
    sqlite.exec('PRAGMA journal_mode = WAL;');
    sqlite.exec('PRAGMA busy_timeout = 5000;');
  } catch {
    // ignore if pragmas fail
  }
}

// Translate SQLite-style placeholders/dialect to Postgres.
function toPgSql(sql) {
  let i = 0;
  const placeholders = sql.replace(/\?/g, () => `$${++i}`);
  // SQLite LIKE is case-insensitive for ASCII; Postgres LIKE is not.
  return placeholders.replace(/\bLIKE\b/g, 'ILIKE');
}

/** Run a SELECT; resolves to an array of row objects. */
export async function query(sql, params = []) {
  if (DB_DRIVER === 'postgres') {
    const r = await pool.query(toPgSql(sql), params);
    return r.rows;
  }
  return sqlite.prepare(sql).all(...params);
}

/** Run a SELECT expected to return at most one row; resolves to the row or null. */
export async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] ?? null;
}

/** Run an INSERT/UPDATE/DELETE; resolves to { changes, lastId }. */
export async function run(sql, params = []) {
  if (DB_DRIVER === 'postgres') {
    let pgSql = toPgSql(sql);
    if (/^\s*INSERT/i.test(pgSql) && !/RETURNING/i.test(pgSql)) {
      pgSql += ' RETURNING id';
    }
    const r = await pool.query(pgSql, params);
    return { changes: r.rowCount, lastId: r.rows[0]?.id ?? null };
  }
  const r = sqlite.prepare(sql).run(...params);
  return { changes: r.changes, lastId: r.lastInsertRowid };
}

// SQLite-only schema bootstrap + seeding. Postgres schema/seeding lives in
// scripts/migrate-pg.mjs (run once when provisioning Supabase).
export async function initDatabase() {
  if (DB_DRIVER === 'postgres') return;

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      icon TEXT DEFAULT '📦',
      description TEXT DEFAULT '',
      billboard_id INTEGER,
      sort_order INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sizes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS colors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      value TEXT NOT NULL,
      hex TEXT DEFAULT '#C4943D',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS billboards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT DEFAULT '',
      image_url TEXT DEFAULT '',
      heading TEXT DEFAULT '',
      badge TEXT DEFAULT '',
      subtitle TEXT DEFAULT '',
      link TEXT DEFAULT '',
      sort_order INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      short_desc TEXT DEFAULT '',
      price REAL NOT NULL DEFAULT 0,
      mrp REAL NOT NULL DEFAULT 0,
      category_id INTEGER,
      size_id INTEGER,
      color_id INTEGER,
      image_url TEXT DEFAULT '',
      badge TEXT DEFAULT '',
      is_featured INTEGER DEFAULT 0,
      is_archived INTEGER DEFAULT 0,
      variants TEXT DEFAULT '[]',
      active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (category_id) REFERENCES categories(id),
      FOREIGN KEY (size_id) REFERENCES sizes(id),
      FOREIGN KEY (color_id) REFERENCES colors(id)
    );

    CREATE TABLE IF NOT EXISTS images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL,
      url TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_name TEXT DEFAULT '',
      phone TEXT DEFAULT '',
      address TEXT DEFAULT '',
      total_price REAL DEFAULT 0,
      is_paid INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL,
      product_id INTEGER,
      product_name TEXT DEFAULT '',
      weight TEXT DEFAULT '',
      quantity INTEGER DEFAULT 1,
      price REAL DEFAULT 0,
      FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS testimonials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      location TEXT DEFAULT '',
      text TEXT NOT NULL,
      avatar TEXT DEFAULT '',
      rating INTEGER DEFAULT 5,
      active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS faq (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question TEXT NOT NULL,
      answer TEXT NOT NULL,
      active INTEGER DEFAULT 1,
      sort_order INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS site_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hero_title TEXT,
      hero_subtitle TEXT,
      hero_description TEXT,
      announcement_text TEXT,
      whatsapp_number TEXT,
      email TEXT,
      footer_description TEXT,
      copyright_text TEXT
    );

    CREATE TABLE IF NOT EXISTS admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT DEFAULT 'admin',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Migration for DBs created before the role column existed
  try { sqlite.exec("ALTER TABLE admin_users ADD COLUMN role TEXT DEFAULT 'admin'"); } catch {}

  // Optional Owner Bootstrap via environment variables
  if (process.env.OWNER_USERNAME && process.env.OWNER_PASSWORD) {
    const existing = sqlite.prepare('SELECT id FROM admin_users WHERE username = ?').get(process.env.OWNER_USERNAME);
    if (!existing) {
      const { hashPassword } = await import('../middleware/auth.js');
      sqlite.prepare('INSERT INTO admin_users (username, password_hash, role) VALUES (?, ?, ?)')
        .run(process.env.OWNER_USERNAME, hashPassword(process.env.OWNER_PASSWORD), 'owner');
    }
  }

  // Seeding — only when the relevant tables are empty (idempotent across restarts)
  const { settingsDefaults, categories, sizes, colors, billboards, products, testimonials, faqs, sampleOrders } = await import('./seedData.js');
  const seedIfEmpty = (table, sql, rows) => {
    const { c } = sqlite.prepare(`SELECT COUNT(*) as c FROM ${table}`).get();
    if (c > 0) return;
    const stmt = sqlite.prepare(sql);
    for (const row of rows) stmt.run(...row);
  };

  seedIfEmpty('site_settings',
    'INSERT OR IGNORE INTO site_settings (id, hero_title, hero_subtitle, hero_description, announcement_text, whatsapp_number, email, footer_description, copyright_text) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)',
    [[settingsDefaults.hero_title, settingsDefaults.hero_subtitle, settingsDefaults.hero_description, settingsDefaults.announcement_text, settingsDefaults.whatsapp_number, settingsDefaults.email, settingsDefaults.footer_description, settingsDefaults.copyright_text]]);

  seedIfEmpty('categories',
    'INSERT INTO categories (id, name, slug, icon, description, sort_order) VALUES (?, ?, ?, ?, ?, ?)',
    categories.map(c => [c.id, c.name, c.slug, c.icon, c.description, c.sort_order]));

  seedIfEmpty('sizes',
    'INSERT INTO sizes (id, name, value) VALUES (?, ?, ?)',
    sizes.map(s => [s.id, s.name, s.value]));

  seedIfEmpty('colors',
    'INSERT INTO colors (id, name, value, hex) VALUES (?, ?, ?, ?)',
    colors.map(c => [c.id, c.name, c.value, c.hex]));

  seedIfEmpty('billboards',
    'INSERT INTO billboards (id, label, image_url, heading, badge, subtitle, link, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    billboards.map(b => [b.id, b.label, b.image_url, b.heading, b.badge, b.subtitle, b.link, b.sort_order]));

  seedIfEmpty('products',
    `INSERT INTO products (id, name, slug, description, short_desc, price, mrp, category_id, image_url, badge, is_featured, is_archived, variants, sort_order)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    products.map(p => [p.id, p.name, p.slug, p.description, p.short_desc, p.price, p.mrp, p.category_id, p.image_url, p.badge, p.is_featured, p.variants, p.sort_order]));

  seedIfEmpty('testimonials',
    'INSERT INTO testimonials (id, name, location, text, avatar, rating, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
    testimonials.map(t => [t.id, t.name, t.location, t.text, t.avatar, t.rating, t.sort_order]));

  seedIfEmpty('faq',
    'INSERT INTO faq (id, question, answer, sort_order) VALUES (?, ?, ?, ?)',
    faqs.map(f => [f.id, f.question, f.answer, f.sort_order]));

  seedIfEmpty('orders',
    `INSERT INTO orders (id, customer_name, phone, address, total_price, is_paid, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    sampleOrders.map(o => [o.id, o.customer_name, o.phone, o.address, o.total_price, o.is_paid, o.status, o.created_at]));

  const { c: itemCount } = sqlite.prepare('SELECT COUNT(*) as c FROM order_items').get();
  if (itemCount === 0) {
    const insertItem = sqlite.prepare('INSERT INTO order_items (order_id, product_id, product_name, weight, quantity, price) VALUES (?, ?, ?, ?, ?, ?)');
    for (const o of sampleOrders) {
      for (const it of o.items) insertItem.run(o.id, it.product_id, it.product_name, it.weight, it.quantity, it.price);
    }
  }
}

export default { DB_DRIVER, query, queryOne, run, initDatabase };
