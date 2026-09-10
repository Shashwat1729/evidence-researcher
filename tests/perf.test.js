import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deduplicate } from '../backend/src/engine/dedup.js';
import { pool } from '../backend/src/engine/pool.js';

// Latency budget tests: the pipeline parallelizes search/fetch, so these
// primitives must overlap work and handle deep-mode volumes quickly.
describe('latency budgets', () => {
  it('deduplicates 400 sources fast enough for exhaustive mode', () => {
    const recs = [];
    for (let i = 0; i < 400; i++) {
      recs.push({ url: `https://site${i % 60}.example/article/${i}?utm_source=x`, title: `Article number ${i} about history`, text: `background text for article ${i} `.repeat(20) });
    }
    const t0 = Date.now();
    const { unique } = deduplicate(recs);
    const ms = Date.now() - t0;
    assert.ok(unique.length > 300, 'genuinely different articles must not merge');
    assert.ok(ms < 2000, `dedup took ${ms}ms, budget 2000ms`);
  });

  it('pool overlaps IO-bound work (parallel, not serial)', async () => {
    const t0 = Date.now();
    const out = await pool([1, 2, 3, 4, 5, 6, 7, 8], 4, async (x) => {
      await new Promise((r) => setTimeout(r, 50));
      return x;
    });
    const ms = Date.now() - t0;
    assert.deepEqual(out, [1, 2, 3, 4, 5, 6, 7, 8]);
    assert.ok(ms < 300, `8x50ms tasks took ${ms}ms, must overlap under limit 4`);
  });
});
