// Session hardening: HMAC-signed cookies + client-IP extraction + rate limiting
// + an async route wrapper with a global error handler.
//
// Why: session cookies were plain base64 JSON — anyone could mint an admin
// session with `base64({"userId":1,"expiry":...})` and no password (verified
// live against production). Cookies are now `payload.signature`; the signature
// is HMAC-SHA256 over exactly the payload bytes, keyed by SESSION_SECRET.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IS_PROD = process.env.NODE_ENV === 'production';

// ---------------------------------------------------------------------------
// Secret resolution (stable value, never logged, never committed)
// ---------------------------------------------------------------------------
// Priority: explicit SESSION_SECRET > persisted local dev file > derived from
// DATABASE_URL (prod fallback: stable across serverless instances without
// living in the repo). A blank/absent secret in prod would log everyone out
// on every cold start, so the DATABASE_URL derivation is the safety net.
let cachedSecret = null;
function sessionSecret() {
  if (cachedSecret) return cachedSecret;
  const explicit = (process.env.SESSION_SECRET || '').trim();
  if (explicit) {
    cachedSecret = explicit;
    return cachedSecret;
  }
  if (!IS_PROD) {
    try {
      const f = path.join(__dirname, '..', '.session-secret');
      if (fs.existsSync(f)) {
        cachedSecret = fs.readFileSync(f, 'utf8').trim();
        if (cachedSecret) return cachedSecret;
      }
      cachedSecret = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(f, cachedSecret, { mode: 0o600 });
      return cachedSecret;
    } catch {
      // fall through to DATABASE_URL derivation
    }
  }
  cachedSecret = crypto
    .createHash('sha256')
    .update(`celestial-session:${process.env.DATABASE_URL || ''}`)
    .digest('hex');
  return cachedSecret;
}

function hmac(payload) {
  return crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
}

// Sign: value is raw JSON; store payload+signature (payload kept verbatim so
// the signature covers the exact bytes — no re-serialization drift).
export function signValue(obj) {
  const payload = Buffer.from(JSON.stringify(obj)).toString('base64');
  return `${payload}.${hmac(payload)}`;
}

// Verify + parse. Returns the parsed object, or null for ANY failure:
// bad structure, unknown scheme (e.g. a legacy unsigned cookie), wrong
// signature, or expiry in the past. Old unsigned cookies stop working —
// that is the point; users just sign in again once.
export function verifyValue(raw) {
  if (typeof raw !== 'string') return null;
  const dot = raw.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = hmac(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64').toString());
    if (!data || typeof data.expiry !== 'number' || data.expiry <= Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Client IP (for rate limiting behind Vercel/Express)
// ---------------------------------------------------------------------------
export function clientIp(req) {
  if (process.env.TRUST_PROXY === '1') {
    // x-real-ip is set by the platform and not client-spoofable; x-forwarded-for
    // chains can carry client-supplied values, so it's the fallback.
    if (req.headers['x-real-ip']) return String(req.headers['x-real-ip']);
    const xff = String(req.headers['x-forwarded-for'] || '');
    if (xff) return xff.split(',')[0].trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

// ---------------------------------------------------------------------------
// Rate limiter — dependency-free fixed-window counter.
// Maps: path -> Map<key, { count, windowStart }>. key = ip + ':' + identity
// (identity distinguishes accounts behind a shared NAT/VPN for login routes).
// Periodic sweep bounds memory; entries self-expire after 15 idle minutes.
// ---------------------------------------------------------------------------
const RL_WIN = 60_000;
const RL_MAX_AGE = 15 * 60_000;
const rlBuckets = new Map();
let rlLastSweep = Date.now();

function rlSweep(now) {
  if (now - rlLastSweep < RL_WIN) return;
  rlLastSweep = now;
  for (const [p, m] of rlBuckets) {
    for (const [k, v] of m) {
      if (now - v.windowStart > RL_MAX_AGE) m.delete(k);
    }
    if (m.size === 0) rlBuckets.delete(p);
  }
}

export function rateLimit({ windowMs = RL_WIN, max, keyBy, methods } = {}) {
  return (req, res, next) => {
    if (process.env.DISABLE_RATE_LIMIT === '1') return next();
    if (methods && !methods.includes(req.method)) return next();
    const now = Date.now();
    rlSweep(now);
    let bucket = rlBuckets.get(req.path);
    if (!bucket) rlBuckets.set(req.path, (bucket = new Map()));
    const key = clientIp(req) + (keyBy ? ':' + keyBy(req) : '');
    let e = bucket.get(key);
    if (!e || now - e.windowStart >= windowMs) {
      e = { count: 0, windowStart: now };
      bucket.set(key, e);
    }
    e.count++;
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - e.count)));
    if (e.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((e.windowStart + windowMs - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests. Please slow down and try again shortly.' });
    }
    next();
  };
}

// ---------------------------------------------------------------------------
// Async route wrapper + global error handler.
// Express 4 does not catch thrown/rejected errors from async handlers — one
// bad request used to become an unhandled rejection that KILLED the process.
// asyncRoute(fn) forwards rejections to next(); errorHandler turns them into
// a logged 500 without touching other requests.
// ---------------------------------------------------------------------------
export function asyncRoute(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

export function errorHandler(err, req, res, _next) {
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ->`, err && (err.stack || err.message || err));
  if (res.headersSent) return;
  res.status(err && err.status ? err.status : 500).json({ error: 'Internal server error.' });
}
