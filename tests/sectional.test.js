import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runResearch } from '../backend/src/engine/orchestrator.js';

const arc6 = ['Origins', 'Phases', 'Sites', 'Society', 'Decline', 'Legacy']
  .map((t) => ({ title: t, focus: `${t} focus` }));

function baseDeps(overrides = {}) {
  return {
    plan: async () => ({
      domain: 'history', complexity: 'medium', steps: ['a'], linesOfInquiry: ['g'],
      queries: [], bookVariants: [], arc: arc6,
    }),
    queries: async () => [{ q: 'founding overview', category: 'general' }],
    search: async () => [],
    academic: async () => [],
    books: async () => [],
    fetch: async () => ({ ok: false, reason: 'x' }),
    claims: async () => [
      { id: 'c1', text: 'X was founded in 1901.', state: 'supported', supporting: [], contradicting: [], confidenceWhy: 'w' },
    ],
    review: async () => ({ contradictions: [], gaps: [], sufficient: true, reason: 'r' }),
    provenance: async () => ({ groups: [], relations: [], note: 'n' }),
    claimsReview: async () => ({ claims: [], review: { contradictions: [], gaps: [], sufficient: true, reason: 'r' } }),
    verify: async () => [],
    urlContext: async () => ({ text: '' }),
    ...overrides,
  };
}

const task = { question: 'When was X founded, and what caused it?', mode: 'standard', stance: 'neutral' };

// Fat bodies clear the prose-quality gate (~1500 chars each) so only the
// dedicated thin-prose tests exercise the expansion retry.
const fat = (s) => `${s} ` + 'Substantive detail with dates, names, numbers, and evidence discussed at length. '.repeat(22);

describe('sectional synthesis (standard mode)', () => {
  it('writes one full-budget section per beat (standard: one group per beat)', async () => {
    const calls = [];
    const result = await runResearch({ ...task }, {
      key: 'k', emit: () => {},
      deps: baseDeps({
        synthesize: async (a) => {
          calls.push({ findingsOnly: !!a.findingsOnly, assembleOnly: !!a.assembleOnly, beats: (a.beats || []).map((b) => b.title), n: (a.assemblyFindings || []).length });
          if (a.findingsOnly) {
            // 3 fat findings per group: meets count and prose gates, no retry.
            return { findings: [...a.beats.map((b) => ({ heading: b.title, body: fat(`Body for ${b.title} with substance.`), cite: [] })), { heading: 'Extra', body: fat('More substance here.'), cite: [] }] };
          }
          return {
            executiveSummary: 'Asm.', established: [], competing: [], contradictions: [],
            timeline: [], sourceQuality: '', independence: '', books: [], primarySources: [],
            uncertainty: ['u'], gaps: [], methodology: 'm',
          };
        },
      }),
    });
    const sections = calls.filter((c) => c.findingsOnly);
    const assembly = calls.filter((c) => c.assembleOnly);
    assert.equal(sections.length, 6, 'standard writes one section per beat');
    assert.deepEqual(sections.flatMap((c) => c.beats), arc6.map((b) => b.title), 'every beat covered once, in order');
    assert.equal(assembly.length, 1);
    assert.equal(assembly[0].n, 12, 'assembly receives all section findings');
    assert.equal(result.report.findings.length, 12);
    assert.ok(!result.report.synthesisFallback, 'full path is not flagged fallback');
  });

  it('degrades per-section: failed groups are skipped, rest still assemble', async () => {
    const result = await runResearch({ ...task }, {
      key: 'k', emit: () => {},
      deps: baseDeps({
        synthesize: async (a) => {
          if (a.findingsOnly) {
            if ((a.beats || []).some((b) => b.title === 'Sites')) throw new Error('quota blip');
            return { findings: (a.beats || []).map((b) => ({ heading: b.title, body: fat('Body.'), cite: [] })) };
          }
          return {
            executiveSummary: 'Asm.', established: [], competing: [], contradictions: [],
            timeline: [], sourceQuality: '', independence: '', books: [], primarySources: [],
            uncertainty: ['u'], gaps: [], methodology: 'm',
          };
        },
      }),
    });
    assert.ok(result.report.findings.length >= 4, 'surviving sections kept');
    assert.ok(!result.report.findings.some((f) => f.heading === 'Sites'));
    assert.ok(!result.report.synthesisFallback);
  });

  it('falls back to evidence inventory when sections AND single call fail', async () => {
    const result = await runResearch({ ...task }, {
      key: 'k', emit: () => {},
      deps: baseDeps({
        synthesize: async () => { throw new Error('all down'); },
      }),
    });
    assert.equal(result.report.synthesisFallback, true);
    assert.ok(result.report.findings.length >= 1, 'claims-derived findings keep the run useful');
    assert.ok(result.report.executiveSummary.includes('unavailable'));
  });

  it('uses template frontmatter when assembly fails but sections exist', async () => {
    const result = await runResearch({ ...task }, {
      key: 'k', emit: () => {},
      deps: baseDeps({
        synthesize: async (a) => {
          if (a.findingsOnly) {
            return { findings: (a.beats || []).map((b) => ({ heading: b.title, body: fat('Body text here.'), cite: [] })) };
          }
          throw new Error('assembly down');
        },
      }),
    });
    assert.equal(result.report.synthesisFallback, true);
    assert.ok(result.report.findings.length > 0, 'model-written sections preserved');
    assert.ok(result.report.findings.every((f) => f.heading && f.body));
  });

  it('retries rate-limited sections instead of skipping planned work', async () => {
    const attempts = [];
    const result = await runResearch({ ...task }, {
      key: 'k', emit: () => {},
      deps: baseDeps({
        synthesize: async (a) => {
          if (a.findingsOnly) {
            const n = attempts.filter((x) => x === 'section').length;
            attempts.push('section');
            if (n === 0) throw Object.assign(new Error('slow down'), { status: 429 });
            return { findings: (a.beats || []).map((b) => ({ heading: b.title, body: fat('Recovered body.'), cite: [] })) };
          }
          return {
            executiveSummary: 'Asm.', established: [], competing: [], contradictions: [],
            timeline: [], sourceQuality: '', independence: '', books: [], primarySources: [],
            uncertainty: ['u'], gaps: [], methodology: 'm',
          };
        },
      }),
    });
    assert.ok(result.report.findings.length === 6, 'all beats recovered after quota wait');
    assert.ok(!result.report.synthesisFallback);
  });

  it('expands thin sections once with an explicit nudge (no silent thinness)', async () => {
    const hints = [];
    const result = await runResearch({ ...task }, {
      key: 'k', emit: () => {},
      deps: baseDeps({
        synthesize: async (a) => {
          if (a.findingsOnly) {
            hints.push(a.retryHint || '');
            if (!a.retryHint) return { findings: [{ heading: 'Only', body: 'Thin.', cite: [] }] };
            return {
              findings: (a.beats || []).map((b) => ({ heading: b.title, body: 'Expanded body with dates, names, and evidence discussed at length.', cite: [] })),
            };
          }
          return {
            executiveSummary: 'Asm.', established: [], competing: [], contradictions: [],
            timeline: [], sourceQuality: '', independence: '', books: [], primarySources: [],
            uncertainty: ['u'], gaps: [], methodology: 'm',
          };
        },
      }),
    });
    assert.ok(hints.some((h) => h.includes('Expand now')), 'retry carries an expansion nudge');
    assert.ok(result.report.findings.length >= 6, 'expanded sections kept');
  });

  it('does not retry non-retryable section failures (fail fast, then degrade)', async () => {
    let calls = 0;
    const result = await runResearch({ ...task }, {
      key: 'k', emit: () => {},
      deps: baseDeps({
        synthesize: async (a) => {
          if (a.findingsOnly) {
            calls++;
            throw Object.assign(new Error('bad request'), { status: 400 });
          }
          return {
            executiveSummary: 'Asm.', established: [], competing: [], contradictions: [],
            timeline: [], sourceQuality: '', independence: '', books: [], primarySources: [],
            uncertainty: ['u'], gaps: [], methodology: 'm',
          };
        },
      }),
    });
    assert.equal(calls, 6, 'one attempt per beat group, no pointless retries on 400');
    assert.ok(result.report);
  });

  it('retries prose-thin sections once even when finding count suffices', async () => {
    const hints = [];
    const result = await runResearch({ ...task }, {
      key: 'k', emit: () => {},
      deps: baseDeps({
        synthesize: async (a) => {
          if (a.findingsOnly) {
            hints.push(a.retryHint || '');
            if (!a.retryHint) {
              // Enough findings, but each body is a stub → thin prose gate fires.
              return { findings: (a.beats || []).flatMap((b) => ([
                { heading: `${b.title} a`, body: 'Stub one.', cite: [] },
                { heading: `${b.title} b`, body: 'Stub two.', cite: [] },
                { heading: `${b.title} c`, body: 'Stub three.', cite: [] },
              ])) };
            }
            return {
              findings: (a.beats || []).map((b) => ({
                heading: b.title,
                body: 'Expanded body with dates, names, numbers, and evidence discussed at length across multiple sentences.',
                cite: [],
              })),
            };
          }
          return {
            executiveSummary: 'Asm.', established: [], competing: [], contradictions: [],
            timeline: [], sourceQuality: '', independence: '', books: [], primarySources: [],
            uncertainty: ['u'], gaps: [], methodology: 'm',
          };
        },
      }),
    });
    assert.ok(hints.some((h) => h.includes('chars')), 'retry nudge quantifies the prose shortfall');
    assert.ok(result.report.findings.every((f) => f.body.length > 20), 'expanded prose kept');
  });
});
