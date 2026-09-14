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

  it('true gap-path sources get full parity (type/tier/hint) plus top-up fetch', async () => {
    const result = await runResearch(
      { question: 'What caused the test event of 1901?', mode: 'standard', stance: 'neutral' },
      {
        key: 'k',
        emit: () => {},
        deps: {
          plan: async () => ({ domain: 'history', complexity: 'medium', steps: ['a'], linesOfInquiry: ['general'] }),
          queries: async () => [{ q: 'test event 1901', category: 'general' }],
          // Branch on the query CATEGORY (not substrings): follow-up angles
          // return new records; every other query returns the seed. Substring
          // matching is fragile because templates legitimately reuse words
          // like "context" inside unrelated (e.g. diversity top-up) queries.
          search: async (q, cat) => {
            if (cat === 'gap' || cat === 'counter-evidence' || cat === 'disagreement') {
              return [
                { url: 'https://openlibrary.org/books/OL9M', title: 'Gap Book', snippet: 'gap book excerpt', via: 'books:openlibrary', category: 'books' },
                { url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/zz', title: 'arxiv.org/abs/9999', snippet: 'gap paper excerpt', via: 'grounding' },
                { url: 'https://c.example/deep-dive', title: 'Deep Dive', snippet: 'deep excerpt', via: 'grounding' },
                { url: 'https://c.example/deep-dive?utm_source=x', title: 'Deep Dive', snippet: 'deep excerpt', via: 'grounding' },
              ];
            }
            return [{ url: 'https://a.example/seed', title: 'Seed', snippet: 'seed excerpt', via: 'grounding' }];
          },
          academic: async () => [],
          books: async () => [],
          fetch: async (url) => String(url).includes('deep-dive')
            ? { ok: true, title: 'Deep Dive Full', author: 'A. Uthor', publishedDate: '2020', canonical: url, text: `Full fetched body text about the test event. `.repeat(30), domain: 'c.example' }
            : { ok: false, reason: 'timeout' },
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
    const book = result.sources.find((s) => s.url === 'https://openlibrary.org/books/OL9M');
    assert.ok(book, 'follow-up book merged');
    assert.equal(book.sourceType, 'book', 'book type detected like initial batch');
    assert.equal(book.accessibility, 'metadata-only', 'book accessibility matches initial batch');
    const paper = result.sources.find((s) => s.title === 'arxiv.org/abs/9999');
    assert.ok(paper, 'hinted redirect merged');
    assert.equal(paper.tier, 2, 'domain hint applied to classification');
    const deep = result.sources.find((s) => s.url === 'https://c.example/deep-dive');
    assert.ok(deep, 'fetchable follow-up merged');
    assert.ok(deep.relatedCopies.some((u) => u.includes('utm_source')), 'intra-batch copies linked, not duplicated');
    assert.equal(deep.verified, true, 'top-up fetch inspected the new source');
    assert.equal(deep.accessibility, 'full');
    assert.ok(deep.passages[0].text.includes('Full fetched body'));
  });
});
