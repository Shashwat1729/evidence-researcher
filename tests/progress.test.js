import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runResearch } from '../backend/src/engine/orchestrator.js';

// Regression: the research-progress UI showed a fake bar and dead counters
// because events carried no phase or running stats. Every event must now
// carry both so the frontend never has to guess.
const PHASE_ORDER = ['plan', 'search', 'read', 'analyze', 'provenance', 'synthesize', 'verify', 'done'];

function mockDeps() {
  const mk = (id) => ({ id, text: 'X happened.', state: 'supported', supporting: [], contradicting: [], confidenceWhy: 'w' });
  return {
    plan: async () => ({ domain: 'history', complexity: 'low', steps: ['a'], linesOfInquiry: ['g'] }),
    queries: async () => [{ q: 'founding overview', category: 'general' }],
    search: async () => [{ url: 'https://example.com/a?utm_source=x', title: 'A', snippet: 'about X' }],
    academic: async () => [],
    books: async () => [],
    fetch: async () => ({ ok: false, reason: 'x' }),
    claims: async () => [mk('c1')],
    claimsReview: async () => ({ claims: [mk('c1')], review: { contradictions: [], gaps: [], sufficient: true, reason: 'r' } }),
    review: async () => ({ contradictions: [], gaps: [], sufficient: true, reason: 'r' }),
    provenance: async () => ({ groups: [], relations: [], note: 'n' }),
    synthesize: async () => ({
      executiveSummary: 'e', established: [], findings: [{ heading: 'H', body: 'B', cite: [] }],
      competing: [], contradictions: [], sourceQuality: '', independence: '', books: [], primarySources: [],
      uncertainty: ['u'], gaps: [], methodology: 'm',
    }),
    verify: async () => [],
    urlContext: async () => ({ text: '' }),
  };
}

describe('progress events carry phase + running stats', () => {
  it('every event has a known phase and numeric stats snapshot', async () => {
    const events = [];
    const result = await runResearch(
      { question: 'Is progress honest?', mode: 'quick', stance: 'neutral' },
      { key: 'k', emit: (e) => events.push(e), deps: mockDeps() },
    );
    assert.ok(result.id);
    assert.ok(events.length > 5, `expected a full event stream, got ${events.length}`);
    for (const e of events) {
      assert.ok(PHASE_ORDER.includes(e.phase), `unknown phase on ${e.type}: ${e.phase}`);
      assert.ok(e.stats && Number.isFinite(e.stats.modelCalls) && Number.isFinite(e.stats.searchCalls),
        `missing numeric stats on ${e.type}`);
      assert.ok(typeof e.at === 'string', `missing timestamp on ${e.type}`);
    }
  });

  it('phases advance monotonically through the pipeline', async () => {
    const events = [];
    await runResearch(
      { question: 'Is progress monotonic?', mode: 'quick', stance: 'neutral' },
      { key: 'k', emit: (e) => events.push(e), deps: mockDeps() },
    );
    const seen = events.map((e) => PHASE_ORDER.indexOf(e.phase));
    for (let i = 1; i < seen.length; i++) {
      assert.ok(seen[i] >= seen[i - 1], `phase went backwards: ${events[i - 1].phase} → ${events[i].phase}`);
    }
    assert.ok(seen.includes(PHASE_ORDER.indexOf('search')), 'search phase reached');
    assert.ok(seen.includes(PHASE_ORDER.indexOf('synthesize')), 'synthesize phase reached');
    assert.equal(seen[seen.length - 1], PHASE_ORDER.indexOf('done'), 'stream ends at done');
  });

  it('stats snapshots accumulate across the run', async () => {
    const events = [];
    await runResearch(
      { question: 'Do counters grow?', mode: 'quick', stance: 'neutral' },
      { key: 'k', emit: (e) => events.push(e), deps: mockDeps() },
    );
    const maxSearches = Math.max(...events.map((e) => e.stats.searchCalls));
    const maxCalls = Math.max(...events.map((e) => e.stats.modelCalls));
    assert.ok(maxSearches >= 1, 'search counter advanced');
    assert.ok(maxCalls >= 2, 'model-call counter advanced');
    const done = events.find((e) => e.type === 'done');
    assert.equal(done.stats.modelCalls, maxCalls, 'done carries final counts');
  });
});
