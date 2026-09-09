import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSemanticScholar, parsePubMedSummary, parseArchiveOrg } from '../backend/src/providers/academic.js';

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
