
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
  image_url TEXT DEFAULT '',
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
  customer_id INTEGER,
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

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  phone_digits TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  full_name TEXT DEFAULT '',
  email TEXT DEFAULT '',
  address TEXT DEFAULT '',
  landmark TEXT DEFAULT '',
  city TEXT DEFAULT '',
  state TEXT DEFAULT '',
  postal_code TEXT DEFAULT '',
  country TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now()
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
                           'images','orders','order_items','customers','testimonials','faq',
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

-- ============================================================
-- Seed data (runs only when tables are empty — idempotent)
-- ============================================================
INSERT INTO site_settings (id, hero_title, hero_subtitle, hero_description, announcement_text, whatsapp_number, email, footer_description, copyright_text)
OVERRIDING SYSTEM VALUE VALUES
  (1, $cb$connecting farmers to the world$cb$, $cb$Farm Direct · 100% Organic$cb$, $cb$Authentic, unrefined delicacies crafted with traditional heritage recipes — sourced directly from farmers in Kolhapur, Bihar, and the Western Ghats. No chemicals. No shortcuts. Just honest food.$cb$, $cb$Free delivery on orders above ₹999 · COD available across India$cb$, $cb$918789267181$cb$, $cb$Sumit@celestialgood.com$cb$, $cb$Pure, organic, and traditionally made delicacies — sourced directly from Indian farmers and delivered to your doorstep.$cb$, $cb$2026 Celestial Good. All rights reserved.$cb$)
ON CONFLICT (id) DO NOTHING;

INSERT INTO categories (id, name, slug, icon, description, sort_order)
OVERRIDING SYSTEM VALUE VALUES
  (1, $cb$Organic Jaggery$cb$, $cb$jaggery$cb$, $cb$🏺$cb$, $cb$Pure chemical-free traditional jaggery from Kolhapur$cb$, 1),
  (2, $cb$Roasted Makhana$cb$, $cb$makhana$cb$, $cb$🥜$cb$, $cb$Slow-roasted giant lotus seeds from Bihar ponds$cb$, 2),
  (3, $cb$Pure Honey & Ghee$cb$, $cb$honey-ghee$cb$, $cb$🍯$cb$, $cb$Raw wild forest honey and Vedic Bilona A2 cow ghee$cb$, 3),
  (4, $cb$Handmade Spices$cb$, $cb$spices$cb$, $cb$🌶️$cb$, $cb$Single-origin stone-ground Meghalaya spices$cb$, 4),
  (5, $cb$Artisanal Pickles$cb$, $cb$pickles$cb$, $cb$🌿$cb$, $cb$Sun-cured traditional achar in cold-pressed mustard oil$cb$, 5)
ON CONFLICT (id) DO NOTHING;

INSERT INTO sizes (id, name, value)
OVERRIDING SYSTEM VALUE VALUES
  (1, $cb$Small (100g/200g/250g)$cb$, $cb$250g$cb$),
  (2, $cb$Standard (500g/500ml)$cb$, $cb$500g$cb$),
  (3, $cb$Family Pack (1kg/1L)$cb$, $cb$1kg$cb$)
ON CONFLICT (id) DO NOTHING;

INSERT INTO colors (id, name, value, hex)
OVERRIDING SYSTEM VALUE VALUES
  (1, $cb$Golden Amber$cb$, $cb$Golden$cb$, $cb$#C4943D$cb$),
  (2, $cb$Forest Green$cb$, $cb$Organic$cb$, $cb$#1B4332$cb$),
  (3, $cb$Warm Earth$cb$, $cb$Artisanal$cb$, $cb$#6B4F2A$cb$)
ON CONFLICT (id) DO NOTHING;

INSERT INTO billboards (id, label, image_url, heading, badge, subtitle, link, sort_order)
OVERRIDING SYSTEM VALUE VALUES
  (1, $cb$Organic Jaggery$cb$, $cb$assets/organic_jaggery_hero_1785581871908-B_1vChWj.jpg$cb$, $cb$Organic Jaggery$cb$, $cb$🔥 Bestseller$cb$, $cb$Kolhapuri Shakkar Gud$cb$, $cb$/shop.html#shop-organic-sugarcane-jaggery-cubes$cb$, 1),
  (2, $cb$A2 Desi Cow Ghee$cb$, $cb$$cb$, $cb$A2 Desi Cow Ghee$cb$, $cb$✨ New Arrival$cb$, $cb$Traditional Bilona Ghee$cb$, $cb$/shop.html#shop-traditional-bilona-a2-desi-gir-cow-ghee$cb$, 2),
  (3, $cb$Wild Forest Honey$cb$, $cb$$cb$, $cb$Wild Forest Honey$cb$, $cb$💰 20% Off$cb$, $cb$Raw Unprocessed Honey$cb$, $cb$/shop.html#shop-wild-forest-raw-organic-unprocessed-honey$cb$, 3),
  (4, $cb$Foxnuts (Makhana)$cb$, $cb$$cb$, $cb$Foxnuts (Makhana)$cb$, $cb$⭐ Featured$cb$, $cb$Slow-Roasted Makhana$cb$, $cb$/shop.html#shop-classic-himalayan-salt-pepper-roasted-makhana$cb$, 4)
ON CONFLICT (id) DO NOTHING;

INSERT INTO products (id, name, slug, description, short_desc, price, mrp, category_id, image_url, badge, is_featured, is_archived, variants, sort_order)
OVERRIDING SYSTEM VALUE VALUES
  (1, $cb$Organic Sugarcane Jaggery Cubes (Shakkar Gud)$cb$, $cb$organic-sugarcane-jaggery-cubes$cb$, $cb$Handcrafted using traditional sugarcane boiling techniques without any chemicals or artificial clarifiers. Pure, mineral-rich, and naturally dark golden with a luscious molasses warmth.$cb$, $cb$Slow-cooked sugarcane juice, finished without sulphur or refining agents. A deep molasses sweetness for chai, sweets, and everyday cooking.$cb$, 180, 220, 1, $cb$assets/organic_jaggery_hero_1785581871908-B_1vChWj.jpg$cb$, $cb$🔥 Bestseller$cb$, 1, 0, $cb$[{"weight":"500g","price":180,"mrp":220},{"weight":"1kg","price":340,"mrp":420}]$cb$, 1),
  (2, $cb$Dry Fruit & Sesame Stuffed Jaggery Slab (Mewa Til Gud)$cb$, $cb$dry-fruit-sesame-stuffed-jaggery-slab$cb$, $cb$A traditional family recipe made by slow-cooking organic jaggery with roasted sesame seeds, crushed almonds, cashews, pistachios, and a touch of cardamom.$cb$, $cb$Dry fruit & sesame stuffed jaggery — slow-cooked with roasted almonds, cashews, pistachios, and a touch of cardamom.$cb$, 240, 290, 1, $cb$$cb$, $cb$$cb$, 1, 0, $cb$[{"weight":"250g","price":240,"mrp":290},{"weight":"500g","price":450,"mrp":550}]$cb$, 2),
  (3, $cb$Classic Himalayan Salt & Pepper Roasted Makhana$cb$, $cb$classic-himalayan-salt-pepper-roasted-makhana$cb$, $cb$Handpicked giant lotus seeds sourced straight from Bihar ponds, gently roasted in aromatic A2 desi ghee and seasoned with hand-milled pink Himalayan salt and coarse black pepper.$cb$, $cb$Bihar lotus seeds roasted in aromatic A2 desi ghee, seasoned with hand-milled pink salt and coarse black pepper.$cb$, 190, 230, 2, $cb$$cb$, $cb$$cb$, 1, 0, $cb$[{"weight":"100g","price":190,"mrp":230},{"weight":"250g","price":420,"mrp":500},{"weight":"500g","price":790,"mrp":950}]$cb$, 3),
  (4, $cb$Caramel & Organic Jaggery Glazed Makhana$cb$, $cb$caramel-organic-jaggery-glazed-makhana$cb$, $cb$Crispy lotus seeds coated in a golden caramel made from homemade organic sugarcane jaggery, A2 ghee, and a hint of cinnamon. A sweet crunchy delight.$cb$, $cb$Crunchy lotus seeds coated in farm jaggery caramel with a pinch of Ceylon cinnamon.$cb$, 220, 270, 2, $cb$$cb$, $cb$$cb$, 0, 0, $cb$[{"weight":"150g","price":220,"mrp":270},{"weight":"300g","price":410,"mrp":500}]$cb$, 4),
  (5, $cb$Wild Forest Raw Organic Unprocessed Honey$cb$, $cb$wild-forest-raw-organic-unprocessed-honey$cb$, $cb$100% raw, unheated, and unfiltered honey extracted carefully by local tribal bee keepers. Retains natural pollen, propolis, and living enzymes.$cb$, $cb$Collected from wild flora by tribal beekeepers and bottled without heating — natural pollen, enzymes, and floral aroma preserved.$cb$, 320, 380, 3, $cb$$cb$, $cb$$cb$, 1, 0, $cb$[{"weight":"250g","price":320,"mrp":380},{"weight":"500g","price":590,"mrp":700}]$cb$, 5),
  (6, $cb$Traditional Bilona A2 Desi Gir Cow Ghee$cb$, $cb$traditional-bilona-a2-desi-gir-cow-ghee$cb$, $cb$Made from the milk of free-range Gir cows using the age-old Vedic Bilona method (curd churned into butter, then slow-boiled on low flame). Golden, granular, and intensely aromatic.$cb$, $cb$Curd-churned with a wooden madhani and slow-heated for a nutty aroma, clean golden texture, and a rich finish in every spoonful.$cb$, 850, 990, 3, $cb$$cb$, $cb$$cb$, 1, 0, $cb$[{"weight":"500ml","price":850,"mrp":990},{"weight":"1 Litre","price":1650,"mrp":1950}]$cb$, 6),
  (7, $cb$Hand-Pounded Organic Lakadong Turmeric Powder$cb$, $cb$hand-pounded-organic-lakadong-turmeric-powder$cb$, $cb$Sourced from the pristine hills of Jaintia, Meghalaya. Stone-ground at low temperatures to preserve volatile natural essential oils and deep golden hue.$cb$, $cb$Stone-ground at low temperatures with high natural curcumin to preserve volatile natural essential oils.$cb$, 210, 260, 4, $cb$$cb$, $cb$$cb$, 0, 0, $cb$[{"weight":"200g","price":210,"mrp":260},{"weight":"500g","price":480,"mrp":600}]$cb$, 7),
  (8, $cb$Homemade Sun-Dried Spicy Raw Mango Pickle (Aam Achar)$cb$, $cb$homemade-sun-dried-spicy-raw-mango-pickle$cb$, $cb$Freshly cut raw green mangoes marinated with cold-pressed mustard oil, fenugreek, nigella seeds, and red chilli, cured under direct sunlight for 21 days in ceramic barnis.$cb$, $cb$Raw green mangoes marinated in cold-pressed mustard oil and spices, sun-cured for 21 days in ceramic barnis.$cb$, 260, 310, 5, $cb$$cb$, $cb$$cb$, 1, 0, $cb$[{"weight":"350g","price":260,"mrp":310},{"weight":"700g","price":490,"mrp":590}]$cb$, 8)
ON CONFLICT (id) DO NOTHING;

INSERT INTO testimonials (id, name, location, text, avatar, rating, sort_order)
OVERRIDING SYSTEM VALUE VALUES
  (1, $cb$Priya S.$cb$, $cb$Mumbai$cb$, $cb$The jaggery tastes exactly like what my grandmother used to bring home from the local kolhu. Deep, honest sweetness — my chai will never be the same.$cb$, $cb$P$cb$, 5, 1),
  (2, $cb$Meera K.$cb$, $cb$Delhi$cb$, $cb$You can smell the purity the moment you open the ghee jar. Granular, golden, and exactly the bilona ghee I grew up with in my village.$cb$, $cb$M$cb$, 5, 2),
  (3, $cb$Rahul D.$cb$, $cb$Pune$cb$, $cb$Ordered the makhana and honey for my family — fresh, crisp, beautifully packed, and delivered right on time. COD made it effortless.$cb$, $cb$R$cb$, 5, 3)
ON CONFLICT (id) DO NOTHING;

INSERT INTO faq (id, question, answer, sort_order)
OVERRIDING SYSTEM VALUE VALUES
  (1, $cb$Are your products really 100% organic and chemical-free?$cb$, $cb$Yes. Every product is sourced directly from partner farms and crafted using traditional methods — no sulphur, no artificial clarifiers, no preservatives. What you receive is exactly what the farm produces.$cb$, 1),
  (2, $cb$Do you offer Cash on Delivery (COD)?$cb$, $cb$Absolutely. COD is available across India. You can also order instantly via WhatsApp at +91 87892 67181 and pay on delivery.$cb$, 2),
  (3, $cb$How long does delivery take?$cb$, $cb$Orders are dispatched within 24–48 hours. Metro cities usually receive orders in 2–4 days; other locations may take 4–7 days depending on the courier.$cb$, 3),
  (4, $cb$How should I store jaggery and ghee?$cb$, $cb$Store jaggery in an airtight container in a cool, dry place. Ghee stays best in a sealed jar away from direct sunlight — refrigeration is optional; it naturally keeps for months.$cb$, 4),
  (5, $cb$Can I order in bulk for festivals or gifting?$cb$, $cb$Yes! We love festive and corporate gifting orders. Message us on WhatsApp with your requirements and we'll arrange custom quantities and packaging.$cb$, 5)
ON CONFLICT (id) DO NOTHING;

INSERT INTO orders (id, customer_name, phone, address, total_price, is_paid, status, created_at)
OVERRIDING SYSTEM VALUE VALUES
  (1001, $cb$Ananya Sharma$cb$, $cb$+91 98234 11223$cb$, $cb$Flat 402, Green Glen Layout, Bellandur, Bengaluru 560103$cb$, 1030, 1, $cb$delivered$cb$, $cb$2026-08-28 14:32:00$cb$),
  (1002, $cb$Vikram Malhotra$cb$, $cb$+91 98110 54321$cb$, $cb$B-14, Greater Kailash 1, New Delhi 110048$cb$, 530, 0, $cb$processing$cb$, $cb$2026-09-01 10:15:00$cb$),
  (1003, $cb$Siddharth Roy$cb$, $cb$+91 99032 87654$cb$, $cb$7A Salt Lake Sector 3, Kolkata 700098$cb$, 850, 1, $cb$shipped$cb$, $cb$2026-09-03 16:45:00$cb$)
ON CONFLICT (id) DO NOTHING;

INSERT INTO order_items (order_id, product_id, product_name, weight, quantity, price)
SELECT * FROM (
  VALUES
  ((SELECT id FROM orders WHERE id = 1001), 1, $cb$Organic Sugarcane Jaggery Cubes$cb$, $cb$500g$cb$, 2, 180),
  ((SELECT id FROM orders WHERE id = 1001), 6, $cb$Traditional Bilona A2 Desi Gir Cow Ghee$cb$, $cb$500ml$cb$, 1, 850),
  ((SELECT id FROM orders WHERE id = 1002), 3, $cb$Classic Himalayan Salt & Pepper Roasted Makhana$cb$, $cb$250g$cb$, 1, 420),
  ((SELECT id FROM orders WHERE id = 1003), 6, $cb$Traditional Bilona A2 Desi Gir Cow Ghee$cb$, $cb$500ml$cb$, 1, 850)
) AS v(order_id, product_id, product_name, weight, quantity, price)
WHERE NOT EXISTS (SELECT 1 FROM order_items);

-- ============================================================
-- Align IDENTITY sequences past the seeded ids (seeding inserts
-- explicit ids via OVERRIDING SYSTEM VALUE, which does NOT bump
-- the sequence — without this, the next insert fails with
-- "duplicate key value violates unique constraint "<table>_pkey"")
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
END $$;
