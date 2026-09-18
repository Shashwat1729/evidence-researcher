// Merged extract+review (quick mode): one model call instead of two.
// generateJson is reached via mocked global fetch — no network, no key.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeClaims, extractClaimsWithReview, fitSourcesBudget } from '../backend/src/engine/claims.js';
import { findContradictionsAndGaps } from '../backend/src/engine/contradictions.js';
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

describe('fitSourcesBudget (whole records, best-first)', () => {
  const mk = (id, pad) => ({ id, title: `Title ${id}`, url: `https://x.example/${id}`, tier: 2, passages: [{ text: `Excerpt ${pad}` }] });
  it('fits whole records under budget, never mid-object truncation', () => {
    const sources = [mk('s1', 'a'.repeat(200)), mk('s2', 'b'.repeat(200)), mk('s3', 'c'.repeat(200))];
    const one = JSON.stringify({ id: 's1', title: 'Title s1', url: 'https://x.example/s1', tier: 2, excerpt: `Excerpt ${'a'.repeat(200)}` }).length;
    const picked = fitSourcesBudget(sources, one * 2 + 10);
    assert.equal(picked.length, 2, 'two whole records fit, third excluded whole');
    assert.ok(JSON.parse(JSON.stringify(picked)), 'output is valid complete JSON');
    assert.equal(picked[0].id, 's1', 'best-first order preserved');
  });
  it('always includes at least the first record even over budget', () => {
    const picked = fitSourcesBudget([mk('s1', 'z'.repeat(5000))], 100);
    assert.equal(picked.length, 1);
  });
  it('empty sources yield empty list', () => {
    assert.deepEqual(fitSourcesBudget([], 12000), []);
  });
});

describe('findContradictionsAndGaps fallback honesty', () => {
  it('never declares sufficiency on model silence (would skip contradiction hunting)', async () => {
    globalThis.fetch = async () => { throw new Error('quota dead'); };
    const out = await findContradictionsAndGaps({ key: 'k', model: 'm', question: 'Q?', claims: [{ id: 'c1', text: 'X.', state: 'supported' }], sources: SOURCES, iteration: 3 });
    assert.equal(out.sufficient, false, 'failed review stays provisional even at iteration 3');
    assert.ok(out.gaps.length >= 1);
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
