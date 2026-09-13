#!/usr/bin/env node
// One-time Supabase Postgres provisioning for Celestial Goods.
//
//   node scripts/migrate-pg.mjs
//
// Requires in .env:
//   DATABASE_URL                  — Supabase → Project Settings → Database → Connection string (URI, pooler mode)
//   NEXT_PUBLIC_SUPABASE_URL      — already present
//   SUPABASE_SERVICE_KEY          — service_role key (creates the public storage bucket)
//   OWNER_USERNAME / OWNER_PASSWORD (optional) — bootstraps a local-admin
//
// Idempotent: safe to re-run; seeds only empty tables.

import { readFileSync } from 'fs';
import pg from 'pg';
import dotenv from 'dotenv';
import {
  settingsDefaults, categories, sizes, colors, billboards,
  products, testimonials, faqs, sampleOrders,
} from '../server/config/seedData.js';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const SCHEMA = `
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
  address TEXT DEFAULT '',
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
`;

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set. Add it to .env first:');
    console.error('  Supabase → Project Settings → Database → Connection string → URI (use the "Pooler" string, port 6543)');
    process.exit(1);
  }

  const needsSsl = !/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 3,
    ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
  });

  console.log(`Connecting to Postgres (${needsSsl ? 'with SSL' : 'local'})...`);
  const client = await pool.connect();
  try {
    await client.query(SCHEMA);
    console.log('✓ Schema created (11 tables + indexes)');

    // RLS lockdown: the Vercel function connects with the Postgres role from the
    // connection string (service role, bypasses RLS); anon/authenticated roles
    // get nothing. Defense in depth for the public database.
    await client.query(`
      ALTER TABLE categories ENABLE ROW LEVEL SECURITY;
      ALTER TABLE sizes ENABLE ROW LEVEL SECURITY;
      ALTER TABLE colors ENABLE ROW LEVEL SECURITY;
      ALTER TABLE billboards ENABLE ROW LEVEL SECURITY;
      ALTER TABLE products ENABLE ROW LEVEL SECURITY;
      ALTER TABLE images ENABLE ROW LEVEL SECURITY;
      ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
      ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
      ALTER TABLE testimonials ENABLE ROW LEVEL SECURITY;
      ALTER TABLE faq ENABLE ROW LEVEL SECURITY;
      ALTER TABLE site_settings ENABLE ROW LEVEL SECURITY;
      ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;
      DROP POLICY IF EXISTS "service role full access" ON categories; CREATE POLICY "service role full access" ON categories FOR ALL TO service_role USING (true) WITH CHECK (true);
      DROP POLICY IF EXISTS "service role full access" ON sizes; CREATE POLICY "service role full access" ON sizes FOR ALL TO service_role USING (true) WITH CHECK (true);
      DROP POLICY IF EXISTS "service role full access" ON colors; CREATE POLICY "service role full access" ON colors FOR ALL TO service_role USING (true) WITH CHECK (true);
      DROP POLICY IF EXISTS "service role full access" ON billboards; CREATE POLICY "service role full access" ON billboards FOR ALL TO service_role USING (true) WITH CHECK (true);
      DROP POLICY IF EXISTS "service role full access" ON products; CREATE POLICY "service role full access" ON products FOR ALL TO service_role USING (true) WITH CHECK (true);
      DROP POLICY IF EXISTS "service role full access" ON images; CREATE POLICY "service role full access" ON images FOR ALL TO service_role USING (true) WITH CHECK (true);
      DROP POLICY IF EXISTS "service role full access" ON orders; CREATE POLICY "service role full access" ON orders FOR ALL TO service_role USING (true) WITH CHECK (true);
      DROP POLICY IF EXISTS "service role full access" ON order_items; CREATE POLICY "service role full access" ON order_items FOR ALL TO service_role USING (true) WITH CHECK (true);
      DROP POLICY IF EXISTS "service role full access" ON testimonials; CREATE POLICY "service role full access" ON testimonials FOR ALL TO service_role USING (true) WITH CHECK (true);
      DROP POLICY IF EXISTS "service role full access" ON faq; CREATE POLICY "service role full access" ON faq FOR ALL TO service_role USING (true) WITH CHECK (true);
      DROP POLICY IF EXISTS "service role full access" ON site_settings; CREATE POLICY "service role full access" ON site_settings FOR ALL TO service_role USING (true) WITH CHECK (true);
      DROP POLICY IF EXISTS "service role full access" ON admin_users; CREATE POLICY "service role full access" ON admin_users FOR ALL TO service_role USING (true) WITH CHECK (true);
    `);
    console.log('✓ RLS enabled (service_role policies)');

    const count = async (t) => (await client.query(`SELECT COUNT(*)::int as c FROM ${t}`)).rows[0].c;
    const seed = async (t, sql, rows) => {
      if ((await count(t)) > 0) { console.log(`  ${t}: already seeded, skipping`); return; }
      for (const row of rows) await client.query(sql, row);
      console.log(`✓ ${t}: ${rows.length} rows`);
    };

    await seed('site_settings',
      `INSERT INTO site_settings (id, hero_title, hero_subtitle, hero_description, announcement_text, whatsapp_number, email, footer_description, copyright_text)
       OVERRIDING SYSTEM VALUE VALUES (1, $1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
      [[settingsDefaults.hero_title, settingsDefaults.hero_subtitle, settingsDefaults.hero_description, settingsDefaults.announcement_text, settingsDefaults.whatsapp_number, settingsDefaults.email, settingsDefaults.footer_description, settingsDefaults.copyright_text]]);

    await seed('categories',
      `INSERT INTO categories (id,name,slug,icon,description,sort_order) OVERRIDING SYSTEM VALUE VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
      categories.map(c => [c.id, c.name, c.slug, c.icon, c.description, c.sort_order]));

    await seed('sizes',
      `INSERT INTO sizes (id,name,value) OVERRIDING SYSTEM VALUE VALUES ($1,$2,$3) ON CONFLICT (id) DO NOTHING`,
      sizes.map(s => [s.id, s.name, s.value]));

    await seed('colors',
      `INSERT INTO colors (id,name,value,hex) OVERRIDING SYSTEM VALUE VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
      colors.map(c => [c.id, c.name, c.value, c.hex]));

    await seed('billboards',
      `INSERT INTO billboards (id,label,image_url,heading,badge,subtitle,link,sort_order) OVERRIDING SYSTEM VALUE VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
      billboards.map(b => [b.id, b.label, b.image_url, b.heading, b.badge, b.subtitle, b.link, b.sort_order]));

    await seed('products',
      `INSERT INTO products (id,name,slug,description,short_desc,price,mrp,category_id,image_url,badge,is_featured,is_archived,variants,sort_order)
       OVERRIDING SYSTEM VALUE VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,0,$12,$13) ON CONFLICT (id) DO NOTHING`,
      products.map(p => [p.id, p.name, p.slug, p.description, p.short_desc, p.price, p.mrp, p.category_id, p.image_url, p.badge, p.is_featured, p.variants, p.sort_order]));

    await seed('testimonials',
      `INSERT INTO testimonials (id,name,location,text,avatar,rating,sort_order) OVERRIDING SYSTEM VALUE VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO NOTHING`,
      testimonials.map(t => [t.id, t.name, t.location, t.text, t.avatar, t.rating, t.sort_order]));

    await seed('faq',
      `INSERT INTO faq (id,question,answer,sort_order) OVERRIDING SYSTEM VALUE VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING`,
      faqs.map(f => [f.id, f.question, f.answer, f.sort_order]));

    if ((await count('orders')) === 0) {
      for (const o of sampleOrders) {
        await client.query(
          `INSERT INTO orders (id,customer_name,phone,address,total_price,is_paid,status,created_at)
           OVERRIDING SYSTEM VALUE VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
          [o.id, o.customer_name, o.phone, o.address, o.total_price, o.is_paid, o.status, o.created_at]);
        for (const it of o.items) {
          await client.query(
            `INSERT INTO order_items (order_id,product_id,product_name,weight,quantity,price) VALUES ($1,$2,$3,$4,$5,$6)`,
            [o.id, it.product_id, it.product_name, it.weight, it.quantity, it.price]);
        }
      }
      console.log('✓ orders + order_items: sample rows');
    } else {
      console.log('  orders: already seeded, skipping');
    }

    // Optional local-admin bootstrap
    if (process.env.OWNER_USERNAME && process.env.OWNER_PASSWORD) {
      const { hashPassword } = await import('../server/middleware/auth.js');
      const exists = (await client.query('SELECT id FROM admin_users WHERE username = $1', [process.env.OWNER_USERNAME])).rowCount > 0;
      if (!exists) {
        await client.query('INSERT INTO admin_users (username,password_hash,role) VALUES ($1,$2,$3)',
          [process.env.OWNER_USERNAME, hashPassword(process.env.OWNER_PASSWORD), 'owner']);
        console.log(`✓ admin_users: owner "${process.env.OWNER_USERNAME}" created`);
      }
    }
  } finally {
    client.release();
    await pool.end();
  }

  // Storage bucket (needs the service key)
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
    const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'product-images';
    const { data: existing } = await sb.storage.getBucket(bucket);
    if (!existing) {
      const { error } = await sb.storage.createBucket(bucket, { public: true, fileSizeLimit: '10MB' });
      if (error) console.error(`✗ bucket "${bucket}": ${error.message}`);
      else console.log(`✓ storage bucket "${bucket}" created (public)`);
    } else {
      console.log(`  storage bucket "${bucket}" already exists`);
    }
  } else {
    console.warn('! SUPABASE_SERVICE_KEY not set — storage bucket NOT created. Uploads will fail in Postgres mode until it exists.');
  }

  console.log('\nDone. Your Supabase project is ready for production.');
}

main().catch(e => { console.error(e); process.exit(1); });
