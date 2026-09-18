import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runResearch } from '../backend/src/engine/orchestrator.js';

// Per-call wait budgets + single waiting notice per episode: searches must
// fail fast (academic/books still produce results) instead of silently
// burning minutes, and the UI must never see wait-spam.
describe('search wait budget and waiting notices', () => {
  const baseDeps = {
    plan: async () => ({ domain: 'history', complexity: 'low', steps: ['a'], linesOfInquiry: ['g'] }),
    queries: async () => [{ q: 'founding overview', category: 'general' }],
    academic: async () => [],
    books: async () => [],
    fetch: async () => ({ ok: false, reason: 'x' }),
    claims: async () => [{ id: 'c1', text: 'X happened.', state: 'supported', supporting: [], contradicting: [], confidenceWhy: 'w' }],
    claimsReview: async () => ({ claims: [{ id: 'c1', text: 'X happened.', state: 'supported', supporting: [], contradicting: [], confidenceWhy: 'w' }], review: { contradictions: [], gaps: [], sufficient: true, reason: 'r' } }),
    review: async () => ({ contradictions: [], gaps: [], sufficient: true, reason: 'r' }),
    provenance: async () => ({ groups: [], relations: [], note: 'n' }),
    synthesize: async () => ({
      executiveSummary: 'e', established: [], findings: [], competing: [], contradictions: [],
      sourceQuality: '', independence: '', books: [], primarySources: [], uncertainty: ['u'], gaps: [], methodology: 'm',
    }),
    verify: async () => [],
    urlContext: async () => ({ text: '' }),
  };

  it('passes a small wait budget to searches in quick mode', async () => {
    let seenBudget;
    await runResearch(
      { question: 'Is the budget tiered?', mode: 'quick', stance: 'neutral' },
      {
        key: 'k', emit: () => {},
        deps: {
          ...baseDeps,
          search: async (_q, _cat, ctx) => { seenBudget = ctx?.rateWaitBudgetMs; return []; },
        },
      },
    );
    assert.equal(seenBudget, 45_000, 'quick searches fail fast instead of stalling the run');
  });

  it('emits exactly one waiting notice per episode, then resumes silently', async () => {
    const messages = [];
    await runResearch(
      { question: 'Is waiting quiet?', mode: 'quick', stance: 'neutral' },
      {
        key: 'k',
        emit: (e) => { if (e.type === 'progress') messages.push(e.message); },
        deps: {
          ...baseDeps,
          search: async (_q, _cat, ctx) => {
            // Small waits (3s/search, 6s aggregate) stay under the 40%
            // search-phase cap so BOTH searches execute: the test measures
            // notice-per-episode, not cap aborts (covered elsewhere).
            ctx.onKeyEvent({ type: 'rate-wait', waitMs: 1000 });
            ctx.onKeyEvent({ type: 'rate-wait', waitMs: 1000 });
            ctx.onKeyEvent({ type: 'resumed' });
            ctx.onKeyEvent({ type: 'rate-wait', waitMs: 1000 });
            return [];
          },
        },
      },
    );
    const notices = messages.filter((m) => m.includes('Waiting for API quota'));
    // 2 searches × 2 episodes each (resumed separates them): one notice per
    // episode, never one per wait. 8 waits → 4 notices, never 0, never 8.
    assert.equal(notices.length, 4, 'one notice per episode per operation');
  });
});
