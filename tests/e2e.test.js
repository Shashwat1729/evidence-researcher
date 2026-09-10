// End-to-end pipeline test with deterministic fakes (no network, no API key).
// Exercises: plan → search → dedup → classify → fetch → claims → review →
// gap/counter-evidence search → escalation → provenance → synthesis →
// citation-integrity → eval audit score. Plus HTTP/SSE plumbing.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { runResearch } from '../backend/src/engine/orchestrator.js';
import { createApp } from '../backend/src/app.js';
import { score } from '../eval/score.js';
import { MODES } from '../backend/src/config.js';

before(() => { delete process.env.GEMINI_API_KEY; });

const SEARCH_RESULTS = [
  { url: 'https://www.archives.gov/founding-charter', title: 'Founding charter record', snippet: 'archival government record of the founding', via: 'grounding' },
  { url: 'https://www.archives.gov/founding-charter?utm_source=copy', title: 'Founding charter record', snippet: 'archival government record', via: 'grounding' },
  { url: 'https://arxiv.org/abs/1234.5678', title: 'A quantitative study', snippet: 'peer-reviewed analysis doi:10.1/x', via: 'academic:arxiv' },
  { url: 'https://en.wikipedia.org/wiki/Founding', title: 'Founding (overview)', snippet: 'tertiary overview of the founding', via: 'grounding' },
  { url: 'https://www.reddit.com/r/history/comments/abc', title: 'Discussion thread', snippet: 'user comments with a citation lead', via: 'grounding' },
  { url: 'https://openlibrary.org/books/OL123M', title: 'A scholarly monograph', snippet: 'Open Library: Historian (University Press 1999)', via: 'books:openlibrary' },
  { url: 'https://example-news.com/investigation', title: 'Investigation report', snippet: 'newsroom investigation with editorial review', via: 'grounding' },
];

function fakeFetch(url) {
  if (url.includes('reddit')) return Promise.resolve({ ok: false, reason: 'access denied (auth/paywall/robots)' });
  if (url.includes('archives')) return Promise.resolve({ ok: true, title: 'Charter of 1901', author: 'National Archives', publishedDate: '1901-03-04', canonical: url, text: ('The charter dated march 1901 establishes the founding in the capital district. ').repeat(40) });
  if (url.includes('arxiv')) return Promise.resolve({ ok: true, title: 'Quantitative study', author: 'Researcher', publishedDate: '2019', canonical: url, text: ('Peer reviewed regression analysis of founding records and census data. ').repeat(40) });
  return Promise.resolve({ ok: true, title: 'Page', author: '', publishedDate: '', canonical: url, text: ('General background page describing the founding era and its context. ').repeat(40) });
}

let reviewCalls = 0;
const deps = {
  plan: async () => ({
    domain: 'history', complexity: 'low',
    steps: ['a', 'b', 'c', 'd', 'e', 'f'],
    linesOfInquiry: ['general', 'scholarly', 'primary evidence', 'counter-evidence'],
  }),
  queries: async () => [
    { q: 'founding date overview', category: 'general' },
    { q: 'founding scholarly study', category: 'scholarly' },
    { q: 'founding primary records', category: 'primary-evidence' },
    { q: 'founding alternative accounts', category: 'alternative-explanations' },
  ],
  search: async (_q, _cat, ctx) => { ctx?.onUsage?.({ in: 10, out: 5 }); return SEARCH_RESULTS; },
  academic: async () => [],
  books: async () => [],
  fetch: fakeFetch,
  claims: async ({ sources }) => {
    const find = (fn) => sources.find(fn)?.id;
    return [
      { id: 'c1', text: 'X was founded in 1901.', state: 'supported', supporting: [find((s) => s.domain.includes('archives'))].filter(Boolean), contradicting: [], confidenceWhy: 'Archive record plus independent quantitative study.' },
      { id: 'c2', text: 'Economic decline was the primary cause.', state: 'disputed', supporting: [find((s) => s.sourceType === 'book')].filter(Boolean), contradicting: [find((s) => s.domain.includes('arxiv'))].filter(Boolean), confidenceWhy: 'Historians disagree; evidence is indirect.' },
    ];
  },
  review: async ({ sources }) => {
    reviewCalls++;
    const arxiv = sources.find((s) => s.domain.includes('arxiv'))?.id;
    const contra = [{ id: 'k1', claimId: 'c2', against: 'Census data shows growth, not decline, before the founding.', sources: [arxiv, 'src_GHOST'].filter(Boolean), severity: 'high' }];
    return reviewCalls === 1
      ? { contradictions: contra, gaps: ['day-level record not yet verified'], sufficient: false, reason: 'disagreement open' }
      : { contradictions: contra, gaps: [], sufficient: true, reason: 'resolved' };
  },
  provenance: async ({ sources }) => {
    const verified = sources.filter((s) => s.verified);
    if (verified.length < 2) return { groups: [], relations: [], note: 'Source independence could not be determined.' };
    return {
      groups: [{ ids: [verified[0].id, verified[1].id], verdict: 'derived', explanation: 'shared charter transcription' }],
      relations: [{ from: verified[1].id, to: verified[0].id, kind: 'derived_from', evidence: 'verbatim overlap' }],
      note: 'Two pages derive from one transcription — not independent confirmations.',
    };
  },
  synthesize: async ({ task, sources, claims, contradictions, provenance }) => ({
    executiveSummary: 'X was founded in 1901 per the charter; the economic-decline theory is disputed.',
    established: ['X was founded in 1901.'],
    findings: [
      { heading: 'Date', body: `Charter and study agree on 1901 (mode ${task.mode}).`, cite: [sources[0].id, 'cite_GHOST'] },
      { heading: 'Cause debate', body: `Claim "${claims[1].text}" is ${claims[1].state}.`, cite: claims[1].supporting },
    ],
    competing: ['Gradual emergence theory.'],
    contradictions: contradictions.map((c) => c.against),
    sourceQuality: 'Archive record strongest; social thread is a lead only.',
    independence: provenance.note,
    books: ['A scholarly monograph (metadata only — text not inspected).'],
    primarySources: ['1901 charter (archive).'],
    uncertainty: ['Exact day unverified.'],
    gaps: ['Day-level record missing.'],
    methodology: `Searched, fetched, cross-checked in ${task.mode} mode.`,
  }),
  verify: async () => [
    { n: 0, supported: 'yes', note: 'Excerpts directly support the finding.' },
    { n: 1, supported: 'partial', note: 'Book evidence is metadata only.' },
  ],
  urlContext: async () => ({ text: '' }), // hermetic: never hit network even if enrichment triggers
};

describe('full research pipeline (mocked models)', () => {
  let result;
  it('runs plan→synthesis without network', async () => {
    reviewCalls = 0;
    result = await runResearch(
      { question: 'When was X founded, and what caused it?', mode: 'standard', stance: 'lean', hypothesis: 'economic decline was primary' },
      { key: 'test-key', emit: () => {}, deps },
    );
    assert.ok(result.id && result.report && result.claims.length === 2);
  });

  it('deduplicates tracking variants but keeps copies linked', () => {
    assert.equal(result.sources.length, 6);
    const arch = result.sources.find((s) => s.url.includes('archives'));
    assert.ok((arch.relatedCopies || []).some((u) => u.includes('utm_source')));
  });

  it('filters ghost citations everywhere (findings, claims, contradictions)', () => {
    assert.ok(!JSON.stringify(result).includes('GHOST'), 'no ghost source id may survive');
    assert.ok(result.report.findings[0].cite.length >= 1);
  });

  it('escalates on disagreement and iterates', () => {
    assert.equal(result.stats.escalated, true);
    assert.equal(result.iterations.length, 2);
    assert.ok(result.relations.some((r) => r.kind === 'derived_from'));
  });

  it('respects budgets and tracks real token usage', () => {
    assert.ok(result.stats.searchCalls <= MODES.standard.maxSearches);
    assert.ok(result.stats.modelCalls <= MODES.standard.maxModelCalls);
    assert.ok(result.stats.tokensOut <= MODES.standard.maxTokensOut);
    assert.deepEqual([result.stats.tokensIn, result.stats.tokensOut], [80, 40]);
  });

  it('discloses non-neutral stance with safeguards', () => {
    assert.ok(result.stanceDisclosure.includes('lean') && result.stanceDisclosure.includes('truth conditions'));
  });

  it('scores full marks on the audit benchmark', () => {
    const { checks, score: s } = score(result);
    assert.deepEqual(Object.entries(checks).filter(([, v]) => !v), [], 'all audit checks must pass');
    assert.equal(s, '15/15');
  });

  it('records phase timings, fetch telemetry, and cross-evaluation', () => {
    for (const p of ['plan', 'search', 'fetch', 'analyze', 'provenance', 'synthesis', 'verify']) {
      assert.ok(Number.isFinite(result.stats.phases[p]), `phase ${p} timed`);
    }
    assert.equal(result.report.verification.length, 2);
    assert.equal(result.report.verification[0].supported, 'yes');
  });

  it('rejects non-questions at the classification gate without searching', async () => {
    let searches = 0;
    await assert.rejects(
      runResearch(
        { question: 'Hello there!', mode: 'quick', stance: 'neutral' },
        { key: 'k', emit: () => {}, deps: { plan: async () => ({ valid: false, clarify: 'Ask me something to investigate.' }), search: async () => { searches++; return []; } } },
      ),
      /Not a research question/,
    );
    assert.equal(searches, 0);
  });
});

describe('HTTP + SSE plumbing', () => {
  let base;
  let server;
  const fakeResult = { id: 'r_http', task: { question: 'Q?' }, report: {}, sources: [], claims: [] };

  before(async () => {
    const app = createApp({
      runFn: async (_input, { emit }) => { emit({ type: 'progress', message: 'Working' }); return fakeResult; },
      store: {
        saveResult: async () => {}, getResult: async () => { throw new Error('nf'); },
        listResults: async () => [], deleteResult: async () => {},
      },
    });
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    // Deterministic teardown: drop sockets first so close() never hangs.
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  });

  it('streams SSE events ending in result', async () => {
    const res = await fetch(`${base}/api/research`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-gemini-key': 'k' },
      body: JSON.stringify({ question: 'When was X founded?' }),
    });
    assert.equal(res.status, 200);
    let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += Buffer.from(chunk).toString();
        if (buf.includes('"type":"result"')) break;
      }
    } finally {
      await res.body.cancel().catch(() => {});
    }
    const events = buf.split('\n\n').filter((p) => p.includes('data:')).map((p) => JSON.parse(p.split('data:')[1]));
    assert.ok(events.some((e) => e.type === 'progress'));
    assert.equal(events.find((e) => e.type === 'result').result.id, 'r_http');
  });

  it('rejects short questions (400) and missing keys (401)', async () => {
    const bad = await fetch(`${base}/api/research`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-gemini-key': 'k' }, body: JSON.stringify({ question: 'hi' }) });
    assert.equal(bad.status, 400);
    const nokey = await fetch(`${base}/api/research`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: 'When was X founded?' }) });
    assert.equal(nokey.status, 401);
  });

  it('serves health and history', async () => {
    assert.equal((await (await fetch(`${base}/api/health`)).json()).ok, true);
    assert.deepEqual((await (await fetch(`${base}/api/history`)).json()).items, []);
  });
});
