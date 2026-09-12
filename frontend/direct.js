// Browser-direct research mode for static hosting (GitHub Pages).
// Runs the SAME engine as the server (shared modules under ../backend/src)
// with a user-supplied Gemini key (BYOK). History lives in localStorage.
// No secrets are persisted except the user-opted browser-local key itself.
//
// Honest limits of static mode (shown in the UI): arbitrary page fetching may
// be blocked by site CORS policies (recorded as inaccessible, never bypassed);
// grounding excerpts + CORS-open academic APIs still provide cited evidence.
import { runResearch } from '../backend/src/engine/orchestrator.js';

/** Minimal `process` safety net for shared modules that read env optionally.
 *  Injectable global makes it unit-testable without touching the real one.
 *  Every read site must still prefer explicit guards; this only prevents
 *  hard crashes on paths nobody predicted. */
export function ensureProcessShim(g = globalThis) {
  if (g.process && g.process.env) return g.process;
  g.process = {
    env: (g.process && g.process.env) || {},
    pid: 0,
    uptime: () => 0,
    memoryUsage: () => ({}),
    versions: {},
  };
  return g.process;
}
ensureProcessShim();

/** True when no same-origin API is reachable (pure static host). */
export async function apiAvailable(base = '') {
  try {
    const res = await fetch(`${base}/api/config`, { cache: 'no-store' });
    if (!res.ok) return false;
    const cfg = await res.json().catch(() => null);
    return !!(cfg && Array.isArray(cfg.modes));
  } catch {
    return false;
  }
}

export async function runDirect(input, { key, emit = () => {}, deps = {} } = {}) {
  if (!key) {
    throw Object.assign(new Error('Enter a Gemini API key to run in static mode.'), { status: 401 });
  }
  return runResearch(input, { key, emit, deps });
}

const RESULT_PREFIX = 'er_result_';
const MAX_STORED = 3_500_000; // localStorage safety cap per result

export function saveLocalResult(result) {
  try {
    if (typeof localStorage === 'undefined' || !result?.id) return false;
    const raw = JSON.stringify(result);
    if (raw.length > MAX_STORED) return false;
    localStorage.setItem(RESULT_PREFIX + result.id, raw);
    return true;
  } catch {
    return false; // quota/full/blocked storage must never break the run
  }
}

export function loadLocalResult(id) {
  try {
    if (typeof localStorage === 'undefined') return null;
    return JSON.parse(localStorage.getItem(RESULT_PREFIX + id) || 'null');
  } catch {
    return null;
  }
}
