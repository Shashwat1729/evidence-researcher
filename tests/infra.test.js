import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../backend/src/app.js';
import { getSearchProvider, listSearchProviders } from '../backend/src/providers/registry.js';
import { logger } from '../backend/src/logger.js';
import { openapiSpec } from '../backend/src/openapi.js';
import { createRateLimiter } from '../backend/src/middleware/security.js';
import { validateMiddleware } from '../backend/src/middleware/validate.js';

describe('provider registry', () => {
  it('lists and resolves providers, rejects unknown', () => {
    assert.ok(listSearchProviders().includes('gemini'));
    assert.equal(getSearchProvider('gemini').name, 'gemini-grounding');
    assert.throws(() => getSearchProvider('nope'), /Unknown search provider/);
  });
});

describe('logger redaction', () => {
  it('never logs key material', () => {
    const lines = [];
    const orig = console.log;
    console.log = (l) => lines.push(l);
    try {
      logger.info('test', { apiKey: 'AIzaSECRET', nested: { token: 'abc' }, ok: 'fine' });
    } finally { console.log = orig; }
    const out = lines.join('\n');
    assert.ok(!out.includes('AIzaSECRET') && !out.includes('abc'));
    assert.ok(out.includes('[REDACTED]') && out.includes('fine'));
  });
});

describe('openapi spec', () => {
  it('covers all routes with a version', () => {
    assert.equal(openapiSpec.openapi, '3.0.3');
    for (const p of ['/api/health', '/api/research', '/api/history', '/api/export/{id}']) {
      assert.ok(openapiSpec.paths[p], `missing ${p}`);
    }
  });
});

describe('validate middleware', () => {
  it('passes non-research paths through', () => {
    let nexted = false;
    validateMiddleware({ path: '/health', method: 'GET' }, {}, () => { nexted = true; });
    assert.equal(nexted, true);
  });
  it('rejects bad bodies with 400', () => {
    let code = 0, body = null;
    const res = { status: (c) => { code = c; return { json: (b) => { body = b; } }; } };
    validateMiddleware({ path: '/api/research', method: 'POST', body: { question: 'x' } }, res, () => {});
    assert.equal(code, 400);
    assert.ok(body.error.length > 0);
  });
});

describe('rate limiter', () => {
  it('blocks after max requests in window', () => {
    const limit = createRateLimiter({ windowMs: 60_000, max: 2 });
    const res = () => {
      const r = { code: 0, headers: {}, status(c) { r.code = c; return { json() {} }; }, setHeader(k, v) { r.headers[k] = v; } };
      return r;
    };
    let nexts = 0;
    const next = () => { nexts++; };
    const req = { ip: '1.2.3.4', headers: {}, method: 'POST' };
    limit(req, res(), next); limit(req, res(), next);
    const r3 = res();
    limit(req, r3, next);
    assert.equal(nexts, 2);
    assert.equal(r3.code, 429);
    assert.ok(r3.headers['Retry-After'] !== undefined);
  });
});

describe('singleflight + export attachments', () => {
  let base;
  let server;
  let calls = 0;
  let release;
  const gate = () => new Promise((r) => { release = r; });

  before(async () => {
    const app = createApp({
      runFn: async () => { calls++; await gate(); return { id: 'shared', task: {}, report: {}, sources: [], claims: [] }; },
      store: {
        saveResult: async () => {}, getResult: async (id) => ({ id, task: { question: 'Q' }, report: {}, sources: [], claims: [] }),
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
  afterEach(() => { calls = 0; });

  async function readResult(res) {
    let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += Buffer.from(chunk).toString();
        if (buf.includes('"type":"result"')) break;
      }
    } finally { await res.body.cancel().catch(() => {}); }
    const ev = buf.split('\n\n').map((p) => { try { return JSON.parse(p.split('data:')[1]); } catch { return null; } }).find((e) => e?.type === 'result');
    return ev?.result;
  }

  it('two identical concurrent runs execute once and both get the result', async () => {
    const body = JSON.stringify({ question: 'Same question here?' });
    const h = { 'Content-Type': 'application/json', 'x-gemini-key': 'k' };
    const [r1, r2] = await Promise.all([
      fetch(`${base}/api/research`, { method: 'POST', headers: h, body }),
      fetch(`${base}/api/research`, { method: 'POST', headers: h, body }),
    ]);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    release(); // let the single shared run complete
    const [res1, res2] = await Promise.all([readResult(r1), readResult(r2)]);
    assert.equal(calls, 1);
    assert.equal(res1?.id, 'shared');
    assert.equal(res2?.id, 'shared');
  });

  it('exports download as attachments', async () => {
    const md = await fetch(`${base}/api/export/abc?format=md`);
    assert.equal(md.status, 200);
    assert.match(md.headers.get('content-disposition') || '', /attachment.*\.md/);
    const js = await fetch(`${base}/api/export/abc?format=json`);
    assert.match(js.headers.get('content-disposition') || '', /attachment.*\.json/);
  });
});
