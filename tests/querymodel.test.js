import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { topicOf, normalizeQueries } from '../backend/src/engine/queries.js';
import { templatePlan, suggestArc, normalizeArc } from '../backend/src/engine/planner.js';
import { getKeys } from '../backend/src/gemini.js';
import { AVAILABLE_MODELS, isKnownModel } from '../backend/src/config.js';
import { validateResearchBody } from '../backend/src/middleware/validate.js';
import { runResearch } from '../backend/src/engine/orchestrator.js';

describe('topic extraction for keyword APIs', () => {
  it('strips interrogatives and filler, keeps key terms in order', () => {
    assert.equal(topicOf('tell about Harappan civilization'), 'harappan civilization');
    assert.equal(topicOf('What were the major causes of the collapse of the Western Roman Empire?'), 'major collapse western roman empire');
    assert.equal(topicOf('When was X founded?'), 'founded');
  });
  it('falls back to trimmed question when nothing significant remains', () => {
    assert.ok(topicOf('What is it?').length > 0);
    assert.equal(topicOf(''), '');
  });
});

describe('planner outputs: queries, book variants, narrative arc', () => {
  it('picks domain-shaped arcs: biography, civilization, event, science', () => {
    const bio = suggestArc('Who was Ada Lovelace?', 'biography');
    assert.ok(bio[0].title.toLowerCase().includes('birth') || bio[0].title.toLowerCase().includes('origins'));
    assert.ok(bio.some((b) => /legacy/i.test(b.title)));
    const civ = suggestArc('Tell about Harappan civilization?', 'archaeology');
    assert.ok(civ.some((b) => /decline/i.test(b.title)));
    assert.ok(civ.some((b) => /site/i.test(b.title)));
    const ev = suggestArc('Why did the Roman Empire collapse?', 'history');
    assert.ok(ev.some((b) => /cause/i.test(b.title)));
    const sci = suggestArc('How does CRISPR work?', 'science');
    assert.ok(sci.some((b) => /mechanism|how it works/i.test(b.title)));
    for (const arc of [bio, civ, ev, sci]) {
      assert.ok(arc.length >= 5 && arc.length <= 8);
      assert.ok(arc.every((b) => b.title && b.focus));
    }
  });
  it('normalizeArc keeps good model arcs, falls back on thin ones', () => {
    const good = normalizeArc(
      Array.from({ length: 5 }, (_, i) => ({ title: `Beat ${i}`, focus: `Focus ${i} detail here` })),
      'Q?', 'history',
    );
    assert.equal(good.length, 5);
    assert.deepEqual(normalizeArc([{ title: 'Only', focus: 'one' }], 'Q?', 'history').length >= 4, true);
    assert.deepEqual(normalizeArc('garbage', 'Q?', 'history').length >= 4, true);
  });
  it('synthesis prompt lists beats in order with narrative rules', async () => {
    const { buildSynthesisPrompt, DEPTH } = await import('../backend/src/engine/synthesis.js');
    const arc = suggestArc('Who was Ada Lovelace?', 'biography');
    const p = buildSynthesisPrompt({
      task: { question: 'Who was Ada Lovelace?', mode: 'standard', stance: 'neutral' },
      plan: { domain: 'biography', arc }, claims: [], sources: [], contradictions: [],
      provenance: {}, stats: {}, documentary: false, depth: DEPTH.standard,
    });
    let lastIdx = -1;
    for (const b of arc) {
      const idx = p.indexOf(b.title);
      assert.ok(idx > lastIdx, `beat "${b.title}" out of order`);
      lastIdx = idx;
    }
    assert.ok(p.includes('IN ORDER') && p.includes('chronological transitions'));
  });
  it('normalizeQueries validates categories and drops empties', () => {
    const out = normalizeQueries([
      { q: '  Rome fall causes  ', category: 'general' },
      { q: 'Rome historians', category: 'bogus-category' },
      { q: '   ', category: 'books' },
      null,
      'bare string query',
    ]);
    assert.deepEqual(out, [
      { q: 'Rome fall causes', category: 'general' },
      { q: 'Rome historians', category: 'general' },
      { q: 'bare string query', category: 'general' },
    ]);
    assert.deepEqual(normalizeQueries(null), []);
    assert.deepEqual(normalizeQueries('nope'), []);
  });
  it('templatePlan carries template queries + heuristic book variants (zero calls)', () => {
    const p = templatePlan('Tell about Harappan civilization?');
    assert.ok(Array.isArray(p.queries) && p.queries.length > 0);
    assert.ok(p.queries.every((q) => q.q && q.category));
    assert.ok(Array.isArray(p.bookVariants) && p.bookVariants.length > 0);
  });
});

describe('multi-key support', () => {  it('accepts arrays, dedupes, caps fan-out', () => {
    const keys = getKeys(['k1', 'k1', 'k2', '', 'k3', 'k4', 'k5', 'k6', 'k7']);
    assert.ok(keys.includes('k1') && keys.includes('k2'));
    assert.ok(keys.length <= 6);
    assert.equal(new Set(keys).size, keys.length);
  });
  it('strings still work as before', () => {
    assert.deepEqual(getKeys('solo'), ['solo']);
  });
});

describe('model picker', () => {
  it('offers a curated list with blurbs', () => {
    assert.ok(AVAILABLE_MODELS.length >= 2);
    assert.ok(AVAILABLE_MODELS.every((m) => m.id && m.label && m.blurb));
    assert.ok(isKnownModel('gemini-2.5-flash') && !isKnownModel('turbo-9000'));
  });
  it('validation accepts empty (default) and known, rejects unknown', () => {
    assert.equal(validateResearchBody({ question: 'Is this ok?', model: '' }).length, 0);
    assert.equal(validateResearchBody({ question: 'Is this ok?', model: 'gemini-2.0-flash' }).length, 0);
    assert.ok(validateResearchBody({ question: 'Is this ok?', model: 'turbo-9000' }).some((m) => /model/i.test(m)));
  });
});

describe('orchestrator model override + book wiring', () => {
  it('applies one override to all roles and passes topic + limits to discovery', async () => {
    const seen = { models: [], academic: [], books: [], bookOpts: [] };
    const mk = (id) => ({ id, text: 'X.', state: 'supported', supporting: [], contradicting: [], confidenceWhy: 'w' });
    const planQueries = ['general', 'scholarly', 'primary-evidence', 'books', 'alternative-explanations', 'counter-evidence', 'disagreement', 'institutional']
      .map((c, i) => ({ q: `Harappan civilization angle ${i}`, category: c }));
    const result = await runResearch(
      { question: 'Tell about Harappan civilization?', mode: 'standard', stance: 'neutral', model: 'gemini-2.0-flash' },
      {
        key: 'k', emit: () => {},
        deps: {
          plan: async (a) => { seen.models.push(['plan', a.model]); return { domain: 'history', complexity: 'low', steps: ['a'], linesOfInquiry: ['g'], queries: planQueries, bookVariants: ['harappan books', 'indus valley'] }; },
          queries: async (a) => { seen.models.push(['queries', a.model]); return [{ q: 'Harappan civilization book historian', category: 'books' }]; },
          search: async () => [],
          academic: async (q) => { seen.academic.push(q); return []; },
          books: async (q, lim, opts) => { seen.books.push([q, lim]); seen.bookOpts.push(opts); return []; },
          expandBooks: async ({ topic }) => { seen.expand = topic; return { variants: [`${topic} books`], llm: false }; },
          fetch: async () => ({ ok: false, reason: 'x' }),
          claims: async (a) => { seen.models.push(['claims', a.model]); return [mk('c1')]; },
          review: async (a) => { seen.models.push(['review', a.model]); return { contradictions: [], gaps: [], sufficient: true, reason: 'r' }; },
          provenance: async () => ({ groups: [], relations: [], note: 'n' }),
          synthesize: async (a) => {
            seen.models.push(['synth', a.model]);
            return {
              executiveSummary: 'e', established: [], findings: [], competing: [], contradictions: [],
              sourceQuality: '', independence: '', books: [], primarySources: [], uncertainty: ['u'], gaps: [], methodology: 'm',
            };
          },
          verify: async () => [],
          urlContext: async () => ({ text: '' }),
        },
      },
    );
    assert.ok(result.id);
    assert.ok(seen.models.length >= 4);
    assert.ok(seen.models.every(([, m]) => m === 'gemini-2.0-flash'), JSON.stringify(seen.models));
    assert.ok(seen.academic.some((q) => q.includes('harappan')), JSON.stringify(seen.academic));
    assert.ok(seen.books.some(([q]) => q.includes('harappan')), JSON.stringify(seen.books));
    assert.ok(seen.books.every(([, lim]) => lim === 6), 'standard bookLimit wires through');
    // Planner supplied 8 queries → separate query-generation call skipped.
    assert.ok(!seen.models.some(([role]) => role === 'queries'), 'planner queries reused, no extra call');
    // Planner supplied book variants → standalone expansion skipped, variants
    // forwarded to every book query (no per-query LLM expansion either).
    assert.equal(seen.expand, undefined, 'no standalone expansion call when plan provides variants');
    assert.ok(seen.bookOpts.every((o) => o && o.variants && o.variants.includes('indus valley')), JSON.stringify(seen.bookOpts));
  });

  it('falls back to query-generation + heuristic books when the plan omits them', async () => {
    const seen = { queriesCalls: 0, expandCalls: 0, bookOpts: [] };
    const mk = (id) => ({ id, text: 'X.', state: 'supported', supporting: [], contradicting: [], confidenceWhy: 'w' });
    const result = await runResearch(
      { question: 'Tell about Harappan civilization?', mode: 'standard', stance: 'neutral', model: 'gemini-2.0-flash' },
      {
        key: 'k', emit: () => {},
        deps: {
          plan: async () => ({ domain: 'history', complexity: 'low', steps: ['a'], linesOfInquiry: ['g'] }),
          queries: async () => { seen.queriesCalls++; return [{ q: 'Harappan civilization overview', category: 'general' }]; },
          search: async () => [],
          academic: async () => [],
          books: async (q, lim, opts) => { seen.bookOpts.push(opts); return []; },
          expandBooks: async () => { seen.expandCalls++; return { variants: [], llm: false }; },
          fetch: async () => ({ ok: false, reason: 'x' }),
          claims: async () => [mk('c1')],
          review: async () => ({ contradictions: [], gaps: [], sufficient: true, reason: 'r' }),
          provenance: async () => ({ groups: [], relations: [], note: 'n' }),
          synthesize: async () => ({
            executiveSummary: 'e', established: [], findings: [], competing: [], contradictions: [],
            sourceQuality: '', independence: '', books: [], primarySources: [], uncertainty: ['u'], gaps: [], methodology: 'm',
          }),
          verify: async () => [],
          urlContext: async () => ({ text: '' }),
        },
      },
    );
    assert.ok(result.id);
    assert.equal(seen.queriesCalls, 1, 'separate query call used as fallback');
    assert.equal(seen.expandCalls, 0, 'standard mode never burns a call on standalone expansion');
    assert.ok(seen.bookOpts.every((o) => !o || !o.variants), 'heuristic path: no variants forwarded');
  });

  it('rejects planner queries that lack category diversity (accuracy over call savings)', async () => {
    let queriesCalls = 0;
    const mk = (id) => ({ id, text: 'X.', state: 'supported', supporting: [], contradicting: [], confidenceWhy: 'w' });
    // 8 queries but ALL general — accepting them would silently kill
    // counter-evidence search, so the dedicated call must still happen.
    const monoQueries = Array.from({ length: 8 }, (_, i) => ({ q: `Harappan angle ${i}`, category: 'general' }));
    const result = await runResearch(
      { question: 'Tell about Harappan civilization?', mode: 'standard', stance: 'neutral' },
      {
        key: 'k', emit: () => {},
        deps: {
          plan: async () => ({ domain: 'history', complexity: 'medium', steps: ['a'], linesOfInquiry: ['g'], queries: monoQueries, bookVariants: [] }),
          queries: async () => { queriesCalls++; return [{ q: 'Harappan overview', category: 'general' }]; },
          search: async () => [],
          academic: async () => [],
          books: async () => [],
          fetch: async () => ({ ok: false, reason: 'x' }),
          claims: async () => [mk('c1')],
          review: async () => ({ contradictions: [], gaps: [], sufficient: true, reason: 'r' }),
          provenance: async () => ({ groups: [], relations: [], note: 'n' }),
          synthesize: async () => ({
            executiveSummary: 'e', established: [], findings: [], competing: [], contradictions: [],
            sourceQuality: '', independence: '', books: [], primarySources: [], uncertainty: ['u'], gaps: [], methodology: 'm',
          }),
          verify: async () => [],
          urlContext: async () => ({ text: '' }),
        },
      },
    );
    assert.ok(result.id);
    assert.equal(queriesCalls, 1, 'monochrome planner queries must trigger dedicated generation');
  });
});
