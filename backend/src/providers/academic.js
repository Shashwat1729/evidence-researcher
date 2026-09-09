// Free academic/book metadata providers (no keys required).
// OpenAlex (works), Crossref (metadata), arXiv (papers), Open Library + Google Books (books).
// These yield DISCOVERY records; full text is marked metadata-only unless fetched.

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
  const d = await getJson(`https://api.openalex.org/works?search=${encodeURIComponent(query)}&per-page=${perPage}`);
  return (d.results || []).map((w) => ({
    url: w.doi ? `https://doi.org/${w.doi.replace(/^https?:\/\/(dx\.)?doi\.org\//, '')}` : (w.primary_location?.landing_page_url || w.open_access?.oa_url || ''),
    title: w.title || w.display_name || '',
    snippet: `OpenAlex: ${(w.authorships || []).slice(0, 3).map((a) => a.author?.display_name).filter(Boolean).join(', ')} (${w.publication_year || 'n.d.'}), cited by ${w.cited_by_count ?? 0}. DOI: ${w.doi || 'none'}.`,
    via: 'academic:openalex',
    meta: { doi: w.doi || '', year: w.publication_year, openAccess: !!w.open_access?.is_oa, oaUrl: w.open_access?.oa_url || '' },
  })).filter((r) => r.url);
}

export async function searchCrossref(query, rows = 8) {
  const d = await getJson(`https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${rows}&select=title,author,published,DOI,URL,publisher`);
  return (d.message?.items || []).map((w) => ({
    url: w.URL || (w.DOI ? `https://doi.org/${w.DOI}` : ''),
    title: (w.title || []).join(' ') || '',
    snippet: `Crossref: ${(w.author || []).slice(0, 3).map((a) => `${a.given || ''} ${a.family || ''}`.trim()).join(', ')} (${w.published?.['date-parts']?.[0]?.[0] || 'n.d.'}), ${w.publisher || ''}. DOI: ${w.DOI || 'none'}.`,
    via: 'academic:crossref',
    meta: { doi: w.DOI || '' },
  })).filter((r) => r.url);
}

export async function searchArxiv(query, max = 6) {
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
}

export async function searchBooks(query, limit = 8) {
  const out = [];
  try {
    const d = await getJson(`https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=${limit}`);
    for (const b of d.docs || []) {
      out.push({
        url: b.key ? `https://openlibrary.org${b.key}` : '',
        title: b.title || '',
        snippet: `Open Library: ${(b.author_name || []).slice(0, 3).join(', ')} (${b.first_publish_year || 'n.d.'}), ${b.publisher?.slice(0, 3).join(', ') || ''}.`,
        via: 'books:openlibrary',
        meta: { authors: b.author_name || [], year: b.first_publish_year },
      });
    }
  } catch { /* book APIs are best-effort */ }
  try {
    const g = await getJson(`https://www.googleapis.com/books/v1/volumes?q=${encodeURIComponent(query)}&maxResults=${limit}`);
    for (const b of g.items || []) {
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
  try {
    const a = await searchArchiveOrg(query, Math.min(limit, 8));
    out.push(...a);
  } catch { /* best-effort */ }
  return out.filter((r) => r.url);
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
  const d = await getJson(`https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${limit}&fields=title,authors,year,url,openAccessPdf,externalIds,venue,citationCount`);
  return parseSemanticScholar(d);
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
  const s = await getJson(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmode=json&retmax=${max}`);
  const ids = (s?.esearchresult?.idlist || []).slice(0, max);
  if (!ids.length) return [];
  const d = await getJson(`https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${ids.join(',')}&retmode=json`);
  return parsePubMedSummary(d);
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
  const q = encodeURIComponent(`(${query}) AND mediatype:texts`);
  const d = await getJson(`https://archive.org/advancedsearch.php?q=${q}&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=date&rows=${limit}&output=json`);
  return parseArchiveOrg(d);
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
