// Free academic/book metadata providers (no keys required).
// OpenAlex, Crossref, arXiv, Semantic Scholar, PubMed, Open Library + Google Books, Internet Archive.
// These yield DISCOVERY records; full text is marked metadata-only unless fetched.
import { cached } from '../cache.js';

async function getJson(url, { timeoutMs = 20_000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'evidence-researcher/1.0 (research tool)' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally { clearTimeout(t); }
}

export async function searchOpenAlex(query, perPage = 8) {
  return cached(`openalex:${query}:${perPage}`, async () => {
    const d = await getJson(`https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${perPage}`);
    return (d.results || []).map((w) => ({
      url: w.doi ? `https://doi.org/${w.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, '')}` : (w.primary_location?.landing_page_url || w.open_access?.oa_url || ''),
      title: w.title || w.display_name || '',
      snippet: `OpenAlex: ${(w.authorships || []).slice(0, 3).map((a) => a.author?.display_name).filter(Boolean).join(', ')} (${w.publication_year || 'n.d.'}), cited by ${w.cited_by_count ?? 0}. DOI: ${w.doi || 'none'}.`,
      via: 'academic:openalex',
      meta: { doi: w.doi || '', year: w.publication_year, openAccess: !!w.open_access?.is_oa, oaUrl: w.open_access?.oa_url || '' },
    })).filter((r) => r.url);
  });
}

export async function searchCrossref(query, rows = 8) {
  return cached(`crossref:${query}:${rows}`, async () => {
    const d = await getJson(`https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${rows}&select=title,author,published,DOI,URL,publisher`);
    return (d.message?.items || []).map((w) => ({
      url: w.URL || (w.DOI ? `https://doi.org/${w.DOI}` : ''),
      title: (w.title || []).join(' ') || '',
      snippet: `Crossref: ${(w.author || []).slice(0, 3).map((a) => `${a.given || ''} ${a.family || ''}`.trim()).join(', ')} (${w.published?.['date-parts']?.[0]?.[0] || 'n.d.'}), ${w.publisher || ''}. DOI: ${w.DOI || 'none'}.`,
      via: 'academic:crossref',
      meta: { doi: w.DOI || '' },
    })).filter((r) => r.url);
  });
}

export async function searchArxiv(query, max = 6) {
  return cached(`arxiv:${query}:${max}`, async () => {
    const q = encodeURIComponent(`all:${query}`);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20_000);
    try {
      const res = await fetch(`https://export.arxiv.org/api/query?search_query=${q}&start=0&max_results=${max}`, { signal: ctrl.signal });
      const xml = await res.text();
      const out = [];
      for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
        const e = m[1];
        const id = (e.match(/<id>(.*?)<\/id>/) || [])[1] || '';
        const title = ((e.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '').replace(/\s+/g, ' ').trim();
        const summary = ((e.match(/<summary>([\s\S]*?)<\/summary>/) || [])[1] || '').replace(/\s+/g, ' ').trim().slice(0, 400);
        if (id) out.push({ url: id.trim(), title, snippet: `arXiv: ${summary}`, via: 'academic:arxiv', meta: {} });
      }
      return out;
    } finally { clearTimeout(t); }
  });
}

// Generate dynamic variant queries for any topic — truly dynamic, no hardcoding.
// Shared wrapper: expand once per run, then reuse across all book queries
// (one model call total instead of one per query).
async function generateBookVariants(question, { key, model } = {}) {
  const expanded = await expandBookQueries(question, { key, model });
  return expanded.variants;
}

// Expand a topic into book-search variants. Returns { variants, llm } where
// llm reports whether the LLM path succeeded. LLM handles ANY topic's
// synonyms dynamically (Harappan→Indus Valley); heuristic needs zero calls.
export async function expandBookQueries(topic, { key, model } = {}) {
  const q = String(topic || '').trim().slice(0, 120);
  if (key && model) {
    try {
      const { generateJson } = await import('../gemini.js');
      const result = await generateJson({
        key, model,
        prompt: `Given the research question: "${q}", generate 2-3 alternative search queries for finding BOOKS and scholarly monographs. Include synonyms, broader terms, and related concepts. For example, if question is about "Harappan civilization", alternatives might include "Indus Valley civilization books", "Mohenjo-daro Harappa archaeology". Return JSON: {"variants": ["query1", "query2", "query3"]}`,
        system: 'You are a research librarian helping expand book search queries. Be concise and include alternative phrasings.',
        schema: { type: 'object', properties: { variants: { type: 'array', items: { type: 'string' } } }, required: ['variants'] },
        temperature: 0.7, maxTokens: 300,
        timeoutMs: 8000
      });
      if (result.data?.variants?.length > 0) {
        const llmVariants = result.data.variants.map(v => String(v).trim()).filter(Boolean).slice(0, 3);
        if (llmVariants.length > 0) {
          return { variants: [q, ...llmVariants].slice(0, 4), llm: true };
        }
      }
    } catch { /* fallback to heuristic */ }
  }
  return { variants: heuristicBookVariants(q || topic), llm: false };
}

// Heuristic variant broadening: zero model calls, works for any topic.
export function heuristicBookVariants(question) {
  const q = String(question || '').trim().slice(0, 120);
  const lower = q.toLowerCase();
  const stopwords = new Set(['tell', 'about', 'what', 'is', 'are', 'was', 'were', 'the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'how', 'when', 'where', 'why', 'who', 'which', 'explain', 'describe', 'discuss']);
  const words = lower.replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !stopwords.has(w));
  const keyTerms = words.slice(0, 4).join(' ');
  const variants = new Set([q].filter(Boolean));
  if (keyTerms && keyTerms !== q.toLowerCase() && keyTerms.length > 3) variants.add(keyTerms);
  if (words.length > 2) variants.add(words.slice(0, 3).join(' '));
  if (words.length > 1) variants.add(words.slice(0, 2).join(' '));
  // Add book suffix variants
  const base = [...variants];
  for (const v of base) {
    if (!v.includes('book') && v.length > 5) variants.add(v + ' book');
  }
  return [...variants].slice(0, 4);
}

/** Dynamic relevance score 0..1: key-term overlap with title (×2) + snippet/authors.
 *  Fully query-driven — no topic lists. Zero-overlap records rank last so a
 *  conversational query ("tell about X") doesn't surface unrelated books. */
const REL_STOPWORDS = new Set(['tell', 'about', 'what', 'is', 'are', 'was', 'were', 'the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'how', 'when', 'where', 'why', 'who', 'which', 'explain', 'describe', 'discuss', 'me', 'please', 'give', 'find', 'books', 'book']);
export function queryTerms(query) {
  return [...new Set(
    String(query || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      .filter((w) => w.length > 2 && !REL_STOPWORDS.has(w)),
  )];
}
export function bookRelevance(query, r) {
  const terms = queryTerms(query);
  if (!terms.length) return 0.5; // nothing to match against — keep provider order
  const title = `${r.title || ''}`.toLowerCase();
  const rest = `${r.snippet || ''} ${(r.meta?.authors || []).join(' ')}`.toLowerCase();
  let hit = 0;
  for (const t of terms) {
    if (title.includes(t)) hit += 2;
    else if (rest.includes(t)) hit += 1;
  }
  return hit / (terms.length * 2);
}
/** Sort by relevance; drop zero-overlap records unless that would empty the list. */
export function rankByRelevance(query, records) {
  const scored = records.map((r, i) => ({ r, i, s: bookRelevance(query, r) }));
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  const filtered = scored.filter((x) => x.s > 0);
  return (filtered.length ? filtered : scored).map((x) => x.r);
}

export async function searchBooks(query, limit = 8, opts = {}) {
  // Shared variants skip per-call expansion (one LLM call per run, not per query).
  const variants = (opts.variants && opts.variants.length)
    ? opts.variants.slice(0, 4)
    : await generateBookVariants(query, opts);
  const cacheKey = `books:${variants.join('|')}:${limit}`;
  return cached(cacheKey, async () => {
    const allQueries = variants;
    // Search all variants in parallel across providers, then deduplicate
    const results = await Promise.allSettled(
      allQueries.map(async (q) => {
        const out = [];
        try {
          const d = await getJson(`https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=${Math.ceil(limit/2)}`);
          for (const b of (d.docs || []).slice(0, Math.ceil(limit/2))) {
            out.push({
              url: b.key ? `https://openlibrary.org${b.key}` : '',
              title: b.title || '',
              snippet: `Open Library: ${(b.author_name || []).slice(0, 3).join(', ')} (${b.first_publish_year || 'n.d.'}), ${b.publisher?.slice(0, 3).join(', ') || ''}.`,
              via: 'books:openlibrary',
              meta: { authors: b.author_name || [], year: b.first_publish_year },
            });
          }
        } catch { /* best-effort */ }
        try {
          const g = await getJson(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(q)}&maxResults=${Math.ceil(limit/2)}`);
          for (const b of (g.items || []).slice(0, Math.ceil(limit/2))) {
            const v = b.volumeInfo || {};
            out.push({
              url: v.infoLink || v.previewLink || '',
              title: v.title || '',
              snippet: `Google Books: ${(v.authors || []).slice(0, 3).join(', ')} (${v.publisher || ''} ${v.publishedDate || ''}). ${v.description ? v.description.slice(0, 300) : 'Metadata only — text not inspected.'}`,
              via: 'books:googlebooks',
              meta: { authors: v.authors || [], year: v.publishedDate || '' },
            });
          }
        } catch { /* best-effort */ }
        return out;
      })
    );
    const out = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
    try {
      const a = await searchArchiveOrg(query, Math.min(limit, 8));
      out.push(...a);
    } catch { /* best-effort */ }
    // Deduplicate by URL and title, then rank by relevance to the ORIGINAL
    // question (variant queries widen recall; ranking restores precision).
    const seen = new Set();
    const deduped = [];
    for (const r of out) {
      if (!r.url || seen.has(r.url)) continue;
      const titleKey = r.title.toLowerCase().trim();
      if (deduped.some(d => d.title.toLowerCase().trim() === titleKey && titleKey.length > 5)) continue;
      seen.add(r.url);
      deduped.push(r);
    }
    return rankByRelevance(query, deduped).slice(0, limit * 2);
  });
}

/** Pure parser (fixture-testable): Semantic Scholar search payload → results. */
export function parseSemanticScholar(d) {
  return ((d && d.data) || []).map((p) => {
    const doi = p.externalIds?.DOI;
    return {
      url: p.openAccessPdf?.url || (doi ? `https://doi.org/${doi}` : (p.paperId ? `https://www.semanticscholar.org/paper/${p.paperId}` : '')),
      title: p.title || '',
      snippet: `Semantic Scholar: ${(p.authors || []).slice(0, 3).map((a) => a.name).join(', ')} (${p.year || 'n.d.'}), ${p.venue || ''}, cited by ${p.citationCount ?? 0}.`,
      via: 'academic:semanticscholar',
      meta: { doi: doi || '', year: p.year, openAccess: !!p.openAccessPdf?.url },
    };
  }).filter((r) => r.url);
}

export async function searchSemanticScholar(query, limit = 8) {
  return cached(`semanticscholar:${query}:${limit}`, async () => {
    const d = await getJson(`https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${limit}&fields=title,authors,year,url,openAccessPdf,externalIds,venue,citationCount`);
    return parseSemanticScholar(d);
  });
}

/** Pure parser (fixture-testable): PubMed esummary payload → results. */
export function parsePubMedSummary(d) {
  const uids = (d?.result?.uids || []);
  return uids.map((id) => {
    const r = d.result[id] || {};
    return {
      url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      title: r.title || '',
      snippet: `PubMed: ${(r.authors || []).slice(0, 3).map((a) => a.name).join(', ')} (${r.pubdate || 'n.d.'}), ${r.source || ''}.`,
      via: 'academic:pubmed',
      meta: {},
    };
  }).filter((r) => r.title);
}

export async function searchPubMed(query, max = 8) {
  return cached(`pubmed:${query}:${max}`, async () => {
    const s = await getJson(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmode=json&retmax=${max}`);
    const ids = (s?.esearchresult?.idlist || []).slice(0, max);
    if (!ids.length) return [];
    const d = await getJson(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${ids.join(',')}&retmode=json`);
    return parsePubMedSummary(d);
  });
}

/** Pure parser (fixture-testable): Internet Archive search payload → results. */
export function parseArchiveOrg(d) {
  return ((d?.response?.docs) || [])
    .filter((b) => b && b.identifier && b.title)
    .map((b) => ({
      url: `https://archive.org/details/${b.identifier}`,
      title: b.title || '',
      snippet: `Internet Archive: ${Array.isArray(b.creator) ? b.creator.slice(0, 3).join(', ') : (b.creator || '')} (${b.date || 'n.d.'}). Digitized text — verify edition before citing.`,
      via: 'books:archive.org',
      meta: { authors: Array.isArray(b.creator) ? b.creator : [b.creator].filter(Boolean), year: b.date || '' },
    }));
}

export async function searchArchiveOrg(query, limit = 8) {
  return cached(`archive:${query}:${limit}`, async () => {
    const q = encodeURIComponent(`(${query}) AND mediatype:texts`);
    const d = await getJson(`https://archive.org/advancedsearch.php?q=${q}&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=date&rows=${limit}&output=json`);
    return parseArchiveOrg(d);
  });
}

/** Run all academic providers best-effort in parallel; failures never throw. */
export async function searchAcademic(query, { perSource = 5 } = {}) {
  const settled = await Promise.allSettled([
    searchOpenAlex(query, perSource),
    searchCrossref(query, perSource),
    searchArxiv(query, Math.min(perSource, 6)),
    searchSemanticScholar(query, perSource),
    searchPubMed(query, Math.min(perSource, 6)),
  ]);
  return settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));
}
