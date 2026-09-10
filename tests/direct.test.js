import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { apiAvailable, runDirect, saveLocalResult, loadLocalResult } from '../frontend/direct.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe('static-mode helpers', () => {
  it('apiAvailable detects a real API and fails closed offline', async () => {
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ modes: ['quick'] }) });
    assert.equal(await apiAvailable(''), true);
    globalThis.fetch = async () => { throw new Error('offline'); };
    assert.equal(await apiAvailable(''), false);
    globalThis.fetch = async () => ({ ok: false });
    assert.equal(await apiAvailable(''), false);
  });

  it('runDirect rejects without a key and runs with fakes', async () => {
    await assert.rejects(runDirect({ question: 'Is this ok?' }, { key: '' }), /API key/);
    const seen = [];
    const result = await runDirect(
      { question: 'Is this ok?', mode: 'quick', stance: 'neutral' },
      {
        key: 'k',
        emit: (e) => seen.push(e.type),
        deps: {
          plan: async () => ({ domain: 'history', complexity: 'low', steps: ['a'], linesOfInquiry: ['g'] }),
          queries: async () => [],
          search: async () => [],
          academic: async () => [],
          books: async () => [],
          fetch: async () => ({ ok: false, reason: 'x' }),
          claims: async () => [{ id: 'c1', text: 'X.', state: 'supported', supporting: [], contradicting: [], confidenceWhy: 'w' }],
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
    assert.ok(seen.includes('plan') && seen.includes('claims') && seen.includes('done'));
  });

  it('local persistence degrades gracefully without localStorage (node)', () => {
    assert.equal(saveLocalResult({ id: 'x' }), false);
    assert.equal(loadLocalResult('x'), null);
  });
});
