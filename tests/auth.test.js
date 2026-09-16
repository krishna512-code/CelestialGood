// tests/auth.test.js — runs against the unified app in SQLite mode (no DATABASE_URL).
import request from 'supertest';
import app from '../server/index.js';
import { run } from '../server/config/db.js';
import { hashPassword } from '../server/middleware/auth.js';

const ADMIN_USER = { username: 'testadmin', password: 'Password123!' };

beforeAll(async () => {
  await run('DELETE FROM admin_users WHERE username = ?', [ADMIN_USER.username]);
  await run(
    'INSERT INTO admin_users (username, password_hash, role) VALUES (?, ?, ?)',
    [ADMIN_USER.username, hashPassword(ADMIN_USER.password), 'owner']
  );
});

afterAll(async () => {
  await run('DELETE FROM admin_users WHERE username = ?', [ADMIN_USER.username]);
  // Allow open handles (Supabase client keepalives) to settle
  await new Promise(r => setTimeout(r, 100));
});

describe('Admin Authentication', () => {
  test('Successful login returns session cookie', async () => {
    const res = await request(app)
      .post('/api/admin/login')
      .send({ username: ADMIN_USER.username, password: ADMIN_USER.password })
      .expect(200);
    expect(res.body.success).toBe(true);
    const cookies = res.headers['set-cookie'];
    expect(cookies).toBeDefined();
    const sessionCookie = cookies.find(c => c.startsWith('session='));
    expect(sessionCookie).toBeDefined();
  });

  test('Login with wrong password fails', async () => {
    await request(app)
      .post('/api/admin/login')
      .send({ username: ADMIN_USER.username, password: 'wrong' })
      .expect(401);
  });

  test('Authenticated request to protected route succeeds', async () => {
    const loginRes = await request(app)
      .post('/api/admin/login')
      .send(ADMIN_USER);
    const cookie = loginRes.headers['set-cookie'];
    const res = await request(app)
      .get('/api/dashboard/stats')
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body).toHaveProperty('totalRevenue');
  });

  test('Unauthenticated dashboard access is rejected', async () => {
    await request(app)
      .get('/api/dashboard/stats')
      .expect(401);
  });

  test('Logout clears session cookie', async () => {
    const loginRes = await request(app)
      .post('/api/admin/login')
      .send(ADMIN_USER);
    const cookie = loginRes.headers['set-cookie'];
    const logoutRes = await request(app)
      .post('/api/admin/logout')
      .set('Cookie', cookie)
      .expect(200);
    expect(logoutRes.body.success).toBe(true);
    // Sessions are stateless (expiry encoded in the cookie), so logout
    // instructs the browser to drop the cookie via an expired Set-Cookie.
    const setCookie = logoutRes.headers['set-cookie'].join(';');
    expect(setCookie).toMatch(/session=;/); // value emptied
    expect(setCookie).toMatch(/Expires=Thu, 01 Jan 1970/); // expiry in the past
  });
});

describe('Storefront read APIs', () => {
  test('products list is seeded and parses variants', async () => {
    const res = await request(app).get('/api/products').expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(8);
    expect(res.body[0].variants).toBeDefined();
  });

  test('settings returns the seeded hero content', async () => {
    const res = await request(app).get('/api/settings').expect(200);
    // hero_title is editable via the admin panel, so assert presence, not the exact seed value
    expect(typeof res.body.hero_title).toBe('string');
    expect(res.body.hero_title.length).toBeGreaterThan(0);
  });

  test('banners and billboards endpoints agree', async () => {
    const banners = await request(app).get('/api/banners').expect(200);
    const billboards = await request(app).get('/api/billboards').expect(200);
    expect(banners.body.length).toBe(billboards.body.length);
  });

  test('storefront order creation works without auth', async () => {
    const res = await request(app)
      .post('/api/orders')
      .send({
        customer_name: 'Test Customer',
        phone: '9000000000',
        address: 'Test Address, Test Area',
        city: 'Test City',
        state: 'Test State',
        pincode: '400001',
        total_price: 500,
        items: [{ product_id: 1, name: 'Organic Sugarcane Jaggery Cubes', weight: '500g', quantity: 1, price: 180 }],
      })
      .expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.orderId).toBeDefined();
  });

  test('COD checkout stores full customer details, location pin, and rejects invalid data', async () => {
    const orderPayload = {
      customer_name: 'COD Checkout Test',
      phone: '+91 98765 43210',
      email: 'cod@example.com',
      address: '12 Heritage Lane, Green Fields',
      landmark: 'Near Old Temple',
      city: 'Kolhapur',
      state: 'Maharashtra',
      pincode: '416001',
      notes: 'Ring the bell twice',
      latitude: 16.705, longitude: 74.243,
      map_link: 'https://maps.google.com/?q=16.705,74.243',
      payment_method: 'cod',
      total_price: 430,
      items: [{ product_id: 1, name: 'Organic Sugarcane Jaggery Cubes', weight: '500g', quantity: 1, price: 180 },
              { product_id: 6, name: 'Traditional Bilona A2 Desi Gir Cow Ghee', weight: '500ml', quantity: 1, price: 250 }],
    };
    const created = await request(app).post('/api/orders').send(orderPayload).expect(200);
    expect(created.body.success).toBe(true);
    const orderId = created.body.orderId;

    // Admin view exposes every field the COD form collected
    const loginRes = await request(app).post('/api/admin/login').send(ADMIN_USER).expect(200);
    const cookie = loginRes.headers['set-cookie'];
    const orders = await request(app).get('/api/orders').set('Cookie', cookie).expect(200);
    const saved = orders.body.find(o => o.id === orderId);
    expect(saved).toBeDefined();
    expect(saved.customer_name).toBe('COD Checkout Test');
    expect(saved.phone).toBe('9876543210'); // normalized to bare 10 digits
    expect(saved.email).toBe('cod@example.com');
    expect(saved.landmark).toBe('Near Old Temple');
    expect(saved.city).toBe('Kolhapur');
    expect(saved.state).toBe('Maharashtra');
    expect(saved.pincode).toBe('416001');
    expect(saved.notes).toBe('Ring the bell twice');
    expect(Number(saved.latitude)).toBeCloseTo(16.705, 5);
    expect(Number(saved.longitude)).toBeCloseTo(74.243, 5);
    expect(saved.map_link).toBe('https://maps.google.com/?q=16.705,74.243');
    expect(saved.payment_method).toBe('cod');
    expect(saved.items).toHaveLength(2);

    // Cleanup before validation checks (deleting is auth-only too)
    await request(app).delete(`/api/orders/${orderId}`).set('Cookie', cookie).expect(200);

    // Validation: each bad payload is rejected with 400 and a helpful message
    const bad = (field, override) =>
      request(app).post('/api/orders').send({ ...orderPayload, ...override }).then(res => {
        expect(res.status).toBe(400);
        expect(res.body.success).toBe(false);
        expect(res.body.errors.join(' ')).toMatch(field);
      });
    await bad(/name/i, { customer_name: '' });
    await bad(/mobile/i, { phone: '12345' });
    await bad(/address/i, { address: 'x' });
    await bad(/city/i, { city: '' });
    await bad(/pincode/i, { pincode: '12345' });
    await bad(/email/i, { email: 'not-an-email' });
    await bad(/coordinates/i, { latitude: 999, longitude: 0 });
  });

  test('admin can set a product image via direct URL and it reaches the storefront', async () => {
    // Login as admin
    const loginRes = await request(app)
      .post('/api/admin/login')
      .send(ADMIN_USER)
      .expect(200);
    const cookie = loginRes.headers['set-cookie'];

    const imageUrl = 'https://cdn.example.com/jaggery-photo.jpg';

    // Create a product with a direct image URL (multipart, as the admin form does)
    const created = await request(app)
      .post('/api/products')
      .set('Cookie', cookie)
      .field('name', 'Image URL Test Product')
      .field('price', '199')
      .field('image_url', imageUrl)
      .expect(200);
    expect(created.body.success).toBe(true);
    const productId = created.body.id;
    expect(productId).toBeDefined();

    // Storefront list endpoint exposes the URL exactly as provided
    const list = await request(app).get('/api/products').expect(200);
    const listed = list.body.find(p => p.id === productId);
    expect(listed).toBeDefined();
    expect(listed.image_url).toBe(imageUrl);

    // Updating the image to another URL is reflected too
    const newUrl = 'https://cdn.example.com/jaggery-photo-v2.jpg';
    const updated = await request(app)
      .put(`/api/products/${productId}`)
      .set('Cookie', cookie)
      .field('image_url', newUrl)
      .expect(200);
    expect(updated.body.success).toBe(true);
    const after = (await request(app).get('/api/products').expect(200)).body.find(p => p.id === productId);
    expect(after.image_url).toBe(newUrl);

    // Cleanup: soft-delete the test product
    await request(app)
      .delete(`/api/products/${productId}`)
      .set('Cookie', cookie)
      .expect(200);
  });

  test('admin can set a banner image via direct URL and it reaches the storefront', async () => {
    const loginRes = await request(app)
      .post('/api/admin/login')
      .send(ADMIN_USER)
      .expect(200);
    const cookie = loginRes.headers['set-cookie'];

    const imageUrl = 'https://cdn.example.com/banner-photo.jpg';

    // Create a banner with a direct image URL (multipart, as the admin form does)
    const created = await request(app)
      .post('/api/banners')
      .set('Cookie', cookie)
      .field('heading', 'Image URL Test Banner')
      .field('image_url', imageUrl)
      .expect(200);
    expect(created.body.success).toBe(true);
    const bannerId = created.body.id;
    expect(bannerId).toBeDefined();

    // Storefront carousel endpoint exposes the URL exactly as provided
    const list = await request(app).get('/api/banners').expect(200);
    const listed = list.body.find(b => b.id === bannerId);
    expect(listed).toBeDefined();
    expect(listed.image_url).toBe(imageUrl);

    // Updating the image to another URL is reflected too
    const newUrl = 'https://cdn.example.com/banner-photo-v2.jpg';
    const updated = await request(app)
      .put(`/api/banners/${bannerId}`)
      .set('Cookie', cookie)
      .field('image_url', newUrl)
      .expect(200);
    expect(updated.body.success).toBe(true);
    const after = (await request(app).get('/api/banners').expect(200)).body.find(b => b.id === bannerId);
    expect(after.image_url).toBe(newUrl);

    // Cleanup: banners are hard-deleted
    await request(app)
      .delete(`/api/banners/${bannerId}`)
      .set('Cookie', cookie)
      .expect(200);
  });
});
