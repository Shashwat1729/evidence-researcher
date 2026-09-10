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

/** Jaccard similarity of precomputed word sets (memoize per document for O(n²) passes). */
export function jaccardSets(A, B) {
  if (!A?.size || !B?.size) return 0;
  let inter = 0;
  const [small, big] = A.size <= B.size ? [A, B] : [B, A];
  for (const w of small) if (big.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Exported for memoized similarity passes (see provenance.heuristicGroups). */
export { fingerprint };

/** Jaccard similarity of word sets. */
export function textSimilarity(a, b) {
  return jaccardSets(fingerprint(a), fingerprint(b));
}

// Generic one-word titles ("Home", "News") must never merge distinct articles.
const GENERIC_TITLES = new Set(['home', 'index', 'untitled', 'untitled document', 'overview', 'news', 'blog', 'search', 'login', 'page not found', '404']);
function isGenericTitle(t) {
  const n = String(t || '').trim().toLowerCase();
  return n.length < 12 || GENERIC_TITLES.has(n);
}

/** Deduplicate source-like records {url, title, text?}. Returns {unique, duplicates}. */
export function deduplicate(records) {
  const seen = new Map(); // canonical -> record
  const unique = [];
  const duplicates = [];
  // Fingerprints computed once per record (not per pair) for the O(n²) content pass.
  const fps = new Map();
  const fpOf = (r) => {
    if (!fps.has(r)) fps.set(r, fingerprint(r.text || ''));
    return fps.get(r);
  };
  const hostOf = (u) => {
    try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
  };
  for (const r of records) {
    // URL-less records carry no identity — never merge them into anything.
    if (!r.url || !String(r.url).trim()) { unique.push(r); continue; }
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
      if (!u.url) continue;
      const sameTitle = r.title && u.title && r.title.toLowerCase() === u.title.toLowerCase();
      // Long distinctive titles merge across domains (syndication). Short or
      // generic titles ("Home", "Second") merge only with same-host or
      // text-similar backups — never on the bare string across domains.
      const simTextLong = r.text && u.text && r.text.length > 500 && u.text.length > 500 && jaccardSets(fpOf(r), fpOf(u)) > 0.85;
      const simTextShort = !simTextLong && r.text && u.text && r.text.length > 100 && u.text.length > 100 && jaccardSets(fpOf(r), fpOf(u)) > 0.7;
      const simTitle = sameTitle && (!isGenericTitle(r.title) || hostOf(r.url) === hostOf(u.url) || simTextShort);
      if (simTitle || simTextLong) {
        u.relatedCopies = [...(u.relatedCopies || []), r.url];
        duplicates.push({ url: r.url, canonicalOf: u.url, reason: simTextLong ? 'near-identical content' : 'identical title' });
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
