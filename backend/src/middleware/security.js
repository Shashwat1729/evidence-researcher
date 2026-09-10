// Security + observability middleware — no external deps.
// - Request ID (X-Request-Id) for tracing
// - Security headers (minimal Helmet-equivalent)
// - CORS (configurable via CORS_ORIGIN)
// - Per-IP rate limiter (in-memory token bucket, for free-tier friendliness)

import { randomUUID } from 'node:crypto';

export function requestId(req, res, next) {
  req.id = req.headers['x-request-id'] || randomUUID().slice(0, 8);
  res.setHeader('X-Request-Id', req.id); // echo for client-side correlation
  next();
}

export function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // Minimal CSP for our zero-build frontend (inline styles/scripts allowed)
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

export function cors(req, res, next) {
  const origin = process.env.CORS_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-gemini-key, x-request-id');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

// Simple sliding-window per-IP limiter: max requests per windowMs.
// Used only for POST /api/research to protect free-tier quota.
export function createRateLimiter({ windowMs = 60_000, max = 30 } = {}) {
  const hits = new Map(); // ip -> { count, resetAt }
  const interval = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (now > v.resetAt) hits.delete(k);
  }, windowMs);
  // Allow the interval to not keep the process alive in tests
  if (interval.unref) interval.unref();

  return (req, res, next) => {
    const ip = req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
    const now = Date.now();
    let e = hits.get(ip);
    if (!e || now > e.resetAt) {
      e = { count: 1, resetAt: now + windowMs };
      hits.set(ip, e);
      return next();
    }
    e.count++;
    if (e.count > max) {
      res.setHeader('Retry-After', Math.ceil((e.resetAt - now) / 1000));
      return res.status(429).json({ error: 'Too many requests — please slow down.' });
    }
    next();
  };
}
