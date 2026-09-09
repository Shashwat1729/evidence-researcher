// Tiny in-memory LRU + TTL cache — zero deps, for academic/book metadata.
// Not for research results (those are persisted). Keeps free-tier API quota
// and latency low for repeated questions.

export class LruTtlCache {
  constructor({ max = 200, ttlMs = 15 * 60 * 1000 } = {}) {
    this.max = max;
    this.ttlMs = ttlMs;
    this.map = new Map(); // key -> { value, expiresAt }
  }

  get(key) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (Date.now() > e.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    // LRU bump
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    else if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  clear() { this.map.clear(); }
  get size() { return this.map.size; }
}

export const academicCache = new LruTtlCache({ max: 300, ttlMs: 20 * 60 * 1000 });

export async function cached(key, fn, cache = academicCache) {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const val = await fn();
  cache.set(key, val);
  return val;
}
