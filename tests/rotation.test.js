import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generate, getKeys, resetKeyState } from '../backend/src/gemini.js';

const realFetch = globalThis.fetch;

function mockFetch(handler) {
  globalThis.fetch = handler;
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const okPayload = {
  candidates: [{ content: { parts: [{ text: 'hi' }] } }],
  usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
};

describe('API key rotation', () => {
  let saved = {};
  beforeEach(() => {
    resetKeyState();
    saved = { primary: process.env.GEMINI_API_KEY, fallback: process.env.GEMINI_API_KEY_FALLBACK };
    process.env.GEMINI_API_KEY = 'KEY_PRIMARY';
    process.env.GEMINI_API_KEY_FALLBACK = 'KEY_FALLBACK';
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    resetKeyState();
    if (saved.primary === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = saved.primary;
    if (saved.fallback === undefined) delete process.env.GEMINI_API_KEY_FALLBACK; else process.env.GEMINI_API_KEY_FALLBACK = saved.fallback;
  });

  it('orders keys explicit → primary → fallback, deduped', () => {
    assert.deepEqual(getKeys('K0'), ['K0', 'KEY_PRIMARY', 'KEY_FALLBACK']);
    assert.deepEqual(getKeys('KEY_PRIMARY'), ['KEY_PRIMARY', 'KEY_FALLBACK']);
    assert.deepEqual(getKeys(''), ['KEY_PRIMARY', 'KEY_FALLBACK']);
  });

  it('fails over to fallback on 429 and reports rotation (no key values leaked)', async () => {
    const seen = [];
    const events = [];
    mockFetch(async (url) => {
      seen.push(url);
      if (url.includes('KEY_PRIMARY')) return jsonResponse(429, { error: { message: 'quota', status: 'RESOURCE_EXHAUSTED' } });
      return jsonResponse(200, okPayload);
    });
    const r = await generate({ key: '', model: 'm', prompt: 'hi', onKeyEvent: (e) => events.push(e) });
    assert.equal(r.text, 'hi');
    assert.deepEqual(r.usage, { in: 5, out: 3 });
    assert.ok(seen.some((u) => u.includes('KEY_FALLBACK')));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'rotated');
    assert.equal(events[0].reason, 'rate-limit');
    assert.ok(!JSON.stringify(events).includes('KEY_'), 'rotation events must never contain key material');
  });

  it('emits resumed after waiting then succeeding', async () => {
    delete process.env.GEMINI_API_KEY_FALLBACK;
    const events = [];
    let calls = 0;
    const limited = () => jsonResponse(429, { error: { message: 'quota', status: 'RESOURCE_EXHAUSTED', details: [{ retryDelay: '1s' }] } });
    mockFetch(async () => { calls++; return calls === 1 ? limited() : jsonResponse(200, okPayload); });
    const r = await generate({ key: '', model: 'm', prompt: 'hi', onKeyEvent: (e) => events.push(e) });
    assert.equal(r.text, 'hi');
    assert.deepEqual(
      events.map((e) => e.type),
      ['rate-wait', 'resumed'],
      'exactly one wait and one resume — no spam, no silence',
    );
  });

  it('honors a tiny per-call budget and fails fast with QUOTA_EXHAUSTED', async () => {
    delete process.env.GEMINI_API_KEY_FALLBACK;
    const saved = process.env.QUOTA_WAIT_BUDGET_MS;
    process.env.QUOTA_WAIT_BUDGET_MS = '0';
    try {
      mockFetch(async () => jsonResponse(429, { error: { message: 'quota', status: 'RESOURCE_EXHAUSTED', details: [{ retryDelay: '120s' }] } }));
      const t0 = Date.now();
      const err = await generate({ key: '', model: 'm', prompt: 'hi' }).catch((e) => e);
      assert.equal(err.code, 'QUOTA_EXHAUSTED');
      assert.ok(Date.now() - t0 < 10_000, 'must not sleep through a 120s hint on zero budget');
    } finally {
      if (saved === undefined) delete process.env.QUOTA_WAIT_BUDGET_MS;
      else process.env.QUOTA_WAIT_BUDGET_MS = saved;
    }
  });

  it('fails over on invalid-key 400, then throws first error when all keys fail', async () => {
    mockFetch(async () => jsonResponse(400, { error: { message: 'API key not valid', status: 'INVALID_ARGUMENT' } }));
    await assert.rejects(generate({ key: '', model: 'm', prompt: 'hi' }), /API key not valid/);
  });

  it('does not rotate on timeouts — fails fast', async () => {
    let calls = 0;
    mockFetch(async () => { calls++; const e = new Error('aborted'); e.name = 'AbortError'; throw e; });
    await assert.rejects(generate({ key: '', model: 'm', prompt: 'hi', timeoutMs: 50 }), /aborted/);
    assert.equal(calls, 1);
  });

  it('honors RetryInfo per-minute wait when all keys are limited, then retries', async () => {
    delete process.env.GEMINI_API_KEY_FALLBACK; // single key forces the wait path
    const events = [];
    let calls = 0;
    const limited = () => jsonResponse(429, { error: { message: 'quota', status: 'RESOURCE_EXHAUSTED', details: [{ retryDelay: '1s' }] } });
    mockFetch(async () => { calls++; return calls === 1 ? limited() : jsonResponse(200, okPayload); });
    const t0 = Date.now();
    const r = await generate({ key: '', model: 'm', prompt: 'hi', onKeyEvent: (e) => events.push(e) });
    assert.equal(r.text, 'hi');
    assert.ok(Date.now() - t0 >= 900, 'should have waited out the per-minute bucket hint');
    assert.ok(events.some((e) => e.type === 'rate-wait' && e.waitMs === 1000));
    assert.ok(!JSON.stringify(events).includes('KEY_'));
  });

  it('keeps waiting across rounds (never one-and-done) until the budget is spent', async () => {
    delete process.env.GEMINI_API_KEY_FALLBACK;
    const events = [];
    let calls = 0;
    const limited = () => jsonResponse(429, { error: { message: 'quota', status: 'RESOURCE_EXHAUSTED', details: [{ retryDelay: '1s' }] } });
    mockFetch(async () => { calls++; return calls <= 2 ? limited() : jsonResponse(200, okPayload); });
    const r = await generate({ key: '', model: 'm', prompt: 'hi', onKeyEvent: (e) => events.push(e) });
    assert.equal(r.text, 'hi');
    assert.equal(calls, 3, 'two waits then success — nothing skipped');
    assert.equal(events.filter((e) => e.type === 'rate-wait').length, 2);
  });

  it('gives up fast with zero wait budget (no hanging)', async () => {
    delete process.env.GEMINI_API_KEY_FALLBACK;
    const saved = process.env.QUOTA_WAIT_BUDGET_MS;
    process.env.QUOTA_WAIT_BUDGET_MS = '0';
    try {
      mockFetch(async () => jsonResponse(429, { error: { message: 'quota', status: 'RESOURCE_EXHAUSTED', details: [{ retryDelay: '120s' }] } }));
      const err = await generate({ key: '', model: 'm', prompt: 'hi' }).catch((e) => e);
      assert.equal(err.status, 429);
      assert.equal(err.code, 'QUOTA_EXHAUSTED');
    } finally {
      if (saved === undefined) delete process.env.QUOTA_WAIT_BUDGET_MS;
      else process.env.QUOTA_WAIT_BUDGET_MS = saved;
    }
  });

  it('billing text WITH RetryInfo still waits (per-minute throttle, not a hard cap)', async () => {
    delete process.env.GEMINI_API_KEY_FALLBACK; // single key forces the wait path
    let calls = 0;
    const throttle = () => jsonResponse(429, { error: { message: 'You exceeded your current quota, please check your plan and billing details.', status: 'RESOURCE_EXHAUSTED', details: [{ retryDelay: '1s' }] } });
    mockFetch(async () => { calls++; return calls === 1 ? throttle() : jsonResponse(200, okPayload); });
    const r = await generate({ key: '', model: 'm', prompt: 'hi' });
    assert.equal(r.text, 'hi', 'must wait out the bucket, never fail fast on the text alone');
    assert.equal(calls, 2);
  });

  it('billing text WITHOUT RetryInfo fails fast as a hard cap (no futile hours)', async () => {
    delete process.env.GEMINI_API_KEY_FALLBACK;
    mockFetch(async () => jsonResponse(429, { error: { message: 'You exceeded your current quota, please check your plan and billing details.' } }));
    const err = await generate({ key: '', model: 'm', prompt: 'hi' }).catch((e) => e);
    assert.equal(err.code, 'RPD_EXHAUSTED');
  });

  it('model 404 falls back to the default model once (stale picker never kills a run)', async () => {
    delete process.env.GEMINI_API_KEY_FALLBACK;
    const seen = [];
    let calls = 0;
    mockFetch(async (url) => {
      calls++;
      const model = String(url).match(/models\/([^:]+):/)?.[1] || '';
      seen.push(decodeURIComponent(model));
      if (calls === 1) return jsonResponse(404, { error: { message: 'models/gemini-2.5-pro is no longer available to new users.', status: 'NOT_FOUND' } });
      return jsonResponse(200, { candidates: [{ content: { parts: [{ text: 'hi' }] } }] });
    });
    const events = [];
    const r = await generate({ key: '', model: 'gemini-2.5-pro', prompt: 'hi', onKeyEvent: (e) => events.push(e) }).catch((e) => e);
    assert.equal(calls, 2, 'one failed attempt + one fallback attempt');
    assert.ok(seen[0].includes('2.5-pro') && !seen[1].includes('2.5-pro'), `retried on default: ${seen.join(' → ')}`);
    assert.ok(events.some((e) => e.type === 'model-fallback'), 'loud warning, never silent substitution');
    assert.equal(r.text, 'hi');
  });
  it('quota 429 never triggers model fallback (stays and waits)', async () => {
    delete process.env.GEMINI_API_KEY_FALLBACK;
    const saved = process.env.QUOTA_WAIT_BUDGET_MS;
    process.env.QUOTA_WAIT_BUDGET_MS = '0';
    try {
      const seen = [];
      mockFetch(async (url) => {
        seen.push(String(url).match(/models\/([^:]+):/)?.[1]);
        return jsonResponse(429, { error: { message: 'quota', status: 'RESOURCE_EXHAUSTED', details: [{ retryDelay: '1s' }] } });
      });
      const err = await generate({ key: '', model: 'gemini-2.5-flash', prompt: 'hi' }).catch((e) => e);
      assert.equal(err.code, 'QUOTA_EXHAUSTED');
      assert.ok(seen.every((m) => String(m).includes('2.5-flash')), 'never switched models on quota');
    } finally {
      if (saved === undefined) delete process.env.QUOTA_WAIT_BUDGET_MS;
      else process.env.QUOTA_WAIT_BUDGET_MS = saved;
    }
  });
  it('quota errors carry the server exact wait (retryAfter ms) for timed retries', async () => {
    delete process.env.GEMINI_API_KEY_FALLBACK;
    const saved = process.env.QUOTA_WAIT_BUDGET_MS;
    process.env.QUOTA_WAIT_BUDGET_MS = '0';
    try {
      mockFetch(async () => jsonResponse(429, { error: { message: 'quota', status: 'RESOURCE_EXHAUSTED', details: [{ retryDelay: '45s' }] } }));
      const err = await generate({ key: '', model: 'm', prompt: 'hi' }).catch((e) => e);
      assert.equal(err.code, 'QUOTA_EXHAUSTED');
      assert.equal(err.retryAfter, 45000, 'section retries honor this exactly instead of guessing');
    } finally {
      if (saved === undefined) delete process.env.QUOTA_WAIT_BUDGET_MS;
      else process.env.QUOTA_WAIT_BUDGET_MS = saved;
    }
  });
});
