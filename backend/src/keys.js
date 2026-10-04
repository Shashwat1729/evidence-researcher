// Gemini API-key shapes, limits, masking and input parsing — ONE source of
// truth for the server, the CLI and the browser (the static Pages build
// imports backend/src/* straight into the page, so this module must stay
// browser-safe: no node built-ins, `process` guarded).
//
// Google issues TWO key formats (ai.google.dev/gemini-api/docs/api-key):
//   • "AIza…"  legacy *standard* keys, bound to a Cloud project for quota.
//   • "AQ.…"   *authorization* keys, bound to a service account. AI Studio has
//              issued ONLY these since June 2026.
// This repo used to gate on the "AIza" prefix alone. Every AQ key was
// therefore reported "Invalid format" and the UI then told the user it had
// "removed N keys that did not work" — for keys that worked perfectly.
// Gating on a prefix is also the wrong idea in principle: only the live call
// can decide whether a key works, so the format check is a cheap typo filter
// (it also keeps /keys/validate from being an open key-probing oracle) and
// nothing more.

const env = (typeof process !== 'undefined' && process.env) || {};

/** Prefixes Google currently issues. Anything else is a typo, not a key. */
export const KEY_PREFIXES = ['AIza', 'AQ.'];

/**
 * Shape filter: strict on the prefix (keeps junk out of a network call),
 * permissive on the body (base64url + '.' + '-' + '_'). Deliberately NOT a
 * length-pinned regex — Google has shipped at least three key lengths and
 * pinning one is exactly how valid keys get thrown away.
 */
export const KEY_SHAPE = /^(?:AIza|AQ\.)[A-Za-z0-9._-]{20,}$/;

/** 'auth' for AQ. authorization keys, 'standard' for AIza, else 'unknown'. */
export function keyKind(key) {
  const k = String(key || '').trim();
  if (k.startsWith('AQ.')) return 'auth';
  if (k.startsWith('AIza')) return 'standard';
  return 'unknown';
}

/** Human label for the UI/report. */
export function keyKindLabel(kind) {
  return kind === 'auth' ? 'authorization key (AQ.)'
    : kind === 'standard' ? 'standard key (AIza…)'
      : 'key';
}

/** Cheap pre-flight typo filter. Never the arbiter of whether a key works. */
export function looksLikeKey(key) {
  return KEY_SHAPE.test(String(key || '').trim());
}

/** Mask a key for display: never more than the first 6 + last 4 chars. */
export function maskKey(k) {
  const s = String(k || '');
  return s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : (s ? `${s.slice(0, 2)}…` : '(empty)');
}

/**
 * How many keys one request may carry. Dynamic on purpose: the old hard cap of
 * 5 was arbitrary, and because the frontend truncated pasted lists to 5 the UI
 * silently DISCARDED keys the user had typed — the reason "saved 1 key" showed
 * up next to six pasted ones. Env-tunable, hard-bounded so a fat-fingered
 * value can't turn this into a 10k-key rotation list.
 */
export function maxKeys() {
  const raw = Number(env.MAX_KEYS_PER_REQUEST);
  const n = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 25;
  return Math.min(Math.max(n, 1), 200);
}

/**
 * Parse a pasted blob into individual keys. Accepts a JSON array, one key per
 * line, or any comma/semicolon/space separated list — the three shapes people
 * actually paste from AI Studio, .env files and password managers.
 * Keys never contain whitespace, so whitespace is a safe separator.
 */
export function splitKeyInput(raw) {
  const out = [];
  const text = String(raw ?? '').trim();
  if (!text) return out;
  if (text.startsWith('[')) {
    try {
      const arr = JSON.parse(text);
      if (Array.isArray(arr)) return arr.map((k) => String(k || '').trim()).filter(Boolean);
    } catch { /* not JSON after all — fall through to text splitting */ }
  }
  for (const part of text.split(/[\s,;]+/)) {
    const k = part.trim();
    if (k) out.push(k);
  }
  return out;
}

/**
 * Order-preserving dedupe. Returns the duplicate count too, because silently
 * swallowing a repeated key hides a real user mistake (pasting the same key
 * twice and believing they supplied two quotas).
 */
export function dedupeKeys(list) {
  const seen = new Set();
  const keys = [];
  let duplicates = 0;
  for (const raw of list || []) {
    const k = String(raw || '').trim();
    if (!k) continue;
    if (seen.has(k)) { duplicates++; continue; }
    seen.add(k);
    keys.push(k);
  }
  return { keys, duplicates };
}

/** Parse + dedupe + cap in one call — the shape every caller actually wants. */
export function normalizeKeys(input, limit = maxKeys()) {
  const listed = Array.isArray(input) ? input : splitKeyInput(input);
  const { keys, duplicates } = dedupeKeys(listed);
  const capped = keys.slice(0, Math.max(0, limit));
  return { keys: capped, duplicates, dropped: Math.max(0, keys.length - capped.length) };
}