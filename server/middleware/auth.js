import bcrypt from 'bcryptjs';
import { supabase } from '../config/supabase.js';

// Verify Supabase JWT token and attach user info to request
export async function verifySupabaseToken(token) {
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

export function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

export function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

// Session guard for the local-admin fallback auth flow:
// expects req.session.userId to be populated by the cookie middleware.
export function requireAdmin(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.status(401).json({ error: 'Authentication required' });
}
