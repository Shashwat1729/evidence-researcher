import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { applyBudgetOverrides, MODES } from '../backend/src/config.js';
import { pool } from '../backend/src/engine/pool.js';
import { deduplicate } from '../backend/src/engine/dedup.js';
import { classifySource } from '../backend/src/engine/classify.js';
import { analyzeProvenance } from '../backend/src/engine/provenance.js';
import { createApp } from '../backend/src/app.js';

describe('budget overrides (pure, safe)', () => {
  it('merges numbers/booleans, ignores strings/unknown/malformed', () => {
    const modes = JSON.parse(JSON.stringify({ quick: MODES.quick }));
    applyBudgetOverrides(modes, { quick: { maxSearches: 3, academic: true, label: 'HACK', maxTokensOut: 'x' }, bogus: { a: 1 } });
    assert.equal(modes.quick.maxSearches, 3);
    assert.equal(modes.quick.academic, true);
    assert.equal(modes.quick.label, 'Quick');
    assert.equal(modes.quick.maxTokensOut, MODES.quick.maxTokensOut);
    assert.equal(modes.bogus, undefined);
    assert.doesNotThrow(() => applyBudgetOverrides(modes, null));
  });
});

describe('pool limit sanitization', () => {
  it('NaN/zero/negative degrade to serial, never silent loss', async () => {
    for (const lim of [NaN, 0, -3, 2.7]) {
      const out = await pool([1, 2, 3], lim, async (x) => x * 2);
      assert.deepEqual(out, [2, 4, 6]);
    }
  });
});

describe('dedup edge cases', () => {
  it('URL-less records never merge into anything', () => {
    const { unique, duplicates } = deduplicate([
      { url: '', title: 'Same title here' },
      { url: '', title: 'Same title here' },
      { url: 'https://a.example/x', title: 'Same title here' },
    ]);
    assert.equal(unique.length, 3);
    assert.equal(duplicates.length, 0);
  });
  it('generic titles do not merge distinct articles; real identical titles still merge', () => {
    const generic = deduplicate([
      { url: 'https://a.example/home', title: 'Home' },
      { url: 'https://b.example/home', title: 'Home' },
    ]);
    assert.equal(generic.unique.length, 2);
    const real = deduplicate([
      { url: 'https://a.example/charter-translation', title: 'Complete Translation of the 1901 Founding Charter' },
      { url: 'https://b.example/charter-translation', title: 'Complete Translation of the 1901 Founding Charter' },
    ]);
    assert.equal(real.unique.length, 1);
    assert.equal(real.duplicates[0].reason, 'identical title');
  });
});

describe('blog-path demotion', () => {
  it('caps news blogs at tier 6 but spares declared papers', () => {
    const blog = classifySource({ url: 'https://example-news.com/blog/opinion-take', title: 'Take', snippet: 'peer-reviewed discussion of findings' });
    assert.equal(blog.tier, 6);
    const paper = classifySource({ url: 'https://example.com/blog/paper-notes', title: 'Paper', snippet: '', sourceType: 'paper' });
    assert.equal(paper.tier, 2);
  });
});

describe('provenance root validation (mocked model)', () => {
  const realFetch = globalThis.fetch;
  const mkSources = () => [
    { id: 'a', url: 'https://a.example/x', title: 'A', passages: [{ text: 'the quick brown fox jumps over the lazy dog near the riverbank at dawn'.repeat(6) }] },
    { id: 'b', url: 'https://b.example/y', title: 'B', passages: [{ text: 'intro words here the quick brown fox jumps over the lazy dog near the riverbank at dawn'.repeat(6) }] },
  ];
  function mockVerdict(body) {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(body) }] } }] }) });
  }
  it('drops relations pointing at hallucinated root ids', async () => {
    const saved = { p: process.env.GEMINI_API_KEY, f: process.env.GEMINI_API_KEY_FALLBACK };
    process.env.GEMINI_API_KEY = 'K1';
    delete process.env.GEMINI_API_KEY_FALLBACK;
    try {
      mockVerdict({ verdict: 'derived', root: 'ghost-id', explanation: 'x' });
      const r = await analyzeProvenance({ key: '', model: 'm', sources: mkSources() });
      assert.equal(r.relations.length, 0);
      mockVerdict({ verdict: 'derived', root: 'a', explanation: 'b copies a' });
      const r2 = await analyzeProvenance({ key: '', model: 'm', sources: mkSources() });
      assert.equal(r2.relations.length, 1);
      assert.deepEqual([r2.relations[0].from, r2.relations[0].to], ['b', 'a']);
    } finally {
      globalThis.fetch = realFetch;
      if (saved.p === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = saved.p;
      if (saved.f === undefined) delete process.env.GEMINI_API_KEY_FALLBACK; else process.env.GEMINI_API_KEY_FALLBACK = saved.f;
    }
  });
});

describe('metrics endpoint', () => {
  let base;
  let server;
  let shouldFail = false;
  before(async () => {
    const app = createApp({
      runFn: async () => {
        if (shouldFail) throw Object.assign(new Error('nope'), { status: 500 });
        return { id: 'm1', task: { mode: 'quick' }, report: {}, sources: [], claims: [] };
      },
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

  it('counts started/completed/failed and byMode', async () => {
    const post = () => fetch(`${base}/api/research`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-gemini-key': 'k' },
      body: JSON.stringify({ question: 'Metrics ok?' }),
    });
    const r1 = await post();
    assert.equal(r1.status, 200);
    await r1.body.cancel().catch(() => {});
    shouldFail = true;
    const r2 = await post();
    assert.equal(r2.status, 200); // streams SSE error event
    await r2.body.cancel().catch(() => {});
    shouldFail = false;
    const m = await (await fetch(`${base}/api/metrics`)).json();
    assert.equal(m.runsStarted, 2);
    assert.equal(m.runsCompleted, 1);
    assert.equal(m.runsFailed, 1);
    assert.equal(m.byMode.standard, 2);
  });
});
