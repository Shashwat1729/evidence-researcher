import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evidenceQuality } from '../backend/src/quality.js';

const src = (id, extra = {}) => ({ id, url: `https://${id}.example/x`, tier: 1, verified: true, ...extra });

describe('evidence quality metrics', () => {
  it('reports null, not zero, when there is nothing to measure', () => {
    const q = evidenceQuality({});
    assert.equal(q.attributableFindingRate, null, 'no denominator, no rate');
    assert.equal(q.claimSupportRate, null);
    assert.equal(q.citationPrecision, null);
    assert.match(q.weakestLink, /No findings or claims/);
  });

  it('measures attributable findings (the Auto-AIS analogue)', () => {
    const q = evidenceQuality({
      report: { findings: [{ cite: ['s1'] }, { cite: ['s2'] }, { cite: [] }, { cite: [] }] },
      claims: [], sources: [src('s1'), src('s2')],
    });
    assert.equal(q.findingsTotal, 4);
    assert.equal(q.findingsCited, 2);
    assert.equal(q.findingsUncited, 2);
    assert.equal(q.attributableFindingRate, 0.5);
    assert.match(q.weakestLink, /2 of 4 findings carry no citation/);
  });

  it('measures claim support (the FActScore analogue) and keeps the histogram', () => {
    const q = evidenceQuality({
      report: { findings: [] },
      claims: [
        { state: 'strongly-supported' }, { state: 'supported' },
        { state: 'disputed' }, { state: 'unknown' },
      ],
      sources: [],
    });
    assert.equal(q.claimsTotal, 4);
    assert.equal(q.claimSupportRate, 0.5);
    assert.deepEqual(q.claimStates, { 'strongly-supported': 1, supported: 1, disputed: 1, unknown: 1 });
  });

  it('flags citations that support no claim (the ALCE precision analogue)', () => {
    const q = evidenceQuality({
      report: { findings: [{ cite: ['s1', 's2', 's3'] }] },
      // Only s1 carries claim weight; s2 and s3 are listed but load nothing.
      claims: [{ state: 'supported', supporting: ['s1'], contradicting: [] }],
      sources: [src('s1'), src('s2'), src('s3')],
    });
    assert.equal(q.citationsTotal, 3);
    assert.equal(q.decorativeCitations, 2);
    assert.equal(q.citationPrecision, 1 / 3);
    assert.match(q.weakestLink, /support no claim/);
  });

  it('prefers claims whose support spans independent sources', () => {
    const q = evidenceQuality({
      report: { findings: [{ cite: ['a', 'b', 'c', 'd'] }] },
      claims: [
        { state: 'supported', supporting: ['a'], contradicting: [] },   // one source, group 1
        { state: 'supported', supporting: ['b'], contradicting: [] },   // one source, SAME group 1
        { state: 'supported', supporting: ['a', 'c'], contradicting: [] }, // two sources, two groups
      ],
      sources: [src('a'), src('b'), src('c'), src('d')],
      provenance: { groups: [{ ids: ['a', 'b'] }, { ids: ['c', 'd'] }] },
    });
    assert.equal(q.claimsWithProvenance, 3);
    assert.equal(q.multiSourceClaims, 1, 'only one claim cites more than one source');
    assert.equal(q.independentClaims, 1, 'and only that one spans two provenance groups');
    assert.equal(q.independenceAdjustedRate, 1 / 3);
  });

  it('does not count two pages of one site as cross-verification', () => {
    const q = evidenceQuality({
      report: { findings: [] },
      claims: [{ state: 'supported', supporting: ['a', 'b'], contradicting: [] }],
      sources: [src('a'), src('b')],
      provenance: { groups: [{ ids: ['a', 'b'] }] },   // one cluster: same site
    });
    assert.equal(q.multiSourceClaims, 1, 'two sources cited');
    assert.equal(q.independentClaims, 0, 'but both are the same provenance group');
  });

  it('reports how much of the source set was actually read', () => {
    const q = evidenceQuality({
      report: { findings: [] }, claims: [],
      sources: [src('a'), src('b'), src('c', { verified: false }), src('d', { verified: false })],
    });
    assert.equal(q.sourcesTotal, 4);
    assert.equal(q.sourcesInspected, 2);
    assert.equal(q.inspectedSourceRate, 0.5);
  });

  it('flags a degraded write-up rather than letting the numbers look healthy', () => {
    const q = evidenceQuality({
      report: { findings: [{ cite: ['s1'] }], synthesisFallback: true },
      claims: [{ state: 'supported', supporting: ['s1'], contradicting: [] }],
      sources: [src('s1')],
    });
    assert.equal(q.synthesisFallback, true);
    // Every rate is clean here (1 finding, cited; 1 claim, supported). The
    // degradation must still surface, or a clean-looking report would imply a
    // finished interpretation it does not contain.
    assert.equal(q.attributableFindingRate, 1);
    assert.equal(q.claimSupportRate, 1);
    assert.match(q.weakestLink, /model quota ran out/);
  });

  it('never invents a grade', () => {
    const q = evidenceQuality({ report: { findings: [] }, claims: [], sources: [] });
    const keys = Object.keys(q);
    for (const forbidden of ['grade', 'score', 'letter', 'rating']) {
      assert.ok(!keys.some((k) => k.toLowerCase().includes(forbidden)), `no "${forbidden}" field`);
    }
  });
});