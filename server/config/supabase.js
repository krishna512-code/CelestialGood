import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
export const SUPABASE_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
// service_role key — required for Storage uploads once RLS is enabled, and for
// admin operations. Never expose this to the browser.
export const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !(SUPABASE_PUBLISHABLE_KEY || SUPABASE_SERVICE_KEY)) {
  throw new Error(
    'Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and ' +
    'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY (and optionally SUPABASE_SERVICE_KEY) in .env'
  );
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY || SUPABASE_PUBLISHABLE_KEY, {
  auth: { persistSession: false },
});
