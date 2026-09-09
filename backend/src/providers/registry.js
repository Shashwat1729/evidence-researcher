// Provider registry — explicit, typed, zero-magic.
// Each search provider implements: { name, search(query, opts) -> [{url,title,snippet,via}] }
// Registry makes it trivial to add Tavily/Exa/SearXNG/Brave/MCP without
// touching the research engine. V1 uses only Gemini grounding + free academic.

import { geminiSearchProvider } from './geminiSearch.js';
import { searchAcademic, searchBooks } from './academic.js';

export const searchProviders = {
  gemini: geminiSearchProvider,
};

export const academicProviders = {
  openalex: { name: 'openalex', search: searchAcademic },
  books: { name: 'books', search: searchBooks },
};

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
