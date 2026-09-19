// Google Custom Search (Programmable Search) — quota-free complement to Gemini grounding.
// Uses GOOGLE_CSE_API_KEY + GOOGLE_CSE_CX (Custom Search Engine ID). Both must be
// configured; otherwise the provider is disabled (no throw, no quota burn).
// Never logs keys. Results are normalized to the engine's Source shape via base.js.
// Docs: https://developers.google.com/custom-search/v1/overview
import { normalizeResult } from './base.js';

const CSE_ENDPOINT = 'https://www.googleapis.com/customsearch/v1';

function getConfig() {
  const penv = (typeof process !== 'undefined' && process.env) || {};
  const key = String(penv.GOOGLE_CSE_API_KEY || penv.GOOGLE_CUSTOM_SEARCH_API_KEY || '').trim();
  const cx = String(penv.GOOGLE_CSE_CX || penv.GOOGLE_CSE_ID || '').trim();
  return { key, cx, enabled: !!(key && cx) };
}

export function isCseEnabled() {
  return getConfig().enabled;
}

/**
 * Search via Google Custom Search JSON API.
 * @param {string} query - search query
 * @param {{ perPage?: number }} opts - perPage 1-10 (API max 10)
 * @returns {Promise<Array>} normalized results (same shape as other providers)
 */
export async function searchGoogleCse(query, { perPage = 5 } = {}) {
  const { key, cx, enabled } = getConfig();
  if (!enabled) return [];
  const q = String(query || '').trim().slice(0, 400);
  if (!q) return [];
  const n = Math.max(1, Math.min(10, perPage));
  const url = `${CSE_ENDPOINT}?key=${encodeURIComponent(key)}&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(q)}&num=${n}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    // 429/403 are quota/billing — surface as soft failure, not throw (engine is resilient)
    if (res.status === 429 || res.status === 403) return [];
    // Other errors: throw to be caught by orchestrator's resilient handling
    const text = await res.text().catch(() => '');
    throw new Error(`CSE search failed (${res.status}): ${text.slice(0, 120)}`);
  }
  const data = await res.json().catch(() => ({}));
  const items = Array.isArray(data.items) ? data.items : [];
  return items.slice(0, n).map((it) => normalizeResult({
    url: it.link,
    title: it.title || it.htmlTitle || it.link,
    snippet: it.snippet || it.htmlSnippet || '',
    meta: { cse: true },
  }, 'google-cse'));
}

/** Provider shape consistent with other registry providers. */
export const googleCseProvider = {
  name: 'google-cse',
  search: searchGoogleCse,
  isEnabled: isCseEnabled,
};
