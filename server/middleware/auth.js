import bcrypt from 'bcryptjs';

export function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

export function verifyPassword(password, hash) {
  return bcrypt.compareSync(password, hash);
}

export function requireAdmin(req, res, next) {
  if (req.session && req.session.userId) return next();
  res.status(401).json({ error: 'Authentication required' });
}
