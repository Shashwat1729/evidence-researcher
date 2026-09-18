// Minimal Gemini REST client (no SDK dependency).
// Uses generateContent with google_search grounding, url_context, and
// structured JSON outputs (responseMimeType + responseSchema).
// Docs: ai.google.dev/gemini-api/docs/{google-search,url-context,structured-output}

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export function getKey(explicit) {
  return getKeys(explicit)[0] || '';
}

/** Ordered key list: explicit BYOK (string, array, or comma-separated) → server primary → server
 *  fallback (deduped, capped). Rotation in post() cycles this list, so N user
 *  keys multiply effective quota instead of failing over once.
 *  Handles comma, newline, and JSON-array formats from multi-key UI.
 *  Browser-safe (`process` guarded) for the static Pages build. */
export function getKeys(explicit) {
  const penv = (typeof process !== 'undefined' && process.env) || {};
  let listed = [];
  if (Array.isArray(explicit)) {
    listed = explicit;
  } else if (typeof explicit === 'string' && explicit.trim().startsWith('[')) {
    try { listed = JSON.parse(explicit); } catch { listed = [explicit]; }
  } else if (typeof explicit === 'string' && explicit.includes(',')) {
    listed = explicit.split(/[,;\n]+/);
  } else {
    listed = [explicit];
  }
  const list = [
    ...listed.map((k) => String(k || '').trim()).filter(Boolean),
    (penv.GEMINI_API_KEY || '').trim(),
    (penv.GEMINI_API_KEY_FALLBACK || '').trim(),
  ].filter(Boolean);
  return [...new Set(list)].slice(0, 6);
}

function endpoint(model, key) {
  return `${API_BASE}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
}

// Even distribution + per-key blocking for multi-key setups.
// Keys from DIFFERENT projects have independent quotas — even round-robin
// multiplies throughput. Keys from same project share quota (per Google docs).
let preferredIdx = 0;
let globalCallCounter = 0;
export function resetKeyState() {
  preferredIdx = 0;
  globalCallCounter = 0;
  keyBlockedUntil.clear();
  modelNextAllowed.clear();
  paceMult.clear();
  sharedPauseUntil.clear();
}

// Per-key blocked-until tracking for multi-key rotation.
// IMPORTANT: Per Google docs, rate limits are PER PROJECT, not per key.
// Multiple keys from the SAME project share quota — rotation only helps
// if keys are from DIFFERENT projects. We track per-key to handle the
// cross-project case correctly, and per-project would ideally require
// project ID extraction (not available from key alone).
const keyBlockedUntil = new Map(); // keyHash -> timestamp (ms)
function keyHash(k) { return String(k || '').slice(0, 12); }
function isKeyBlocked(k) {
  const until = keyBlockedUntil.get(keyHash(k));
  return until && Date.now() < until;
}
function blockKey(k, ms) {
  keyBlockedUntil.set(keyHash(k), Date.now() + Math.max(1000, ms));
}
function unblockKey(k) { keyBlockedUntil.delete(keyHash(k)); }

// Per-key-per-model pacing with ADAPTIVE gaps (AIMD, TCP-style).
// Why dynamic: Gemini exposes no quota headers, and per-model RPM limits
// change without notice (the 2.0 family retired silently in Sep 2026).
// So instead of hardcoding "model X = N RPM", we start from a conservative
// floor per model CLASS and adapt to observed signals: every 429 doubles the
// gap for that key+model (up to 8×), every success halves it back toward the
// floor. Floors are class-based (lite/flash/pro), never per-version, so a
// future "gemini-4-flash" still paces sanely on day one.
// With 5 keys from 5 projects, effective throughput still multiplies via
// round-robin — pacing is per key+model, never a global bucket.
const modelNextAllowed = new Map(); // `${model}|${keyHash}` -> timestamp (ms)
const paceMult = new Map(); // `${model}|${keyHash}` -> current multiplier (≥1)
const PACE_MAX_MULT = 8;
/** Conservative floor gap per model class. Class-based, not version-based. */
export function paceFloorMs(model) {
  const m = String(model || '').toLowerCase();
  if (m.includes('pro') || m.includes('gemma') || m.includes('ultra')) return 12000; // ~5 RPM class
  if (m.includes('lite')) return 3000; // high-headroom class (~20 RPM effective)
  if (m.includes('flash')) return 7000; // standard class (~8.5 RPM effective, grounding-safe)
  return 7000; // unknown models pace conservatively
}
function paceKey(model, key) {
  return `${model}|${key ? keyHash(key) : 'nokey'}`;
}
/** Current effective gap (floor × adaptive multiplier). Exported for tests. */
export function currentPaceGap(model, key) {
  return paceFloorMs(model) * (paceMult.get(paceKey(model, key)) || 1);
}
/** A 429 was observed: back off (double, capped). Exported for tests. */
export function notePaceBackoff(model, key) {
  const k = paceKey(model, key);
  paceMult.set(k, Math.min(PACE_MAX_MULT, (paceMult.get(k) || 1) * 2));
}
/** A call succeeded: ease back toward the floor (halve, floored at 1). Exported for tests. */
export function notePaceSuccess(model, key) {
  const k = paceKey(model, key);
  const next = (paceMult.get(k) || 1) / 2;
  if (next <= 1) paceMult.delete(k);
  else paceMult.set(k, next);
}
// Global per-model shared pause: a 429 on ANY key proves the underlying
// project bucket is hot — same-project keys share it, so per-key pacing alone
// cannot prevent pile-on (5 keys × per-key gaps still hammer one 10-RPM
// bucket). All keys pause for that model until the pause expires, which is
// what lets late-pipeline calls (synthesis) succeed instead of drowning in
// retry storms. Timestamp-based, decays naturally. Exported for tests.
const sharedPauseUntil = new Map(); // model -> timestamp (ms)
/** Record a global pause for a model after a 429. Exported for tests. */
export function noteSharedBackoff(model, waitMs) {
  const m = String(model || '');
  const until = Date.now() + Math.max(0, waitMs || 0);
  if (until > (sharedPauseUntil.get(m) || 0)) sharedPauseUntil.set(m, until);
}
// Single pace wait cap: bounds any one stall AND the reservation below, so
// repeated rounds on a dead key cannot accumulate an unbounded silent wait
// (the reservation used to grow faster than real time — a hang with no
// events and no budget accounting). Exported for tests.
export const PACE_MAX_WAIT_MS = 60_000;
/** Pace for a model across keys; returns ms actually waited. Exported for tests. */
export async function paceForModel(model, key, onKeyEvent) {
  const gap = currentPaceGap(model, key);
  const mapKey = paceKey(model, key);
  const next = modelNextAllowed.get(mapKey) || 0;
  const sharedWait = Math.max(0, (sharedPauseUntil.get(String(model || '')) || 0) - Date.now());
  const wait = Math.min(Math.max(next - Date.now(), sharedWait), PACE_MAX_WAIT_MS);
  // Reserve next slot before waiting so concurrent callers queue correctly,
  // but never more than the cap ahead — unbounded reservation was a silent hang.
  modelNextAllowed.set(mapKey, Math.min(Math.max(next, Date.now()) + gap, Date.now() + PACE_MAX_WAIT_MS));
  if (wait > 0) {
    onKeyEvent?.({ type: 'rate-wait', waitMs: wait });
    await sleep(wait);
  }
  return wait;
}

const isKeyError = (err) =>
  err?.status === 401 || err?.status === 403 ||
  (err?.status === 400 && /api key|key not valid|API_KEY_INVALID/i.test(err?.message || ''));

const isTransient = (status) => status === 429 || status === 502 || status === 503;

/** Round wait with anti-hammer escalation: honor the server's exact
 *  Retry-After for the first couple of rounds, then escalate (30s, 60s, 120s
 *  cap). Rationale, measured live: constant ~10s retry rounds EXTEND a short
 *  server throttle into a minutes-long ban (the key works fine the moment we
 *  stop hammering), so sustained failure must REDUCE request rate, not hold
 *  it. Pure — exported for tests. */
export function roundWaitMs(hintedMs, jitterMs, failedRounds) {
  if (failedRounds <= 2) return hintedMs > 0 ? Math.min(hintedMs, 60_000) : jitterMs;
  return Math.min(Math.max(hintedMs > 0 ? hintedMs : 0, 30_000 * 2 ** Math.min(failedRounds - 3, 2)), 120_000);
}

/** Honor Google's RetryInfo retryDelay or Retry-After header; else 0 (caller decides).
 *  Caps at 5 minutes for RPM; values >2 min are treated as RPD (hours) by caller.
 *  Never invents a 30s default — that was the source of the hardcoded "waiting 30s" users saw. */
function retryDelayMs(err, fallbackMs) {
  // Prefer Retry-After header if present (more accurate than details)
  try {
    const hdr = err?.headers?.['retry-after'] || err?.headers?.['Retry-After'];
    if (hdr) {
      const secs = parseFloat(String(hdr).trim());
      if (Number.isFinite(secs)) return Math.max(500, Math.ceil(secs * 1000));
    }
  } catch { /* ignore */ }
  try {
    const details = err?.data?.error?.details || [];
    for (const d of details) {
      if (typeof d.retryDelay === 'string') {
        const m = d.retryDelay.match(/([\d.]+)\s*s/);
        if (m) return Math.max(500, Math.ceil(parseFloat(m[1]) * 1000));
      }
      // Also check retryInfo field variant
      if (d.retryDelay && typeof d.retryDelay === 'object' && d.retryDelay.seconds) {
        return Math.max(500, parseInt(d.retryDelay.seconds, 10) * 1000);
      }
    }
  } catch { /* ignore malformed details */ }
  return fallbackMs;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// POST with key rotation and PATIENT quota handling: tries keys in order
// (preferred first), rotates immediately on 429/key-errors, and — when every
// key reports 429 — waits out per-minute buckets and retries, round after
// round, until the wait budget is spent. Only 429s are waited for (quota
// refills); other errors fail fast so real problems surface immediately.
// Timeouts/bad requests fail fast, never rotated, never retried.
// onKeyEvent receives { type:'rotated'|'rate-wait'|'resumed', ... } — never key values.
async function post(urlFor, body, { timeoutMs = 90_000, retries = 2, keys = [], onKeyEvent, rateWaitBudgetMs, model } = {}) {
  if (!keys.length) throw Object.assign(new Error('GEMINI_API_KEY is required'), { status: 401 });
  const penv = (typeof process !== 'undefined' && process.env) || {};
  // Default 5 minutes — user explicitly says "time can be more but results should be best"
  // RPD (daily) exhaustion has Retry-After of hours; RPM (per-minute) is seconds.
  // We wait patiently for RPM, but fail fast on RPD and fall back to evidence inventory.
  const budget = Number.isFinite(rateWaitBudgetMs) ? Math.max(0, rateWaitBudgetMs)
    : Math.max(0, Number(penv.QUOTA_WAIT_BUDGET_MS || 300_000));
  // Even round-robin from first call: ensures load is spread across all keys
  // proactively, not only on failures. This multiplies throughput when keys
  // are from different projects (per-project quota).
  const startIdx = globalCallCounter++ % keys.length;
  const order = keys.map((_, i) => (startIdx + i) % keys.length);
  let firstErr = null;
  let waitedMs = 0;
  let round = 0;
  let waited = false;
  for (;;) {
    round++;
    let round429 = null;
    // Build ordered list skipping currently-blocked keys (per-key tracking).
    // Per Google docs, limits are per PROJECT, so keys from same project share
    // quota — but keys from DIFFERENT projects have independent quotas. Tracking
    // per-key lets cross-project setups actually multiply throughput.
    const available = order.filter(ki => !isKeyBlocked(keys[ki]));
    const tryOrder = available.length ? available : order;
    let hadAvailable = available.length > 0;
    for (let o = 0; o < tryOrder.length; o++) {
      const ki = tryOrder[o];
      // Preemptive pacing per key+model to avoid hitting RPM in the first place.
      // Pacing waits are budgeted and surfaced like any other quota wait (they
      // used to be silent and unbounded — a hang with no events).
      if (model) {
        const pw = await paceForModel(model, keys[ki], onKeyEvent);
        waitedMs += pw;
        if (pw > 0) waited = true;
      }
      try {
        const data = await attemptKey(urlFor(keys[ki]), body, timeoutMs, retries);
        preferredIdx = ki;
        unblockKey(keys[ki]); // success clears block
        if (model) notePaceSuccess(model, keys[ki]); // adaptive pacing: ease off
        if (waited) onKeyEvent?.({ type: 'resumed' });
        return data;
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        firstErr = firstErr || e;
        if (e.status === 429) {
          round429 = round429 || e;
          if (model) notePaceBackoff(model, keys[ki]); // adaptive pacing: back off
          // Block this key for the hinted duration (per-key, not global)
          // Use actual Retry-After when available; fallback is small (6-10s) based on 10 RPM free tier, not hardcoded 15-30s.
          const hintedMs = retryDelayMs(e, 0);
          const blockMs = hintedMs || (8000 + Math.floor(Math.random() * 4000));
          blockKey(keys[ki], Math.min(blockMs, 120000));
          // NOTE: no global pause here — untried keys must fail over
          // INSTANTLY (cross-project rotation is the fast path). The shared
          // pause engages below, only when every key is exhausted and we are
          // about to wait: that 429 storm proves the project bucket itself
          // is hot, so ALL keys back off instead of piling on round after
          // round — the pile-on is what starved synthesis.
          if (hadAvailable && tryOrder.length > 1 && o + 1 < tryOrder.length) {
            onKeyEvent?.({ type: 'rotated', keyIndex: tryOrder[o + 1], reason: 'rate-limit' });
            continue;
          }
        } else if ((isTransient(e.status) || isKeyError(e)) && o + 1 < tryOrder.length) {
          onKeyEvent?.({ type: 'rotated', keyIndex: tryOrder[o + 1], reason: e.status === 429 ? 'rate-limit' : 'key-error' });
          continue;
        }
        if (!(isTransient(e.status) || isKeyError(e))) throw e;
      }
    }
    // If we skipped blocked keys and none were available, wait for earliest unblock
    if (!hadAvailable) {
      const waits = order.map(ki => {
        const until = keyBlockedUntil.get(keyHash(keys[ki])) || 0;
        return Math.max(0, until - Date.now());
      });
      const minWait = Math.min(...waits);
      if (minWait > 0 && minWait <= 120000 && waitedMs + minWait <= budget) {
        waitedMs += minWait;
        onKeyEvent?.({ type: 'rate-wait', waitMs: minWait });
        await sleep(minWait);
        // The explicit wait already spaced the retry — drop stale pacing
        // reservations so the next round doesn't stall twice on old gaps.
        if (model) for (const ki of order) modelNextAllowed.delete(paceKey(model, keys[ki]));
        continue; // retry with fresh blocked checks
      }
    }
    // All keys tried this round. Only 429s are worth waiting for (per-minute
    // buckets refill); anything else fails fast with the first error.
    // Distinguish RPM (seconds, wait helps) vs RPD/hard cap (hours or never —
    // wait is futile, fall back to evidence inventory instead of hanging).
    // NOTE: ordinary per-minute 429s carry the SAME "check your plan and
    // billing details" text AND a short RetryInfo. The text alone must NEVER
    // trigger fail-fast — only the absence of any refill time (or an hours
    // long one) proves waiting is futile.
    if (!round429 || round429.status !== 429) throw firstErr;
    const hinted = retryDelayMs(round429, 0);
    const msgBilling = /billing|check your plan/i.test(round429.message || '');
    if (msgBilling && hinted === 0) {
      throw Object.assign(new Error('Billing quota exceeded — no amount of waiting will refill the per-project daily/plan limit. Add a billed project or wait until reset.'), {
        status: 429, code: 'RPD_EXHAUSTED', retryAfter: 0,
      });
    }
    if (hinted > 120000) {
      // RPD/day quota — Retry-After is hours, not seconds. Waiting won't help.
      throw Object.assign(new Error('Daily quota (RPD) exhausted — try again after midnight PT, or use a billed project. Partial results will be assembled from gathered evidence.'), {
        status: 429, code: 'RPD_EXHAUSTED', retryAfter: hinted,
      });
    }
    // Anti-hammer escalation: constant short rounds extend server throttles
    // (measured: key healthy the moment hammering stops). Honor Retry-After
    // first, then back off hard so request rate collapses instead of holding.
    const wait = roundWaitMs(hinted, 8000 + Math.floor(Math.random() * 4000), round);
    if (waitedMs + wait > budget) break; // budget spent → honest failure below
    // Every key exhausted: engage the global per-model pause so the next
    // round (and any concurrent caller) backs off instead of re-hammering.
    if (model) noteSharedBackoff(model, wait);
    waitedMs += wait;
    waited = true;
    onKeyEvent?.({ type: 'rate-wait', waitMs: wait });
    await sleep(wait);
    // Same stale-reservation drop as above: the explicit wait did the spacing.
    if (model) for (const ki of order) modelNextAllowed.delete(paceKey(model, keys[ki]));
  }
  // Attach the server's exact wait (ms) so callers can honor it precisely
  // instead of guessing — section retries use it for server-timed backoff.
  throw Object.assign(firstErr || new Error('Gemini quota exhausted'), {
    status: firstErr?.status ?? 429, code: 'QUOTA_EXHAUSTED',
    retryAfter: retryDelayMs(firstErr, 0) || retryDelayMs(round429, 0) || 0,
  });
}

async function attemptKey(url, body, timeoutMs, retries) {
  for (let attempt = 0; ; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(data?.error?.message || `Gemini HTTP ${res.status}`);
        err.status = res.status;
        err.code = data?.error?.status || '';
        err.data = data;
        // 429 is per-key quota: don't sleep within this key's retries, just
        // let the outer rotation try the next key immediately. Sleep only for
        // 502/503 (true transients) or as a last resort before giving up.
        if (attempt < retries && isTransient(res.status)) {
          if (res.status === 429) throw err; // rotate immediately, no sleep here
          await sleep(750 * (attempt + 1));
          continue;
        }
        throw err;
      }
      return data;
    } finally {
      clearTimeout(t);
    }
  }
}

export function extractText(resp) {
  const parts = resp?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || '').join('').trim();
}

export function extractGrounding(resp) {
  const meta = resp?.candidates?.[0]?.groundingMetadata || {};
  const chunks = (meta.groundingChunks || [])
    .map((c) => c.web)
    .filter((w) => w?.uri)
    .map((w) => ({ url: w.uri, title: w.title || '' }));
  return {
    queries: meta.webSearchQueries || [],
    chunks,
    supports: meta.groundingSupports || [],
    searchEntryPoint: meta.searchEntryPoint?.renderedContent || '',
  };
}

/** Thinking levels exist on Gemini 3.x (low/medium/high). Older models reject
 *  the field, so it is sent only for 3.x — with a strip-and-retry fallback. */
const supportsThinkingLevel = (model) => /^gemini-3(\.|-|$)/i.test(model || '');

function injectThinking(body, thinking) {
  return {
    ...body,
    generationConfig: { ...(body.generationConfig || {}), thinkingConfig: { thinkingLevel: thinking } },
  };
}

async function postThinking(urlFor, body, opts, model, thinking) {
  if (!thinking || !supportsThinkingLevel(model)) return post(urlFor, body, opts);
  try {
    return await post(urlFor, injectThinking(body, thinking), opts);
  } catch (e) {
    if (e.status === 400) return post(urlFor, body, opts); // model rejected the field
    throw e;
  }
}
/** Real token counts reported by the API (for cost telemetry, not estimates). */
export function extractUsage(resp) {
  const u = resp?.usageMetadata || {};
  return { in: u.promptTokenCount || 0, out: u.candidatesTokenCount || 0 };
}

/** Plain generation (temperature default 0.4 for research determinism). */
export async function generate({ key, model, prompt, system = '', temperature = 0.4, maxTokens = 4096, timeoutMs, onKeyEvent, thinking }) {
  const data = await postThinking((k) => endpoint(model, k), {
    contents: [{ parts: [{ text: prompt }] }],
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    generationConfig: { temperature, maxOutputTokens: maxTokens },
  }, { timeoutMs, keys: getKeys(key), onKeyEvent, model });
  return { text: extractText(data), usage: extractUsage(data), raw: data };
}

/** Structured JSON generation with schema; falls back to fenced-JSON extraction. */
export async function generateJson({ key, model, prompt, system = '', schema, temperature = 0.2, maxTokens = 4096, timeoutMs, onKeyEvent, thinking }) {
  const keys = getKeys(key);
  const opts = { timeoutMs, keys, onKeyEvent, model };
  const run = (body) => postThinking((k) => endpoint(model, k), body, opts, model, thinking);
  let data;
  try {
    data = await run({
      contents: [{ parts: [{ text: prompt }] }],
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        generationConfig: {
        temperature,
        maxOutputTokens: maxTokens,
        responseMimeType: 'application/json',
        ...(schema ? { responseSchema: schema } : {}),
      },
    });
  } catch (e) {
    // Older models may reject responseSchema; retry without it.
    if (e.status === 400 && schema) {
      data = await run({
        contents: [{ parts: [{ text: prompt + '\n\nRespond with VALID JSON only. No markdown fences, no commentary.' }] }],
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        generationConfig: { temperature, maxOutputTokens: maxTokens },
      });
    } else throw e;
  }
  const text = extractText(data);
  const usage = extractUsage(data);
  try {
    return { data: parseJsonLenient(text), usage, raw: data };
  } catch {
    // Repair pass (1 extra call max): show the model its broken output and
    // demand strict JSON. Fixes the common "prose + JSON" drift that would
    // otherwise kill a whole run at synthesis time.
    const fix = await post((k) => endpoint(model, k), {
      contents: [{ parts: [{ text: `Your previous response was not valid JSON. Re-emit ONLY the JSON value — no prose, no fences, no commentary.\n\nPrevious response:\n${text.slice(0, 6000)}` }] }],
      generationConfig: { temperature: 0, maxOutputTokens: maxTokens },
    }, { timeoutMs, keys, onKeyEvent, model });
    const text2 = extractText(fix);
    const usage2 = extractUsage(fix);
    return {
      data: parseJsonLenient(text2),
      usage: { in: usage.in + usage2.in, out: usage.out + usage2.out },
      raw: fix,
    };
  }
}

/** Grounded search: one Gemini call with the google_search tool.
 *  Returns { text, queries, chunks, supports } — chunks become Sources. */
export async function groundedSearch({ key, model, query, timeoutMs, onKeyEvent, thinking, rateWaitBudgetMs }) {
  const data = await postThinking((k) => endpoint(model, k), {
    contents: [{ parts: [{ text: query }] }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 1.0, maxOutputTokens: 2048 },
  }, { timeoutMs, keys: getKeys(key), onKeyEvent, model, rateWaitBudgetMs }, model, thinking);
  const g = extractGrounding(data);
  return { text: extractText(data), ...g, usage: extractUsage(data), raw: data };
}

/** URL-context grounding: ask Gemini to synthesize from explicit URLs. */
export async function urlContext({ key, model, prompt, urls, timeoutMs, onKeyEvent, thinking }) {
  const quoted = urls.map((u) => `• ${u}`).join('\n');
  const data = await postThinking((k) => endpoint(model, k), {
    contents: [{ parts: [{ text: `${prompt}\n\nConsult these URLs:\n${quoted}` }] }],
    tools: [{ url_context: {} }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 4096 },
  }, { timeoutMs, keys: getKeys(key), onKeyEvent, model }, model, thinking);
  return { text: extractText(data), grounding: extractGrounding(data), usage: extractUsage(data), raw: data };
}

export function parseJsonLenient(text) {
  const t = String(text || '').trim();
  if (!t) throw new Error('empty model response');
  try { return JSON.parse(t); } catch { /* fall through */ }
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch { /* fall through */ } }
  const start = t.search(/[{[]/);
  if (start >= 0) {
    for (let end = t.length; end > start; end--) {
      try { return JSON.parse(t.slice(start, end)); } catch { /* shrink */ }
    }
  }
  throw new Error('model did not return valid JSON');
}

export function isRateLimit(err) { return err?.status === 429; }
export function isAuthError(err) { return err?.status === 400 || err?.status === 401 || err?.status === 403; }
