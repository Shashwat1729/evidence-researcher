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
});
