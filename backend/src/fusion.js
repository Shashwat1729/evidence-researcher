// Retrieval fusion: Reciprocal Rank Fusion (RRF) across lanes + MMR diversity.
// Pure functions — no network, no model calls. Multi-lane retrieval is the
// 2026 pattern (Gemini grounding + Tavily + academic): lanes rank differently,
// fusion recovers recall that any single lane loses. MMR then enforces
// per-domain diversity in ranking, mirroring the fetch-time domain caps.

/**
 * Reciprocal Rank Fusion over ranked lanes.
 * @param {Array<Array<{url:string}>>} lanes ranked lists (best first)
 * @param {number} k RRF constant (default 60, standard value)
 * @returns {string[]} canonical URLs ordered by fused score (best first)
 */
export function rrfFuse(lanes, k = 60) {
  const scores = new Map();
  for (const lane of lanes || []) {
    (lane || []).forEach((item, rank) => {
      const key = item?.canonicalUrl || item?.url;
      if (!key) return;
      scores.set(key, (scores.get(key) || 0) + 1 / (k + rank + 1));
    });
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([u]) => u);
}

/**
 * Maximal Marginal Relevance diversification by domain.
 * Selects up to `limit` items, preferring high fused score but capping
 * per-domain share so one domain cannot crowd out the rest.
 * @param {Array<object>} ranked items in fused-score order (with `domain`)
 * @param {number} limit max items to return
 * @param {number} maxPerDomain per-domain cap within the selection
 */
export function mmrDiversify(ranked, limit, maxPerDomain = 3) {
  const out = [];
  const perDomain = new Map();
  const deferred = [];
  for (const item of ranked || []) {
    const d = item?.domain || '';
    const n = perDomain.get(d) || 0;
    if (d && n >= maxPerDomain) { deferred.push(item); continue; }
    if (d) perDomain.set(d, n + 1);
    out.push(item);
    if (out.length >= limit) break;
  }
  // If caps starved the selection, fill remaining slots from deferred.
  if (out.length < limit) {
    for (const item of deferred) {
      out.push(item);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** Fuse lanes of {url, domain, ...} records into one diversified selection. */
export function fuseResults(lanes, limit = 60) {
  const byUrl = new Map();
  for (const lane of lanes || []) {
    for (const r of lane || []) {
      if (r?.url && !byUrl.has(r.url)) byUrl.set(r.url, r);
      else if (r?.url) {
        const prev = byUrl.get(r.url);
        // Earlier lanes are primary; keep first occurrence's fields.
        void prev;
      }
    }
  }
  const order = rrfFuse(lanes);
  const ranked = order.map((u) => byUrl.get(u)).filter(Boolean);
  return mmrDiversify(ranked, limit);
}
