import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { domainCount, diversityTopups } from '../backend/src/engine/queries.js';
import { splitEnrichment } from '../backend/src/engine/enrich.js';

describe('diversity helpers', () => {
  it('counts distinct domains, ignoring malformed URLs', () => {
    assert.equal(domainCount([
      { url: 'https://a.com/1' },
      { url: 'https://www.a.com/2' },
      { url: 'https://b.org/x' },
      { url: 'not a url' },
    ]), 2);
    assert.equal(domainCount([]), 0);
  });
  it('top-ups bias scholarly/primary/book angles without a model call', () => {
    const qs = diversityTopups('fall of rome', 3);
    assert.equal(qs.length, 3);
    assert.deepEqual(qs.map((q) => q.category).sort(), ['books', 'primary-evidence', 'scholarly']);
    assert.ok(qs.every((q) => q.q.includes('fall of rome')));
  });
});

describe('enrichment splitter', () => {
  it('maps numbered URL sections positionally', () => {
    const out = splitEnrichment('URL 1: charter text here\nURL 2: study text here', 2);
    assert.equal(out.length, 2);
    assert.ok(out[0].includes('charter') && out[1].includes('study'));
  });
  it('falls back to whole text for the first source', () => {
    assert.deepEqual(splitEnrichment('just some summary', 2), ['just some summary']);
    assert.deepEqual(splitEnrichment('', 2), []);
    assert.deepEqual(splitEnrichment('x', 0), []);
  });
});
