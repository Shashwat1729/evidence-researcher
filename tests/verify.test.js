import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { verifyFindings } from '../backend/src/engine/verify.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const sources = [
  { id: 's1', passages: [{ text: 'The charter dated 1088 establishes the studium.' }] },
  { id: 's2', passages: [] },
];

describe('post-synthesis verification', () => {
  it('grades findings against excerpts strictly', async () => {
    globalThis.fetch = async () => jsonResponse(200, {
      candidates: [{ content: { parts: [{ text: '{"results":[{"n":0,"supported":"yes","note":"Direct match."},{"n":1,"supported":"no","note":"No excerpts."}]}' }] } }],
      usageMetadata: {},
    });
    const out = await verifyFindings({
      key: 'k', model: 'm',
      findings: [
        { heading: 'Date', body: 'Founded 1088.', cite: ['s1'] },
        { heading: 'Cause', body: 'Economic decline.', cite: ['s2'] },
      ],
      sources,
    });
    assert.equal(out.length, 2);
    assert.equal(out[0].supported, 'yes');
    assert.equal(out[1].supported, 'no');
  });

  it('never fails the run — returns [] when the model errors', async () => {
    globalThis.fetch = async () => { throw new Error('down'); };
    const out = await verifyFindings({ key: 'k', model: 'm', findings: [{ heading: 'H', body: 'B', cite: [] }], sources });
    assert.deepEqual(out, []);
  });

  it('returns [] with no findings (no wasted call)', async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return jsonResponse(200, {}); };
    assert.deepEqual(await verifyFindings({ key: 'k', model: 'm', findings: [], sources }), []);
    assert.equal(calls, 0);
  });
});
