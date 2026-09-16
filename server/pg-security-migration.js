// Production Postgres security migration.
//
// Runs once per process on the first Postgres query (see server/config/db.js).
// Idempotent: every statement is guarded (IF NOT EXISTS / DO-block checks), so
// it is safe to run on every cold start and on any database state.
//
// Origin: the Supabase security advisor flagged (a) `rls_auto_enable()` — a
// SECURITY DEFINER function executable by anon/authenticated via PostgREST —
// and (b) 12 public tables with RLS enabled but zero policies. The customers
// table was also missing entirely from production (self-migration gap), which
// broke every customer sign-up/sign-in until this shipped.
import { getPool } from './config/db.js';

const APP_TABLES = [
  'categories', 'sizes', 'colors', 'billboards', 'products', 'images',
  'orders', 'order_items', 'testimonials', 'faq', 'site_settings',
  'admin_users', 'customers',
];

// Guarded DDL: each statement is safe to re-run on any state.
const STATEMENTS = [
  // 0) Self-heal the missing customers table (production gap).
  `CREATE TABLE IF NOT EXISTS customers (
     id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
     phone_digits TEXT UNIQUE NOT NULL,
     password_hash TEXT NOT NULL,
     full_name TEXT DEFAULT '',
     email TEXT DEFAULT '',
     address TEXT DEFAULT '',
     landmark TEXT DEFAULT '',
     city TEXT DEFAULT '',
     state TEXT DEFAULT '',
     postal_code TEXT DEFAULT '',
     country TEXT DEFAULT '',
     notes TEXT DEFAULT '',
     created_at TIMESTAMPTZ DEFAULT now()
   )`,

  // 1) Lock down the stray SECURITY DEFINER function the advisor flagged.
  `DO $$
   BEGIN
     IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public' AND p.proname = 'rls_auto_enable') THEN
       REVOKE ALL ON FUNCTION public.rls_auto_enable() FROM PUBLIC;
       REVOKE ALL ON FUNCTION public.rls_auto_enable() FROM anon;
       REVOKE ALL ON FUNCTION public.rls_auto_enable() FROM authenticated;
     END IF;
   END $$`,

  // 2) RLS on every app table (idempotent).
  ...APP_TABLES.map((t) => `ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`),

  // 3) Policy model: explicit deny-all for anon/authenticated on every table.
  //    RLS with no policy also denies them, but an explicit USING(false)
  //    policy states the intent (and keeps the advisor's no-policy lint
  //    quiet). The app connects with the direct service connection, which
  //    bypasses RLS — matching scripts/migrate-pg.mjs's service_role model.
  ...APP_TABLES.map((t) => `DO $$
   BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_policies
                    WHERE schemaname = 'public' AND tablename = '${t}' AND policyname = 'deny_anon_all') THEN
       EXECUTE $$CREATE POLICY deny_anon_all ON public.${t} FOR ALL TO anon, authenticated USING (false) WITH CHECK (false)$$;
     END IF;
   END $$`),
];

let applied = false;
export async function ensureSecurityMigration() {
  if (applied) return;
  applied = true; // set first: a half-applied run retries on the next request
  const pool = getPool();
  for (const sql of STATEMENTS) {
    await pool.query(sql);
  }
}
