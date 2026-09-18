import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  runResearch, searchQuotaCapMs, sectionRetryWaitMs, SEARCH_BUDGET_SHARE,
} from '../backend/src/engine/orchestrator.js';

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
  let savedGate;
  beforeEach(() => {
    savedBudget = process.env.QUOTA_WAIT_BUDGET_MS;
    process.env.QUOTA_WAIT_BUDGET_MS = '30000'; // floor: aborts fast, deterministically
    // Gate pause defaults to 45s real time — shrink for every test here
    // (individual tests may override further).
    savedGate = process.env.SYNTH_GATE_MS;
    process.env.SYNTH_GATE_MS = '50';
  });
  afterEach(() => {
    if (savedBudget === undefined) delete process.env.QUOTA_WAIT_BUDGET_MS;
    else process.env.QUOTA_WAIT_BUDGET_MS = savedBudget;
    if (savedGate === undefined) delete process.env.SYNTH_GATE_MS;
    else process.env.SYNTH_GATE_MS = savedGate;
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

  it('search phase is capped so synthesis keeps a wait reserve', async () => {
    // Global 30s → searches may wait at most 12s. Each mocked search burns
    // 5s of waits then succeeds: wave 1 (3 calls, 15s accumulated) trips the
    // cap, wave 2 aborts fast — while claims/synthesis still have patience.
    let searchCalls = 0;
    // Genuinely different URLs, titles, AND vocab — near-duplicate
    // detection would otherwise merge them and the test would measure
    // dedup, not the wait-budget cap.
    const texts = [
      'Granaries at Harappa stored barley and wheat on raised brick platforms dated to 2600 BCE.',
      'Unicorn seals identified merchants across Mohenjo-daro trading houses and distant ports.',
      'Lothal dockyard linked the city to ocean routes through an engineered tidal basin.',
    ];
    const rec = (i) => ({
      url: `https://example.org/r${i}`,
      title: ['Granary platforms', 'Unicorn seals', 'Lothal dockyard'][i],
      snippet: texts[i],
      via: 'grounding',
    });
    const deps = baseDeps({
      search: async (q, cat, o) => {
        const n = searchCalls++;
        o?.onKeyEvent?.({ type: 'rate-wait', waitMs: 5000 });
        return [rec(n)];
      },
      academic: async () => [],
      claims: async () => [{ id: 'c1', text: 'X.', state: 'supported', supporting: [], contradicting: [], confidenceWhy: 'w' }],
      synthesize: async () => ({
        executiveSummary: 'e', findings: [{ heading: 'H', body: 'B', cite: [] }],
        uncertainty: ['u'], methodology: 'm',
      }),
      verify: async () => [],
    });
    const result = await runResearch(
      { question: 'Tell about Harappan civilization?', mode: 'standard', stance: 'neutral' },
      { key: 'k1', emit: () => {}, deps },
    );
    assert.equal(searchCalls, 3, 'search phase stopped at the cap instead of burning the reserve');
    assert.ok(result.sources.length >= 3, 'wave-1 evidence survived');
    assert.equal(result.report?.synthesisFallback, undefined, 'model synthesis completed — no fallback');
  });

  it('synthesis retries quota failures with server-timed waits and succeeds', async () => {
    // The production success path: sections 429 twice (exact 100ms waits),
    // then succeed — the report must be model-written, not an inventory.
    let synthCalls = 0;
    const plan2beats = () => ({
      domain: 'history', complexity: 'medium', steps: ['a'], linesOfInquiry: ['g'],
      queries: CATS.map((c, i) => ({ q: `Harappan civilization angle ${i}`, category: c })),
      bookVariants: ['harappan books'],
      arc: [{ title: 'Origins', focus: 'where' }, { title: 'Decline', focus: 'why' }],
    });
    const rec = { url: 'https://example.org/r', title: 'Rec', snippet: 'evidence', via: 'grounding' };
    const deps = baseDeps({
      plan: async () => plan2beats(),
      search: async () => [rec],
      academic: async () => [],
      claims: async () => [{ id: 'c1', text: 'X.', state: 'supported', supporting: ['s1'], contradicting: [], confidenceWhy: 'w' }],
      synthesize: async (a) => {
        if (a.assembleOnly) {
          return { executiveSummary: 'full story', uncertainty: ['u'], methodology: 'm' };
        }
        synthCalls++;
        if (synthCalls <= 2) {
          throw Object.assign(new Error('hot bucket'), { status: 429, code: 'QUOTA_EXHAUSTED', retryAfter: 100 });
        }
        return { findings: [{ heading: `H${synthCalls}`, body: 'substantive prose '.repeat(40), cite: ['s1'] }] };
      },
      verify: async () => [],
    });
    const result = await runResearch(
      { question: 'Tell about Harappan civilization?', mode: 'standard', stance: 'neutral' },
      { key: 'k1', emit: () => {}, deps },
    );
    assert.ok(synthCalls >= 3, `retried through quota pressure, calls: ${synthCalls}`);
    assert.equal(result.report?.synthesisFallback, undefined, 'model-written report — never an inventory');
    assert.ok((result.report?.findings || []).length >= 2, 'both beats written');
  });

  it('hot quota triggers one refill pause and collapses to fewer, bigger sections', async () => {
    const savedGate = process.env.SYNTH_GATE_MS;
    process.env.SYNTH_GATE_MS = '50';
    try {
      const events = [];
      const emit = (ev) => events.push(`${ev.type}:${String(ev.message || '').slice(0, 80)}`);
      const texts = [
        'Granaries at Harappa stored barley on raised brick platforms dated to 2600 BCE.',
        'Unicorn seals identified merchants across Mohenjo-daro trading houses.',
        'Lothal dockyard linked the city to ocean routes via a tidal basin.',
      ];
      const titles = ['Granary platforms', 'Unicorn seals', 'Lothal dockyard'];
      let n = 0;
      const fat = (h) => ({ heading: h, body: 'substantive prose '.repeat(40), cite: [] });
      const deps = baseDeps({
        plan: async () => ({
          domain: 'history', complexity: 'medium', steps: ['a'], linesOfInquiry: ['g'],
          queries: CATS.map((c, i) => ({ q: `angle ${i}`, category: c })),
          bookVariants: ['hb'],
          arc: ['A', 'B', 'C', 'D', 'E', 'F'].map((t) => ({ title: t, focus: t })),
        }),
        search: async (q, cat, o) => {
          const i = n++;
          o?.onKeyEvent?.({ type: 'rate-wait', waitMs: 60000 });
          return [{ url: `https://example.org/g${i}`, title: titles[i % 3], snippet: texts[i % 3], via: 'grounding' }];
        },
        academic: async () => [],
        claims: async () => [{ id: 'c1', text: 'X.', state: 'supported', supporting: [], contradicting: [], confidenceWhy: 'w' }],
        synthesize: async (a) => a.assembleOnly
          ? { executiveSummary: 'full story', uncertainty: ['u'], methodology: 'm' }
          : { findings: [fat('H1'), fat('H2'), fat('H3')] },
        verify: async () => [],
      });
      const result = await runResearch(
        { question: 'Tell about Harappan civilization?', mode: 'standard', stance: 'neutral' },
        { key: 'k1', emit, deps },
      );
      const log = events.join('\n');
      assert.ok(log.includes('pausing once to let it refill'), 'gate fired on hot quota');
      assert.ok(log.includes('Writing report in 3 sections'), 'collapsed 6 beats into 3 bigger calls');
      assert.equal(result.report?.synthesisFallback, undefined, 'model-written, not inventory');
      assert.ok((result.report?.findings || []).length >= 6, 'fewer sections still carry the findings');
    } finally {
      if (savedGate === undefined) delete process.env.SYNTH_GATE_MS;
      else process.env.SYNTH_GATE_MS = savedGate;
    }
  });

  it('healthy quota skips the gate and keeps full sections', async () => {
    const events = [];
    const emit = (ev) => events.push(`${ev.type}:${String(ev.message || '').slice(0, 80)}`);
    const fat = (h) => ({ heading: h, body: 'substantive prose '.repeat(40), cite: [] });
    const deps = baseDeps({
      plan: async () => ({
        domain: 'history', complexity: 'medium', steps: ['a'], linesOfInquiry: ['g'],
        queries: CATS.map((c, i) => ({ q: `angle ${i}`, category: c })),
        bookVariants: ['hb'],
        arc: ['A', 'B', 'C', 'D', 'E', 'F'].map((t) => ({ title: t, focus: t })),
      }),
      search: async (q, cat) => [{ url: `https://example.org/${encodeURIComponent(q.q || q)}`, title: `T ${q.q || q}`, snippet: `Distinct evidence text about ${q.q || q} with unique vocabulary.`, via: 'grounding' }],
      academic: async () => [],
      claims: async () => [{ id: 'c1', text: 'X.', state: 'supported', supporting: [], contradicting: [], confidenceWhy: 'w' }],
      synthesize: async (a) => a.assembleOnly
        ? { executiveSummary: 'full story', uncertainty: ['u'], methodology: 'm' }
        : { findings: [fat('H1'), fat('H2')] },
      verify: async () => [],
    });
    const result = await runResearch(
      { question: 'Tell about Harappan civilization?', mode: 'standard', stance: 'neutral' },
      { key: 'k1', emit, deps },
    );
    const log = events.join('\n');
    assert.ok(!log.includes('pausing once'), 'no gate pause on healthy quota (zero cost)');
    assert.ok(log.includes('Writing report in 6 sections'), 'full sectional depth preserved');
    assert.equal(result.report?.synthesisFallback, undefined);
  });

  it('wait helpers are pure and server-timed', () => {
    assert.equal(SEARCH_BUDGET_SHARE, 0.4);
    assert.equal(searchQuotaCapMs(300000), 120000, 'searches cap at 40% of the global budget');
    assert.equal(searchQuotaCapMs(30000), 12000);
    assert.equal(searchQuotaCapMs(0), 0);
    assert.equal(sectionRetryWaitMs({ retryAfter: 53000 }, 1), 53000, 'exact server wait honored');
    assert.equal(sectionRetryWaitMs({ retryAfter: 999999 }, 1), 60000, 'exact wait capped at 60s');
    assert.equal(sectionRetryWaitMs({}, 1), 15000, 'escalating fallback starts at 15s');
    assert.equal(sectionRetryWaitMs({}, 4), 60000, 'escalating fallback caps at 60s');
  });
});
