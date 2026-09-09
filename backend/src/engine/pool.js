// Bounded-concurrency pool: runs `fn` over `items` with at most `limit`
// operations in flight. Results keep input order. Rejections propagate
// (fail-fast) so budget/deadline aborts still stop the whole run instead of
// being swallowed. Check-then-act budget guards must stay synchronous inside
// `fn` (no await between check and reserve) to remain race-free.

export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, worker));
  return out;
}
