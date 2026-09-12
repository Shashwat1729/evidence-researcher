// Merged extract+review (quick mode): one model call instead of two.
// generateJson is reached via mocked global fetch — no network, no key.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeClaims, extractClaimsWithReview } from '../backend/src/engine/claims.js';
import { normalizeReview } from '../backend/src/engine/contradictions.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function mockModel(payload) {
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(payload) }] } }] }),
  });
}

const SOURCES = [{ id: 's1' }, { id: 's2' }];

describe('normalizeClaims', () => {
  it('caps at 30, drops ghost ids and empty texts, coerces bad states', () => {
    const data = {
      claims: [
        { text: 'Real claim.', state: 'supported', supporting: ['s1', 'ghost'], contradicting: [], confidenceWhy: 'w' },
        { text: 'Weird state.', state: 'definitely-true', supporting: [], contradicting: [], confidenceWhy: '' },
        ...Array.from({ length: 40 }, (_, i) => ({ text: ` filler ${i} `, state: 'plausible', supporting: [], contradicting: [], confidenceWhy: '' })),
        { text: '', state: 'supported', supporting: [], contradicting: [], confidenceWhy: '' },
      ],
    };
    const out = normalizeClaims(data, SOURCES);
    assert.equal(out.length, 30);
    assert.deepEqual(out[0].supporting, ['s1']);
    assert.equal(out[1].state, 'unknown');
    assert.deepEqual(normalizeClaims({ claims: [{ text: '', state: 'supported', supporting: [], contradicting: [], confidenceWhy: '' }] }, SOURCES), []);
  });
});

describe('normalizeReview', () => {
  it('filters ghost sources, coerces severity, keeps reason', () => {
    const out = normalizeReview({
      contradictions: [{ claimId: 'c1', against: 'Counter.', sources: ['s1', 'ghost'], severity: 'extreme' }],
      gaps: ['g1'], sufficient: true, reason: 'r',
    }, SOURCES, 1);
    assert.deepEqual(out.contradictions[0].sources, ['s1']);
    assert.equal(out.contradictions[0].severity, 'medium');
    assert.equal(out.sufficient, true);
  });
});

describe('extractClaimsWithReview (single call)', () => {
  it('returns normalized claims + review from one response', async () => {
    let calls = 0;
    const payload = {
      claims: [{ text: 'X founded 1901.', state: 'supported', supporting: ['s1', 'ghost'], contradicting: [], confidenceWhy: 'charter' }],
      contradictions: [{ claimId: 'c0', against: 'Maybe later.', sources: ['s2'], severity: 'low' }],
      gaps: ['exact day'],
      sufficient: true,
      reason: 'enough',
    };
    globalThis.fetch = async () => {
      calls++;
      const text = JSON.stringify(payload);
      return {
        ok: true,
        status: 200,
        json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }),
      };
    };
    const { claims, review } = await extractClaimsWithReview({ key: 'k', model: 'm', question: 'Q?', sources: SOURCES });
    assert.equal(calls, 1, 'exactly one model round-trip');
    assert.equal(claims.length, 1);
    assert.deepEqual(claims[0].supporting, ['s1']);
    assert.equal(review.contradictions.length, 1);
    assert.deepEqual(review.gaps, ['exact day']);
    assert.equal(review.sufficient, true);
  });
});
