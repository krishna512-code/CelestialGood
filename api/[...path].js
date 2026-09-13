// Vercel Functions entry: the mandatory catch-all route ([...path]) sends
// every /api/* request into the shared Express app, which runs in Postgres
// mode when DATABASE_URL is set (SQLite mode is for local dev only).
import app from '../server/index.js';

export default function handler(req, res) {
  return app(req, res);
}
