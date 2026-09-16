#!/usr/bin/env node
// Generates scripts/supabase-setup.sql from server/config/seedData.js so the
// dashboard SQL Editor path and `npm run migrate:pg` always seed identically.
//   node scripts/gen-sql.mjs
import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  settingsDefaults, categories, sizes, colors, billboards,
  products, testimonials, faqs, sampleOrders,
} from '../server/config/seedData.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Dollar-quoted literal (safe for apostrophes/emoji); neutralize the tag itself.
const q = (v) => `$cb$${String(v ?? '').replaceAll('$cb$', '')}$cb$`;

const SCHEMA = `
-- ============================================================
-- Celestial Goods — Supabase setup (schema + RLS + seed + bucket)
-- Paste the WHOLE file into: Supabase Dashboard → SQL Editor → New query → Run
-- Idempotent: safe to run more than once (seeds only empty tables).
-- ============================================================

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  icon TEXT DEFAULT '📦',
  description TEXT DEFAULT '',
  billboard_id INTEGER,
  sort_order INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sizes (
  id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS colors (
  id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  name TEXT NOT NULL,
  value TEXT NOT NULL,
  hex TEXT DEFAULT '#C4943D',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS billboards (
  id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  label TEXT DEFAULT '',
  image_url TEXT DEFAULT '',
  heading TEXT DEFAULT '',
  badge TEXT DEFAULT '',
  subtitle TEXT DEFAULT '',
  link TEXT DEFAULT '',
  sort_order INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
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
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS images (
  id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  product_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  customer_name TEXT DEFAULT '',
  phone TEXT DEFAULT '',
  email TEXT DEFAULT '',
  address TEXT DEFAULT '',
  landmark TEXT DEFAULT '',
  city TEXT DEFAULT '',
  state TEXT DEFAULT '',
  pincode TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  latitude REAL,
  longitude REAL,
  map_link TEXT DEFAULT '',
  payment_method TEXT DEFAULT 'cod',
  total_price REAL DEFAULT 0,
  is_paid INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  order_id INTEGER NOT NULL,
  product_id INTEGER,
  product_name TEXT DEFAULT '',
  weight TEXT DEFAULT '',
  quantity INTEGER DEFAULT 1,
  price REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS testimonials (
  id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  name TEXT NOT NULL,
  location TEXT DEFAULT '',
  text TEXT NOT NULL,
  avatar TEXT DEFAULT '',
  rating INTEGER DEFAULT 5,
  active INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS faq (
  id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  active INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS site_settings (
  id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
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
  id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT DEFAULT 'admin',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_products_active ON products(active, is_archived);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

-- ============================================================
-- Row Level Security: the Vercel function connects as the table
-- owner (bypasses RLS); anon keys get nothing on these tables.
-- ============================================================
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['categories','sizes','colors','billboards','products',
                           'images','orders','order_items','testimonials','faq',
                           'site_settings','admin_users']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- ============================================================
-- Storage: public product-images bucket + public read policy
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('product-images', 'product-images', true, 10485760)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "public read product images" ON storage.objects;
CREATE POLICY "public read product images" ON storage.objects
  FOR SELECT TO anon, authenticated
  USING (bucket_id = 'product-images');
`;

const seedBlocks = [];
const seedIfEmpty = (table, cols, rows) => {
  if (rows.length === 0) return;
  const values = rows
    .map(r => `(${r.map(v => (typeof v === 'number' ? v : q(v))).join(', ')})`)
    .join(',\n  ');
  seedBlocks.push(`INSERT INTO ${table} (${cols.join(', ')})
OVERRIDING SYSTEM VALUE VALUES
  ${values}
ON CONFLICT (id) DO NOTHING;`);
};

seedIfEmpty('site_settings',
  ['id', 'hero_title', 'hero_subtitle', 'hero_description', 'announcement_text', 'whatsapp_number', 'email', 'footer_description', 'copyright_text'],
  [[1, settingsDefaults.hero_title, settingsDefaults.hero_subtitle, settingsDefaults.hero_description, settingsDefaults.announcement_text, settingsDefaults.whatsapp_number, settingsDefaults.email, settingsDefaults.footer_description, settingsDefaults.copyright_text]]);

seedIfEmpty('categories',
  ['id', 'name', 'slug', 'icon', 'description', 'sort_order'],
  categories.map(c => [c.id, c.name, c.slug, c.icon, c.description, c.sort_order]));

seedIfEmpty('sizes', ['id', 'name', 'value'], sizes.map(s => [s.id, s.name, s.value]));
seedIfEmpty('colors', ['id', 'name', 'value', 'hex'], colors.map(c => [c.id, c.name, c.value, c.hex]));
seedIfEmpty('billboards',
  ['id', 'label', 'image_url', 'heading', 'badge', 'subtitle', 'link', 'sort_order'],
  billboards.map(b => [b.id, b.label, b.image_url, b.heading, b.badge, b.subtitle, b.link, b.sort_order]));

seedIfEmpty('products',
  ['id', 'name', 'slug', 'description', 'short_desc', 'price', 'mrp', 'category_id', 'image_url', 'badge', 'is_featured', 'is_archived', 'variants', 'sort_order'],
  products.map(p => [p.id, p.name, p.slug, p.description, p.short_desc, p.price, p.mrp, p.category_id, p.image_url, p.badge, p.is_featured, 0, p.variants, p.sort_order]));

seedIfEmpty('testimonials',
  ['id', 'name', 'location', 'text', 'avatar', 'rating', 'sort_order'],
  testimonials.map(t => [t.id, t.name, t.location, t.text, t.avatar, t.rating, t.sort_order]));

seedIfEmpty('faq', ['id', 'question', 'answer', 'sort_order'], faqs.map(f => [f.id, f.question, f.answer, f.sort_order]));

const orderRows = sampleOrders.map(o =>
  [o.id, o.customer_name, o.phone, o.address, o.total_price, o.is_paid, o.status, o.created_at]);
seedIfEmpty('orders',
  ['id', 'customer_name', 'phone', 'address', 'total_price', 'is_paid', 'status', 'created_at'],
  orderRows);

const itemRows = sampleOrders.flatMap(o =>
  o.items.map(it => [o.id, it.product_id, it.product_name, it.weight, it.quantity, it.price]));
// order_items has no stable natural key; guard on the parent rows above.
if (itemRows.length > 0) {
  const values = itemRows
    .map(r => `(${r.map((v, i) => (i === 0 ? `(SELECT id FROM orders WHERE id = ${r[0]})` : (typeof v === 'number' ? v : q(v)))).join(', ')})`)
    .join(',\n  ');
  seedBlocks.push(`INSERT INTO order_items (order_id, product_id, product_name, weight, quantity, price)
SELECT * FROM (
  VALUES
  ${values}
) AS v(order_id, product_id, product_name, weight, quantity, price)
WHERE NOT EXISTS (SELECT 1 FROM order_items);`);
}

const SEED_COMMENT = `
-- ============================================================
-- Seed data (runs only when tables are empty — idempotent)
-- ============================================================`;

const SEQ_FIX = `

-- ============================================================
-- Align IDENTITY sequences past the seeded ids (seeding inserts
-- explicit ids via OVERRIDING SYSTEM VALUE, which does NOT bump
-- the sequence — without this, the next insert fails with
-- "duplicate key value violates unique constraint \"<table>_pkey\"")
-- ============================================================
DO $$
DECLARE r RECORD; v_next bigint;
BEGIN
  FOR r IN
    SELECT table_name AS tbl, column_name AS col
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND (column_default LIKE 'nextval%' OR is_identity = 'YES')
  LOOP
    EXECUTE format('SELECT COALESCE(MAX(%I), 0) + 1 FROM %I', r.col, r.tbl) INTO v_next;
    PERFORM setval(pg_get_serial_sequence(r.tbl, r.col), v_next, false);
  END LOOP;
END $$;`;

writeFileSync(join(__dirname, 'supabase-setup.sql'), SCHEMA + SEED_COMMENT + '\n' + seedBlocks.join('\n\n') + SEQ_FIX + '\n');
console.log('✓ wrote scripts/supabase-setup.sql — paste it into Supabase → SQL Editor → Run');
