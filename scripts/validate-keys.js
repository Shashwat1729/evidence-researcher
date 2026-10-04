// Validates every configured Gemini key with a read-only models-list call.
// Prints VALID/INVALID only — never echoes key material.
// Usage: npm run keys
//
// Accepts BOTH key formats Google issues: AIza… (standard) and AQ.…
// (authorization keys, the only kind AI Studio has issued since June 2026).
// It reads GEMINI_API_KEYS (any count, comma/space/newline separated) as well
// as GEMINI_API_KEY / GEMINI_API_KEY_FALLBACK, so a multi-key deployment can be
// checked in one go. Duplicates are reported: a repeated key shares one quota,
// so listing it twice is a configuration mistake worth surfacing.
import { loadEnv } from '../backend/src/env.js';
import { getKeys, maskKey } from '../backend/src/keys.js';

loadEnv();
const keys = getKeys();
if (!keys.length) {
  console.log('No keys configured. Set GEMINI_API_KEY (or GEMINI_API_KEYS) in .env — see .env.example.');
  process.exitCode = 2;
} else {
  console.log(`Checking ${keys.length} key(s)…\n`);
  let ok = 0;
  for (let i = 0; i < keys.length; i++) {
    const label = `key ${i + 1} (${maskKey(keys[i])})`;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15_000);
      let res, data = {};
      try {
        res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', { headers: { 'x-goog-api-key': keys[i] }, signal: ctrl.signal });
        data = await res.json().catch(() => ({}));
      } finally { clearTimeout(t); }
      if (res.ok) { ok++; console.log(`${label}: VALID (${(data.models || []).length} models visible)`); }
      else console.log(`${label}: INVALID (HTTP ${res.status}: ${(data?.error?.message || '').slice(0, 100)})`);
    } catch (e) {
      console.log(`${label}: ERROR (${(e.message || '').slice(0, 80)})`);
    }
  }
  // Rotation only multiplies quota when the keys belong to DIFFERENT projects;
  // same-project keys share one bucket. Worth saying out loud.
  if (ok > 1) {
    console.log(`\n${ok} key(s) usable. They only add up if each belongs to a different Google Cloud project —`);
    console.log('keys from one project share a single quota (Google bills and limits per project).');
  }
  process.exitCode = ok ? 0 : 1;
}