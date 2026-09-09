import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, deduplicate, textSimilarity } from '../backend/src/engine/dedup.js';

describe('deduplication', () => {
  it('strips tracking params to one canonical', () => {
    const a = canonicalize('https://example.com/article?utm_source=x&fbclid=1');
    const b = canonicalize('https://example.com/article');
    assert.equal(a, b);
  });
  it('merges tracking variants, keeps relatedCopies', () => {
    const { unique, duplicates } = deduplicate([
      { url: 'https://example.com/a?utm_medium=1', title: 'A' },
      { url: 'https://example.com/a', title: 'A' },
    ]);
    assert.equal(unique.length, 1);
    assert.equal(duplicates.length, 1);
    assert.ok(unique[0].relatedCopies.length >= 1);
  });
  it('does not merge genuinely different articles', () => {
    const { unique } = deduplicate([
      { url: 'https://example.com/a', title: 'Collapse theory one' },
      { url: 'https://example.com/b', title: 'A totally different finding' },
    ]);
    assert.equal(unique.length, 2);
  });
  it('detects near-identical syndicated content', () => {
    const words = 'senate legion frontier danube marcus aurelius plague antonine garrison supply grain annona prefect consul tribute census cohort ala vexillation diploma veteran colony municipium forum basilica aqueduct road milestone customs tariff mine salt iron pottery amphora olive oil wine fish garum trade merchant shipwreck harbor ostia rome gaul britain hispania africa egypt syria asia greece macedonia thrace dacia pannonia noricum raetia germania lugdunum carthage alexandria antioch ephesus athens corinth byzantium nile tiber rhine danube euphrates alps apennines pyrenees atlas caucasus balkans aegean adriatic tyrrhenian mediterranean black caspian red persian'.split(' ');
    const text = words.join(' ');
    const { unique, duplicates } = deduplicate([
      { url: 'https://a.com/x', title: 'T1', text },
      { url: 'https://b.com/y', title: 'T2', text: text + ' syndicated byline' },
    ]);
    assert.equal(unique.length, 1);
    assert.equal(duplicates[0].reason, 'near-identical content');
  });
  it('textSimilarity is 1 for identical, ~0 for disjoint', () => {
    assert.equal(textSimilarity('alpha beta gamma delta', 'alpha beta gamma delta'), 1);
    assert.ok(textSimilarity('alpha beta gamma', 'zebra yacht xray womb') < 0.2);
  });
});
