import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../backend/src/app.js';
import { exportMarkdown, exportHtml } from '../backend/src/routes.js';

describe('route hardening', () => {
  let base;
  let server;
  const savedCap = process.env.MAX_CONCURRENT_RUNS;

  before(async () => {
    const app = createApp({
      runFn: async () => ({ id: 'r1', task: {}, report: {}, sources: [], claims: [] }),
      store: {
        saveResult: async () => {}, getResult: async () => { throw new Error('nf'); },
        listResults: async () => [], deleteResult: async () => {},
      },
    });
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  });
  afterEach(() => {
    if (savedCap === undefined) delete process.env.MAX_CONCURRENT_RUNS;
    else process.env.MAX_CONCURRENT_RUNS = savedCap;
  });

  const post = (body, headers = {}) => fetch(`${base}/api/research`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-gemini-key': 'k', ...headers },
    body: JSON.stringify(body),
  });

  it('rejects unknown mode/stance before streaming (400 JSON)', async () => {
    const badMode = await post({ question: 'Is this ok?', mode: 'turbo' });
    assert.equal(badMode.status, 400);
    assert.match((await badMode.json()).error, /mode/i);
    const badStance = await post({ question: 'Is this ok?', stance: 'sycophant' });
    assert.equal(badStance.status, 400);
  });

  it('rejects with 503 when the concurrency cap is reached', async () => {
    process.env.MAX_CONCURRENT_RUNS = '0';
    const res = await post({ question: 'Is this ok?' });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /busy/i);
  });

  it('labels cached inventories honestly (never masquerades as a fresh report)', async () => {
    const app2 = createApp({
      runFn: async () => { throw new Error('must not run on cache hit'); },
      store: {
        findCached: async () => ({ id: 'c1', report: { synthesisFallback: true } }),
        saveResult: async () => {}, getResult: async () => { throw new Error('nf'); },
        listResults: async () => [], deleteResult: async () => {},
      },
    });
    const s2 = app2.listen(0, '127.0.0.1');
    await once(s2, 'listening');
    const base2 = `http://127.0.0.1:${s2.address().port}`;
    try {
      const res = await fetch(`${base2}/api/research`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-gemini-key': 'k' },
        body: JSON.stringify({ question: 'Is this ok?' }),
      });
      const text = await res.text();
      assert.ok(text.includes('cached evidence inventory'), 'fallback cache labeled honestly');
      assert.ok(!text.includes('Served from a recent identical run'), 'full-report message not used for inventory');
    } finally {
      s2.closeAllConnections?.();
      await new Promise((r) => s2.close(r));
    }
  });
});

describe('export sanitization', () => {
  const fixture = {
    task: { question: 'Q?', mode: 'quick', stance: 'neutral' },
    stanceDisclosure: '', completedAt: '', report: {
      executiveSummary: 'S', established: ['Line one\nLine two'],
      findings: [{ heading: 'Head\ning', body: 'Body.', cite: [] }],
      competing: [], contradictions: [], sourceQuality: '', independence: '',
      books: [], primarySources: [], uncertainty: ['U1\nU2'], gaps: [], methodology: 'M',
    },
    claims: [], sources: [{ id: 's1', title: 'T\nT2', url: 'https://x.example/', domain: 'x.example', tier: 6, sourceType: 'webpage', accessibility: 'unknown', verified: false, passages: [] }],
  };
  it('collapses stray newlines so list structure cannot break', () => {
    const md = exportMarkdown(fixture);
    assert.ok(md.includes('- Line one Line two'));
    assert.ok(md.includes('### Head ing'));
    assert.ok(!md.includes('### Head\ning'));
  });
  it('wraps list items in valid <ul> markup', () => {
    const html = exportHtml(fixture);
    assert.ok(html.includes('<ul><li>Line one Line two</li></ul>'));
  });
  it('keeps citations clickable and tables real in HTML export', () => {
    const linked = {
      ...fixture,
      report: {
        ...fixture.report,
        findings: [{ heading: 'Date', body: 'See archive.', cite: ['s1'] }],
        timeline: [{ date: '1088', event: 'Traditional founding' }],
      },
      sources: [{ id: 's1', title: 'Archive [charter] (copy)', url: 'https://archives.example/x', domain: 'archives.example', tier: 1, sourceType: 'primary', accessibility: 'full', verified: true, passages: [] }],
    };
    const html = exportHtml(linked);
    assert.ok(html.includes('<a href="https://archives.example/x" rel="noopener noreferrer">Archive charter copy</a>'), 'links are anchors, not dead text; metachars stripped');
    assert.ok(!html.includes('[Archive charter]('), 'no literal markdown links remain');
    assert.ok(html.includes('<table>') && html.includes('<th>Date</th>') && html.includes('<td>1088</td>'), 'chronology is a real table');
    assert.ok(!html.includes('| --- |'), 'separator row consumed');
  });
});
