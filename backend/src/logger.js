// Structured logger — zero dependencies, no secret leakage.
// LOG_LEVEL: debug|info|warn|error (default info). In production outputs
// single-line JSON, in development pretty-prints. Never logs key material.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const levelName = (process.env.LOG_LEVEL || 'info').toLowerCase();
const threshold = LEVELS[levelName] ?? LEVELS.info;
const isProd = process.env.NODE_ENV === 'production';

function redact(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const copy = Array.isArray(obj) ? [...obj] : { ...obj };
  for (const k of Object.keys(copy)) {
    if (/key|secret|token|auth/i.test(k) && typeof copy[k] === 'string') {
      copy[k] = '[REDACTED]';
    } else if (copy[k] && typeof copy[k] === 'object') {
      copy[k] = redact(copy[k]);
    }
  }
  return copy;
}

function log(lvl, msg, meta = {}) {
  if (LEVELS[lvl] < threshold) return;
  const entry = {
    time: new Date().toISOString(),
    level: lvl,
    msg,
    ...redact(meta),
  };
  const line = isProd ? JSON.stringify(entry) : `${entry.time} [${lvl.toUpperCase()}] ${msg}${Object.keys(meta).length ? ' ' + JSON.stringify(redact(meta)) : ''}`;
  const fn = lvl === 'error' ? console.error : lvl === 'warn' ? console.warn : console.log;
  fn(line);
}

export const logger = {
  debug: (m, meta) => log('debug', m, meta),
  info: (m, meta) => log('info', m, meta),
  warn: (m, meta) => log('warn', m, meta),
  error: (m, meta) => log('error', m, meta),
  child(bindings) {
    return {
      debug: (m, meta) => log('debug', m, { ...bindings, ...meta }),
      info: (m, meta) => log('info', m, { ...bindings, ...meta }),
      warn: (m, meta) => log('warn', m, { ...bindings, ...meta }),
      error: (m, meta) => log('error', m, { ...bindings, ...meta }),
    };
  },
};
