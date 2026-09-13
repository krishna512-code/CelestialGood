import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { hashPassword } from '../middleware/auth.js';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
// SQLITE_PATH lets hosts like Railway point the DB at a persistent volume;
// defaults to the bundled dev DB for local use.
const dbPath = process.env.SQLITE_PATH
  ? resolve(process.env.SQLITE_PATH)
  : join(__dirname, '..', 'celestial-goods.db');

function ensureDir(path) {
  const d = dirname(path);
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}
ensureDir(dbPath);

export const db = new DatabaseSync(dbPath);
try {
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
} catch (e) {
  // ignore if pragmas fail
}

export function initDatabase() {
  db.exec(`
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
      hero_title TEXT DEFAULT 'connecting farmers to the world',
      hero_subtitle TEXT DEFAULT 'Farm Direct · 100% Organic',
      hero_description TEXT DEFAULT 'Authentic, unrefined delicacies crafted with traditional heritage recipes — sourced directly from farmers in Kolhapur, Bihar, and the Western Ghats. No chemicals. No shortcuts. Just honest food.',
      announcement_text TEXT DEFAULT 'Free delivery on orders above ₹999 · COD available across India',
      whatsapp_number TEXT DEFAULT '918789267181',
      email TEXT DEFAULT 'Sumit@celestialgood.com',
      footer_description TEXT DEFAULT 'Pure, organic, and traditionally made delicacies — sourced directly from Indian farmers and delivered to your doorstep.',
      copyright_text TEXT DEFAULT '2026 Celestial Good. All rights reserved.'
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
    try { db.exec("ALTER TABLE admin_users ADD COLUMN role TEXT DEFAULT 'admin'"); } catch (e) {}

    // Default Admin User: admin / admin
    // bcrypt hash for 'admin'
    // const adminHash = '$2a$10$bhnQw/kC3tUvcpV7l8x5.O7lmeu1/We9bhwY4BXRYRV2.UQXwFyKC';
    // db.prepare(`INSERT OR IGNORE INTO admin_users (id, username, password_hash) VALUES (1, 'admin', ?)`).run(adminHash);

    // Optional Owner Bootstrap via environment variables
    if (process.env.OWNER_USERNAME && process.env.OWNER_PASSWORD) {
      const existing = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(process.env.OWNER_USERNAME);
      if (!existing) {
        const ownerHash = hashPassword(process.env.OWNER_PASSWORD);
        db.prepare('INSERT INTO admin_users (username, password_hash, role) VALUES (?, ?, ?)')
          .run(process.env.OWNER_USERNAME, ownerHash, 'owner');
      }
    }

  // Default Site Settings
  db.prepare(`INSERT OR IGNORE INTO site_settings (id) VALUES (1)`).run();

  // Default Categories
  const catCount = db.prepare('SELECT COUNT(*) as c FROM categories').get().c;
  if (catCount === 0) {
    const insertCat = db.prepare('INSERT INTO categories (id, name, slug, icon, description, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
    insertCat.run(1, 'Organic Jaggery', 'jaggery', '🏺', 'Pure chemical-free traditional jaggery from Kolhapur', 1);
    insertCat.run(2, 'Roasted Makhana', 'makhana', '🥜', 'Slow-roasted giant lotus seeds from Bihar ponds', 2);
    insertCat.run(3, 'Pure Honey & Ghee', 'honey-ghee', '🍯', 'Raw wild forest honey and Vedic Bilona A2 cow ghee', 3);
    insertCat.run(4, 'Handmade Spices', 'spices', '🌶️', 'Single-origin stone-ground Meghalaya spices', 4);
    insertCat.run(5, 'Artisanal Pickles', 'pickles', '🌿', 'Sun-cured traditional achar in cold-pressed mustard oil', 5);
  }

  // Default Sizes
  const sizeCount = db.prepare('SELECT COUNT(*) as c FROM sizes').get().c;
  if (sizeCount === 0) {
    const insertSize = db.prepare('INSERT INTO sizes (name, value) VALUES (?, ?)');
    insertSize.run('Small (100g/200g/250g)', '250g');
    insertSize.run('Standard (500g/500ml)', '500g');
    insertSize.run('Family Pack (1kg/1L)', '1kg');
  }

  // Default Colors
  const colorCount = db.prepare('SELECT COUNT(*) as c FROM colors').get().c;
  if (colorCount === 0) {
    const insertColor = db.prepare('INSERT INTO colors (name, value, hex) VALUES (?, ?, ?)');
    insertColor.run('Golden Amber', 'Golden', '#C4943D');
    insertColor.run('Forest Green', 'Organic', '#1B4332');
    insertColor.run('Warm Earth', 'Artisanal', '#6B4F2A');
  }

  // Default Billboards (Advertisements carousel in hero)
  const billCount = db.prepare('SELECT COUNT(*) as c FROM billboards').get().c;
  if (billCount === 0) {
    const insertBill = db.prepare('INSERT INTO billboards (label, image_url, heading, badge, subtitle, link, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)');
    insertBill.run('Organic Jaggery', 'assets/organic_jaggery_hero_1785581871908-B_1vChWj.jpg', 'Organic Jaggery', '🔥 Bestseller', 'Kolhapuri Shakkar Gud', '/shop.html#shop-organic-sugarcane-jaggery-cubes', 1);
    insertBill.run('A2 Desi Cow Ghee', '', 'A2 Desi Cow Ghee', '✨ New Arrival', 'Traditional Bilona Ghee', '/shop.html#shop-traditional-bilona-a2-desi-gir-cow-ghee', 2);
    insertBill.run('Wild Forest Honey', '', 'Wild Forest Honey', '💰 20% Off', 'Raw Unprocessed Honey', '/shop.html#shop-wild-forest-raw-organic-unprocessed-honey', 3);
    insertBill.run('Foxnuts (Makhana)', '', 'Foxnuts (Makhana)', '⭐ Featured', 'Slow-Roasted Makhana', '/shop.html#shop-classic-himalayan-salt-pepper-roasted-makhana', 4);
  }

  // Default Products
  const prodCount = db.prepare('SELECT COUNT(*) as c FROM products').get().c;
  if (prodCount === 0) {
    const insertProd = db.prepare(`
      INSERT INTO products (
        id, name, slug, description, short_desc, price, mrp, category_id, image_url, badge, is_featured, is_archived, variants, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertProd.run(
      1,
      'Organic Sugarcane Jaggery Cubes (Shakkar Gud)',
      'organic-sugarcane-jaggery-cubes',
      'Handcrafted using traditional sugarcane boiling techniques without any chemicals or artificial clarifiers. Pure, mineral-rich, and naturally dark golden with a luscious molasses warmth.',
      'Slow-cooked sugarcane juice, finished without sulphur or refining agents. A deep molasses sweetness for chai, sweets, and everyday cooking.',
      180, 220, 1,
      'assets/organic_jaggery_hero_1785581871908-B_1vChWj.jpg',
      '🔥 Bestseller',
      1, 0,
      JSON.stringify([{ weight: '500g', price: 180, mrp: 220 }, { weight: '1kg', price: 340, mrp: 420 }]),
      1
    );

    insertProd.run(
      2,
      'Dry Fruit & Sesame Stuffed Jaggery Slab (Mewa Til Gud)',
      'dry-fruit-sesame-stuffed-jaggery-slab',
      'A traditional family recipe made by slow-cooking organic jaggery with roasted sesame seeds, crushed almonds, cashews, pistachios, and a touch of cardamom.',
      'Dry fruit & sesame stuffed jaggery — slow-cooked with roasted almonds, cashews, pistachios, and a touch of cardamom.',
      240, 290, 1,
      '',
      '',
      1, 0,
      JSON.stringify([{ weight: '250g', price: 240, mrp: 290 }, { weight: '500g', price: 450, mrp: 550 }]),
      2
    );

    insertProd.run(
      3,
      'Classic Himalayan Salt & Pepper Roasted Makhana',
      'classic-himalayan-salt-pepper-roasted-makhana',
      'Handpicked giant lotus seeds sourced straight from Bihar ponds, gently roasted in aromatic A2 desi ghee and seasoned with hand-milled pink Himalayan salt and coarse black pepper.',
      'Bihar lotus seeds roasted in aromatic A2 desi ghee, seasoned with hand-milled pink salt and coarse black pepper.',
      190, 230, 2,
      '',
      '',
      1, 0,
      JSON.stringify([{ weight: '100g', price: 190, mrp: 230 }, { weight: '250g', price: 420, mrp: 500 }, { weight: '500g', price: 790, mrp: 950 }]),
      3
    );

    insertProd.run(
      4,
      'Caramel & Organic Jaggery Glazed Makhana',
      'caramel-organic-jaggery-glazed-makhana',
      'Crispy lotus seeds coated in a golden caramel made from homemade organic sugarcane jaggery, A2 ghee, and a hint of cinnamon. A sweet crunchy delight.',
      'Crunchy lotus seeds coated in farm jaggery caramel with a pinch of Ceylon cinnamon.',
      220, 270, 2,
      '',
      '',
      0, 0,
      JSON.stringify([{ weight: '150g', price: 220, mrp: 270 }, { weight: '300g', price: 410, mrp: 500 }]),
      4
    );

    insertProd.run(
      5,
      'Wild Forest Raw Organic Unprocessed Honey',
      'wild-forest-raw-organic-unprocessed-honey',
      '100% raw, unheated, and unfiltered honey extracted carefully by local tribal bee keepers. Retains natural pollen, propolis, and living enzymes.',
      'Collected from wild flora by tribal beekeepers and bottled without heating — natural pollen, enzymes, and floral aroma preserved.',
      320, 380, 3,
      '',
      '',
      1, 0,
      JSON.stringify([{ weight: '250g', price: 320, mrp: 380 }, { weight: '500g', price: 590, mrp: 700 }]),
      5
    );

    insertProd.run(
      6,
      'Traditional Bilona A2 Desi Gir Cow Ghee',
      'traditional-bilona-a2-desi-gir-cow-ghee',
      'Made from the milk of free-range Gir cows using the age-old Vedic Bilona method (curd churned into butter, then slow-boiled on low flame). Golden, granular, and intensely aromatic.',
      'Curd-churned with a wooden madhani and slow-heated for a nutty aroma, clean golden texture, and a rich finish in every spoonful.',
      850, 990, 3,
      '',
      '',
      1, 0,
      JSON.stringify([{ weight: '500ml', price: 850, mrp: 990 }, { weight: '1 Litre', price: 1650, mrp: 1950 }]),
      6
    );

    insertProd.run(
      7,
      'Hand-Pounded Organic Lakadong Turmeric Powder',
      'hand-pounded-organic-lakadong-turmeric-powder',
      'Sourced from the pristine hills of Jaintia, Meghalaya. Stone-ground at low temperatures to preserve volatile natural essential oils and deep golden hue.',
      'Stone-ground at low temperatures with high natural curcumin to preserve volatile natural essential oils.',
      210, 260, 4,
      '',
      '',
      0, 0,
      JSON.stringify([{ weight: '200g', price: 210, mrp: 260 }, { weight: '500g', price: 480, mrp: 600 }]),
      7
    );

    insertProd.run(
      8,
      'Homemade Sun-Dried Spicy Raw Mango Pickle (Aam Achar)',
      'homemade-sun-dried-spicy-raw-mango-pickle',
      'Freshly cut raw green mangoes marinated with cold-pressed mustard oil, fenugreek, nigella seeds, and red chilli, cured under direct sunlight for 21 days in ceramic barnis.',
      'Raw green mangoes marinated in cold-pressed mustard oil and spices, sun-cured for 21 days in ceramic barnis.',
      260, 310, 5,
      '',
      '',
      1, 0,
      JSON.stringify([{ weight: '350g', price: 260, mrp: 310 }, { weight: '700g', price: 490, mrp: 590 }]),
      8
    );
  }

  // Default Testimonials
  const testCount = db.prepare('SELECT COUNT(*) as c FROM testimonials').get().c;
  if (testCount === 0) {
    const insertTest = db.prepare('INSERT INTO testimonials (name, location, text, avatar, rating, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
    insertTest.run('Priya S.', 'Mumbai', 'The jaggery tastes exactly like what my grandmother used to bring home from the local kolhu. Deep, honest sweetness — my chai will never be the same.', 'P', 5, 1);
    insertTest.run('Meera K.', 'Delhi', 'You can smell the purity the moment you open the ghee jar. Granular, golden, and exactly the bilona ghee I grew up with in my village.', 'M', 5, 2);
    insertTest.run('Rahul D.', 'Pune', 'Ordered the makhana and honey for my family — fresh, crisp, beautifully packed, and delivered right on time. COD made it effortless.', 'R', 5, 3);
  }

  // Default FAQ
  const faqCount = db.prepare('SELECT COUNT(*) as c FROM faq').get().c;
  if (faqCount === 0) {
    const insertFaq = db.prepare('INSERT INTO faq (question, answer, sort_order) VALUES (?, ?, ?)');
    insertFaq.run('Are your products really 100% organic and chemical-free?', 'Yes. Every product is sourced directly from partner farms and crafted using traditional methods — no sulphur, no artificial clarifiers, no preservatives. What you receive is exactly what the farm produces.', 1);
    insertFaq.run('Do you offer Cash on Delivery (COD)?', 'Absolutely. COD is available across India. You can also order instantly via WhatsApp at +91 87892 67181 and pay on delivery.', 2);
    insertFaq.run('How long does delivery take?', 'Orders are dispatched within 24–48 hours. Metro cities usually receive orders in 2–4 days; other locations may take 4–7 days depending on the courier.', 3);
    insertFaq.run('How should I store jaggery and ghee?', 'Store jaggery in an airtight container in a cool, dry place. Ghee stays best in a sealed jar away from direct sunlight — refrigeration is optional; it naturally keeps for months.', 4);
    insertFaq.run('Can I order in bulk for festivals or gifting?', "Yes! We love festive and corporate gifting orders. Message us on WhatsApp with your requirements and we'll arrange custom quantities and packaging.", 5);
  }

  // Default Sample Orders for Admin Insights
  const orderCount = db.prepare('SELECT COUNT(*) as c FROM orders').get().c;
  if (orderCount === 0) {
    const insertOrder = db.prepare('INSERT INTO orders (id, customer_name, phone, address, total_price, is_paid, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    insertOrder.run(1001, 'Ananya Sharma', '+91 98234 11223', 'Flat 402, Green Glen Layout, Bellandur, Bengaluru 560103', 1030, 1, 'delivered', '2026-08-28 14:32:00');
    insertOrder.run(1002, 'Vikram Malhotra', '+91 98110 54321', 'B-14, Greater Kailash 1, New Delhi 110048', 530, 0, 'processing', '2026-09-01 10:15:00');
    insertOrder.run(1003, 'Siddharth Roy', '+91 99032 87654', '7A Salt Lake Sector 3, Kolkata 700098', 850, 1, 'shipped', '2026-09-03 16:45:00');

    const insertItem = db.prepare('INSERT INTO order_items (order_id, product_id, product_name, weight, quantity, price) VALUES (?, ?, ?, ?, ?, ?)');
    insertItem.run(1001, 1, 'Organic Sugarcane Jaggery Cubes', '500g', 2, 180);
    insertItem.run(1001, 6, 'Traditional Bilona A2 Desi Gir Cow Ghee', '500ml', 1, 850);
    insertItem.run(1002, 3, 'Classic Himalayan Salt & Pepper Roasted Makhana', '250g', 1, 420);
    insertItem.run(1003, 6, 'Traditional Bilona A2 Desi Gir Cow Ghee', '500ml', 1, 850);
  }
}

export default { db, initDatabase };
