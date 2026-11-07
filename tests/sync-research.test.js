// REST surface: sync delivery mode, receipts endpoint, service metadata,
// idempotency, validation and error behavior — all with a fake runFn.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../backend/src/app.js';

let server; let base;
const fakeResult = () => ({ id: 'task_sync1', task: { question: 'q?', mode: 'quick' }, claims: [], sources: [], completedAt: new Date().toISOString() });

before(async () => {
  process.env.GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'test-key';
  const fakeStore = { saveResult: async () => {}, getResult: async () => null, listResults: async () => [], deleteResult: async () => {}, findCached: async () => null, saveCacheEntry: async () => {} };
  const app = createApp({ runFn: async () => fakeResult(), store: fakeStore });
  server = app.listen(0);
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

describe('sync research delivery', () => {
  it('returns one JSON result with a receipt for stream:false', async () => {
    const res = await fetch(`${base}/api/research`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'Is the sky blue?', mode: 'quick', stream: false }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, 'task_sync1');
    assert.ok(body.receipt, 'receipt attached');
    assert.equal(body.receipt.v, 1);
    assert.ok(body.receipt.sig.length > 20);
    assert.ok(body.receipt.delivery_sha256.length === 64);
  });

  it('replays the same result for a repeated Idempotency-Key', async () => {
    const init = {
      method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'idem-1' },
      body: JSON.stringify({ question: 'Is water wet?', mode: 'quick', stream: false }),
    };
    const a = await (await fetch(`${base}/api/research`, init)).json();
    const b = await (await fetch(`${base}/api/research`, { ...init, headers: { ...init.headers } })).json();
    assert.equal(a.id, b.id);
    assert.equal(a.receipt.sig, b.receipt.sig);
  });

  it('rejects malformed bodies with 400', async () => {
    const res = await fetch(`${base}/api/research`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'quick' }),
    });
    assert.equal(res.status, 400);
  });
});

describe('discovery endpoints', () => {
  it('serves the public keys document', async () => {
    const res = await fetch(`${base}/.well-known/receipts.json`);
    assert.equal(res.status, 200);
    const doc = await res.json();
    assert.equal(doc.alg, 'Ed25519');
    assert.equal(doc.keys[0].kty, 'OKP');
    assert.equal(doc.keys[0].d, undefined, 'no private material');
  });

  it('serves service metadata', async () => {
    const res = await fetch(`${base}/api/service`);
    const svc = await res.json();
    assert.ok(svc.name);
    assert.ok(Number.isFinite(svc.price_minor));
    assert.ok(svc.endpoints.research);
  });

  it('health endpoint reports ok', async () => {
    const res = await fetch(`${base}/api/health`);
    const h = await res.json();
    assert.equal(h.ok, true);
  });
});
