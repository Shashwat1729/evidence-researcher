// Provider abstraction: every search provider implements
//   { name, search(query, opts) -> [{url,title,snippet,via}] }
// so Tavily/Exa/SearXNG/Brave/MCP tools can be added later without
// touching the research engine. V1 ships Gemini grounding + free
// academic APIs only (GEMINI_API_KEY is the only credential).

export function normalizeResult(r, via) {
  return {
    url: r.url || '',
    title: r.title || '',
    snippet: r.snippet || '',
    via,
  };
}
