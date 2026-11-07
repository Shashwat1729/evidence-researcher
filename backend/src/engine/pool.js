// Bounded-concurrency pool: runs `fn` over `items` with at most `limit`
// operations in flight. Results keep input order. Rejections propagate
// (fail-fast) so budget/deadline aborts still stop the whole run instead of
// being swallowed. Check-then-act budget guards must stay synchronous inside
// `fn` (no await between check and reserve) to remain race-free.

export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  let aborted = false;
  const worker = async () => {
    while (!aborted && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i], i);
      } catch (e) {
        // First rejection aborts the pool: siblings stop picking up new work
        // instead of continuing to burn quota/network after the run is dead.
        aborted = true;
        throw e;
      }
    }
  };
  // Sanitize: NaN/zero/negative/fractional limits degrade to serial (1),
  // never to silent data loss (length-0 worker set returns undefineds).
  const n = Number.isFinite(limit) ? Math.max(1, Math.min(Math.floor(limit), items.length)) : 1;
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}
