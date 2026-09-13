import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

// Accepts both naming schemes:
//  - classic:  NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY / SUPABASE_SERVICE_KEY
//  - current Supabase dashboard "Copy .env": SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY / SUPABASE_SECRET_KEY
export const SUPABASE_URL =
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
export const SUPABASE_PUBLISHABLE_KEY =
  process.env.SUPABASE_PUBLISHABLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
// service/secret key — required for Storage uploads once RLS is enabled.
// Never expose this to the browser.
export const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !(SUPABASE_PUBLISHABLE_KEY || SUPABASE_SERVICE_KEY)) {
  throw new Error(
    'Supabase is not configured. Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY ' +
    '(NEXT_PUBLIC_* variants also accepted) and optionally SUPABASE_SECRET_KEY in the environment.'
  );
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY || SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: false },
});
