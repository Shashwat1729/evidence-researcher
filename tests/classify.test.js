import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifySource } from '../backend/src/engine/classify.js';

describe('source classification', () => {
  it('does not auto-trust .edu blogs', () => {
    const r = classifySource({ url: 'https://somedept.university.edu/blog/my-take', title: 'My take', snippet: 'opinion post' });
    assert.notEqual(r.tier, 2, 'edu blog must not be tier 2');
  });
  it('treats scholarly .edu paths as scholarly-secondary', () => {
    const r = classifySource({ url: 'https://repository.university.edu/papers/123', title: 'A study', snippet: 'peer-reviewed findings doi:10.1/x' });
    assert.equal(r.tier, 2);
  });
  it('wikipedia is discovery, not evidence', () => {
    const r = classifySource({ url: 'https://en.wikipedia.org/wiki/Rome', title: 'Rome', snippet: 'history' });
    assert.equal(r.tier, 6);
  });
  it('reddit is a lead, not evidence', () => {
    const r = classifySource({ url: 'https://www.reddit.com/r/history/comments/x', title: 'thread', snippet: 'comment' });
    assert.equal(r.tier, 7);
  });
  it('arxiv/doi domains are scholarly', () => {
    const r = classifySource({ url: 'https://arxiv.org/abs/1234', title: 'paper', snippet: 'abstract' });
    assert.equal(r.tier, 2);
  });
  it('national archives are institutional', () => {
    const r = classifySource({ url: 'https://www.archives.gov/records/x', title: 'record', snippet: 'archival document' });
    assert.ok([1, 3].includes(r.tier));
  });
  it('a book on archive.org is a book (tier 2), never primary evidence', () => {
    const r = classifySource({ url: 'https://archive.org/details/flushed00whod', title: 'Flushed: how the plumber saved civilization', snippet: 'Internet Archive', sourceType: 'book' });
    assert.equal(r.tier, 2, 'declared type beats the archival-domain guess');
  });
  it('a declared paper on a generic domain keeps tier 2', () => {
    const r = classifySource({ url: 'https://example.com/paper', title: 'Study', snippet: 'abstract', sourceType: 'paper' });
    assert.equal(r.tier, 2);
  });
  it('topically unrelated keyword matches are demoted (academic channel only)', () => {
    const noise = classifySource({ url: 'https://pubmed.ncbi.nlm.nih.gov/1/', title: 'Impact of Yoga on the Cardiovascular System', snippet: 'PubMed', sourceType: 'paper', relevance: 0, strictTopical: true });
    assert.equal(noise.tier, 5, 'PubMed keyword noise must not parade as tier 2');
    assert.ok(/topical/i.test(noise.tierReason));
    // Grounding passed Google's own ranking — never demoted here.
    const grounded = classifySource({ url: 'https://example.com/x', title: 'Unrelated', snippet: '...', sourceType: 'webpage', relevance: 0, strictTopical: false });
    assert.equal(grounded.tier, 6);
    // Topical papers are untouched.
    const good = classifySource({ url: 'https://doi.org/10.1/x', title: 'Fluvial landscapes of the Harappan civilization', snippet: 'OpenAlex', sourceType: 'paper', relevance: 1, strictTopical: true });
    assert.equal(good.tier, 2);
  });
  it('official documents rank dynamically: court, legislative, and IGO sources', () => {
    assert.equal(classifySource({ url: 'https://www.courtlistener.com/docket/12345/smith-v-jones/', title: 'Docket', snippet: 'court filing' }).tier, 2, 'court filing tier 2');
    assert.equal(classifySource({ url: 'https://www.supremecourt.gov/opinions/22pdf/21-1234.pdf', title: 'Opinion', snippet: 'supreme court' }).tier, 2, 'supreme court opinion tier 2');
    assert.equal(classifySource({ url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000320193', title: '10-K Filing', snippet: 'Apple Inc. annual report' }).tier, 2, 'SEC 10-K filing tier 2');
    assert.equal(classifySource({ url: 'https://patents.google.com/patent/US10123456B2', title: 'Patent', snippet: 'Inventor: Smith' }).tier, 2, 'patent tier 2');
    assert.equal(classifySource({ url: 'https://www.parliament.uk/business/committees/committees-a-z/commons-select/x/', title: 'Hansard', snippet: 'parliamentary record' }).tier, 3, 'parliament.uk tier 3');
    assert.equal(classifySource({ url: 'https://www.un.org/en/resolution/123', title: 'UN Resolution', snippet: 'General Assembly' }).tier, 3, 'un.org tier 3');
    assert.equal(classifySource({ url: 'https://europa.eu/legislation_summaries/x', title: 'EU Directive', snippet: 'official journal' }).tier, 3, 'europa.eu tier 3');
    assert.equal(classifySource({ url: 'https://www.fda.gov/drugs/drug-approvals-and-databases/x', title: 'FDA Approval', snippet: 'clinical trial' }).tier, 3, 'fda.gov tier 3');
    assert.equal(classifySource({ url: 'https://www.nasa.gov/mission/apollo-11', title: 'Apollo 11', snippet: 'mission report' }).tier, 3, 'nasa.gov tier 3');
    // Primary-evidence markers lift even a generic gov page when the snippet says so
    const whitepaper = classifySource({ url: 'https://www.gov.uk/government/publications/white-paper-on-x', title: 'White paper', snippet: 'official government white paper on policy' });
    assert.equal(whitepaper.proximity, 'primary', 'white paper flagged as primary');
    assert.ok(whitepaper.tier <= 3, 'official document not left at tier 6');
    const clinical = classifySource({ url: 'https://clinicaltrials.gov/study/NCT12345', title: 'Clinical Trial', snippet: 'trial protocol NCT12345' });
    assert.equal(clinical.proximity, 'primary', 'clinical trial flagged as primary');
  });
  it('domainHint applies rules to grounding redirects (honest: unknown stays 6)', () => {
    const paper = classifySource({ url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc', title: 'arxiv.org/abs/123', domainHint: 'arxiv.org' });
    assert.equal(paper.tier, 2);
    const social = classifySource({ url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc', title: 'facebook.com/post', domainHint: 'facebook.com' });
    assert.equal(social.tier, 7);
    // unibo.it matches no fixed rule — conservative 6, never auto-promoted
    const uni = classifySource({ url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc', title: 'unibo.it/history', domainHint: 'unibo.it' });
    assert.equal(uni.tier, 6);
    const plain = classifySource({ url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc', title: 'unknown' });
    assert.equal(plain.tier, 6);
  });
});
