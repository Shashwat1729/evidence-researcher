import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runResearch } from '../backend/src/engine/orchestrator.js';

// Free-provider fallback: when grounded search returns NOTHING (quota outage)
// and the mode skipped academic/books, the engine must still try the free
// APIs (zero Gemini quota) instead of failing with zero sources.
describe('free-provider fallback on empty grounding', () => {
  const FREE_ACADEMIC = [
    { url: 'https://arxiv.org/abs/9999.0001', title: 'Free paper', snippet: 'open access study', via: 'academic:arxiv' },
  ];
  const FREE_BOOKS = [
    { url: 'https://openlibrary.org/books/OL999M', title: 'Free monograph', snippet: 'Open Library record', via: 'books:openlibrary' },
  ];
  let booksOpts = 'not-called';
  const deps = {
    plan: async () => ({ domain: 'history', complexity: 'low', steps: ['a'], linesOfInquiry: ['g'] }),
    queries: async () => [{ q: 'q1', category: 'general' }],
    search: async () => [], // grounding totally dead (quota outage)
    academic: async () => FREE_ACADEMIC,
    books: async (_q, _limit, opts) => { booksOpts = opts; return FREE_BOOKS; },
    fetch: async () => ({ ok: false, reason: 'unavailable' }),
    claims: async ({ sources }) => sources.map((s, i) => ({
      id: `c${i}`, text: `Claim from ${s.title}.`, state: 'plausible',
      supporting: [s.id], contradicting: [], confidenceWhy: 'Single free source.',
    })),
    review: async () => ({ contradictions: [], gaps: [], sufficient: true, reason: 'provisional' }),
    provenance: async () => ({ groups: [], relations: [], note: 'Source independence could not be determined.' }),
    synthesize: async ({ sources, claims }) => ({
      executiveSummary: `Provisional report from ${sources.length} free sources.`,
      established: [], findings: claims.map((c) => ({ heading: c.text.slice(0, 40), body: c.text, cite: c.supporting })),
      competing: [], contradictions: [], sourceQuality: 'Free sources only.',
      independence: 'Unknown.', books: [], primarySources: [],
      uncertainty: ['Everything — grounding was unavailable.'], gaps: [], methodology: 'Free fallback.',
    }),
    verify: async () => [],
    urlContext: async () => ({ text: '' }),
  };

  it('rescues quick mode with free sources and no model-keyed book expansion', async () => {
    const events = [];
    const result = await runResearch(
      { question: 'When was the free city founded?', mode: 'quick', stance: 'neutral' },
      { key: 'test-key', emit: (e) => events.push(e), deps },
    );
    assert.equal(result.sources.length, 2);
    assert.ok(result.sources.some((s) => s.sourceType === 'paper'));
    assert.ok(result.sources.some((s) => s.sourceType === 'book'));
    assert.equal(booksOpts, undefined, 'fallback book search must not receive key/model (heuristic only, zero quota)');
    assert.ok(events.some((e) => /rescued from free sources/i.test(e.message || '')));
    assert.ok(result.claims.length >= 1);
    assert.ok(result.report.executiveSummary.length > 0);
  });
});
