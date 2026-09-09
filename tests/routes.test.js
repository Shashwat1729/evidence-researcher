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
});
