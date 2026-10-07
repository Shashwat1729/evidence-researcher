import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bookRelevance, queryTerms, rankByRelevance, termHits } from '../backend/src/providers/academic.js';
import { runResearch } from '../backend/src/engine/orchestrator.js';

const Q = 'How did the Harappan (Indus Valley) cities manage water and sanitation?';

// The records that actually leaked into a real report. Every one is off-topic;
// each scored above zero because a single common word appeared in its abstract.
const LEAKED = [
  // Exactly the records that leaked into a real report. "water" appears in the
  // abstract of each, which is all the old `score > 0` filter ever required.
  { title: 'Quantum field theories and London dispersion', snippet: 'We model dispersion of solutes in water using quantum field theory.' },
  { title: 'Network analysis of undeciphered Indus civilization script', snippet: 'A graph approach to Indus signs.' },
  { title: 'Urban parks and specific green spaces contribute to wellbeing', snippet: 'We survey cities and parks and their water use.' },
];
const ON_TOPIC = [
  { title: 'Water management in the Indus Valley Civilization', snippet: 'Covered drains and soak pits at Mohenjo-daro.' },
  { title: 'Mohenjo-daro: urban planning and sanitation', snippet: 'Excavation notes on the Great Bath.' },
];

describe('academic relevance: a hit in an abstract is not a hit on the topic', () => {
  it('records whether a term hit landed in the title', () => {
    assert.equal(termHits(Q, ON_TOPIC[0]).titleHits >= 1, true, 'on-topic paper hits the title');
    assert.equal(termHits(Q, LEAKED[0]).titleHits, 0, 'the physics paper only matches in the abstract');
  });

  it('drops the records that leaked into a real report', () => {
    // The old filter was `score > 0`, and because "and" was treated as a search
    // term, EVERY record scored a title hit — so the gate was a no-op and these
    // became cited findings in a report about Harappan drainage.
    const kept = rankByRelevance(Q, [...LEAKED, ...ON_TOPIC]);
    const titles = kept.map((r) => r.title);
    assert.ok(!titles.includes(LEAKED[0].title), 'quantum field theories dropped');
    assert.ok(!titles.includes(LEAKED[2].title), 'urban parks dropped');
    assert.ok(titles.includes(ON_TOPIC[0].title), 'on-topic paper kept');
    assert.ok(titles.includes(ON_TOPIC[1].title), 'second on-topic paper kept');
  });

  it('keeps a paper that names the civilisation, even when it misses the sub-topic', () => {
    // "Network analysis of undeciphered Indus civilization script" names "Indus"
    // in its title, so it survives. That is intended: it IS about the Indus
    // civilization. It is off-topic for water management, but a title-level
    // lexical gate cannot tell "Indus script" from "Indus drainage", and
    // discarding genuine subject evidence to avoid a near-miss is the worse
    // error. The section it feeds is still ranked below the on-topic work.
    const kept = rankByRelevance(Q, [LEAKED[1], ON_TOPIC[0], ON_TOPIC[1]]);
    assert.ok(kept.some((r) => r.title === LEAKED[1].title), 'subject-relevant paper survives');
    assert.equal(kept[0].title, ON_TOPIC[0].title, 'but the on-topic work still ranks first');
  });

  it('keeps a paper that names the topic in its title even with a weak score', () => {
    const kept = rankByRelevance(Q, [{ title: 'Indus Valley sanitation', snippet: 'brief note' }]);
    assert.equal(kept.length, 1, 'title hit is sufficient');
  });

  it('contributes nothing rather than everything when nothing is on topic', () => {
    assert.deepEqual(rankByRelevance(Q, LEAKED.filter((r) => r.title.includes('Quantum'))), [],
      'an empty result is honest; returning the off-topic record is not');
  });

  it('does not discard everything when the query has no usable terms', () => {
    const recs = [{ title: 'Anything', snippet: 'x' }];
    assert.equal(rankByRelevance('tell me about', recs).length, 1,
      'no signal to judge by -> keep provider order');
  });

  it('still ranks on-topic work above the rest', () => {
    assert.ok(bookRelevance(Q, ON_TOPIC[0]) > bookRelevance(Q, LEAKED[2]));
    assert.ok(queryTerms(Q).includes('harappan'));
  });
});

describe('figures also run when the report degrades on quota', () => {
  const CLAIM = { id: 'c1', text: 'Harappan cities used covered drains.', state: 'supported', supporting: ['s1'], contradicting: [], confidenceWhy: 'w' };
  const base = {
    plan: async () => ({ domain: 'history', complexity: 'medium', steps: [], linesOfInquiry: [], queries: [], bookVariants: [], arc: [{ title: 'Origins' }] }),
    queries: async () => [{ q: 'q', category: 'general' }],
    search: async () => [{ url: 'https://a.example/x', title: 'Harappan drains', snippet: 'Covered drains at Mohenjo-daro.', via: 'test', relevance: 0.9 }],
    academic: async () => [], books: async () => [],
    fetch: async () => ({ ok: false, reason: 'x' }),
    claims: async () => [CLAIM],
    // claimsReview must hand the claim back or it is wiped and the run has
    // nothing to write a report from.
    claimsReview: async () => ({ claims: [CLAIM], review: { contradictions: [], gaps: [], sufficient: true, reason: 'r' } }),
    review: async () => ({ contradictions: [], gaps: [], sufficient: true, reason: 'r' }),
    provenance: async () => ({ groups: [], relations: [], note: 'n' }),
    verify: async () => [],
    urlContext: async () => ({ text: '' }),
    synthesize: async () => { throw Object.assign(new Error('Daily quota (requests per day) exhausted'), { status: 429, code: 'RPD_EXHAUSTED', dailyCap: true }); },
  };
  const fig = { section: 0, url: 'https://upload.wikimedia.org/x.jpg', caption: 'c', author: 'A', license: 'CC BY-SA 4.0', sourcePage: 'https://commons.wikimedia.org/wiki/File:x.jpg' };

  it('still attaches figures on the degraded path', async () => {
    // The figure step used to live inline in the normal path only, so every run
    // that fell back on quota shipped with no images at all.
    const r = await runResearch(
      { question: 'How did the Harappan cities manage water?', mode: 'quick', stance: 'neutral' },
      { key: 'k', emit: () => {}, deps: { ...base, figures: async () => [fig] } },
    );
    assert.equal(r.report.synthesisFallback, true, 'the run did degrade');
    assert.deepEqual(r.report.figures, [fig], 'and figures were still attached');
  });
});