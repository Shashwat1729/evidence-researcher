// Security + observability middleware — no external deps.
// - Request ID (X-Request-Id) for tracing
// - Security headers (minimal Helmet-equivalent)
// - CORS (configurable via CORS_ORIGIN)
// - Per-IP rate limiter (in-memory token bucket, for free-tier friendliness)

import { randomUUID } from 'node:crypto';

export function requestId(req, res, next) {
  // Client-supplied ids are echoed back as a header: restrict them to a safe
  // charset/length (a raw value with control chars made setHeader throw → 500).
  const given = String(req.headers['x-request-id'] || '');
  req.id = /^[A-Za-z0-9._-]{1,64}$/.test(given) ? given : randomUUID().slice(0, 8);
  res.setHeader('X-Request-Id', req.id); // echo for client-side correlation
  next();
}

export function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // CSP for the zero-build frontend: scripts are all external modules (no
  // inline script needed); inline styles stay allowed for rendered reports.
  // connect-src includes the Gemini API for in-browser key checks; fonts
  // come from Google Fonts (stylesheet + font files).
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://generativelanguage.googleapis.com; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

export function cors(req, res, next) {
  const origin = process.env.CORS_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  // Every header the frontend actually sends (multi-key + model picker were
  // missing, so cross-origin clients failed preflight with >1 key).
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-gemini-key, x-gemini-keys, x-gemini-model, x-request-id');
  res.setHeader('Access-Control-Expose-Headers', 'Retry-After, X-Request-Id, X-RateLimit-Remaining');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
}

// Dynamic sliding-window limiter with exponential backoff + Retry-After.
// Tracks per-IP request timestamps (not just count) for true sliding window.
// On downstream 429 (Gemini quota), it honors Retry-After and temporarily
// lowers the effective limit, then gradually recovers. Retries use
// exponential backoff with jitter to avoid thundering herd.
export function createRateLimiter({ windowMs = 60_000, max = 30, baseDelayMs = 1000, maxDelayMs = 60_000 } = {}) {
  const hits = new Map(); // ip -> { timestamps: number[], blockedUntil: number, consecutive429s: number }
  let dynamicMax = max;
  let last429At = 0;

  const interval = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) {
      // Clean old timestamps outside window
      v.timestamps = v.timestamps.filter(t => now - t < windowMs);
      if (v.timestamps.length === 0 && now > (v.blockedUntil || 0)) hits.delete(k);
    }
    // Gradually recover dynamicMax after 429s stop
    if (dynamicMax < max && now - last429At > windowMs * 2) {
      dynamicMax = Math.min(max, dynamicMax + 1);
    }
  }, Math.min(windowMs, 10000));
  if (interval.unref) interval.unref();

  // Called by gemini client when downstream returns 429 with Retry-After
  function recordDownstream429(retryAfterMs = 0) {
    last429At = Date.now();
    dynamicMax = Math.max(1, Math.floor(dynamicMax * 0.7));
    // Block all IPs briefly to let quota refill
    const blockUntil = Date.now() + Math.min(retryAfterMs || 15000, maxDelayMs);
    for (const v of hits.values()) {
      v.blockedUntil = Math.max(v.blockedUntil || 0, blockUntil);
      v.consecutive429s = (v.consecutive429s || 0) + 1;
    }
  }

  const middleware = (req, res, next) => {
    const ip = req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
    const now = Date.now();
    let e = hits.get(ip);
    if (!e) {
      e = { timestamps: [], blockedUntil: 0, consecutive429s: 0 };
      hits.set(ip, e);
    }

    // Check if blocked due to downstream 429
    if (now < e.blockedUntil) {
      const waitSec = Math.ceil((e.blockedUntil - now) / 1000);
      res.setHeader('Retry-After', waitSec);
      res.setHeader('X-RateLimit-Reason', 'downstream-quota');
      return res.status(429).json({
        error: `Upstream quota exceeded — retry after ${waitSec}s. Try fewer searches or wait a moment.`,
        retryAfter: waitSec
      });
    }

    // Clean old timestamps
    e.timestamps = e.timestamps.filter(t => now - t < windowMs);

    // Check limit with dynamic max
    const effectiveMax = e.consecutive429s > 2 ? Math.max(1, Math.floor(dynamicMax * 0.5)) : dynamicMax;
    if (e.timestamps.length >= effectiveMax) {
      const oldest = e.timestamps[0];
      const waitMs = windowMs - (now - oldest);
      const waitSec = Math.ceil(waitMs / 1000);
      // Exponential backoff based on consecutive 429s
      const backoffMs = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, e.consecutive429s));
      const finalWait = Math.max(waitMs, backoffMs);
      res.setHeader('Retry-After', Math.ceil(finalWait / 1000));
      res.setHeader('X-RateLimit-Remaining', '0');
      return res.status(429).json({
        error: `Rate limit exceeded — ${e.timestamps.length} requests in ${windowMs/1000}s. Retry after ${Math.ceil(finalWait/1000)}s.`,
        retryAfter: Math.ceil(finalWait / 1000)
      });
    }

    // Record this request
    e.timestamps.push(now);
    e.consecutive429s = Math.max(0, e.consecutive429s - 0.5); // gradual recovery on success
    res.setHeader('X-RateLimit-Remaining', String(effectiveMax - e.timestamps.length));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil((e.timestamps[0] + windowMs - now) / 1000)));

    // Attach retry helper to res for downstream handlers to use
    res.locals = res.locals || {};
    res.locals.recordDownstream429 = recordDownstream429;

    next();
  };

  middleware.recordDownstream429 = recordDownstream429;
  middleware.getStats = () => ({ dynamicMax, totalIPs: hits.size, last429At });
  return middleware;
}
