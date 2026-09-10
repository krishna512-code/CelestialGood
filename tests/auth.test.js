// tests/auth.test.js
import request from 'supertest';
import app from '../../server/index.js';
import { db } from '../../server/config/db.js';
import { hashPassword } from '../../server/middleware/auth.js';

const ADMIN_USER = { username: 'testadmin', password: 'Password123!' };

beforeAll(() => {
  // Clean any existing test admin
  db.prepare('DELETE FROM admin_users WHERE username = ?').run(ADMIN_USER.username);
  const hash = hashPassword(ADMIN_USER.password);
  db.prepare('INSERT INTO admin_users (username, password_hash, role) VALUES (?, ?, ?)')
    .run(ADMIN_USER.username, hash, 'owner');
});

afterAll(() => {
  // Remove test admin
  db.prepare('DELETE FROM admin_users WHERE username = ?').run(ADMIN_USER.username);
});

describe('Admin Authentication', () => {
  test('Successful login returns session cookie', async () => {
    const res = await request(app)
      .post('/api/admin/login')
      .send({ username: ADMIN_USER.username, password: ADMIN_USER.password })
      .expect(200);
    expect(res.body.success).toBe(true);
    // Check Set-Cookie header
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

  test('Logout clears session', async () => {
    const loginRes = await request(app)
      .post('/api/admin/login')
      .send(ADMIN_USER);
    const cookie = loginRes.headers['set-cookie'];
    const logoutRes = await request(app)
      .post('/api/admin/logout')
      .set('Cookie', cookie)
      .expect(200);
    expect(logoutRes.body.success).toBe(true);
    // Subsequent protected request should be unauthorized
    await request(app)
      .get('/api/dashboard/stats')
      .set('Cookie', cookie)
      .expect(401);
  });
});
