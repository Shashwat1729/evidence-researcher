# Architecture

## Why this shape

The spec forbids `Question → Gemini → Answer`. Gemini's grounding (`google_search`
tool + `groundingMetadata`) is excellent at *retrieval*, but a single grounded call
returns an answer with citations — no planning, no contradiction hunting, no
provenance, no claim-level confidence. So the system is an **orchestrated pipeline**
where Gemini is called 6–100 times per run (budgets per mode) and code owns the
control flow.

## Alternatives rejected

- **LangGraph / LangChain agent**: powerful but a heavy dependency that hides the
  loop; our loop is ~200 lines of readable JS in `orchestrator.js`. MCP/search
  flexibility is preserved via the provider interface instead.
- **Firecrawl / Tavily / Exa as mandatory search**: violates the Gemini-only
  credential requirement; Gemini grounding + free academic APIs suffice for v1.
- **Next.js / SPA framework**: unnecessary for this UI; zero-build static files
  keep the project understandable and deployable anywhere.
- **Gemini SDK package**: direct REST (`fetch`) avoids version drift and works in
  serverless runtimes; the API surface used (generateContent + tools + responseSchema)
  is stable and documented.

## Data flow

`POST /api/research` (SSE) → `runResearch()`:
1. **Plan** (`planner.js`): domain + complexity + steps + lines of inquiry. Template fallback offline.
2. **Search**: model-generated diverse queries × categories → grounding chunks; plus OpenAlex/Crossref/arXiv/OpenLibrary/Google Books (keyless).
3. **Collect**: `dedup.js` (tracking-param canonicalization, near-identical merge → `relatedCopies`), `classify.js` (tiers 1–7 by evidence, not domain).
4. **Fetch** top candidates per tier with per-domain diversity caps.
5. **Iterate**: `claims.js` → `contradictions.js` (gaps, sufficiency) → gap/counter-evidence searches → adaptive escalation on disagreement.
6. **Provenance** (`provenance.js`): shared-quote heuristics + model verdicts → `derived_from` relations.
7. **Synthesize** (`synthesis.js`): full report JSON → citation-integrity filter → SSE `result`.

## Tradeoffs

- Grounding returns snippets/URLs, not full text: breadth is cheap, depth requires fetching (which some sites block — recorded honestly).
- Model-judged provenance/claims can err; heuristics bound the blast radius and "unknown" is always an allowed output.
- File-store persistence is single-node; the `store.js` interface is narrow for later DB swap.
