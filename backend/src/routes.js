// HTTP routes: research (SSE), history, export.
// BYOK: client may send x-gemini-key header (never persisted, never logged).
// Otherwise server uses GEMINI_API_KEY env (hosted server mode).

import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runResearch } from './engine/orchestrator.js';
import { getKeys } from './gemini.js';
import { AVAILABLE_MODELS, canonicalizeModel, isKnownModel } from './config.js';
import { academicCache } from './cache.js';
import { createRateLimiter } from './middleware/security.js';
import { exportMarkdown, exportHtml, exportNotebookLm, exportMediaBrief } from './export.js';
import { keyKind, looksLikeKey, maskKey, maxKeys, normalizeKeys } from './keys.js';
import { DISCOVERY_MAX_KEYS, discoverModelsCached, modelCacheTtlMs } from './models.js';
import * as defaultStore from './store.js';
export { exportMarkdown, exportHtml };
export { maskKey };

const PKG_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8')).version || '1.0.0';
  } catch { return '1.0.0'; }
})();

function cacheTtl() {
  const raw = Number(process.env.RESULT_CACHE_TTL_MS);
  if (!Number.isFinite(raw)) return 2 * 3600_000; // 2h default; 0 disables
  return Math.max(0, raw);
}

/** Curated suggestions first (order and written blurbs preserved), then every
 *  discovered model the keys can call, de-duplicated by id. Keeps the picker
 *  useful with no network and current with a live catalogue. */
export function mergeModels(curated, discovered) {
  const out = [];
  const seen = new Set();
  for (const m of [...(curated || []), ...(discovered || [])]) {
    const id = m?.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: m.label || id, blurb: m.blurb || '', curated: Boolean(m.curated) });
  }
  return out;
}

/** Lightweight key check via ListModels (no generation quota burned).
 *  Key goes in the x-goog-api-key header, never the URL. Exported for tests.
 *
 *  Format gate accepts BOTH formats Google issues (AIza standard keys and AQ.
 *  authorization keys). Gating on "AIza" alone was the bug that reported four
 *  perfectly working AQ keys as invalid and then deleted them. The gate is now
 *  only a typo filter — the live call below is the real arbiter.
 *
 *  Returns { valid, masked, kind, error?, warning? }. */
export async function validateKey(k, { fetchFn = fetch, timeoutMs = 8000 } = {}) {
  const key = typeof k === 'string' ? k.trim() : '';
  const masked = maskKey(key);
  const kind = keyKind(key);
  if (!key || key.length < 20) return { valid: false, masked, kind, error: 'Too short to be a valid key' };
  if (!looksLikeKey(key)) return { valid: false, masked, kind, error: 'Unrecognized key format (expected AIza… or AQ.…)' };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetchFn('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', {
      headers: { 'x-goog-api-key': key }, signal: ctrl.signal,
    });
    if (resp.ok) return { valid: true, masked, kind };
    const data = await resp.json().catch(() => ({}));
    const msg = data?.error?.message || `HTTP ${resp.status}`;
    if (resp.status === 400 && /API key not valid/i.test(msg)) return { valid: false, masked, kind, error: 'Invalid API key' };
    if (resp.status === 403) {
      // Since 2026-06-19 the Gemini API rejects UNRESTRICTED standard keys
      // outright. That is fixable in the Cloud console and the message is
      // uselessly generic without saying so — name it and point at the fix.
      if (/unrestricted|api keys? (is|are) not allowed|create keys/i.test(msg) || /API_KEY_INVALID/i.test(String(data?.error?.status || ''))) {
        return { valid: false, masked, kind, error: 'Key rejected as unrestricted — restrict it to the Gemini API (generativelanguage.googleapis.com)' };
      }
      return { valid: false, masked, kind, error: 'Permission denied (check the Generative Language API is enabled for the project)' };
    }
    // 429: the key is real, its quota is just hot right now.
    if (resp.status === 429) return { valid: true, masked, kind, warning: 'Key valid but quota exceeded (try later)' };
    return { valid: false, masked, kind, error: String(msg).slice(0, 80) };
  } catch (e) {
    if (e?.name === 'AbortError') return { valid: false, masked, kind, error: 'Timeout' };
    return { valid: false, masked, kind, error: String(e?.message || 'Unknown error').slice(0, 80) };
  } finally {
    clearTimeout(t);
  }
}

export function apiRouter({ runFn = runResearch, store = defaultStore } = {}) {
  const r = Router();
  // Per-router concurrency guard: quota is per project, so unbounded parallel
  // runs would 429 everyone. Env-tunable, defaults to 8.
  let activeRuns = 0;
  // Run counters for /api/metrics (per-router instance → test-isolated).
  const metrics = { startedAt: new Date().toISOString(), runsStarted: 0, runsCompleted: 0, runsFailed: 0, runsCancelled: 0, byMode: {} };
  r.get('/metrics', (_req, res) => res.json(metrics));
  // Per-IP rate limit scoped to research runs only (history/export polling
  // must never 429). Env-tunable via RATE_LIMIT_MAX, default 30/min.
  const researchLimiter = createRateLimiter({ windowMs: 60_000, max: Number(process.env.RATE_LIMIT_MAX || 30) });
  const inflight = new Map(); // identical-body → in-flight result promise
  const MODES_LIST = ['quick', 'standard', 'deep', 'exhaustive'];
  const STANCES_LIST = ['neutral', 'lean', 'adversarial', 'steelman', 'comparative'];

  r.get('/health', (_req, res) => res.json({
    ok: true,
    time: new Date().toISOString(),
    uptime: process.uptime(),
    version: PKG_VERSION,
    memory: process.memoryUsage(),
    model: process.env.DEFAULT_MODEL || 'gemini-2.5-flash',
    cache: { academicEntries: academicCache.size },
  }));

  r.get('/config', (_req, res) => res.json({
    serverKey: !!process.env.GEMINI_API_KEY || !!process.env.GEMINI_API_KEYS,
    hasFallback: !!process.env.GEMINI_API_KEY_FALLBACK,
    modes: ['quick', 'standard', 'deep', 'exhaustive'],
    stances: ['neutral', 'lean', 'adversarial', 'steelman', 'comparative'],
    // Suggestions only. Any well-formed gemini-* id is accepted (see
    // GET /api/models for what your keys can actually call), so a new release
    // never requires a code change to be usable.
    models: AVAILABLE_MODELS,
    // Dynamic, not a hardcoded 5: the client renders this many key rows and the
    // validator accepts this many keys. Both used to be pinned to 5, which made
    // the UI discard everything past the fifth pasted key without a word.
    maxKeysPerRequest: maxKeys(),
    keyFormats: ['AIza…', 'AQ.…'],
  }));

  // Live model discovery. Answers "what can these keys actually call?" instead
  // of shipping a frozen list, so a model Google released this morning is
  // selectable this morning. Curated ids keep their position and written blurb;
  // everything else is appended in ranked order. Falls back to the curated
  // catalog when no key is available or every probe fails — the picker must
  // never be empty.
  r.get('/models', async (req, res) => {
    const explicit = [];
    const single = (req.header('x-gemini-key') || '').trim();
    if (single) explicit.push(single);
    try {
      const arr = JSON.parse(req.header('x-gemini-keys') || '[]');
      if (Array.isArray(arr)) explicit.push(...arr);
    } catch { /* malformed header ignored */ }
    const serverKey = (process.env.GEMINI_API_KEY || '').trim();
    const keys = getKeys(explicit.length ? explicit : serverKey);
    if (!keys.length) return res.json({ models: AVAILABLE_MODELS, live: false, reason: 'no key supplied' });
    try {
      const discovered = await discoverModelsCached(keys, modelCacheTtlMs());
      const merged = mergeModels(AVAILABLE_MODELS, discovered);
      if (!discovered.length) return res.json({ models: merged, live: false, reason: 'no models returned' });
      // Report what was ACTUALLY probed, not how many keys exist: discovery
      // deliberately asks only the first few (a catalogue from one project is
      // enough, and every extra key is another request).
      res.json({ models: merged, live: true, discovered: discovered.length, keys: keys.length, probed: Math.min(keys.length, DISCOVERY_MAX_KEYS) });
    } catch {
      res.json({ models: AVAILABLE_MODELS, live: false, reason: 'discovery failed' });
    }
  });

  // Validate pasted keys with a lightweight model-list call (no quota burn on research).
  // Body: { keys: string[] } -> { results: [{ valid, masked, kind, error? }],
  //                              duplicates, dropped }
  // Invalid keys are automatically flagged for removal; valid keys are kept.
  // Duplicates are REPORTED, never silently swallowed: a key pasted twice shares
  // one quota, so pretending it doubled your capacity is a lie.
  // Key checks hit Google on the caller's behalf: rate-limit them so the
  // endpoint can't be used as an open proxy for key probing.
  const keyLimiter = createRateLimiter({ windowMs: 60_000, max: Number(process.env.KEY_VALIDATE_RATE_MAX || 12) });
  r.post('/keys/validate', keyLimiter, async (req, res) => {
    const input = Array.isArray(req.body?.keys) ? req.body.keys : [];
    if (!input.length) return res.status(400).json({ error: 'No keys provided' });
    const limit = maxKeys();
    const { keys, duplicates, dropped } = normalizeKeys(input, limit);
    if (!keys.length) return res.status(400).json({ error: 'No usable keys provided' });
    res.json({
      results: await Promise.all(keys.map((k) => validateKey(k))),
      duplicates,
      dropped,
      limit,
    });
  });

  // SSE research run. Query/body: question, mode, stance, hypothesis, documentary, model, fresh.
  r.post('/research', researchLimiter, async (req, res) => {
    // Multi-key: x-gemini-key (single) and/or x-gemini-keys (JSON array or
    // separated list). All supplied keys rotate on 429 — N keys multiply
    // effective quota. Cap comes from maxKeys(), never a hardcoded number.
    let explicit = [];
    const single = (req.header('x-gemini-key') || '').trim();
    if (single) explicit.push(single);
    try {
      const arr = JSON.parse(req.header('x-gemini-keys') || '[]');
      if (Array.isArray(arr)) explicit.push(...arr);
    } catch { /* malformed header ignored; single key still works */ }
    const key = (process.env.GEMINI_API_KEY || '').trim();
    // Model can come from body or header (UI sends both for static/server parity)
    const headerModel = (req.header('x-gemini-model') || '').trim();
    const input = {
      question: req.body?.question || '',
      mode: req.body?.mode || 'standard',
      stance: req.body?.stance || 'neutral',
      hypothesis: req.body?.hypothesis || '',
      documentary: !!req.body?.documentary,
      fresh: req.body?.fresh === true,
      model: (req.body?.model || headerModel || '').trim(),
    };
    if (!input.question || input.question.trim().length < 3) {
      return res.status(400).json({ error: 'A research question is required.' });
    }
    if (!MODES_LIST.includes(input.mode)) {
      return res.status(400).json({ error: `Unknown research mode "${input.mode}".` });
    }
    if (!STANCES_LIST.includes(input.stance)) {
      return res.status(400).json({ error: `Unknown research stance "${input.stance}".` });
    }
    input.model = canonicalizeModel(input.model);
    if (input.model && !isKnownModel(input.model)) {
      return res.status(400).json({ error: 'Unknown model. Use one offered by GET /api/config.' });
    }
    if (!getKeys(explicit).length && !key) {
      return res.status(401).json({ error: 'GEMINI_API_KEY is required — enter it in the UI or set it server-side.' });
    }
    // Effective keys for this run (user keys first, then server keys).
    const runKeys = getKeys(explicit.length ? explicit : key);
    const rawCap = Number(process.env.MAX_CONCURRENT_RUNS);
    const cap = Number.isFinite(rawCap) ? Math.max(0, rawCap) : 8;
    // Singleflight: identical concurrent bodies share ONE run (fresh result,
    // zero extra quota). Joiners get a note + the final result event.
    // `fresh: true` never joins (explicit new work) but still publishes.
    // Model is part of the key: different models may return different work.
    const bk = JSON.stringify([input.question, input.mode, input.stance, input.hypothesis, input.documentary, input.model]);
    const shared = input.fresh ? null : inflight.get(bk);
    // SSE preamble shared by owner + joiner paths.
    let heartbeat = null;
    const beginStream = () => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // nginx & co: stream, don't buffer
      });
      if (typeof res.flushHeaders === 'function') { try { res.flushHeaders(); } catch { /* ignore */ } }
      // Quota waits can leave the stream silent for minutes; proxies and load
      // balancers drop idle connections (~60-100s). An SSE comment every 15s
      // keeps it open and is ignored by every client.
      heartbeat = setInterval(() => {
        if (closed || res.writableEnded) return;
        try { res.write(': ping\n\n'); } catch { closed = true; }
      }, Number(process.env.SSE_HEARTBEAT_MS || 15_000));
      if (heartbeat.unref) heartbeat.unref();
    };
    let closed = false;
    res.on('close', () => { if (heartbeat) clearInterval(heartbeat); if (!res.writableEnded) closed = true; });
    // Never throw on a dead socket: a disconnected client must not crash the run.
    const send = (obj) => {
      if (closed || res.writableEnded) return;
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); }
      catch { closed = true; }
    };
    const sendError = (e) => {
      const status = e.status || 500;
      let msg = e.message || 'research failed';
      // These are already retried patiently in gemini.js; if they surface here,
      // the wait budget was truly exhausted. Handle gracefully with fallback info.
      if (e.code === 'RPD_EXHAUSTED') {
        // The ladder already tried every configured model, so this only fires
        // when each model's own daily cap is spent. Google's free tiers are
        // uneven (full flash 20/day, flash-LITE 500/day per project), so the
        // actionable advice is a project with its own budget, or a billed tier.
        msg = 'Daily request cap reached on every model this key can use (free tier: ~20/day per full model, ~500/day per Flash-Lite model, per project). '
          + 'Quota is per project, not per key — so extra keys from the SAME project do not help. '
          + 'Use a key from a different Google Cloud project, enable billing, or try again after midnight Pacific.';
      } else if (e.code === 'QUOTA_EXHAUSTED' || status === 429 || /quota|rate|429/i.test(msg)) {
        // This should rarely happen now that gemini.js waits patiently (5 min).
        // Same-project keys share ONE quota — extra keys only help when each
        // comes from a different Google Cloud project (per-project quota).
        msg = 'API quota temporarily exhausted after patient retries. Keys from the SAME project share one quota — add keys from different Google Cloud projects to multiply quota, use Quick mode (~5 calls vs ~21), or try again shortly. Partial results may be in cache.';
      } else if (e.code === 'MODEL_UNAVAILABLE' || e.modelUnavailable) {
        // Every configured model 404'd on every key. Say what to do about it
        // instead of echoing a raw provider error.
        msg = 'None of the configured Gemini models are available on the supplied key(s) for this project. Leave the model picker on "Auto", or create a key in AI Studio for a project that has the Gemini API enabled.';
      }
      if (/API key|API_KEY|key not valid/i.test(msg)) msg = 'Invalid Gemini API key. Check the key and try again.';
      send({ type: 'error', message: msg });
    };
    const finish = () => {
      if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
      try { if (!res.writableEnded) res.end(); } catch { /* ignore */ }
    };
    // Result cache: identical repeats served from disk (zero quota, zero wait).
    // Checked before singleflight/cap so hits consume no slots. Bypass: { fresh: true }.
    if (!input.fresh && typeof store.findCached === 'function' && cacheTtl() > 0) {
      const hit = await store.findCached(input, cacheTtl()).catch(() => null);
      if (hit?.id) {
        beginStream();
        // Honesty: a cached INVENTORY must never masquerade as a fresh full
        // report — say what it is so the user can force a new run now that
        // quota may have refilled.
if (hit.report?.synthesisFallback) {
          send({ type: 'progress', message: 'Served a cached report written from cited extracts (the model quota was exhausted during that run) — no quota used. Send { fresh: true } for a new run now that quota may have refilled.' });
        } else {
          send({ type: 'progress', message: 'Served from a recent identical run — no quota used. Send { fresh: true } to force a new run.' });
        }
        send({ type: 'result', message: 'Done', result: hit });
        finish();
        return;
      }
    }
    // Client refcount: the shared run is cancelled only when EVERY attached
    // client has gone (owner + joiners). Each response decrements once.
    const trackClient = (entry) => {
      let left = false;
      const leave = () => { if (!left) { left = true; entry.clients--; } };
      res.on('close', leave);
      return leave;
    };
    if (shared) {
      beginStream();
      shared.clients++;
      const leave = trackClient(shared);
      send({ type: 'progress', message: 'Joined an identical run already in progress — sharing its result (no extra quota used).' });
      try {
        const result = await shared.task;
        send({ type: 'result', message: 'Done', result });
      } catch (e) { sendError(e); }
      finally { leave(); finish(); }
      return;
    }
    if (activeRuns >= cap) {
      return res.status(503).json({ error: 'Server is busy — too many concurrent research runs. Try again shortly.' });
    }
    activeRuns++;
    metrics.runsStarted++;
    metrics.byMode[input.mode] = (metrics.byMode[input.mode] || 0) + 1;
    // Disconnect detection must watch the RESPONSE, not the request: for POSTs
    // the req stream closes as soon as the body is consumed, long before we
    // finish streaming. res 'close' with an unfinished body = client gone.
    beginStream();
    const entry = { task: null, clients: 1 };
    const leave = trackClient(entry);
    // Defensive: a synchronously-throwing runFn must 400/500 the request,
    // never hang it or crash the process via unhandled rejection.
    let task;
    try {
      task = runFn(input, { key: runKeys, emit: send, isCancelled: () => entry.clients <= 0 });
    } catch (e) {
      metrics.runsFailed++;
      sendError(e);
      activeRuns--;
      leave();
      finish();
      return;
    }
    entry.task = task;
    inflight.set(bk, entry);
    if (inflight.size > 100) inflight.delete(inflight.keys().next().value); // bounded
    try {
      const result = await task;
      await store.saveResult(result).catch(() => {});
      if (typeof store.saveCacheEntry === 'function' && cacheTtl() > 0) {
        await store.saveCacheEntry(input, result).catch(() => {});
      }
      metrics.runsCompleted++;
      send({ type: 'result', message: 'Done', result });
    } catch (e) {
      if (e?.code === 'CANCELLED') metrics.runsCancelled++;
      else metrics.runsFailed++;
      sendError(e);
    }
    finally {
      inflight.delete(bk);
      activeRuns--;
      leave();
      finish();
    }
  });

  r.get('/history', async (req, res) => {
    try {
      const raw = Number(req.query.limit);
      const limit = Number.isFinite(raw) ? Math.min(200, Math.max(1, Math.floor(raw))) : 50;
      res.json({ items: await store.listResults(limit) });
    }
    catch (e) { res.status(500).json({ error: String(e.message) }); }
  });

  r.get('/history/:id', async (req, res) => {
    try {
      const result = await store.getResult(req.params.id);
      if (!result || !result.id) return res.status(404).json({ error: 'not found' });
      res.json(result);
    } catch { res.status(404).json({ error: 'not found' }); }
  });

  r.delete('/history/:id', async (req, res) => {
    try { await store.deleteResult(req.params.id); res.json({ ok: true }); }
    catch { res.status(404).json({ error: 'not found' }); }
  });

  // Export: ?format=md|html|json|notebooklm|brief (downloads as attachment)
  r.get('/export/:id', async (req, res) => {
    try {
      const format = String(req.query.format || 'md');
      // notebooklm = uploadable dossier for NotebookLM's audio/video/notes
      // outputs; brief = a per-section narration + on-screen production outline.
      const formats = ['md', 'html', 'json', 'notebooklm', 'brief'];
      if (!formats.includes(format)) return res.status(400).json({ error: `format must be one of ${formats.join(', ')}` });
      const result = await store.getResult(req.params.id);
      const base = `research-${String(req.params.id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'report'}`;
      if (format === 'json') {
        res.attachment(`${base}.json`);
        return res.json(result);
      }
      if (format === 'notebooklm') {
        res.attachment(`${base}-notebooklm.md`);
        res.type('markdown');
        return res.send(exportNotebookLm(result));
      }
      if (format === 'brief') {
        res.attachment(`${base}-media-brief.md`);
        res.type('markdown');
        return res.send(exportMediaBrief(result));
      }
      if (format === 'html') {
        res.attachment(`${base}.html`);
        res.type('html');
        return res.send(exportHtml(result));
      }
      res.attachment(`${base}.md`);
      res.type('markdown');
      return res.send(exportMarkdown(result));
    } catch { res.status(404).json({ error: 'not found' }); }
  });

  return r;
}
