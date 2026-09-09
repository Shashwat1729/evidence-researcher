import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../backend/src/engine/pool.js';

describe('bounded-concurrency pool', () => {
  it('preserves input order under concurrency', async () => {
    const out = await pool([1, 2, 3, 4, 5], 3, async (x) => {
      await new Promise((r) => setTimeout(r, (6 - x) * 5));
      return x * 2;
    });
    assert.deepEqual(out, [2, 4, 6, 8, 10]);
  });
  it('never exceeds the limit in flight', async () => {
    let inFlight = 0, max = 0;
    await pool([1, 2, 3, 4, 5, 6], 2, async (x) => {
      inFlight++; max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return x;
    });
    assert.ok(max <= 2, `max in flight was ${max}`);
  });
  it('propagates failures fail-fast (budget aborts stop the run)', async () => {
    await assert.rejects(
      pool([1, 2, 3], 3, async (x) => { if (x === 2) throw new Error('BUDGET'); return x; }),
      /BUDGET/,
    );
  });
});
