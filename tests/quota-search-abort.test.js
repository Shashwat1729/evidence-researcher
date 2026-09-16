import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runResearch } from '../backend/src/engine/orchestrator.js';

// Regression tests for the live Pages failure: thin/dead quota killed runs
// with "rate limit reached" and nothing shown, even when free academic/book
// sources had evidence. Grounding searches must degrade to free evidence
// (inventory) instead of discarding it, and a truly empty haul must report
// QUOTA_EXHAUSTED (right advice: wait/retry) rather than NO_EVIDENCE
// (wrong advice: rephrase a fine question).
const quotaErr = () => Object.assign(new Error('quota dead'), { status: 429, code: 'QUOTA_EXHAUSTED' });

const CATS = ['general', 'scholarly', 'primary-evidence', 'books', 'alternative-explanations', 'counter-evidence', 'disagreement', 'institutional'];
const diversePlan = () => ({
  domain: 'history', complexity: 'medium', steps: ['a'], linesOfInquiry: ['g'],
  queries: CATS.map((c, i) => ({ q: `Harappan civilization angle ${i}`, category: c })),
  bookVariants: ['harappan books'], arc: [],
});

// Every grounding attempt burns the (tiny, test-set) wait budget via
// rate-wait key events, then fails with quota — mimics a dead free-tier key.
const deadSearch = async (q, cat, o) => {
  o?.onKeyEvent?.({ type: 'rate-wait', waitMs: 60_000 });
  throw quotaErr();
};

const baseDeps = (over = {}) => ({
  plan: async () => diversePlan(),
  queries: async () => { throw new Error('must not be called when plan queries are diverse'); },
  search: deadSearch,
  academic: async () => [],
  books: async () => [],
  expandBooks: async () => ({ variants: [], llm: false }),
  fetch: async () => ({ ok: false, reason: 'x' }),
  claims: async () => { throw quotaErr(); },
  review: async () => ({ contradictions: [], gaps: [], sufficient: true, reason: 'r' }),
  provenance: async () => ({ groups: [], relations: [], note: 'n' }),
  synthesize: async () => { throw quotaErr(); },
  verify: async () => [],
  urlContext: async () => ({ text: '' }),
  ...over,
});

describe('quota-dead search phase (Pages static-mode scenario)', () => {
  let savedBudget;
  beforeEach(() => {
    savedBudget = process.env.QUOTA_WAIT_BUDGET_MS;
    process.env.QUOTA_WAIT_BUDGET_MS = '30000'; // floor: aborts fast, deterministically
  });
  afterEach(() => {
    if (savedBudget === undefined) delete process.env.QUOTA_WAIT_BUDGET_MS;
    else process.env.QUOTA_WAIT_BUDGET_MS = savedBudget;
  });

  it('settles free sources after a grounding pool abort and delivers an inventory, not an error', async () => {
    const academicRecs = [
      { url: 'https://example.org/paper1', title: 'Harappan paper one', snippet: 'evidence text one', via: 'academic' },
      { url: 'https://example.org/paper2', title: 'Harappan paper two', snippet: 'evidence text two', via: 'academic' },
    ];
    const result = await runResearch(
      { question: 'Tell about Harappan civilization?', mode: 'standard', stance: 'neutral' },
      { key: 'k1', emit: () => {}, deps: baseDeps({ academic: async () => academicRecs }) },
    );
    assert.ok(result.id, 'run completes instead of throwing quota');
    assert.equal(result.sources.length, 2, 'free academic evidence survives the grounding abort');
    assert.equal(result.report?.synthesisFallback, true, 'flagged honestly as inventory');
  });

  it('reports QUOTA_EXHAUSTED (not NO_EVIDENCE) when quota is dead and nothing was gathered', async () => {
    const err = await runResearch(
      { question: 'Tell about Harappan civilization?', mode: 'quick', stance: 'neutral' },
      { key: 'k1', emit: () => {}, deps: baseDeps() },
    ).then(() => null, (e) => e);
    assert.ok(err, 'run fails (nothing honest to show)');
    assert.equal(err.code, 'QUOTA_EXHAUSTED', `right advice (wait/retry), got: ${err?.code} ${err?.message}`);
  });
});
