// ExaProvider: academic/publication lane (paid, optional, Deep+ only).
// Enabled only when EXA_API_KEY is set. Uses `category: publication` with
// highlights extraction — never `type: deep` (that delegates synthesis and
// breaks auditability). The orchestrator enables this lane only for
// deep/exhaustive modes. Never logs keys.
import { normalizeResult } from './base.js';

const ENDPOINT = 'https://api.exa.ai/search';

function key() {
  const penv = (typeof process !== 'undefined' && process.env) || {};
  return String(penv.EXA_API_KEY || '').trim();
}

export function isExaEnabled() { return !!key(); }

export async function searchExaPublications(query, { perPage = 8, timeoutMs = 25000 } = {}) {
  const k = key();
  if (!k) return [];
  const q = String(query || '').trim().slice(0, 400);
  if (!q) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': k },
      signal: ctrl.signal,
      body: JSON.stringify({
        query: q,
        category: 'publication',
        numResults: Math.max(1, Math.min(10, perPage)),
        type: 'auto',
        contents: { highlights: true, text: false },
      }),
    });
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({}));
    const items = Array.isArray(data.results) ? data.results : [];
    return items.map((it) => normalizeResult({
      url: it.url,
      title: it.title || it.url,
      snippet: (it.highlights || []).join(' ').slice(0, 700) || it.snippet || '',
      via: 'exa',
    }, 'exa'));
  } finally { clearTimeout(timer); }
}

export const exaProvider = {
  name: 'exa',
  search: searchExaPublications,
  isEnabled: isExaEnabled,
};
