// Vercel Functions entry point: routes every /api/* request into the shared
// Express app (which runs in Postgres mode when DATABASE_URL is set).
import app from '../server/index.js';

export default function handler(req, res) {
  return app(req, res);
}
