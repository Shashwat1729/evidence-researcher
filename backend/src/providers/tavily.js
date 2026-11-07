// TavilyProvider: second search lane (paid, optional).
// Enabled only when TAVILY_API_KEY is set; disabled otherwise (no throw).
// `basic` depth, chunks are LLM-ready. Fused with Gemini grounding via RRF
// (see fusion.js) — two lanes recover recall either one loses alone.
// Never logs keys; key travels in Authorization header.
import { normalizeResult } from './base.js';

const ENDPOINT = 'https://api.tavily.com/search';

function key() {
  const penv = (typeof process !== 'undefined' && process.env) || {};
  return String(penv.TAVILY_API_KEY || '').trim();
}

export function isTavilyEnabled() { return !!key(); }

export async function searchTavily(query, { perPage = 10, timeoutMs = 20000 } = {}) {
  const k = key();
  if (!k) return [];
  const q = String(query || '').trim().slice(0, 400);
  if (!q) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${k}` },
      signal: ctrl.signal,
      body: JSON.stringify({
        query: q,
        search_depth: 'basic',
        max_results: Math.max(1, Math.min(10, perPage)),
        chunks_per_source: 3,
        include_answer: false,
      }),
    });
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({}));
    const items = Array.isArray(data.results) ? data.results : [];
    return items.map((it) => normalizeResult({
      url: it.url,
      title: it.title || it.url,
      snippet: it.content || it.snippet || '',
      via: 'tavily',
    }, 'tavily'));
  } finally { clearTimeout(timer); }
}

export const tavilyProvider = {
  name: 'tavily',
  search: searchTavily,
  isEnabled: isTavilyEnabled,
};
