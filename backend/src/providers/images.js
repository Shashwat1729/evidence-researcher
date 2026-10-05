// Figures for reports: real, freely-licensed photographs and diagrams pulled
// from Wikimedia, matched to each section of the finished report.
//
// Why Wikimedia and not a web image scraper: it is the only source that is
// simultaneously (a) quotable without a key, (b) honest about licensing, and
// (c) stable enough to cite. Wikipedia's own fair-use policy means `pageimages`
// only ever returns freely-licensed media, and every record we keep carries the
// author, licence and source page so the report can attribute it. Attributing
// properly is not decoration — it is the condition on which the image may be
// redistributed at all.
//
// Matching is intentionally conservative: a wrong photo under a heading is worse
// than no photo, so a candidate must match the section's subject closely or we
// return nothing. Every function is best-effort and never throws.

const API = 'https://en.wikipedia.org/w/api.php';
// Wikimedia's API policy asks for a descriptive User-Agent. Send one.
const UA = 'EvidenceResearcher/1.0 (https://github.com/Shashwat1729/evidence-researcher; research tool)';

/** Words that never identify a subject on their own — stripped before search. */
const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'in', 'on', 'at', 'to', 'for', 'by', 'with', 'from',
  'its', 'their', 'his', 'her', 'this', 'that', 'these', 'those', 'was', 'were', 'is', 'are', 'be', 'been',
  'as', 'into', 'over', 'under', 'about', 'during', 'after', 'before', 'between', 'through', 'what', 'why',
  'how', 'when', 'who', 'which', 'not', 'but', 'than', 'then', 'there', 'they', 'them', 'we', 'it', 'also',
  'more', 'most', 'some', 'such', 'only', 'other', 'others', 'part', 'role', 'use', 'used', 'evidence',
  'finding', 'findings', 'section', 'overview', 'summary', 'analysis', 'introduction', 'conclusion']);

/** Strip HTML from a Wikimedia metadata field (Artist is full of markup).
 *  Inline tags vanish (no invented word breaks); block tags become a space so
 *  separate paragraphs stay separate. */
export function stripHtml(s) {
  return String(s ?? '')
    .replace(/<\/(p|div|li|tr|td|dd|dt)>/gi, ' ')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Turn a section into a search query. The heading is the subject; the opening
 * clause of the body rescues headings that are too vague on their own
 * ("Sewage and drainage" → "Harappan civilization drainage").
 */
export function imageQueryFor(heading, body = '') {
  const clean = (s) => String(s || '')
    // Drop parentheticals and trailing clauses: "Mohenjo-daro (UNESCO site)" → "Mohenjo-daro"
    .replace(/\([^)]*\)/g, ' ')
    // The synthesis model sometimes emits structural junk into a heading —
    // a trailing `”, "` or a stray closing quote. Left in, these become search
    // terms that guarantee no match. Strip leading/trailing quote and bracket
    // debris before anything else looks at the words.
    .replace(/["“”'‘’)\]}]+/g, ' ')
    // Punctuation that cannot occur inside a name. Hyphens and apostrophes are
    // PRESERVED on purpose: stripping them turns "Mohenjo-daro" into
    // "Mohenjo daro", which no encyclopedia title will ever match.
    .replace(/[.:;!?—–,"“”]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w.toLowerCase().replace(/[^a-z]/g, '')))
    .slice(0, 8)
    .join(' ')
    .trim();
  let q = clean(heading);
  const firstSentence = String(body || '').split(/(?<=[.!?])\s/)[0] || '';
  const fromBody = clean(firstSentence);
  // A 1-2 word heading carries no subject; borrow from the body's opening.
  if (q.split(' ').filter(Boolean).length < 2 && fromBody) {
    q = [clean(heading), fromBody.split(' ').slice(0, 6).join(' ')].filter(Boolean).join(' ');
  }
  return q.replace(/\s+/g, ' ').trim().slice(0, 120);
}

/**
 * Generic descriptive words that carry no identifying information. Kept
 * separate from STOP (grammar) because these are the words that make an
 * encyclopedia article title match a report heading by coincidence:
 * "Grid plan citadel Mohenjo-daro" must not resolve to the article "Grid plan".
 * Anything here cannot, on its own, justify accepting a candidate.
 */
const GENERIC = new Set(['grid', 'plan', 'planning', 'layout', 'map', 'citadel', 'city', 'cities', 'urban',
  'rural', 'town', 'township', 'village', 'site', 'sites', 'system', 'systems', 'technology', 'culture',
  'civilization', 'civilisation', 'history', 'historical', 'period', 'era', 'age', 'phase', 'periods',
  'structure', 'structures', 'architecture', 'design', 'water', 'supply', 'management', 'technology',
  'development', 'construction', 'engineering', 'ancient', 'modern', 'region', 'area', 'valley', 'basin',
  'river', 'plain', 'trade', 'trade', 'economy', 'political', 'social', 'religion', 'language']);

/** Meaningful, identifying tokens of a search query. */
export function queryTokens(query) {
  const STOPW = new Set([...STOP, ...GENERIC]);
  return String(query || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPW.has(w));
}

/**
 * Match signals for a query against a candidate title.
 *
 * `specific` is the count of IDENTIFYING query tokens the title contains.
 * Acceptance requires either one specific hit or high overall coverage,
 * because pure string overlap cannot know that "Harappan" and "Indus Valley
 * Civilisation" are the same subject — and pure search rank cannot tell a
 * genuine synonym hit from a generic title like "Grid plan". Requiring both a
 * positional and a lexical signal is what keeps a Chinese city photo out of a
 * report about Mohenjo-daro.
 */
export function matchSignals(query, title) {
  const q = queryTokens(query);
  const t = String(title || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean);
  if (!q.length || !t.length) return { coverage: 0, specific: 0 };
  const tset = new Set(t);
  const hits = q.filter((w) => tset.has(w)).length;
  return { coverage: hits / q.length, specific: hits };
}

/** Token overlap between the query and a candidate page title. 0..1.
 *  Uses the SAME identifying-token filter as matchSignals, so a candidate can
 *  never be admitted by words that matchSignals would dismiss. Previously this
 *  scored on raw words and re-admitted "Grid plan" for a query about
 *  Mohenjo-daro, undoing the generic-word filter entirely. */
export function titleMatch(query, title) {
  const q = new Set(queryTokens(query));
  const t = String(title || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean);
  if (!q.size || !t.length) return 0;
  const tset = new Set(t);
  const hits = t.filter((w) => q.has(w)).length;
  const union = new Set([...q, ...t]).size || 1;
  const jaccard = hits / union;
  const coverage = hits / q.size;
  // Coverage dominates: a page containing every query term is the subject even
  // if the title carries extra disambiguators ("Harappan civilization").
  return coverage * 0.7 + jaccard * 0.3;
}

/** SVGs are near-always logos, maps or diagrams we cannot render well; skip. */
function usableThumb(page) {
  const src = String(page?.thumbnail?.source || '');
  if (!src) return '';
  if (/\.svg($|\?)/i.test(src)) return '';
  // Wikimedia serves scaled thumbs from thumb.wikimedia.org as well as
  // upload.wikimedia.org. Allowing only the latter silently dropped every
  // article whose lead image came back thumb-scaled.
  if (!/^https:\/\/(?:upload|thumb)\.wikimedia\.org\//i.test(src)) return '';
  return src;
}

/** Canonical comparison key for a Commons file name. MediaWiki treats
 *  "A_B.jpeg" and "A B.jpeg" as the same file and answers with the spaced form,
 *  so both sides of any join must be normalised the same way. */
export function fileKey(name) {
  return String(name || '').replace(/^File:\s*/i, '').replace(/_/g, ' ').trim().toLowerCase();
}

/**
 * Build a preliminary figure from a search hit. Author/licence are attached
 * later by enrichFiguresFromCommons(), because licence metadata lives on the
 * FILE (prop=imageinfo), not on the article (prop=pageimages) — so it costs one
 * extra batched request instead of one request per figure.
 */
export function toFigure(page, query) {
  const src = usableThumb(page);
  if (!src) return null;
  const title = String(page?.title || '').replace(/^File:/, '');
  return {
    // Commons file page is the canonical home of the licence — always cite it.
    sourcePage: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(String(page?.pageimage || title || ''))}`,
    articleUrl: String(page?.fullurl || `https://en.wikipedia.org/wiki/${encodeURIComponent(String(page?.title || '').replace(/ /g, '_'))}`),
    url: src,
    width: Number(page?.thumbnail?.width) || 0,
    height: Number(page?.thumbnail?.height) || 0,
    file: String(page?.pageimage || title || ''),
    // File name without the extension makes a far better caption than a hash.
    caption: title.replace(/\.(jpe?g|png|webp)$/i, '').replace(/_/g, ' ').slice(0, 160) || String(query || '').slice(0, 160),
    alt: title.replace(/_/g, ' ').slice(0, 300),
    author: '',
    license: '',
    licenseUrl: '',
    provider: 'Wikimedia Commons',
  };
}

const cache = new Map(); // query -> { at, page|null }
const TTL_MS = 24 * 3600_000;

/**
 * One lookup: search the wiki and pick the best candidate.
 *
 * Selection uses TWO signals, because either alone fails on real queries:
 *   • search rank — the wiki's own relevance order for this exact query, which
 *     is the only thing that knows "Harappan" and "Indus Valley Civilisation"
 *     are the same subject (string overlap scores that pair zero);
 *   • lexical match — guards against a top-ranked but unrelated article.
 *
 * A candidate is accepted only if its title overlaps at least one IDENTIFYING
 * query token, or covers most of the query. Rank alone was tried first and
 * shipped a photograph of Chang'an (a Chinese city) into a report about
 * Mohenjo-daro, because "Grid plan" is a real article and ranked first for
 * "Grid plan citadel Mohenjo-daro". A missing photo is far cheaper than a
 * wrong one, so acceptance is deliberately strict.
 *
 * Returns the article page (with `pageimage`), not a finished figure.
 */
export async function findFigurePage(query, { fetchFn = fetch, timeoutMs = 7000, minScore = 0.34, maxRank = 3, now = Date.now() } = {}) {
  const q = String(query || '').trim();
  if (!q) return null;
  // A one-word query matches that word ANYWHERE, so a short generic word finds
  // whatever Wikipedia happens to rank first ("major" -> "Major Arcana"). Only
  // search a single token when it is proper-noun shaped.
  const tokens = queryTokens(q);
  if (tokens.length < 2 && !(tokens.length === 1 && tokens[0].length >= 6)) return null;
  const hit = cache.get(q);
  if (hit && now - hit.at < TTL_MS) return hit.page;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  let page = null;
  try {
    const url = `${API}?action=query&format=json&formatversion=2&generator=search` +
      `&gsrsearch=${encodeURIComponent(q)}&gsrlimit=4&gsrnamespace=0` +
      `&prop=pageimages|info&piprop=thumbnail%7Cname&pithumbsize=1280&inprop=url&origin=*`;
    const res = await fetchFn(url, { headers: { 'Api-User-Agent': UA, Accept: 'application/json' }, signal: ctrl.signal });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    const pages = Array.isArray(data?.query?.pages) ? data.query.pages : [];
    // generator=search preserves relevance order via `index`.
    const ranked = [...pages].sort((a, b) => (a?.index ?? 99) - (b?.index ?? 99));
    for (const [rank, p] of ranked.slice(0, maxRank + 1).entries()) {
      if (!usableThumb(p)) continue;
      const { specific, coverage } = matchSignals(q, p?.title);
      const lexical = specific >= 1 || coverage >= 0.5 || titleMatch(q, p?.title) >= minScore;
      // Rank is a tiebreaker among ACCEPTED candidates, never a licence on its own.
      if (lexical && (!page || rank < (page.index ?? 99))) page = p;
    }
  } catch { /* offline, blocked, or malformed — a report without a photo is fine */ }
  finally { clearTimeout(t); }
  cache.set(q, { at: now, page });
  return page;
}

/**
 * Single-figure lookup that is SAFE TO RENDER.
 *
 * This previously returned a raw toFigure() record with no licence attached —
 * nothing called it except tests, but it was exported, and the next caller would
 * have shipped an image credited "Unknown / see source", which free-licensed
 * media does not permit. It now routes through enrichFiguresFromCommons, so
 * there is exactly one way to obtain a figure and that way attributes it. If the
 * licence cannot be resolved it returns null, exactly like the batch path.
 */
export async function findFigure(query, opts = {}) {
  const page = await findFigurePage(query, opts);
  if (!page) return null;
  const [attributed] = await enrichFiguresFromCommons([toFigure(page, query)], opts);
  return attributed || null;
}

/**
 * Attach author, licence, licence URL and file description to figures whose
 * underlying file is named. Chunked (a long title list is a slow, failure-prone
 * request) and best-effort per chunk, so one slow chunk cannot starve the rest.
 *
 * Licence metadata is only available via prop=imageinfo on the FILE. When
 * pageimages returns no file name the fallback was the ARTICLE title, the
 * lookup missed, and the report shipped "Unknown / see source" — unattributed.
 * So this now returns ONLY ATTRIBUTED figures and drops the rest: freely
 * licensed media may only be redistributed with author and licence visible, and
 * an unattributed figure is in practice a reliable signal that the match itself
 * was bogus.
 */
export async function enrichFiguresFromCommons(figures, { fetchFn = fetch, timeoutMs = 12000 } = {}) {
  const withFile = (figures || []).filter((f) => f?.file);
  if (!withFile.length) return [];
  const titles = [...new Set(withFile.map((f) => `File:${f.file}`))];
  const byName = new Map();
  const byNameFrom = (data) => {
    const pages = Array.isArray(data?.query?.pages) ? data.query.pages : [];
    for (const p of pages) {
      const info = p?.imageinfo?.[0];
      if (!info) continue;
      const meta = info.extmetadata || {};
      // MediaWiki NORMALISES titles: the API answers "File:A B.jpeg" for a
      // request of "File:A_B.jpeg". Keying the map on the raw request name made
      // every lookup miss, which shipped every image as "unknown author".
      // Both sides go through fileKey() so underscores never break the join.
      byName.set(fileKey(p.title), {
        author: stripHtml(meta.Artist?.value || '') || 'Wikimedia Commons contributor',
        license: stripHtml(meta.LicenseShortName?.value || '') || 'see source page',
        licenseUrl: /^https?:\/\//i.test(String(meta.LicenseUrl?.value || '')) ? String(meta.LicenseUrl.value).trim() : '',
        description: stripHtml(meta.ImageDescription?.value || ''),
        sourcePage: String(info.descriptionurl || '') || `https://commons.wikimedia.org/wiki/${encodeURIComponent(String(p.title || ''))}`,
      });
    }
  };
  const fetchMeta = async (titleList) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const url = `${API}?action=query&format=json&formatversion=2&prop=imageinfo` +
        `&iiprop=extmetadata%7Curl&titles=${encodeURIComponent(titleList.join('|'))}`;
      const res = await fetchFn(url, { headers: { 'Api-User-Agent': UA, Accept: 'application/json' }, signal: ctrl.signal });
      if (!res.ok) return false;
      byNameFrom(await res.json().catch(() => ({})));
      return true;
    } catch { return false; }
    finally { clearTimeout(t); }
  };
  // Small chunks, and a failed chunk is retried one title at a time. A single
  // unresolvable title (an SVG logo, a .gif) otherwise fails the whole request
  // and every figure in it was dropped — which is exactly how a run ended up
  // with zero attributed images.
  const CHUNK = 3;
  for (let i = 0; i < titles.length; i += CHUNK) {
    const chunk = titles.slice(i, i + CHUNK);
    if (await fetchMeta(chunk)) continue;
    for (const one of chunk) await fetchMeta([one]);
  }
  return (figures || [])
    .map((f) => {
      const m = byName.get(fileKey(f.file));
      if (!m) return null;
      return {
        ...f,
        author: m.author,
        license: m.license,
        licenseUrl: m.licenseUrl,
        alt: m.description || f.alt,
        sourcePage: m.sourcePage || f.sourcePage,
      };
    })
    .filter(Boolean);
}

/** Capitalised, non-sentence-initial words: the proper nouns in a passage.
 *  These are the only reliable search terms for a report section: headings are
 *  full of generic vocabulary ("Society, Economy, and Trade in the Harappan
 *  Civilization..."), while the body names the actual subject. */
export function properNouns(text) {
  const counts = new Map();
  // Not sentence-initial, so "The" and "Water" at the start are excluded.
  const re = /(?:^|[.!?;:]\s+|\s)([A-Z][a-zA-Z]{3,}(?:-[A-Z]?[a-z]+)*)/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const w = m[1];
    const lower = w.toLowerCase();
    if (GENERIC.has(lower) || STOP.has(lower)) continue;
    // Sentence-initial position yields the section's first word only.
    counts.set(w, (counts.get(w) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => (b[1] - a[1]) || (b[0].length - a[0].length)).map(([w]) => w);
}

/**
 * Queries to try, best first, built from PROPER NOUNS rather than from the
 * heading's generic vocabulary.
 *
 * Why this replaced the length heuristic: searching "legacy transitions" found
 * "Microsoft Edge Legacy", and "chronological phases transition" found
 * "Demographic transition" — long words, but not names. Meanwhile "Harappan"
 * and "Mohenjo-daro" were verified to return exactly the right articles. Word
 * length is a poor proxy for specificity; capitalisation in running prose is a
 * much better one.
 */
export function figureQueries(heading, body = '') {
  const out = [];
  const nouns = [...properNouns(body)];
  for (const n of properNouns(heading)) if (!nouns.includes(n)) nouns.push(n);
  if (nouns.length >= 2) out.push(nouns.slice(0, 2).join(' '));
  // Single-token searches only for proper-noun-shaped names (>= 6 chars), since
  // one word matches everywhere ("major" -> "Major Arcana").
  const first = nouns[0];
  if (first && first.length >= 6) out.push(first);
  if (nouns.length >= 3) out.push(nouns.slice(0, 3).join(' '));
  // Last resort: the cleaned heading, which at least carries the whole subject.
  const rich = imageQueryFor(heading, body);
  if (rich) out.push(rich);
  const fromBody = imageQueryFor(null, body);
  if (fromBody) out.push(fromBody);
  return [...new Set(out.filter(Boolean))].slice(0, 4);
}

/** Per-mode budget. Quick stays lean; deeper modes get several per section. */
export function figureBudget(mode) {
  if (mode === 'quick') return { perSection: 1, total: 4 };
  if (mode === 'standard') return { perSection: 2, total: 10 };
  if (mode === 'deep') return { perSection: 2, total: 14 };
  return { perSection: 3, total: 18 };
}
/** How many images a single section may carry. */
export function figuresPerSectionBudget(mode) {
  return { perSection: figureBudget(mode).perSection, total: figureBudget(mode).total };
}

/**
* Figures for a finished report. One search lookup per section heading (they are
 * the best available subject summaries), bounded by the mode budget, then ONE
 * batched licence lookup for the whole set.
 *
 * Returns records that already carry the section index, so the renderer can
 * drop each image inside the prose it illustrates. Never throws.
 */
export async function figuresForReport({ findings = [], plan = null, mode = 'standard', fetchFn, timeoutMs } = {}) {
  const { perSection, total } = figuresPerSectionBudget(mode);
  const list = Array.isArray(findings) ? findings.filter((f) => f && (f.heading || f.body)) : [];
  if (!list.length) return [];
  const used = new Set();
  const chosenFiles = new Set();
  const out = [];
  let index = 0;
  for (const f of list) {
    if (out.length >= total) break;
    // Proper-noun-led queries, best first.
    const queries = figureQueries(f.heading, f.body);
    for (const q of queries) {
      if (out.length >= total) break;
      const key = q.toLowerCase();
      if (used.has(key)) continue;
      used.add(key);
      // eslint-disable-next-line no-await-in-loop -- deliberate: bounded serial lookups keep latency predictable
      const page = await findFigurePage(q, { fetchFn, timeoutMs });
      if (!page) continue;
      const fig = toFigure(page, q);
      if (!fig) continue;
      // One photo once. Repeating the same image across neighbouring sections
      // reads as padding and devalues the whole report, so a file already used
      // is skipped and the next query gets the chance.
      const fk = fileKey(fig.file || fig.url);
      if (chosenFiles.has(fk)) continue;
      chosenFiles.add(fk);
      out.push({ ...fig, section: index, query: q });
      break;
    }
    index++;
  }
  if (!out.length) return [];
  // Second pass: author + licence for every chosen file, in one request.
  const enriched = await enrichFiguresFromCommons(out, { fetchFn, timeoutMs });
  return Array.isArray(enriched) ? enriched.slice(0, total) : out.slice(0, total);
}