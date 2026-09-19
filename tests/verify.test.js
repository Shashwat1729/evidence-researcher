import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { verifyFindings } from '../backend/src/engine/verify.js';
import { runResearch } from '../backend/src/engine/orchestrator.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const sources = [
  { id: 's1', passages: [{ text: 'The charter dated 1088 establishes the studium.' }] },
  { id: 's2', passages: [] },
];

describe('post-synthesis verification', () => {
  it('grades findings against excerpts strictly', async () => {
    globalThis.fetch = async () => jsonResponse(200, {
      candidates: [{ content: { parts: [{ text: '{"results":[{"n":0,"supported":"yes","note":"Direct match."},{"n":1,"supported":"no","note":"No excerpts."}]}' }] } }],
      usageMetadata: {},
    });
    const out = await verifyFindings({
      key: 'k', model: 'm',
      findings: [
        { heading: 'Date', body: 'Founded 1088.', cite: ['s1'] },
        { heading: 'Cause', body: 'Economic decline.', cite: ['s2'] },
      ],
      sources,
    });
    assert.equal(out.length, 2);
    assert.equal(out[0].supported, 'yes');
    assert.equal(out[1].supported, 'no');
  });

  it('never fails the run — returns [] when the model errors', async () => {
    globalThis.fetch = async () => { throw new Error('down'); };
    const out = await verifyFindings({ key: 'k', model: 'm', findings: [{ heading: 'H', body: 'B', cite: [] }], sources });
    assert.deepEqual(out, []);
  });

  it('returns [] with no findings (no wasted call)', async () => {
    let calls = 0;
    globalThis.fetch = async () => { calls++; return jsonResponse(200, {}); };
    assert.deepEqual(await verifyFindings({ key: 'k', model: 'm', findings: [], sources }), []);
    assert.equal(calls, 0);
  });

  it('a "no" verdict demotes the finding into uncertainty (verification acts)', async () => {
    const deps = {
      plan: async () => ({ domain: 'history', complexity: 'low', steps: ['a'], linesOfInquiry: ['g'], queries: [], bookVariants: [], arc: [] }),
      queries: async () => [{ q: 'founding overview', category: 'general' }],
      search: async () => [{ url: 'https://x.example/r', title: 'Rec', snippet: 'Distinct evidence about founding with unique vocabulary.', via: 'grounding' }],
      academic: async () => [],
      books: async () => [],
      fetch: async () => ({ ok: false, reason: 'x' }),
      claims: async () => [{ id: 'c1', text: 'X founded 1901.', state: 'supported', supporting: [], contradicting: [], confidenceWhy: 'w' }],
      review: async () => ({ contradictions: [], gaps: [], sufficient: true, reason: 'r' }),
      provenance: async () => ({ groups: [], relations: [], note: 'n' }),
      synthesize: async () => ({
        executiveSummary: 'e', findings: [{ heading: 'Shaky date', body: 'Founded 1901, allegedly.', cite: [] }],
        uncertainty: [], methodology: 'm',
      }),
      verify: async () => [{ n: 0, supported: 'no', note: 'No excerpts back the date.' }],
      urlContext: async () => ({ text: '' }),
    };
    const result = await runResearch(
      { question: 'When was X founded?', mode: 'standard', stance: 'neutral' },
      { key: 'k', emit: () => {}, deps },
    );
    assert.ok((result.report.uncertainty || []).some((u) => /Cross-check failed.*Shaky date/.test(u)), 'failed finding flagged in uncertainty');
  });

  it('sends whole findings (never mid-object truncation)', async () => {
    let sent = '';
    globalThis.fetch = async (url, opts) => {
      sent = JSON.parse(opts.body).contents[0].parts[0].text;
      return jsonResponse(200, { candidates: [{ content: { parts: [{ text: '{"results":[]}' }] } }] });
    };
    const big = 'x'.repeat(5000);
    await verifyFindings({
      key: 'k', model: 'm',
      findings: [
        { heading: 'A', body: big, cite: ['s1'] },
        { heading: 'B', body: big, cite: ['s1'] },
        { heading: 'C', body: big, cite: ['s1'] },
      ],
      sources,
    });
    const m = sent.match(/Findings: (\[.*?\])\nReturn JSON/s);
    assert.ok(m, 'findings embedded');
    const parsed = JSON.parse(m[1]);
    assert.ok(parsed.length >= 1 && parsed.length <= 3, 'whole items only');
    assert.ok(parsed.every((f) => f.heading && typeof f.body === 'string'), 'no partial objects');
  });
});
