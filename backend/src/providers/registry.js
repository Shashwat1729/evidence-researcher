// Provider registry — explicit, typed, zero-magic.
// Each search provider implements: { name, search(query, opts) -> [{url,title,snippet,via}] }
// Registry makes it trivial to add Tavily/Exa/SearXNG/Brave/MCP without
// touching the research engine. v2: Gemini grounding + free academic +
// optional Tavily (2nd lane) + optional Exa publications (Deep+ only).

import { geminiSearchProvider } from './geminiSearch.js';
import { searchAcademic, searchBooks } from './academic.js';
import { tavilyProvider, isTavilyEnabled } from './tavily.js';
import { exaProvider, isExaEnabled } from './exa.js';

export const searchProviders = {
  gemini: geminiSearchProvider,
  tavily: tavilyProvider,
  exa: exaProvider,
};

export const academicProviders = {
  openalex: { name: 'openalex', search: searchAcademic },
  books: { name: 'books', search: searchBooks },
};

/** Optional lanes that can be enabled by env keys (never throw when absent). */
export function availableLanes() {
  const lanes = ['gemini'];
  if (isTavilyEnabled()) lanes.push('tavily');
  if (isExaEnabled()) lanes.push('exa');
  return lanes;
}

/**
 * @param {string} name
 * @returns {import('./base.js').SearchProvider}
 */
export function getSearchProvider(name = 'gemini') {
  const p = searchProviders[name];
  if (!p) throw new Error(`Unknown search provider: ${name}`);
  return p;
}

export function listSearchProviders() {
  return Object.keys(searchProviders);
}
