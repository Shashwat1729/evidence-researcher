// GeminiSearchProvider: live-web search via Gemini Google Search grounding.
// One grounded generateContent call returns webSearchQueries + groundingChunks
// (uri/title) which the engine converts into Source records.
import { groundedSearch } from '../gemini.js';
import { normalizeResult } from './base.js';

function snippetForChunk(text, supports, idx) {
  if (!text || !supports?.length) return text ? text.slice(0, 700) : '';
  const segs = supports
    .filter((s) => (s.groundingChunkIndices || []).includes(idx))
    .map((s) => text.slice(s.segment?.startIndex || 0, s.segment?.endIndex || text.length))
    .join(' ')
    .trim();
  return (segs || text).slice(0, 700);
}

export const geminiSearchProvider = {
  name: 'gemini-grounding',
  // Single implementation: grounded call → normalized results. onUsage receives
  // real API token counts; onKeyEvent announces key rotation (never values).
  async search(query, { key, model, timeoutMs, onUsage, onKeyEvent } = {}) {
    const r = await groundedSearch({ key, model, query, timeoutMs, onKeyEvent });
    onUsage?.(r.usage);
    return r.chunks
      .filter((c) => c.url && c.url.startsWith('http'))
      .map((c, i) => normalizeResult({ url: c.url, title: c.title, snippet: snippetForChunk(r.text, r.supports, i) }, 'grounding'));
  },
  /** Raw grounded call (exposes queries + synthesized text for gap detection). */
  async searchRaw(query, opts = {}) {
    return groundedSearch({ query, ...opts });
  },
};

// Example future provider (NOT enabled in v1 — no key required):
// export const tavilyProvider = { name: 'tavily',
//   async search(q) { /* POST https://api.tavily.com/search with TAVILY_API_KEY */ } };
