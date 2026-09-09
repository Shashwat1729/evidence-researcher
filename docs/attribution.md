# Attribution

Surveyed before implementation (per spec §1); **no code copied** — all code in
this repo is original (Apache-2.0).

- **cavit99/deep-research-gemini** (MIT): `<500 LoC` philosophy, breadth/depth
  params, iterative generate-queries → search → synthesize loop. *Weakness adopted
  as requirement:* it mandates Firecrawl (paid key); we use Gemini grounding only.
- **langchain-ai/open_deep_research** (MIT): scope → research → write phases,
  supervisor/sub-agent parallelism, model-role separation (planner/research/
  analysis/synthesis), Deep Research Bench eval thinking. *Weakness avoided:*
  LangGraph + Tavily weight; we implement the loop directly with a provider interface.
- **lorenzofavaro/deep-research**, **iflytek/DeepResearch**: pipeline-shape ideas
  (plan → multi-query search → compress → report) surveyed at README level.
- **Google Gemini docs** (ai.google.dev): `google_search` grounding +
  `groundingMetadata` (queries/chunks/supports), `url_context` tool, structured
  output (`responseMimeType` + `responseSchema`), interaction vs generateContent APIs.

## Runtime dependencies

- `express` — MIT License.
- Node.js built-ins only otherwise (`fetch`, `node:test`). No SDK, no framework.
