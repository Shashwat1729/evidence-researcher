import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { geminiSearchProvider } from '../backend/src/providers/geminiSearch.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe('grounding snippet attribution', () => {
  it('maps support segments by ORIGINAL chunk index, not filtered position', async () => {
    // Regression: groundingChunkIndices refer to the raw chunks array. The old
    // code filtered non-http chunks first, so every later passage slid onto
    // the wrong source (evidence attached to the wrong URL).
    const text = 'AAAAAAAAAA' + 'BBBBBBBBBB' + 'CCCCCCCCCC';
    globalThis.fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({
        candidates: [{
          content: { parts: [{ text }] },
          groundingMetadata: {
            webSearchQueries: ['q'],
            groundingChunks: [
              { web: { uri: 'notaurl', title: 'Dropped' } },
              { web: { uri: 'https://a.example/1', title: 'A' } },
              { web: { uri: 'https://b.example/2', title: 'B' } },
            ],
            groundingSupports: [
              { segment: { startIndex: 0, endIndex: 10 }, groundingChunkIndices: [1] },
              { segment: { startIndex: 20, endIndex: 30 }, groundingChunkIndices: [2] },
            ],
          },
        }],
      }),
    });
    const out = await geminiSearchProvider.search('q', { key: 'K', model: 'm' });
    assert.equal(out.length, 2);
    assert.equal(out[0].url, 'https://a.example/1');
    assert.equal(out[0].snippet, 'AAAAAAAAAA');
    assert.equal(out[1].url, 'https://b.example/2');
    assert.equal(out[1].snippet, 'CCCCCCCCCC');
  });
});
