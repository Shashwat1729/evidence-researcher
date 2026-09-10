import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { runResearch } from '../backend/src/engine/orchestrator.js';
import { createApp } from '../backend/src/app.js';

const silentDeps = {
  plan: async () => ({ domain: 'general-factual', complexity: 'low', steps: [], linesOfInquiry: [] }),
  queries: async () => [],
  search: async () => [],
  academic: async () => [],
  books: async () => [],
  fetch: async () => ({ ok: false, reason: 'unavailable' }),
  claims: async () => [],
  review: async () => ({ contradictions: [], gaps: [], sufficient: true, reason: 'ok' }),
  provenance: async () => ({ groups: [], relations: [], note: 'n/a' }),
  synthesize: async () => ({
    executiveSummary: '', established: [], findings: [], competing: [], contradictions: [],
    sourceQuality: '', independence: '', books: [], primarySources: [], uncertainty: [], gaps: [], methodology: '',
  }),
  verify: async () => [],
  urlContext: async () => ({ text: '' }),
};

describe('run cancellation (client disconnect)', () => {
  it('aborts before any work when already cancelled', async () => {
    let modelCalls = 0;
    await assert.rejects(
      runResearch(
        { question: 'Will this run?', mode: 'quick', stance: 'neutral' },
        {
          key: 'k', emit: () => {}, isCancelled: () => true,
          deps: { ...silentDeps, plan: async () => { modelCalls++; return silentDeps.plan(); } },
        },
      ),
      (e) => e.code === 'CANCELLED' && modelCalls === 0,
    );
  });

  it('stops mid-run without further searches once cancelled', async () => {
    let searches = 0;
    let cancelled = false;
    await assert.rejects(
      runResearch(
        { question: 'Will this stop?', mode: 'standard', stance: 'neutral' },
        {
          key: 'k', emit: () => {}, isCancelled: () => cancelled,
          deps: {
            ...silentDeps,
            queries: async () => [{ q: 'a', category: 'general' }, { q: 'b', category: 'general' }],
            search: async () => { searches++; cancelled = true; return []; },
          },
        },
      ),
      (e) => e.code === 'CANCELLED' && searches >= 1,
    );
  });
});

describe('history pagination + request telemetry', () => {
  let base;
  let server;
  let seenLimit;
  let capturedOpts = null;

  before(async () => {
    const app = createApp({
      runFn: async (_input, opts) => { capturedOpts = { fn: typeof opts.isCancelled, duringRun: opts.isCancelled() }; return { id: 'r1', task: {}, report: {}, sources: [], claims: [] }; },
      store: {
        saveResult: async () => {}, getResult: async () => { throw new Error('nf'); },
        listResults: async (lim) => { seenLimit = lim; return []; },
        deleteResult: async () => {},
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

  it('passes isCancelled wiring into the engine', async () => {
    const res = await fetch(`${base}/api/research`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-gemini-key': 'k' },
      body: JSON.stringify({ question: 'Is wiring ok?' }),
    });
    assert.equal(res.status, 200);
    await res.body.cancel().catch(() => {});
    assert.equal(capturedOpts?.fn, 'function');
    assert.equal(capturedOpts?.duringRun, false);
  });

  it('clamps ?limit= to 1..200, default 50', async () => {
    await (await fetch(`${base}/api/history?limit=5`)).json();
    assert.equal(seenLimit, 5);
    await (await fetch(`${base}/api/history?limit=9999`)).json();
    assert.equal(seenLimit, 200);
    await (await fetch(`${base}/api/history?limit=abc`)).json();
    assert.equal(seenLimit, 50);
  });

  it('echoes X-Request-Id and reports cache stats in health', async () => {
    const res = await fetch(`${base}/api/health`);
    assert.ok(res.headers.get('x-request-id'), 'request id echoed');
    const body = await res.json();
    assert.equal(typeof body.cache?.academicEntries, 'number');
  });
});

describe('Vercel entry middleware parity', () => {
  it('serves openapi + security headers through api/index', async () => {
    const { default: app } = await import('../api/index.js');
    const srv = app.listen(0, '127.0.0.1');
    await once(srv, 'listening');
    try {
      const port = srv.address().port;
      const spec = await (await fetch(`http://127.0.0.1:${port}/api/openapi.json`)).json();
      assert.equal(spec.openapi, '3.0.3');
      const h = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(h.headers.get('x-content-type-options'), 'nosniff');
      assert.ok(h.headers.get('x-request-id'));
    } finally {
      srv.closeAllConnections?.();
      await new Promise((r) => srv.close(r));
    }
  });
});
