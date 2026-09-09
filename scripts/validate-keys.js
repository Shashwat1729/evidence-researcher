// Validates configured Gemini keys with a read-only models-list call.
// Prints VALID/INVALID only — never echoes key material.
// Usage: npm run keys
import { loadEnv } from '../backend/src/env.js';

loadEnv();
const keys = [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_FALLBACK].filter(Boolean);
if (!keys.length) {
  console.log('No keys configured. Set GEMINI_API_KEY in .env (see .env.example).');
  process.exitCode = 2;
} else {
let ok = 0;
for (let i = 0; i < keys.length; i++) {
  const label = i === 0 ? 'primary ' : 'fallback';
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15_000);
    let res, data = {};
    try {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(keys[i])}`, { signal: ctrl.signal });
      data = await res.json().catch(() => ({}));
    } finally { clearTimeout(t); }
    if (res.ok) { ok++; console.log(`${label}: VALID (${(data.models || []).length} models visible)`); }
    else console.log(`${label}: INVALID (HTTP ${res.status}: ${(data?.error?.message || '').slice(0, 100)})`);
  } catch (e) {
    console.log(`${label}: ERROR (${(e.message || '').slice(0, 80)})`);
  }
}
process.exitCode = ok ? 0 : 1;
}
