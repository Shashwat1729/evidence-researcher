// HTTP routes: research (SSE), history, export.
// BYOK: client may send x-gemini-key header (never persisted, never logged).
// Otherwise server uses GEMINI_API_KEY env (hosted server mode).

import { Router } from 'express';
import { runResearch } from './engine/orchestrator.js';
import { getKeys } from './gemini.js';
import * as defaultStore from './store.js';

export function apiRouter({ runFn = runResearch, store = defaultStore } = {}) {
  const r = Router();

  r.get('/health', (_req, res) => res.json({ ok: true, time: new Date().toISOString() }));

  r.get('/config', (_req, res) => res.json({
    serverKey: !!process.env.GEMINI_API_KEY,
    modes: ['quick', 'standard', 'deep', 'exhaustive'],
    stances: ['neutral', 'lean', 'adversarial', 'steelman', 'comparative'],
  }));

  // SSE research run. Query/body: question, mode, stance, hypothesis, documentary.
  r.post('/research', async (req, res) => {
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
    if (!getKeys(key).length) {
      return res.status(401).json({ error: 'GEMINI_API_KEY is required — enter it in the UI or set it server-side.' });
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    try {
      const result = await runFn(input, { key, emit: send });
      await store.saveResult(result).catch(() => {});
      send({ type: 'result', message: 'Done', result });
    } catch (e) {
      const status = e.status || 500;
      let msg = e.message || 'research failed';
      if (status === 429 || /quota|rate|429/i.test(msg)) msg = 'Gemini rate limit reached. Wait a minute and retry, or use a shallower mode.';
      if (/API key|API_KEY|key not valid/i.test(msg)) msg = 'Invalid Gemini API key. Check the key and try again.';
      send({ type: 'error', message: msg });
    } finally {
      res.end();
    }
  });

  r.get('/history', async (_req, res) => {
    try { res.json({ items: await store.listResults() }); }
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

  // Export: ?format=md|html|json
  r.get('/export/:id', async (req, res) => {
    try {
      const result = await store.getResult(req.params.id);
      const format = req.query.format || 'md';
      if (format === 'json') return res.json(result);
      if (format === 'html') {
        res.type('html');
        return res.send(exportHtml(result));
      }
      res.type('markdown');
      return res.send(exportMarkdown(result));
    } catch { res.status(404).json({ error: 'not found' }); }
  });

  return r;
}

export function exportMarkdown(r) {
  const byId = new Map((r.sources || []).map((s) => [s.id, s]));
  const cite = (ids = []) => ids.map((id) => {
    const s = byId.get(id);
    return s ? `[${s.title || s.domain}](${s.url})` : null;
  }).filter(Boolean).join('; ');
  const L = [];
  L.push(`# Research: ${r.task?.question || ''}`, '');
  L.push(`- Mode: ${r.task?.mode} · Stance: ${r.task?.stance} · Date: ${r.completedAt || ''}`);
  L.push(`- ${r.stanceDisclosure || ''}`, '');
  L.push(`## Executive summary`, '', r.report?.executiveSummary || '_No summary produced._', '');
  if (r.report?.established?.length) { L.push('## What we can establish', ''); for (const e of r.report.established) L.push(`- ${e}`); L.push(''); }
  L.push('## Major findings', '');
  for (const [i, f] of (r.report?.findings || []).entries()) {
    L.push(`### ${f.heading || 'Finding'}`, '', f.body || '', '');
    if (f.cite?.length) L.push(`Sources: ${cite(f.cite)}`, '');
    const v = (r.report?.verification || []).find((x) => x.n === i);
    if (v) L.push(`Cross-check: ${v.supported} — ${v.note}`, '');
  }
  if (r.report?.competing?.length) { L.push('## Competing explanations', ''); for (const c of r.report.competing) L.push(`- ${c}`); L.push(''); }
  if (r.report?.contradictions?.length) { L.push('## Contradictory evidence', ''); for (const c of r.report.contradictions) L.push(`- ${c}`); L.push(''); }
  L.push('## Claim confidence', '');
  for (const c of r.claims || []) L.push(`- **${c.state}** — ${c.text}${c.confidenceWhy ? ` (${c.confidenceWhy})` : ''}`);
  L.push('', '## Source quality', '', r.report?.sourceQuality || '', '', '## Source independence', '', r.report?.independence || r.provenance?.note || '');
  if (r.report?.books?.length) { L.push('', '## Books and scholarly literature', ''); for (const b of r.report.books) L.push(`- ${b}`); }
  if (r.report?.primarySources?.length) { L.push('', '## Primary sources', ''); for (const p of r.report.primarySources) L.push(`- ${p}`); }
  if (r.report?.uncertainty?.length) { L.push('', '## Uncertainty', ''); for (const u of r.report.uncertainty) L.push(`- ${u}`); }
  if (r.report?.gaps?.length) { L.push('', '## Research gaps', ''); for (const g of r.report.gaps) L.push(`- ${g}`); }
  L.push('', '## Methodology', '', r.report?.methodology || '', '');
  L.push('## Sources', '');
  for (const s of r.sources || []) {
    L.push(`- [${s.title || s.url}](${s.url}) — tier ${s.tier ?? '?'} (${s.sourceType}, ${s.accessibility}${s.verified ? ', inspected' : ', not inspected'})`);
  }
  return L.join('\n');
}

export function exportHtml(r) {
  const md = exportMarkdown(r)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>')
    .replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/^- (.*)$/gm, '<li>$1</li>')
    .replace(/\n\n/g, '</p><p>');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Research report</title><style>body{font-family:system-ui;max-width:800px;margin:2rem auto;padding:0 1rem;line-height:1.6}li{margin:.3rem 0}</style></head><body><p>${md}</p></body></html>`;
}
