import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSemanticScholar, parsePubMedSummary, parseArchiveOrg, queryTerms, bookRelevance, rankByRelevance, heuristicBookVariants, expandBookQueries, searchBooks } from '../backend/src/providers/academic.js';

describe('academic/book parsers (offline fixtures)', () => {
  it('parses Semantic Scholar, preferring open-access PDF over DOI', () => {
    const out = parseSemanticScholar({ data: [
      { paperId: 'abc', title: 'T1', authors: [{ name: 'A. Uthor' }], year: 2020, venue: 'J', citationCount: 5, openAccessPdf: { url: 'https://pdf.example/t1.pdf' }, externalIds: { DOI: '10.1/x' } },
      { paperId: 'def', title: 'T2', authors: [], year: null, venue: '', citationCount: 0, openAccessPdf: null, externalIds: { DOI: '10.2/y' } },
    ]});
    assert.equal(out.length, 2);
    assert.equal(out[0].url, 'https://pdf.example/t1.pdf');
    assert.equal(out[0].via, 'academic:semanticscholar');
    assert.equal(out[1].url, 'https://doi.org/10.2/y');
  });
  it('parses PubMed esummary into stable pubmed URLs', () => {
    const out = parsePubMedSummary({ result: { uids: ['123'], 123: { title: 'Study', authors: [{ name: 'Smith J' }], pubdate: '2021', source: 'Nature' } } });
    assert.equal(out.length, 1);
    assert.equal(out[0].url, 'https://pubmed.ncbi.nlm.nih.gov/123/');
    assert.ok(out[0].snippet.includes('PubMed'));
  });
  it('parses Internet Archive docs, dropping identifier-less records', () => {
    const out = parseArchiveOrg({ response: { docs: [
      { identifier: 'book123', title: 'Old Book', creator: ['Writer'], date: '1899' },
      { title: 'No identifier' },
    ]}});
    assert.equal(out.length, 1);
    assert.equal(out[0].url, 'https://archive.org/details/book123');
    assert.equal(out[0].via, 'books:archive.org');
  });
});

describe('book relevance ranking (dynamic, no topic lists)', () => {
  const recs = [
    { title: 'A Heritage of Open Air Square Temple Discovered In Russia', snippet: 'Russian archaeology', meta: {} },
    { title: 'The Harappan Civilization', snippet: 'Indus Valley', meta: { authors: ['Mortimer Wheeler'] } },
    { title: 'Harappan civilization', snippet: '', meta: {} },
  ];
  it('extracts key terms minus stopwords', () => {
    assert.deepEqual(queryTerms('tell about harappan civilization'), ['harappan', 'civilization']);
    assert.deepEqual(queryTerms('the the a'), []);
  });
  it('ranks overlapping titles first and drops zero-overlap records', () => {
    const ranked = rankByRelevance('tell about harappan civilization', recs);
    assert.equal(ranked.length, 2);
    assert.ok(ranked[0].title.toLowerCase().includes('harappan'));
    assert.ok(!ranked.some((r) => r.title.includes('Russia')));
  });
  it('keeps provider order when nothing matches (no empty results)', () => {
    const ranked = rankByRelevance('the the a', recs);
    assert.equal(ranked.length, 3);
  });
});

describe('shared book expansion (one LLM call per run)', () => {
  it('heuristic variants need no key and stay topical', () => {
    const v = heuristicBookVariants('Tell about Harappan civilization?');
    assert.ok(v.length >= 1 && v.length <= 4);
    assert.ok(v.some((x) => x.includes('harappan')));
  });
  it('expandBookQueries falls back to heuristic without key (offline-safe)', async () => {
    const out = await expandBookQueries('harappan civilization', {});
    assert.equal(out.llm, false);
    assert.ok(out.variants.length >= 1);
  });
  it('searchBooks reuses provided variants without expanding', async () => {
    const requested = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      requested.push(String(url));
      return { ok: true, status: 200, json: async () => ({ docs: [] }) };
    };
    try {
      const out = await searchBooks('ignored question', 4, { variants: ['harappan civilization books'] });
      assert.deepEqual(out, []);
      // OpenLibrary/Google Books must use the provided variant, never the raw question.
      // (Archive.org intentionally searches the raw question text.)
      const ol = requested.filter((u) => u.includes('openlibrary') || u.includes('googleapis'));
      assert.ok(ol.length > 0);
      assert.ok(ol.every((u) => u.includes('harappan%20civilization%20books')));
      assert.ok(!ol.some((u) => u.includes('ignored%20question') || u.includes('ignored+question')));
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
