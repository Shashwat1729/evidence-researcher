import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runResearch } from '../backend/src/engine/orchestrator.js';

// Regression: result.stats must reflect ALL model/search/token usage including
// the synthesis (+verification) calls — a cost snapshot spread too early used
// to freeze modelCalls/searchCalls/tokens at pre-synthesis values.
describe('stats accounting', () => {
  it('counts every model call and includes synthesis usage', async () => {
    const calls = { model: 0, search: 0 };
    const mk = (id) => ({ id, text: 'X happened.', state: 'supported', supporting: [], contradicting: [], confidenceWhy: 'why' });
    const result = await runResearch(
      { question: 'Is accounting right?', mode: 'quick', stance: 'neutral' },
      {
        key: 'k',
        emit: () => {},
        deps: {
          plan: async () => { calls.model++; return { domain: 'history', complexity: 'low', steps: ['a'], linesOfInquiry: ['g'] }; },
          queries: async () => [],
          search: async () => { calls.search++; return []; },
          academic: async () => [],
          books: async () => [],
          fetch: async () => ({ ok: false, reason: 'x' }),
          claims: async () => { calls.model++; return [mk('c1')]; },
          claimsReview: async () => { calls.model++; return { claims: [mk('c1')], review: { contradictions: [], gaps: [], sufficient: true, reason: 'r' } }; },
          review: async () => { calls.model++; return { contradictions: [], gaps: [], sufficient: true, reason: 'r' }; },
          provenance: async () => ({ groups: [], relations: [], note: 'n' }),
          synthesize: async () => { calls.model++; return {
            executiveSummary: 'e', established: [], findings: [], competing: [], contradictions: [],
            sourceQuality: '', independence: '', books: [], primarySources: [], uncertainty: ['u'], gaps: [], methodology: 'm',
            usage: { in: 7, out: 9 },
          }; },
          verify: async () => [],
          urlContext: async () => ({ text: '' }),
        },
      },
    );
    // quick: plan + merged claimsReview + synth = 3 model calls
    // (queries are templates; review/provenance-model/verify skipped).
    // The merge itself is the call-saving feature under test.
    assert.equal(calls.model, 3);
    assert.equal(result.stats.modelCalls, calls.model);
    assert.equal(result.stats.searchCalls, calls.search);
    assert.ok(result.stats.tokensIn >= 7 && result.stats.tokensOut >= 9);
  });
});
