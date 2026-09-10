// HTTP routes: research (SSE), history, export.
// BYOK: client may send x-gemini-key header (never persisted, never logged).
// Otherwise server uses GEMINI_API_KEY env (hosted server mode).

import { Router } from 'express';
import { runResearch } from './engine/orchestrator.js';
import { getKeys } from './gemini.js';
import { academicCache } from './cache.js';
import { createRateLimiter } from './middleware/security.js';
import * as defaultStore from './store.js';

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
    version: process.env.npm_package_version || '1.0.0',
    memory: process.memoryUsage(),
    model: process.env.DEFAULT_MODEL || 'gemini-2.5-flash',
    cache: { academicEntries: academicCache.size },
  }));

  r.get('/config', (_req, res) => res.json({
    serverKey: !!process.env.GEMINI_API_KEY,
    hasFallback: !!process.env.GEMINI_API_KEY_FALLBACK,
    modes: ['quick', 'standard', 'deep', 'exhaustive'],
    stances: ['neutral', 'lean', 'adversarial', 'steelman', 'comparative'],
  }));

  // SSE research run. Query/body: question, mode, stance, hypothesis, documentary.
  r.post('/research', researchLimiter, async (req, res) => {
    const key = (req.header('x-gemini-key') || '').trim() || (process.env.GEMINI_API_KEY || '').trim();
    const input = {
      question: req.body?.question || '',
      mode: req.body?.mode || 'standard',
      stance: req.body?.stance || 'neutral',
      hypothesis: req.body?.hypothesis || '',
      documentary: !!req.body?.documentary,
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
    if (!getKeys(key).length) {
      return res.status(401).json({ error: 'GEMINI_API_KEY is required — enter it in the UI or set it server-side.' });
    }
    const rawCap = Number(process.env.MAX_CONCURRENT_RUNS);
    const cap = Number.isFinite(rawCap) ? Math.max(0, rawCap) : 8;
    // Singleflight: identical concurrent bodies share ONE run (fresh result,
    // zero extra quota). Joiners get a note + the final result event.
    const bk = JSON.stringify([input.question, input.mode, input.stance, input.hypothesis, input.documentary]);
    const shared = inflight.get(bk);
    // SSE preamble shared by owner + joiner paths.
    const beginStream = () => {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      if (typeof res.flushHeaders === 'function') { try { res.flushHeaders(); } catch { /* ignore */ } }
    };
    let closed = false;
    res.on('close', () => { if (!res.writableEnded) closed = true; });
    // Never throw on a dead socket: a disconnected client must not crash the run.
    const send = (obj) => {
      if (closed || res.writableEnded) return;
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); }
      catch { closed = true; }
    };
    const sendError = (e) => {
      const status = e.status || 500;
      let msg = e.message || 'research failed';
      if (status === 429 || /quota|rate|429/i.test(msg)) msg = 'Gemini rate limit reached. Wait a minute and retry, or use a shallower mode.';
      if (/API key|API_KEY|key not valid/i.test(msg)) msg = 'Invalid Gemini API key. Check the key and try again.';
      send({ type: 'error', message: msg });
    };
    const finish = () => { try { if (!res.writableEnded) res.end(); } catch { /* ignore */ } };
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
      task = runFn(input, { key, emit: send, isCancelled: () => entry.clients <= 0 });
    } catch (e) {
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
    try { res.json(await store.getResult(req.params.id)); }
    catch { res.status(404).json({ error: 'not found' }); }
  });

  r.delete('/history/:id', async (req, res) => {
    try { await store.deleteResult(req.params.id); res.json({ ok: true }); }
    catch { res.status(404).json({ error: 'not found' }); }
  });

  // Export: ?format=md|html|json (downloads as attachment)
  r.get('/export/:id', async (req, res) => {
    try {
      const result = await store.getResult(req.params.id);
      const format = req.query.format || 'md';
      const base = `research-${String(req.params.id).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'report'}`;
      if (format === 'json') {
        res.attachment(`${base}.json`);
        return res.json(result);
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

export function exportMarkdown(r) {
  // One-liner: model text with stray newlines must not break list structure.
  const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const byId = new Map((r.sources || []).map((s) => [s.id, s]));
  const cite = (ids = []) => ids.map((id) => {
    const s = byId.get(id);
    if (!s) return null;
    // Strip markdown metachars from link text so model titles can't break links.
    const text = oneLine(s.title || s.domain).replace(/[\[\]()]/g, '');
    return `[${text}](${s.url})`;
  }).filter(Boolean).join('; ');
  const L = [];
  L.push(`# Research: ${oneLine(r.task?.question) || ''}`, '');
  L.push(`- Mode: ${r.task?.mode} · Stance: ${r.task?.stance} · Date: ${r.completedAt || ''}`);
  if (oneLine(r.stanceDisclosure)) L.push(`- ${oneLine(r.stanceDisclosure)}`, ''); else L.push('');
  L.push(`## Executive summary`, '', r.report?.executiveSummary || '_No summary produced._', '');
  if (r.report?.established?.length) { L.push('## What we can establish', ''); for (const e of r.report.established) L.push(`- ${oneLine(e)}`); L.push(''); }
  L.push('## Major findings', '');
  for (const [i, f] of (r.report?.findings || []).entries()) {
    L.push(`### ${oneLine(f.heading) || 'Finding'}`, '', f.body || '', '');
    if (f.cite?.length) L.push(`Sources: ${cite(f.cite)}`, '');
    const v = (r.report?.verification || []).find((x) => x.n === i);
    if (v) L.push(`Cross-check: ${v.supported} — ${oneLine(v.note)}`, '');
  }
  if (r.report?.competing?.length) { L.push('## Competing explanations', ''); for (const c of r.report.competing) L.push(`- ${oneLine(c)}`); L.push(''); }
  if (r.report?.contradictions?.length) { L.push('## Contradictory evidence', ''); for (const c of r.report.contradictions) L.push(`- ${oneLine(c)}`); L.push(''); }
  L.push('## Claim confidence', '');
  for (const c of r.claims || []) L.push(`- **${c.state}** — ${oneLine(c.text)}${c.confidenceWhy ? ` (${oneLine(c.confidenceWhy)})` : ''}`);
  L.push('', '## Source quality', '', r.report?.sourceQuality || '', '', '## Source independence', '', r.report?.independence || r.provenance?.note || '');
  if (r.report?.books?.length) { L.push('', '## Books and scholarly literature', ''); for (const b of r.report.books) L.push(`- ${oneLine(b)}`); }
  if (r.report?.primarySources?.length) { L.push('', '## Primary sources', ''); for (const p of r.report.primarySources) L.push(`- ${oneLine(p)}`); }
  if (r.report?.uncertainty?.length) { L.push('', '## Uncertainty', ''); for (const u of r.report.uncertainty) L.push(`- ${oneLine(u)}`); }
  if (r.report?.gaps?.length) { L.push('', '## Research gaps', ''); for (const g of r.report.gaps) L.push(`- ${oneLine(g)}`); }
  L.push('', '## Methodology', '', r.report?.methodology || '', '');
  L.push('## Sources', '');
  for (const s of r.sources || []) {
    L.push(`- [${oneLine(s.title || s.url)}](${s.url}) — tier ${s.tier ?? '?'} (${s.sourceType}, ${s.accessibility}${s.verified ? ', inspected' : ', not inspected'})`);
  }
  return L.join('\n');
}

export function exportHtml(r) {
  const md = exportMarkdown(r)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>')
    .replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/^- \s*$/gm, '')
    .replace(/^- (.*)$/gm, '<li>$1</li>')
    .replace(/((?:<li>.*?<\/li>)(?:\n<li>.*?<\/li>)*)/g, '<ul>$1</ul>')
    .replace(/\n\n/g, '</p><p>');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Research report</title><style>body{font-family:system-ui;max-width:800px;margin:2rem auto;padding:0 1rem;line-height:1.6}li{margin:.3rem 0}</style></head><body><p>${md}</p></body></html>`;
}
