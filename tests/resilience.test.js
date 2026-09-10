import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonLenient, extractText, extractGrounding, generateJson, resetKeyState } from '../backend/src/gemini.js';
import { cleanText, fetchPage } from '../backend/src/providers/fetcher.js';

describe('gemini client resilience', () => {
  it('parses fenced and padded JSON', () => {
    assert.deepEqual(parseJsonLenient('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(parseJsonLenient('noise {"a":2} trailing'), { a: 2 });
    assert.throws(() => parseJsonLenient('no json here at all !!!'), /valid JSON/);
    assert.throws(() => parseJsonLenient(''), /empty/);
  });
  it('extracts text and grounding chunks from fixtures', () => {
    const resp = {
      candidates: [{
        content: { parts: [{ text: 'Spain won.' }] },
        groundingMetadata: {
          webSearchQueries: ['euro 2024 winner'],
          groundingChunks: [{ web: { uri: 'https://uefa.com/x', title: 'UEFA' } }],
          groundingSupports: [{ segment: {}, groundingChunkIndices: [0] }],
        },
      }],
    };
    assert.equal(extractText(resp), 'Spain won.');
    const g = extractGrounding(resp);
    assert.deepEqual(g.queries, ['euro 2024 winner']);
    assert.equal(g.chunks[0].url, 'https://uefa.com/x');
  });
  it('handles empty/error responses without throwing', () => {
    assert.equal(extractText({}), '');
    assert.deepEqual(extractGrounding({}).chunks, []);
  });

  it('repairs non-JSON output with one bounded retry, still throwing if unfixable', async () => {
    const realFetch = globalThis.fetch;
    const savedPrimary = process.env.GEMINI_API_KEY;
    const savedFallback = process.env.GEMINI_API_KEY_FALLBACK;
    process.env.GEMINI_API_KEY = 'K1';
    delete process.env.GEMINI_API_KEY_FALLBACK;
    resetKeyState();
    const payload = (text) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }) });
    try {
      let calls = 0;
      globalThis.fetch = async () => (++calls === 1 ? payload('Here is my analysis in prose, no JSON at all !!!') : payload('{"a":1}'));
      const r = await generateJson({ key: '', model: 'm', prompt: 'hi' });
      assert.deepEqual(r.data, { a: 1 });
      assert.equal(calls, 2);
      assert.deepEqual(r.usage, { in: 2, out: 2 });
      globalThis.fetch = async () => payload('still just prose nth time !!!');
      await assert.rejects(generateJson({ key: '', model: 'm', prompt: 'hi' }), /valid JSON/);
    } finally {
      globalThis.fetch = realFetch;
      resetKeyState();
      if (savedPrimary === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = savedPrimary;
      if (savedFallback === undefined) delete process.env.GEMINI_API_KEY_FALLBACK; else process.env.GEMINI_API_KEY_FALLBACK = savedFallback;
    }
  });
});

describe('fetcher failure behavior', () => {
  it('never throws on unreachable URLs; records reason', async () => {
    const r = await fetchPage('http://127.0.0.1:9/nope', { timeoutMs: 3000 });
    assert.equal(r.ok, false);
    assert.ok(r.reason.length > 0);
  });
  it('never throws on malformed URLs', async () => {
    const r = await fetchPage('not a url', { timeoutMs: 3000 });
    assert.equal(r.ok, false);
  });
  it('strips scripts/nav and decodes entities', () => {
    const t = cleanText('<html><head><title>T</title><script>evil()</script></head><body><nav>menu</nav><p>Fish &amp; chips &#65;</p></body></html>');
    assert.ok(!t.includes('evil') && !t.includes('menu'));
    assert.ok(t.includes('Fish & chips A'));
  });
});
