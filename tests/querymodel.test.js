import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { topicOf } from '../backend/src/engine/queries.js';
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

describe('multi-key support', () => {
  it('accepts arrays, dedupes, caps fan-out', () => {
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
    const seen = { models: [], academic: [], books: [] };
    const mk = (id) => ({ id, text: 'X.', state: 'supported', supporting: [], contradicting: [], confidenceWhy: 'w' });
    const result = await runResearch(
      { question: 'Tell about Harappan civilization?', mode: 'standard', stance: 'neutral', model: 'gemini-2.0-flash' },
      {
        key: 'k', emit: () => {},
        deps: {
          plan: async (a) => { seen.models.push(['plan', a.model]); return { domain: 'history', complexity: 'low', steps: ['a'], linesOfInquiry: ['g'] }; },
          queries: async (a) => { seen.models.push(['queries', a.model]); return [{ q: 'Harappan civilization book historian', category: 'books' }]; },
          search: async () => [],
          academic: async (q) => { seen.academic.push(q); return []; },
          books: async (q, lim) => { seen.books.push([q, lim]); return []; },
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
  });
});
