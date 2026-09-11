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
