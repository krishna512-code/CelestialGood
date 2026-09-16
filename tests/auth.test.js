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

  test('admin and customer sessions use separate cookies (no overwrite)', async () => {
    // Cookie names must differ — a customer sign-in used to clobber the admin
    // session on the same device, 401-ing every admin save.
    const adminRes = await request(app)
      .post('/api/admin/login')
      .send({ username: ADMIN_USER.username, password: ADMIN_USER.password })
      .expect(200);
    const adminCookie = adminRes.headers['set-cookie'].find(c => c.startsWith('session='));
    const custRes = await request(app)
      .post('/api/account/register')
      .send({ full_name: 'Cookie Test', phone: '+44 7666 444333', password: 'Password123!' })
      .expect(200);
    const custCookie = custRes.headers['set-cookie'].find(c => c.startsWith('customer_session='));

    expect(adminCookie).toBeDefined();
    expect(custCookie).toBeDefined();

    // Both sessions valid simultaneously on the same cookie jar
    const jar = [adminCookie.split(';')[0], custCookie.split(';')[0]].join('; ');
    await request(app).get('/api/admin/me').set('Cookie', jar).expect(200);
    await request(app).get('/api/account/me').set('Cookie', jar).expect(200);

    // Customer logout clears only its own cookie
    const out = await request(app).post('/api/account/logout').set('Cookie', jar).expect(200);
    expect(out.headers['set-cookie'].join(' ')).toMatch(/customer_session=;/);
    await request(app).get('/api/admin/me').set('Cookie', jar).expect(200);

    await run('DELETE FROM customers WHERE phone_digits = ?', ['447666444333']);
  });

  test('customer accounts: international register, login, profile edit, and phone-matched order history', async () => {
    const ukPhone = '+44 7911 123456';
    const bareDigits = '447911123456';
    const inDigits = '9876543210';
    // Idempotent across runs: remove any leftover rows from earlier attempts
    await run('DELETE FROM customers WHERE phone_digits IN (?, ?, ?)', [bareDigits, inDigits, '7911123456']);

    // Register (international phone) -> auto sign-in cookie
    const reg = await request(app)
      .post('/api/account/register')
      .send({ full_name: 'Nigel test', phone: ukPhone, email: 'nigel@example.co.uk', password: 'Password123!' })
      .expect(200);
    expect(reg.body.success).toBe(true);
    expect(reg.body.customer.phone).toBe(bareDigits);
    const cookie = reg.headers['set-cookie'];

    // Duplicate registration rejected — same number, different formatting
    await request(app)
      .post('/api/account/register')
      .send({ full_name: 'Nigel Again', phone: '+447911123456', password: 'Password123!' })
      .expect(409);

    // me() returns the profile
    const me = await request(app).get('/api/account/me').set('Cookie', cookie).expect(200);
    expect(me.body.signedIn).toBe(true);
    expect(me.body.customer.phone_digits).toBe(bareDigits);

    // Profile edit persists (address block + country)
    const upd = await request(app)
      .put('/api/account/profile')
      .set('Cookie', cookie)
      .send({
        full_name: 'Nigel Test', email: 'nigel@example.co.uk', country: 'United Kingdom',
        address: '10 Downing Street', landmark: 'Near the cat', postal_code: 'SW1A 1AA',
        city: 'London', state: 'Greater London',
      })
      .expect(200);
    expect(upd.body.customer.postal_code).toBe('SW1A 1AA');
    expect(upd.body.customer.country).toBe('United Kingdom');

    // A GUEST order placed with the same UK phone appears in history
    await request(app)
      .post('/api/orders')
      .send({
        customer_name: 'Nigel Guest', phone: '+44 7911 123456', address: '10 Downing Street, Whitehall',
        city: 'London', postal_code: 'SW1A 1AA', total_price: 180,
        items: [{ name: 'Jaggery Cubes', weight: '500g', quantity: 1, price: 180 }],
      })
      .expect(200);

    // ...and an India-equivalence guest order (0-prefix variant)
    const inPhone = '+91 98765 43210';
    await request(app).post('/api/account/register')
      .send({ full_name: 'Asha Test', phone: inPhone, password: 'Password123!' }).expect(200);
    const inCookie = (await request(app).post('/api/account/login')
      .send({ phone: '09876543210', password: 'Password123!' }).expect(200)).headers['set-cookie'];
    await request(app)
      .post('/api/orders')
      .send({
        customer_name: 'Asha Guest', phone: '9876543210', address: '5 MG Road, Area',
        city: 'Kolhapur', postal_code: '416001', total_price: 320,
        items: [{ name: 'Honey', weight: '250g', quantity: 1, price: 320 }],
      })
      .expect(200);

    const orders = await request(app).get('/api/account/orders').set('Cookie', cookie).expect(200);
    expect(Array.isArray(orders.body)).toBe(true);
    expect(orders.body.length).toBeGreaterThanOrEqual(1);
    expect(orders.body[0].status).toBeDefined();
    expect(orders.body[0].items.length).toBe(1);

    const inOrders = await request(app).get('/api/account/orders').set('Cookie', inCookie).expect(200);
    expect(inOrders.body.length).toBeGreaterThanOrEqual(1);

    // Signed-out access to protected account routes is rejected
    await request(app).get('/api/account/orders').expect(401);
    await request(app).put('/api/account/profile').send({ full_name: 'X Y' }).expect(401);

    // Logout instructs the browser to drop the stateless session cookie
    // (same design as admin sessions — expiry encoded in the cookie).
    const logoutRes = await request(app).post('/api/account/logout').set('Cookie', cookie).expect(200);
    const setC = logoutRes.headers['set-cookie'].join(';');
    expect(setC).toMatch(/session=;/); // value emptied
    expect(setC).toMatch(/Expires=Thu, 01 Jan 1970/); // expiry in the past

    // Cleanup customers created here
    await run('DELETE FROM customers WHERE phone_digits IN (?, ?)', [bareDigits, inDigits]);
  });

  test('a Supabase-JWT-shaped session cookie does NOT grant access without verification', async () => {
    // Security regression guard: requireAuth used to trust the mere PRESENCE
    // of a JWT-shaped cookie — a fabricated token granted full admin
    // (confirmed exploitable in production). It must now be verified
    // server-side; a fabricated signature is rejected.
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'user-123', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
    const jwt = header + '.' + payload + '.fake-signature';
    const cookie = 'session=' + encodeURIComponent(Buffer.from(jwt).toString('base64'));

    await request(app)
      .get('/api/dashboard/stats')
      .set('Cookie', cookie)
      .expect(401);
  });

  test('unsigned and tampered session cookies are rejected (HMAC enforcement)', async () => {
    // Pre-hardening forge: plain base64 JSON with no signature at all.
    const legacy = Buffer.from(JSON.stringify({ userId: 1, expiry: Date.now() + 3600_000 })).toString('base64');
    await request(app).get('/api/dashboard/stats').set('Cookie', 'session=' + encodeURIComponent(legacy)).expect(401);

    // Tampered payload: take a legitimately signed cookie and change the body.
    const { signValue, verifyValue } = await import('../server/session-hardening.js');
    const signed = signValue({ userId: 1, expiry: Date.now() + 3600_000 });
    const [payloadB64] = signed.split('.');
    const forgedObj = JSON.parse(Buffer.from(payloadB64, 'base64').toString());
    forgedObj.userId = 999;
    const tampered = Buffer.from(JSON.stringify(forgedObj)).toString('base64') + '.' + signed.split('.')[1];
    expect(verifyValue(tampered)).toBeNull();

    // A validly signed customer cookie still verifies.
    expect(verifyValue(signValue({ customerId: 42, expiry: Date.now() + 60_000 }))).toMatchObject({ customerId: 42 });
  });

  test('rate limiting blocks request floods on public endpoints', async () => {
    // Enabled directly (the suite disables the limiter globally via env).
    const { rateLimit } = await import('../server/session-hardening.js');
    const express = (await import('express')).default;
    // The suite runs with DISABLE_RATE_LIMIT=1 (so fixture traffic isn't
    // throttled); re-enable it for this test only.
    const prevFlag = process.env.DISABLE_RATE_LIMIT;
    delete process.env.DISABLE_RATE_LIMIT;
    try {
      const mini = express();
      mini.use(express.json());
      mini.post('/hit', rateLimit({ windowMs: 60_000, max: 3, keyBy: (req) => String(req.body?.phone ?? '') }), (_req, res) => res.json({ ok: true }));
      mini.use((err, _req, res, _next) => res.status(500).json({ error: String(err) }));

      for (let i = 0; i < 3; i++) {
        await request(mini).post('/hit').send({ phone: '999' }).expect(200);
      }
      const r4 = await request(mini).post('/hit').send({ phone: '999' });
      expect(r4.status).toBe(429);
      expect(r4.headers['retry-after']).toBeDefined();
      // A different identity (keyBy) gets its own budget.
      await request(mini).post('/hit').send({ phone: '888' }).expect(200);
      // And a limited method mix: only POST counts when methods is set.
      const mini2 = express();
      mini2.use(express.json());
      mini2.post('/x', rateLimit({ max: 1, methods: ['POST'] }), (_q, res) => res.json({ ok: true }));
      mini2.get('/x', (_q, res) => res.json({ ok: true }));
      await request(mini2).post('/x').expect(200);
      await request(mini2).get('/x').expect(200); // GET untouched
      await request(mini2).post('/x').expect(429);
    } finally {
      if (prevFlag !== undefined) process.env.DISABLE_RATE_LIMIT = prevFlag;
    }
  });

  test('async handler rejections return 500 JSON instead of crashing the process', async () => {
    // Inject a route that always throws; the wrapper must convert it to a 500
    // and the server must keep serving afterwards.
    const { asyncRoute } = await import('../server/session-hardening.js');
    const express = (await import('express')).default;
    const mini = express();
    mini.get('/boom', asyncRoute(async () => { throw new Error('boom'); }));
    mini.use((err, _req, res, _next) => res.status(500).json({ error: 'Internal server error.' }));
    await request(mini).get('/boom').expect(500, { error: 'Internal server error.' });
    // And the REAL app is still healthy after everything above.
    await request(app).get('/api/health').expect(200);
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
    // Seeded catalog has 8 products; the live-managed DB may have some
    // deactivated, so assert against the seed minimum only.
    expect(res.body.length).toBeGreaterThanOrEqual(6);
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

  test('public order endpoint sanitizes map_link and tolerates malformed items', async () => {
    const loginRes = await request(app).post('/api/admin/login').send(ADMIN_USER).expect(200);
    const cookie = loginRes.headers['set-cookie'];

    // javascript: scheme must be dropped; https link preserved; null/non-object
    // items and non-integer product_id must not hang the request or throw.
    const created = await request(app)
      .post('/api/orders')
      .send({
        customer_name: 'Sanitize Test',
        phone: '9876500000',
        address: '1 Test Lane, Somewhere',
        city: 'Kolhapur',
        state: 'Maharashtra',
        pincode: '416001',
        map_link: 'javascript:alert(document.cookie)',
        total_price: 100,
        items: [null, { product_id: 'abc', name: 'Weird Product', quantity: 2, price: 50 }, { name: 'No Id Item', quantity: 1, price: 50 }],
      })
      .expect(200);
    expect(created.body.success).toBe(true);
    const orderId = created.body.orderId;

    const orders = await request(app).get('/api/orders').set('Cookie', cookie).expect(200);
    const saved = orders.body.find(o => o.id === orderId);
    expect(saved).toBeDefined();
    expect(saved.map_link).toBe(''); // javascript: scheme stripped
    expect(saved.items).toHaveLength(3); // null item normalized, all stored
    expect(saved.items[0].product_id).toBeNull();
    expect(saved.items[1].product_id).toBeNull(); // 'abc' not an integer id
    expect(saved.items[1].quantity).toBe(2);

    // https map_link is preserved
    const ok = await request(app)
      .post('/api/orders')
      .send({
        customer_name: 'Sanitize Test Two',
        phone: '9876500001',
        address: '2 Test Lane, Somewhere',
        city: 'Kolhapur',
        state: 'Maharashtra',
        pincode: '416001',
        map_link: 'https://maps.google.com/?q=16.7,74.2',
        total_price: 50,
        items: [{ name: 'X', quantity: 1, price: 50 }],
      })
      .expect(200);
    const orders2 = await request(app).get('/api/orders').set('Cookie', cookie).expect(200);
    const saved2 = orders2.body.find(o => o.id === ok.body.orderId);
    expect(saved2.map_link).toBe('https://maps.google.com/?q=16.7,74.2');

    await request(app).delete(`/api/orders/${orderId}`).set('Cookie', cookie).expect(200);
    await request(app).delete(`/api/orders/${ok.body.orderId}`).set('Cookie', cookie).expect(200);
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
    expect(saved.phone).toBe('919876543210'); // digits kept, country code preserved
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
    await bad(/phone/i, { phone: '12345' });
    await bad(/address/i, { address: 'x' });
    await bad(/city/i, { city: '' });
    await bad(/postal/i, { pincode: '##' }); // non-alphanumeric postal code
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
