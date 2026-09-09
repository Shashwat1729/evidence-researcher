import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseJsonLenient, extractText, extractGrounding } from '../backend/src/gemini.js';
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
