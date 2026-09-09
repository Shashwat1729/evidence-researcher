// Deduplication: canonical URLs + near-identical content.
// Tracking params stripped; syndicated copies linked as relatedCopies,
// never merged into false "independent confirmations".

const TRACKING = new Set(['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'fbclid', 'gclid', 'ref', 'spm', 'mc_cid', 'mc_eid']);

export function canonicalize(url) {
  try {
    const u = new URL(String(url || '').trim());
    u.hash = '';
    for (const k of [...u.searchParams.keys()]) {
      if (TRACKING.has(k.toLowerCase())) u.searchParams.delete(k);
    }
    let host = u.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
    let path = u.pathname.replace(/\/+$/, '') || '/';
    // amp / output=1 mobile variants
    path = path.replace(/\/amp\/?$/i, '');
    if (u.searchParams.get('output') === '1') u.searchParams.delete('output');
    u.hostname = host; u.pathname = path;
    return u.toString();
  } catch { return String(url || '').trim(); }
}

function fingerprint(text) {
  const words = String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2);
  return new Set(words);
}

/** Jaccard similarity of word sets. */
export function textSimilarity(a, b) {
  const A = fingerprint(a), B = fingerprint(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Deduplicate source-like records {url, title, text?}. Returns {unique, duplicates}. */
export function deduplicate(records) {
  const seen = new Map(); // canonical -> record
  const unique = [];
  const duplicates = [];
  for (const r of records) {
    const c = canonicalize(r.url);
    if (seen.has(c)) {
      const orig = seen.get(c);
      orig.relatedCopies = [...(orig.relatedCopies || []), r.url];
      duplicates.push({ url: r.url, canonicalOf: c });
      continue;
    }
    // near-identical content check against accepted items (title + text when available)
    let merged = false;
    for (const u of unique) {
      const simTitle = r.title && u.title && r.title.toLowerCase() === u.title.toLowerCase();
      const simText = r.text && u.text && r.text.length > 500 && u.text.length > 500 && textSimilarity(r.text, u.text) > 0.85;
      if (simTitle || simText) {
        u.relatedCopies = [...(u.relatedCopies || []), r.url];
        duplicates.push({ url: r.url, canonicalOf: u.url, reason: simText ? 'near-identical content' : 'identical title' });
        merged = true;
        break;
      }
    }
    if (!merged) {
      r.canonicalUrl = c;
      seen.set(c, r);
      unique.push(r);
    }
  }
  return { unique, duplicates };
}
