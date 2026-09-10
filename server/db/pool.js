// server/db/pool.js
import { Pool } from 'pg';

// Use DATABASE_URL from environment (Railway provides it)
const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.error('❌ DATABASE_URL environment variable is not set');
  process.exit(1);
}

export const pool = new Pool({
  connectionString,
  // Optional SSL for Railway
  ssl: { rejectUnauthorized: false }
});

// Export a helper to run queries with automatic error handling
export async function query(text, params) {
  const client = await pool.connect();
  try {
    const res = await client.query(text, params);
    return res;
  } finally {
    client.release();
  }
}
