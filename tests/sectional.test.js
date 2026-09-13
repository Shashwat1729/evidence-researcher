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

describe('sectional synthesis (standard mode)', () => {
  it('writes one full-budget section per beat group, then assembles', async () => {
    const calls = [];
    const result = await runResearch({ ...task }, {
      key: 'k', emit: () => {},
      deps: baseDeps({
        synthesize: async (a) => {
          calls.push({ findingsOnly: !!a.findingsOnly, assembleOnly: !!a.assembleOnly, beats: (a.beats || []).map((b) => b.title), n: (a.assemblyFindings || []).length });
          if (a.findingsOnly) {
            return { findings: a.beats.map((b) => ({ heading: b.title, body: `Body for ${b.title} with substance.`, cite: [] })) };
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
    assert.equal(sections.length, 3, 'standard splits 6 beats into 3 groups');
    assert.deepEqual(sections.flatMap((c) => c.beats), arc6.map((b) => b.title), 'every beat covered once, in order');
    assert.equal(assembly.length, 1);
    assert.equal(assembly[0].n, 6, 'assembly receives all section findings');
    assert.equal(result.report.findings.length, 6);
    assert.ok(!result.report.synthesisFallback, 'full path is not flagged fallback');
  });

  it('degrades per-section: failed groups are skipped, rest still assemble', async () => {
    const result = await runResearch({ ...task }, {
      key: 'k', emit: () => {},
      deps: baseDeps({
        synthesize: async (a) => {
          if (a.findingsOnly) {
            if ((a.beats || []).some((b) => b.title === 'Sites')) throw new Error('quota blip');
            return { findings: (a.beats || []).map((b) => ({ heading: b.title, body: 'Body.', cite: [] })) };
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
            return { findings: (a.beats || []).map((b) => ({ heading: b.title, body: 'Body text here.', cite: [] })) };
          }
          throw new Error('assembly down');
        },
      }),
    });
    assert.equal(result.report.synthesisFallback, true);
    assert.ok(result.report.findings.length > 0, 'model-written sections preserved');
    assert.ok(result.report.findings.every((f) => f.heading && f.body));
  });
});
