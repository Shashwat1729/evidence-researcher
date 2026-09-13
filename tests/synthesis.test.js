import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { repairFindingCites, ensureReportCompleteness, templateReport, buildSynthesisPrompt, DEPTH } from '../backend/src/engine/synthesis.js';
import { buildClaimsPrompt } from '../backend/src/engine/claims.js';

describe('synthesis depth contract', () => {
  const base = {
    task: { question: 'Tell about Harappan civilization?', mode: 'standard', stance: 'neutral' },
    plan: { domain: 'archaeology' }, claims: [], sources: [], contradictions: [],
    provenance: { note: '' }, stats: {}, documentary: false,
  };
  it('DEPTH scales monotonically across modes', () => {
    const order = ['quick', 'standard', 'deep', 'exhaustive'];
    const vals = order.map((m) => DEPTH[m]);
    for (let i = 1; i < vals.length; i++) {
      assert.ok(vals[i].minFindings >= vals[i - 1].minFindings);
      assert.ok(vals[i].minBodyChars >= vals[i - 1].minBodyChars);
    }
  });
  it('standard prompt demands chapter depth and bans process-talk', () => {
    const p = buildSynthesisPrompt({ ...base, depth: DEPTH.standard });
    assert.ok(p.includes('AT LEAST 7 substantive findings'));
    assert.ok(p.includes('600'));
    assert.ok(p.includes('at least 3 discovered books'));
    assert.ok(p.includes('grounding API') && p.includes('NEVER write about'));
    assert.ok(p.includes('provided evidence'));
    assert.ok(p.includes('chronology') && p.includes('DISAGREE'));
  });
  it('claims prompt demands facet coverage minimums', () => {
    const p = buildClaimsPrompt('Q?', '[]', 10, false);
    assert.ok(p.includes('AT LEAST 10 distinct claims'));
    assert.ok(p.includes('chronology/dates'));
    const pr = buildClaimsPrompt('Q?', '[]', 4, true);
    assert.ok(pr.includes('AT LEAST 4 distinct claims') && pr.includes('Part 2'));
  });
});

describe('repairFindingCites', () => {
  const claims = [
    { id: 'c1', text: 'The university was founded in 1088 by scholars in Bologna.', state: 'supported', supporting: ['s1', 's2'], contradicting: [], confidenceWhy: 'charter record' },
    { id: 'c2', text: 'Economic decline caused the fall of the western empire.', state: 'disputed', supporting: ['s3'], contradicting: ['s4'], confidenceWhy: 'historians disagree' },
  ];
  it('links uncited findings via claim word overlap', () => {
    const report = { findings: [{ heading: 'Founding date', body: 'The university in Bologna was founded in 1088 by scholars.', cite: [] }] };
    repairFindingCites(report, claims);
    assert.ok(report.findings[0].cite.includes('s1'), 'should inherit c1 sources');
  });
  it('leaves already-cited findings and unmatched findings alone', () => {
    const report = {
      findings: [
        { heading: 'A', body: 'Bologna founded 1088 scholars university.', cite: ['s9'] },
        { heading: 'Zzz', body: 'Completely unrelated qwerty asdfgh zxcvbn.', cite: [] },
      ],
    };
    repairFindingCites(report, claims);
    assert.deepEqual(report.findings[0].cite, ['s9']);
    assert.deepEqual(report.findings[1].cite, []);
  });
  it('drops vacuous findings and derives from claims when none survive', () => {
    const empty = { findings: [{ heading: '', body: '  ', cite: [] }] };
    repairFindingCites(empty, claims);
    assert.equal(empty.findings.length, 2);
    assert.ok(empty.findings[0].heading.includes('Bologna'));
    assert.ok(empty.findings[0].cite.includes('s1'));
    const noClaims = { findings: [{ heading: '', body: '', cite: [] }] };
    repairFindingCites(noClaims, []);
    assert.deepEqual(noClaims.findings, []);
  });
});

describe('ensureReportCompleteness', () => {
  it('fills empty uncertainty/gaps from run state', () => {
    const r = ensureReportCompleteness(
      { uncertainty: [], gaps: [] },
      {
        claims: [{ text: 'X caused Y', state: 'disputed' }],
        iterations: [{ gaps: ['day-level record missing'] }],
      },
    );
    assert.ok(r.uncertainty.length >= 2);
    assert.ok(r.uncertainty.some((u) => u.includes('disputed')));
    assert.ok(r.gaps.includes('day-level record missing'));
  });
  it('never empties already-present sections', () => {
    const r = ensureReportCompleteness({ uncertainty: ['known unknown'], gaps: ['g1'] }, { claims: [], iterations: [] });
    assert.deepEqual(r.uncertainty, ['known unknown']);
    assert.deepEqual(r.gaps, ['g1']);
  });
});

describe('templateReport honesty', () => {
  it('flags fallback and cites only real ids', () => {
    const sources = [
      { id: 's1', title: 'Charter', url: 'https://a.example/x', tier: 1, proximity: 'primary', verified: true, meta: {}, domain: 'a.example' },
      { id: 's2', title: 'Book', url: 'https://b.example/y', tier: 2, sourceType: 'book', meta: { authors: ['A. Uthor'], year: 1999 }, domain: 'b.example' },
    ];
    const r = templateReport({
      task: { mode: 'quick', stance: 'neutral' }, plan: { domain: 'history' },
      claims: [{ text: 'X founded 1901', state: 'supported', supporting: ['s1', 'ghost'], contradicting: [], confidenceWhy: 'archive' }],
      sources, contradictions: [], provenance: { note: 'n/a' }, gaps: ['g1'],
    });
    assert.equal(r.synthesisFallback, true);
    assert.ok(r.executiveSummary.includes('unavailable'));
    assert.deepEqual(r.findings[0].cite, ['s1']);
    assert.ok(!JSON.stringify(r).includes('ghost'));
    assert.ok(r.books[0].includes('A. Uthor'));
  });
});
