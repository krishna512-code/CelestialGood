// Shared seed data used by the SQLite bootstrap (server/config/db.js)
// and the Postgres migration script (scripts/migrate-pg.mjs).

export const settingsDefaults = {
  hero_title: 'connecting farmers to the world',
  hero_subtitle: 'Farm Direct · 100% Organic',
  hero_description:
    'Authentic, unrefined delicacies crafted with traditional heritage recipes — sourced directly from farmers in Kolhapur, Bihar, and the Western Ghats. No chemicals. No shortcuts. Just honest food.',
  announcement_text: 'Free delivery on orders above ₹999 · COD available across India',
  whatsapp_number: '918789267181',
  email: 'Sumit@celestialgood.com',
  footer_description:
    'Pure, organic, and traditionally made delicacies — sourced directly from Indian farmers and delivered to your doorstep.',
  copyright_text: '2026 Celestial Good. All rights reserved.',
};

export const categories = [
  { id: 1, name: 'Organic Jaggery', slug: 'jaggery', icon: '🏺', description: 'Pure chemical-free traditional jaggery from Kolhapur', sort_order: 1 },
  { id: 2, name: 'Roasted Makhana', slug: 'makhana', icon: '🥜', description: 'Slow-roasted giant lotus seeds from Bihar ponds', sort_order: 2 },
  { id: 3, name: 'Pure Honey & Ghee', slug: 'honey-ghee', icon: '🍯', description: 'Raw wild forest honey and Vedic Bilona A2 cow ghee', sort_order: 3 },
  { id: 4, name: 'Handmade Spices', slug: 'spices', icon: '🌶️', description: 'Single-origin stone-ground Meghalaya spices', sort_order: 4 },
  { id: 5, name: 'Artisanal Pickles', slug: 'pickles', icon: '🌿', description: 'Sun-cured traditional achar in cold-pressed mustard oil', sort_order: 5 },
];

export const sizes = [
  { id: 1, name: 'Small (100g/200g/250g)', value: '250g' },
  { id: 2, name: 'Standard (500g/500ml)', value: '500g' },
  { id: 3, name: 'Family Pack (1kg/1L)', value: '1kg' },
];

export const colors = [
  { id: 1, name: 'Golden Amber', value: 'Golden', hex: '#C4943D' },
  { id: 2, name: 'Forest Green', value: 'Organic', hex: '#1B4332' },
  { id: 3, name: 'Warm Earth', value: 'Artisanal', hex: '#6B4F2A' },
];

export const billboards = [
  { id: 1, label: 'Organic Jaggery', image_url: 'assets/organic_jaggery_hero_1785581871908-B_1vChWj.jpg', heading: 'Organic Jaggery', badge: '🔥 Bestseller', subtitle: 'Kolhapuri Shakkar Gud', link: '/shop.html#shop-organic-sugarcane-jaggery-cubes', sort_order: 1 },
  { id: 2, label: 'A2 Desi Cow Ghee', image_url: '', heading: 'A2 Desi Cow Ghee', badge: '✨ New Arrival', subtitle: 'Traditional Bilona Ghee', link: '/shop.html#shop-traditional-bilona-a2-desi-gir-cow-ghee', sort_order: 2 },
  { id: 3, label: 'Wild Forest Honey', image_url: '', heading: 'Wild Forest Honey', badge: '💰 20% Off', subtitle: 'Raw Unprocessed Honey', link: '/shop.html#shop-wild-forest-raw-organic-unprocessed-honey', sort_order: 3 },
  { id: 4, label: 'Foxnuts (Makhana)', image_url: '', heading: 'Foxnuts (Makhana)', badge: '⭐ Featured', subtitle: 'Slow-Roasted Makhana', link: '/shop.html#shop-classic-himalayan-salt-pepper-roasted-makhana', sort_order: 4 },
];

export const products = [
  {
    id: 1,
    name: 'Organic Sugarcane Jaggery Cubes (Shakkar Gud)',
    slug: 'organic-sugarcane-jaggery-cubes',
    description: 'Handcrafted using traditional sugarcane boiling techniques without any chemicals or artificial clarifiers. Pure, mineral-rich, and naturally dark golden with a luscious molasses warmth.',
    short_desc: 'Slow-cooked sugarcane juice, finished without sulphur or refining agents. A deep molasses sweetness for chai, sweets, and everyday cooking.',
    price: 180, mrp: 220, category_id: 1,
    image_url: 'assets/organic_jaggery_hero_1785581871908-B_1vChWj.jpg',
    badge: '🔥 Bestseller', is_featured: 1, sort_order: 1,
    variants: JSON.stringify([{ weight: '500g', price: 180, mrp: 220 }, { weight: '1kg', price: 340, mrp: 420 }]),
  },
  {
    id: 2,
    name: 'Dry Fruit & Sesame Stuffed Jaggery Slab (Mewa Til Gud)',
    slug: 'dry-fruit-sesame-stuffed-jaggery-slab',
    description: 'A traditional family recipe made by slow-cooking organic jaggery with roasted sesame seeds, crushed almonds, cashews, pistachios, and a touch of cardamom.',
    short_desc: 'Dry fruit & sesame stuffed jaggery — slow-cooked with roasted almonds, cashews, pistachios, and a touch of cardamom.',
    price: 240, mrp: 290, category_id: 1,
    image_url: '',
    badge: '', is_featured: 1, sort_order: 2,
    variants: JSON.stringify([{ weight: '250g', price: 240, mrp: 290 }, { weight: '500g', price: 450, mrp: 550 }]),
  },
  {
    id: 3,
    name: 'Classic Himalayan Salt & Pepper Roasted Makhana',
    slug: 'classic-himalayan-salt-pepper-roasted-makhana',
    description: 'Handpicked giant lotus seeds sourced straight from Bihar ponds, gently roasted in aromatic A2 desi ghee and seasoned with hand-milled pink Himalayan salt and coarse black pepper.',
    short_desc: 'Bihar lotus seeds roasted in aromatic A2 desi ghee, seasoned with hand-milled pink salt and coarse black pepper.',
    price: 190, mrp: 230, category_id: 2,
    image_url: '',
    badge: '', is_featured: 1, sort_order: 3,
    variants: JSON.stringify([{ weight: '100g', price: 190, mrp: 230 }, { weight: '250g', price: 420, mrp: 500 }, { weight: '500g', price: 790, mrp: 950 }]),
  },
  {
    id: 4,
    name: 'Caramel & Organic Jaggery Glazed Makhana',
    slug: 'caramel-organic-jaggery-glazed-makhana',
    description: 'Crispy lotus seeds coated in a golden caramel made from homemade organic sugarcane jaggery, A2 ghee, and a hint of cinnamon. A sweet crunchy delight.',
    short_desc: 'Crunchy lotus seeds coated in farm jaggery caramel with a pinch of Ceylon cinnamon.',
    price: 220, mrp: 270, category_id: 2,
    image_url: '',
    badge: '', is_featured: 0, sort_order: 4,
    variants: JSON.stringify([{ weight: '150g', price: 220, mrp: 270 }, { weight: '300g', price: 410, mrp: 500 }]),
  },
  {
    id: 5,
    name: 'Wild Forest Raw Organic Unprocessed Honey',
    slug: 'wild-forest-raw-organic-unprocessed-honey',
    description: '100% raw, unheated, and unfiltered honey extracted carefully by local tribal bee keepers. Retains natural pollen, propolis, and living enzymes.',
    short_desc: 'Collected from wild flora by tribal beekeepers and bottled without heating — natural pollen, enzymes, and floral aroma preserved.',
    price: 320, mrp: 380, category_id: 3,
    image_url: '',
    badge: '', is_featured: 1, sort_order: 5,
    variants: JSON.stringify([{ weight: '250g', price: 320, mrp: 380 }, { weight: '500g', price: 590, mrp: 700 }]),
  },
  {
    id: 6,
    name: 'Traditional Bilona A2 Desi Gir Cow Ghee',
    slug: 'traditional-bilona-a2-desi-gir-cow-ghee',
    description: 'Made from the milk of free-range Gir cows using the age-old Vedic Bilona method (curd churned into butter, then slow-boiled on low flame). Golden, granular, and intensely aromatic.',
    short_desc: 'Curd-churned with a wooden madhani and slow-heated for a nutty aroma, clean golden texture, and a rich finish in every spoonful.',
    price: 850, mrp: 990, category_id: 3,
    image_url: '',
    badge: '', is_featured: 1, sort_order: 6,
    variants: JSON.stringify([{ weight: '500ml', price: 850, mrp: 990 }, { weight: '1 Litre', price: 1650, mrp: 1950 }]),
  },
  {
    id: 7,
    name: 'Hand-Pounded Organic Lakadong Turmeric Powder',
    slug: 'hand-pounded-organic-lakadong-turmeric-powder',
    description: 'Sourced from the pristine hills of Jaintia, Meghalaya. Stone-ground at low temperatures to preserve volatile natural essential oils and deep golden hue.',
    short_desc: 'Stone-ground at low temperatures with high natural curcumin to preserve volatile natural essential oils.',
    price: 210, mrp: 260, category_id: 4,
    image_url: '',
    badge: '', is_featured: 0, sort_order: 7,
    variants: JSON.stringify([{ weight: '200g', price: 210, mrp: 260 }, { weight: '500g', price: 480, mrp: 600 }]),
  },
  {
    id: 8,
    name: 'Homemade Sun-Dried Spicy Raw Mango Pickle (Aam Achar)',
    slug: 'homemade-sun-dried-spicy-raw-mango-pickle',
    description: 'Freshly cut raw green mangoes marinated with cold-pressed mustard oil, fenugreek, nigella seeds, and red chilli, cured under direct sunlight for 21 days in ceramic barnis.',
    short_desc: 'Raw green mangoes marinated in cold-pressed mustard oil and spices, sun-cured for 21 days in ceramic barnis.',
    price: 260, mrp: 310, category_id: 5,
    image_url: '',
    badge: '', is_featured: 1, sort_order: 8,
    variants: JSON.stringify([{ weight: '350g', price: 260, mrp: 310 }, { weight: '700g', price: 490, mrp: 590 }]),
  },
];

export const testimonials = [
  { id: 1, name: 'Priya S.', location: 'Mumbai', text: 'The jaggery tastes exactly like what my grandmother used to bring home from the local kolhu. Deep, honest sweetness — my chai will never be the same.', avatar: 'P', rating: 5, sort_order: 1 },
  { id: 2, name: 'Meera K.', location: 'Delhi', text: 'You can smell the purity the moment you open the ghee jar. Granular, golden, and exactly the bilona ghee I grew up with in my village.', avatar: 'M', rating: 5, sort_order: 2 },
  { id: 3, name: 'Rahul D.', location: 'Pune', text: 'Ordered the makhana and honey for my family — fresh, crisp, beautifully packed, and delivered right on time. COD made it effortless.', avatar: 'R', rating: 5, sort_order: 3 },
];

export const faqs = [
  { id: 1, question: 'Are your products really 100% organic and chemical-free?', answer: 'Yes. Every product is sourced directly from partner farms and crafted using traditional methods — no sulphur, no artificial clarifiers, no preservatives. What you receive is exactly what the farm produces.', sort_order: 1 },
  { id: 2, question: 'Do you offer Cash on Delivery (COD)?', answer: 'Absolutely. COD is available across India. You can also order instantly via WhatsApp at +91 87892 67181 and pay on delivery.', sort_order: 2 },
  { id: 3, question: 'How long does delivery take?', answer: 'Orders are dispatched within 24–48 hours. Metro cities usually receive orders in 2–4 days; other locations may take 4–7 days depending on the courier.', sort_order: 3 },
  { id: 4, question: 'How should I store jaggery and ghee?', answer: 'Store jaggery in an airtight container in a cool, dry place. Ghee stays best in a sealed jar away from direct sunlight — refrigeration is optional; it naturally keeps for months.', sort_order: 4 },
  { id: 5, question: 'Can I order in bulk for festivals or gifting?', answer: "Yes! We love festive and corporate gifting orders. Message us on WhatsApp with your requirements and we'll arrange custom quantities and packaging.", sort_order: 5 },
];

export const sampleOrders = [
  {
    id: 1001, customer_name: 'Ananya Sharma', phone: '+91 98234 11223',
    address: 'Flat 402, Green Glen Layout, Bellandur, Bengaluru 560103',
    total_price: 1030, is_paid: 1, status: 'delivered', created_at: '2026-08-28 14:32:00',
    items: [
      { product_id: 1, product_name: 'Organic Sugarcane Jaggery Cubes', weight: '500g', quantity: 2, price: 180 },
      { product_id: 6, product_name: 'Traditional Bilona A2 Desi Gir Cow Ghee', weight: '500ml', quantity: 1, price: 850 },
    ],
  },
  {
    id: 1002, customer_name: 'Vikram Malhotra', phone: '+91 98110 54321',
    address: 'B-14, Greater Kailash 1, New Delhi 110048',
    total_price: 530, is_paid: 0, status: 'processing', created_at: '2026-09-01 10:15:00',
    items: [
      { product_id: 3, product_name: 'Classic Himalayan Salt & Pepper Roasted Makhana', weight: '250g', quantity: 1, price: 420 },
    ],
  },
  {
    id: 1003, customer_name: 'Siddharth Roy', phone: '+91 99032 87654',
    address: '7A Salt Lake Sector 3, Kolkata 700098',
    total_price: 850, is_paid: 1, status: 'shipped', created_at: '2026-09-03 16:45:00',
    items: [
      { product_id: 6, product_name: 'Traditional Bilona A2 Desi Gir Cow Ghee', weight: '500ml', quantity: 1, price: 850 },
    ],
  },
];
