import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runResearch } from '../backend/src/engine/orchestrator.js';

// Regression: sources discovered in follow-up (gap/contradiction) searches
// must keep their grounding excerpts as passages and preserve relatedCopies,
// exactly like initial-batch sources (toSources parity).
describe('follow-up source enrichment parity', () => {
  it('follow-up sources carry passages and related copies', async () => {
    let calls = 0;
    const result = await runResearch(
      { question: 'What caused the test event of 1901?', mode: 'standard', stance: 'neutral' },
      {
        key: 'k',
        emit: () => {},
        deps: {
          plan: async () => ({ domain: 'history', complexity: 'medium', steps: ['a', 'b'], linesOfInquiry: ['general'] }),
          queries: async () => [{ q: 'test event 1901', category: 'general' }],
          search: async () => {
            calls++;
            if (calls === 1) return [{ url: 'https://a.example/first', title: 'First', snippet: 'first excerpt', via: 'grounding' }];
            return [
              { url: 'https://b.example/second', title: 'Second', snippet: 'second excerpt here', via: 'grounding' },
              { url: 'https://b.example/second?utm_x=1', title: 'Second', snippet: 'second excerpt here', via: 'grounding' },
            ];
          },
          academic: async () => [],
          books: async () => [],
          fetch: async () => ({ ok: false, reason: 'timeout' }),
          claims: async () => [{ id: 'c1', text: 'X happened.', state: 'plausible', supporting: [], contradicting: [], confidenceWhy: 'why' }],
          review: async ({ iteration }) => iteration === 1
            ? { contradictions: [], gaps: ['need more context'], sufficient: false, reason: 'gap' }
            : { contradictions: [], gaps: [], sufficient: true, reason: 'done' },
          provenance: async () => ({ groups: [], relations: [], note: 'n/a' }),
          synthesize: async () => ({
            executiveSummary: 's', established: [], findings: [], competing: [], contradictions: [],
            sourceQuality: '', independence: '', books: [], primarySources: [], uncertainty: ['u'], gaps: [], methodology: 'm',
          }),
          verify: async () => [],
          urlContext: async () => ({ text: '' }),
        },
      },
    );
    const second = result.sources.find((s) => s.url === 'https://b.example/second');
    assert.ok(second, 'follow-up source must be merged');
    assert.ok((second.passages || []).length > 0, 'follow-up source must keep grounding excerpt');
    assert.ok(second.passages[0].text.includes('second excerpt'));
    assert.ok((second.relatedCopies || []).some((u) => u.includes('utm_x')), 'related copies preserved');
  });
});
