// tests/checkout-flow.test.js — end-to-end coverage for the sign-in-gated
// checkout, customer order history, and the admin order-management lifecycle.
// Runs against the unified app in SQLite mode (no DATABASE_URL), same as
// tests/auth.test.js.
import request from 'supertest';
import app from '../server/index.js';
import { run, queryOne } from '../server/config/db.js';
import { hashPassword } from '../server/middleware/auth.js';

const ADMIN_USER = { username: 'testadmin-e2e', password: 'Password123!' };

// The full order lifecycle the admin can move an order through.
const LIFECYCLE = ['confirmed', 'processing', 'packed', 'shipped', 'out_for_delivery', 'delivered'];

const CUSTOMER = {
  full_name: 'E2E Checkout Customer',
  phone: '+91 90000 11111',
  password: 'Password123!',
};
// phoneKey strips the 91 country code, so '+91 90000 11111' → '9000011111'
const CUSTOMER_KEY = '9000011111';

async function loginAdmin() {
  const res = await request(app).post('/api/admin/login').send(ADMIN_USER).expect(200);
  return res.headers['set-cookie'].map(c => c.split(';')[0]);
}

beforeAll(async () => {
  await run('DELETE FROM admin_users WHERE username = ?', [ADMIN_USER.username]);
  await run('DELETE FROM customers WHERE phone_digits = ?', [CUSTOMER_KEY]);
  await run(
    'INSERT INTO admin_users (username, password_hash, role) VALUES (?, ?, ?)',
    [ADMIN_USER.username, hashPassword(ADMIN_USER.password), 'owner']
  );
});

afterAll(async () => {
  await run('DELETE FROM admin_users WHERE username = ?', [ADMIN_USER.username]);
  await run('DELETE FROM customers WHERE phone_digits = ?', [CUSTOMER_KEY]);
  // Allow open handles (Supabase client keepalives) to settle
  await new Promise(r => setTimeout(r, 100));
});

describe('End-to-end checkout flow (sign-in gate → order → history → admin lifecycle)', () => {
  test('sign-in gate: browsing and carting stay public, ordering requires an account', async () => {
    // Catalog remains public
    await request(app).get('/api/products').expect(200);

    // A guest (no customer_session cookie) cannot place an order
    const guest = await request(app)
      .post('/api/orders')
      .send({
        customer_name: 'Guest Gate Test',
        phone: '9000011112',
        address: '1 Guest Lane, Somewhere',
        city: 'Kolhapur',
        pincode: '416001',
        total_price: 100,
        items: [{ name: 'Honey', quantity: 1, price: 100 }],
      })
      .expect(401);
    expect(guest.body.success).toBe(false);
    expect(guest.body.signInRequired).toBe(true);
    expect(guest.body.message).toMatch(/sign in/i);
  });

  test('customer signs in, places a COD order, and it lands in their order history', async () => {
    const reg = await request(app)
      .post('/api/account/register')
      .send(CUSTOMER)
      .expect(200);
    const custCookie = reg.headers['set-cookie'].map(c => c.split(';')[0]);

    const created = await request(app)
      .post('/api/orders')
      .set('Cookie', custCookie)
      .send({
        customer_name: CUSTOMER.full_name,
        phone: CUSTOMER.phone,
        email: 'e2e@example.com',
        address: '42 Order History Lane, Test Area',
        landmark: 'Near Test Tower',
        city: 'Kolhapur',
        state: 'Maharashtra',
        pincode: '416001',
        notes: 'E2E flow order',
        payment_method: 'cod',
        total_price: 430,
        items: [
          { product_id: 1, name: 'Organic Sugarcane Jaggery Cubes', weight: '500g', quantity: 1, price: 180 },
          { product_id: 6, name: 'Traditional Bilona A2 Desi Gir Cow Ghee', weight: '500ml', quantity: 1, price: 250 },
        ],
      })
      .expect(200);
    expect(created.body.success).toBe(true);
    const orderId = created.body.orderId;

    // The order row is bound to the customer account
    const row = await queryOne('SELECT customer_id, status, is_paid FROM orders WHERE id = ?', [orderId]);
    expect(Number(row.customer_id)).toBe(reg.body.customer.id);
    expect(row.status).toBe('pending');
    expect(Number(row.is_paid)).toBe(0);

    // History: the customer sees the order with its items
    const history = await request(app).get('/api/account/orders').set('Cookie', custCookie).expect(200);
    const mine = history.body.find(o => o.id === orderId);
    expect(mine).toBeDefined();
    expect(mine.status).toBe('pending');
    expect(mine.items).toHaveLength(2);

    // History is protected: no cookie → 401
    await request(app).get('/api/account/orders').expect(401);

    // Keep the order for the admin-lifecycle test (deleted in cleanup below)
    global.__e2eOrderId = orderId;
    global.__e2eCustCookie = custCookie;
  });

  test('admin manages the order through the full lifecycle (validated statuses)', async () => {
    const adminCookie = await loginAdmin();
    const orderId = global.__e2eOrderId;
    expect(orderId).toBeDefined();

    // Admin sees the order with items and customer details
    const list = await request(app).get('/api/orders').set('Cookie', adminCookie).expect(200);
    const saved = list.body.find(o => o.id === orderId);
    expect(saved).toBeDefined();
    expect(saved.customer_name).toBe(CUSTOMER.full_name);
    expect(saved.items).toHaveLength(2);

    // Walk the full lifecycle
    for (const status of LIFECYCLE) {
      const r = await request(app)
        .put(`/api/orders/${orderId}/status`)
        .set('Cookie', adminCookie)
        .send({ status })
        .expect(200);
      expect(r.body.success).toBe(true);
      const after = await queryOne('SELECT status FROM orders WHERE id = ?', [orderId]);
      expect(after.status).toBe(status);
    }

    // Marking as paid persists
    await request(app)
      .put(`/api/orders/${orderId}/status`)
      .set('Cookie', adminCookie)
      .send({ is_paid: true })
      .expect(200);
    expect(Number((await queryOne('SELECT is_paid FROM orders WHERE id = ?', [orderId])).is_paid)).toBe(1);

    // Invalid statuses are rejected with 400 — no silent garbage in the DB
    for (const bad of ['delivered; DROP TABLE orders', 'flying', '']) {
      await request(app)
        .put(`/api/orders/${orderId}/status`)
        .set('Cookie', adminCookie)
        .send({ status: bad })
        .expect(400);
    }

    // Unknown order → 404
    await request(app)
      .put('/api/orders/999999999/status')
      .set('Cookie', adminCookie)
      .send({ status: 'shipped' })
      .expect(404);

    // Status changes require admin auth
    await request(app)
      .put(`/api/orders/${orderId}/status`)
      .send({ status: 'cancelled' })
      .expect(401);

    // Customer sees the delivered status in their history
    const history = await request(app)
      .get('/api/account/orders')
      .set('Cookie', global.__e2eCustCookie)
      .expect(200);
    expect(history.body.find(o => o.id === orderId).status).toBe('delivered');

    // Cleanup
    await request(app).delete(`/api/orders/${orderId}`).set('Cookie', adminCookie).expect(200);
  });

  test('checkout page has no WhatsApp ordering hooks left in the storefront markup', async () => {
    // The shop page is served statically in sqlite mode; assert the deployed
    // markup no longer contains the removed WhatsApp ordering pieces.
    const shop = await request(app).get('/shop.html').expect(200);
    const html = shop.text;
    expect(html).not.toContain('product-wa');
    expect(html).not.toContain('whatsappProductUrl');
    expect(html).not.toContain('success-wa-btn');
    expect(html).not.toContain('Confirm on WhatsApp');
    // Sign-in gate + return-to-checkout wiring present
    expect(html).toContain('/account.html?next=checkout');
    expect(html).toContain('checkout=1');
  });
});
