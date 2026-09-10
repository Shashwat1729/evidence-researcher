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

// Process-wide preferred-key hint (perf only: skip a known-dead key first).
// Benign under concurrency — worst case one wasted attempt before rotation.
let preferredIdx = 0;
export function resetKeyState() { preferredIdx = 0; }

const isKeyError = (err) =>
  err?.status === 401 || err?.status === 403 ||
  (err?.status === 400 && /api key|key not valid|API_KEY_INVALID/i.test(err?.message || ''));

const isTransient = (status) => status === 429 || status === 502 || status === 503;

/** Honor Google's RetryInfo retryDelay (capped at 30s); else bounded backoff. */
function retryDelayMs(err, fallbackMs) {
  try {
    const details = err?.data?.error?.details || [];
    for (const d of details) {
      if (typeof d.retryDelay === 'string') {
        const m = d.retryDelay.match(/([\d.]+)\s*s/);
        if (m) return Math.min(30_000, Math.max(500, Math.ceil(parseFloat(m[1]) * 1000)));
      }
    }
  } catch { /* ignore malformed details */ }
  return fallbackMs;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// POST with key rotation: tries keys in order (preferred first), bounded
// transient retries per key (honoring Google's RetryInfo delay). Rotates on
// rate-limit/transient AND on key errors (401/403/invalid-key 400) so a dead
// primary fails over to the fallback; rotation is announced via onKeyEvent
// even when every key is exhausted. Timeouts/bad requests fail fast. When all
// keys hit 429, honors RetryInfo once before giving up (free-tier 5 RPM).
// onKeyEvent receives { type:'rotated'|'rate-wait', ... } — never key values.
async function post(urlFor, body, { timeoutMs = 90_000, retries = 2, keys = [], onKeyEvent } = {}) {
  if (!keys.length) throw Object.assign(new Error('GEMINI_API_KEY is required'), { status: 401 });
  const order = keys.map((_, i) => (preferredIdx + i) % keys.length);
  let firstErr = null;
  for (let o = 0; o < order.length; o++) {
    const ki = order[o];
    try {
      const data = await attemptKey(urlFor(keys[ki]), body, timeoutMs, retries);
      preferredIdx = ki; // sticky: skip known-dead keys first next time
      return data;
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      firstErr = firstErr || e;
      if ((isTransient(e.status) || isKeyError(e)) && o + 1 < order.length) {
        onKeyEvent?.({ type: 'rotated', keyIndex: order[o + 1], reason: e.status === 429 ? 'rate-limit' : 'key-error' });
        continue; // next key immediately, no sleep
      }
      if (isTransient(e.status) || isKeyError(e)) break; // exhausted: maybe RetryInfo wait
      throw e; // bad request etc: key-independent, fail fast
    }
  }
  // All keys hit 429 with RetryInfo — honor the per-minute bucket once
  // (capped at 60s), then retry one more round across keys.
  if (firstErr?.status === 429) {
    const wait = retryDelayMs(firstErr, 0);
    if (wait > 0) {
      const capped = Math.min(wait, 60000);
      onKeyEvent?.({ type: 'rate-wait', waitMs: capped });
      await sleep(capped);
      // One more attempt across keys after waiting
      for (const ki of order) {
        try {
          const data = await attemptKey(urlFor(keys[ki]), body, timeoutMs, 0);
          preferredIdx = ki;
          return data;
        } catch (e) {
          if (e?.name === 'AbortError') throw e;
          firstErr = e;
          if (isTransient(e.status) || isKeyError(e)) continue;
          throw e;
        }
      }
    }
  }
  throw firstErr;
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
