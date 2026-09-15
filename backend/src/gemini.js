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
export function resetKeyState() { preferredIdx = 0; globalCallCounter = 0; for (const k of keyBlockedUntil.keys()) keyBlockedUntil.delete(k); }

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

const isKeyError = (err) =>
  err?.status === 401 || err?.status === 403 ||
  (err?.status === 400 && /api key|key not valid|API_KEY_INVALID/i.test(err?.message || ''));

const isTransient = (status) => status === 429 || status === 502 || status === 503;

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
// onKeyEvent receives { type:'rotated'|'rate-wait', ... } — never key values.
async function post(urlFor, body, { timeoutMs = 90_000, retries = 2, keys = [], onKeyEvent, rateWaitBudgetMs } = {}) {
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
      try {
        const data = await attemptKey(urlFor(keys[ki]), body, timeoutMs, retries);
        preferredIdx = ki;
        unblockKey(keys[ki]); // success clears block
        return data;
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        firstErr = firstErr || e;
        if (e.status === 429) {
          round429 = round429 || e;
          // Block this key for the hinted duration (per-key, not global)
          // Use actual Retry-After when available; fallback is small (6-10s) based on 10 RPM free tier, not hardcoded 15-30s.
          const hintedMs = retryDelayMs(e, 0);
          const blockMs = hintedMs || (8000 + Math.floor(Math.random() * 4000));
          blockKey(keys[ki], Math.min(blockMs, 120000));
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
        continue; // retry with fresh blocked checks
      }
    }
    // All keys tried this round. Only 429s are worth waiting for (per-minute
    // buckets refill); anything else fails fast with the first error.
    // Distinguish RPM (seconds, wait helps) vs RPD (hours, wait is futile —
    // fall back to evidence inventory instead of hanging for hours).
    if (!round429 || round429.status !== 429) throw firstErr;
    const hinted = retryDelayMs(round429, 0);
    if (hinted > 120000) {
      // RPD/day quota — Retry-After is hours, not seconds. Waiting won't help.
      throw Object.assign(new Error('Daily quota (RPD) exhausted — try again after midnight PT, or use a billed project. Partial results will be assembled from gathered evidence.'), {
        status: 429, code: 'RPD_EXHAUSTED', retryAfter: hinted,
      });
    }
    // Use actual Retry-After when available; fallback is small jitter (6-10s for 10 RPM free tier)
    // Previous hardcoded 15s*round (e.g., 30s on round 2) was arbitrary — now dynamic.
    const wait = hinted > 0 ? Math.min(hinted, 60000) : (8000 + Math.floor(Math.random() * 4000));
    if (waitedMs + wait > budget) break; // budget spent → honest failure below
    waitedMs += wait;
    onKeyEvent?.({ type: 'rate-wait', waitMs: wait });
    await sleep(wait);
  }
  throw Object.assign(firstErr || new Error('Gemini quota exhausted'), {
    status: firstErr?.status ?? 429, code: 'QUOTA_EXHAUSTED',
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
  }, { timeoutMs, keys: getKeys(key), onKeyEvent });
  return { text: extractText(data), usage: extractUsage(data), raw: data };
}

/** Structured JSON generation with schema; falls back to fenced-JSON extraction. */
export async function generateJson({ key, model, prompt, system = '', schema, temperature = 0.2, maxTokens = 4096, timeoutMs, onKeyEvent, thinking }) {
  const keys = getKeys(key);
  const opts = { timeoutMs, keys, onKeyEvent };
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
    }, { timeoutMs, keys, onKeyEvent });
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
export async function groundedSearch({ key, model, query, timeoutMs, onKeyEvent, thinking }) {
  const data = await postThinking((k) => endpoint(model, k), {
    contents: [{ parts: [{ text: query }] }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: 1.0, maxOutputTokens: 2048 },
  }, { timeoutMs, keys: getKeys(key), onKeyEvent }, model, thinking);
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
  }, { timeoutMs, keys: getKeys(key), onKeyEvent }, model, thinking);
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
