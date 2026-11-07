// Evidence + confidence: deterministic shapes and honest degeneration.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evidenceForClaim, contradictingEvidenceForClaim } from '../backend/src/engine/evidence.js';
import { scoreClaimConfidence, claimStatus, independenceFor } from '../backend/src/engine/confidence.js';

const srcs = [
  { id: 's1', tier: 1, proximity: 'primary', domain: 'archives.gov', passages: [{ text: 'charter text' }], independence: 'independent' },
  { id: 's2', tier: 3, proximity: 'secondary', domain: 'news.com', passages: [{ text: 'news report' }], independence: 'independent' },
  { id: 's3', tier: 6, proximity: 'tertiary', domain: 'blog.com', passages: [{ text: 'blog post' }], independence: 'derived' },
];

describe('evidence objects', () => {
  it('builds supporting evidence with strength and directness', () => {
    const ev = evidenceForClaim({ id: 'c1', supporting: ['s1', 's2'] }, srcs);
    assert.equal(ev.length, 2);
    assert.equal(ev[0].type, 'supporting');
    assert.equal(ev[0].directness, 'direct');
    assert.ok(ev[0].strength > 0.8);
    assert.equal(ev[0].source_id, 's1');
  });
  it('builds contradicting evidence', () => {
    const ev = contradictingEvidenceForClaim({ id: 'c1', contradicting: ['s3'] }, srcs);
    assert.equal(ev.length, 1);
    assert.equal(ev[0].type, 'contradicting');
    assert.ok(ev[0].strength < 0.5);
  });
});

describe('confidence', () => {
  it('scores strong independent evidence high', () => {
    const c = scoreClaimConfidence({ claim: { state: 'supported', supporting: ['s1', 's2'], contradicting: [] }, sources: srcs, relations: [] });
    assert.ok(c.score >= 0.6, `got ${c.score}`);
    assert.ok(['high', 'medium'].includes(c.label));
    assert.ok(c.factors.length >= 5);
  });
  it('caps derived-only support at low confidence', () => {
    const c = scoreClaimConfidence({ claim: { state: 'supported', supporting: ['s3'], contradicting: [] }, sources: srcs, relations: [{ from: 's3', to: 's1', kind: 'derived_from' }] });
    assert.ok(c.score <= 0.4, `got ${c.score}`);
  });
  it('caps contradicted claims at 0.6', () => {
    const c = scoreClaimConfidence({ claim: { id: 'c1', state: 'supported', supporting: ['s1', 's2'], contradicting: ['s3'] }, sources: srcs, relations: [], contradictions: [{ claimId: 'c1', severity: 'high' }] });
    assert.ok(c.score <= 0.6, `got ${c.score}`);
  });
  it('returns null score with no evidence', () => {
    const c = scoreClaimConfidence({ claim: { state: 'unknown', supporting: [], contradicting: [] }, sources: srcs });
    assert.equal(c.score, null);
    assert.equal(c.label, 'insufficient-evidence');
  });
});

describe('status + independence', () => {
  it('maps states to the required status vocabulary', () => {
    assert.equal(claimStatus('strongly-supported'), 'supported');
    assert.equal(claimStatus('disputed'), 'mixed');
    assert.equal(claimStatus('contradicted'), 'contradicted');
    assert.equal(claimStatus('unknown'), 'insufficient-evidence');
  });
  it('flags derived provenance groups', () => {
    const ind = independenceFor({ supporting: ['s3'] }, { groups: [{ ids: ['s3', 's1'], verdict: 'derived' }] }, srcs);
    assert.equal(ind.verdict, 'dependent');
  });
});
