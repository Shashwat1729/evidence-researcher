import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LruTtlCache, cached } from '../backend/src/cache.js';

describe('LruTtlCache', () => {
  it('stores and retrieves, evicts LRU when full', () => {
    const c = new LruTtlCache({ max: 2, ttlMs: 60_000 });
    c.set('a', 1); c.set('b', 2); c.set('c', 3);
    assert.equal(c.get('a'), undefined); // evicted
    assert.equal(c.get('b'), 2);
    assert.equal(c.get('c'), 3);
  });
  it('expires after TTL', async () => {
    const c = new LruTtlCache({ max: 10, ttlMs: 10 });
    c.set('x', 42);
    await new Promise(r => setTimeout(r, 15));
    assert.equal(c.get('x'), undefined);
  });
  it('cached helper memoizes async fn', async () => {
    const c = new LruTtlCache({ max: 10, ttlMs: 60_000 });
    let calls = 0;
    const fn = async () => { calls++; return 'v'; };
    assert.equal(await cached('k', fn, c), 'v');
    assert.equal(await cached('k', fn, c), 'v');
    assert.equal(calls, 1);
  });
});
