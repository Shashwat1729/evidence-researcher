# Evidence Researcher

An **evidence-first deep research agent powered by Gemini**. Ask a question — from
*"When was X founded?"* to *"What caused the collapse of the Western Roman Empire?"* —
and get an auditable, citation-backed research report instead of a chatbot answer.

It searches the live web broadly, discovers books and scholarly literature, evaluates
source quality, extracts claims with claim-level confidence, hunts contradictory
evidence, checks whether "independent" sources actually copy one another, and tells
you what remains uncertain.

## Architecture

```
USER → RESEARCH ORCHESTRATOR → PLAN → SEARCH → COLLECT → CLAIMS →
EVALUATE → GAPS → CONTRADICTIONS → PROVENANCE → DECIDE → SYNTHESIZE → REPORT
```

**Gemini is the reasoning engine, not the whole system.** The engine (`backend/src/engine/`)
owns planning, budgets, classification, deduplication, provenance, and synthesis;
Gemini is called for planning, query generation, claim extraction, review, and
report writing — every structured call uses JSON schemas, and every source link is
integrity-checked against actually-retrieved sources.

| Layer | Implementation |
|---|---|
| Search | `GeminiSearchProvider` (Google Search grounding: `tools: [{google_search}]` → `groundingMetadata` chunks become Sources). Provider registry in `providers/registry.js` — Tavily/Exa/SearXNG/Brave/MCP can be added without touching the engine. |
| Academic/books | Free, keyless: OpenAlex, Crossref, arXiv, Semantic Scholar, PubMed, Open Library, Google Books, Internet Archive (metadata = discovery, never "read"; 20-min LRU cache). |
| Fetch | Dependency-free HTML extraction with timeouts, size caps, robots.txt respect, no paywall/auth/CAPTCHA bypass. |
| API | Express + SSE (`POST /api/research` streams progress; never streams chain-of-thought). Request validation, per-IP rate limiting, concurrency guard, singleflight dedup of identical concurrent runs, OpenAPI at `/api/openapi.json`. Serves the static frontend. |
| Frontend | Zero-build HTML/CSS/JS: ask form, live progress, 10-tab dashboard, SVG source graph, Markdown/HTML/JSON export, print/PDF, keyboard-navigable tabs, ARIA live regions. |
| Persistence | Atomic JSON file store (`DATA_DIR`); browser localStorage history. Swappable for a real DB. |
| Ops | Structured logs (`LOG_LEVEL`), `/api/health` with uptime/memory, CLI (`npm run research`), MCP tool stub, GitHub Actions CI. |

Key methodology rules enforced in code: search-result ≠ evidence, `.edu` ≠ auto-trust,
Wikipedia/Reddit = discovery value not evidentiary value, books distinguished as
discovered vs inspected vs page-verified, provenance `derived_from` links prevent
counting copies as confirmations, confidence is per-claim (qualitative), and a user
stance changes the research *objective*, never the truth conditions.

## Setup

Requirements: Node.js ≥ 20. Get a Gemini key at https://aistudio.google.com/apikey.

```bash
npm install
cp .env.example .env   # then set GEMINI_API_KEY=...
npm run dev            # http://localhost:8787
```

Private (BYOK) mode: with no server key, enter the key in the UI — it stays in
browser localStorage, is sent only to your backend per run, and is never persisted
or logged. Hosted mode: set `GEMINI_API_KEY` server-side; visitors optionally
override with their own key.

## Research modes & stance

Modes: **Quick** (~2 searches, ~1 min, template queries) · **Standard** (~10, cross-checking) ·
**Deep** (~24, books/academic/primary/provenance) · **Exhaustive** (~50,
documentary-grade). Every run has hard budgets (iterations, searches, sources,
fetches, model calls, runtime, output tokens) and stops early when evidence suffices; a simple
question whose sources disagree **escalates** automatically.

Stances: Neutral · Lean · Adversarial · Steelman · Comparative. The stance is
disclosed in the report, counter-evidence is always hunted, and evidence is never
manufactured to fit.

## Testing & evaluation

```bash
npm test        # 110+ tests: units + offline full-pipeline E2E (15/15 audit) + HTTP/SSE
                # + infra (registry, logger redaction, OpenAPI, rate limiter, singleflight, exports)
                # + perf latency budgets — no API key or network needed
npm run research -- "When was X founded?" --mode quick   # CLI, same engine as the server
node eval/run.js  # audit-score heuristic over eval/questions.json (needs GEMINI_API_KEY for live runs)
```

## Deployment

Stateless Node server + static assets: deploy to Vercel (see `docs/deployment.md`),
Cloudflare (via adapter), Fly.io, or any Node host. Set `GEMINI_API_KEY` as a
secret env var — never bake it into the frontend.

## Limitations

- Grounding chunks give URLs/titles, not full text; paywalled pages are recorded as inaccessible, never bypassed.
- Provenance uses textual overlap + model judgment — uncertain cases are labeled "could not be determined", never fabricated.
- Cost display is an estimate; billing follows Google's current pricing.
- No analytics, no tracking; external calls go only to Google Gemini, Google Search (via grounding), and the free academic/book APIs listed above.

## Attribution & licenses

Ideas adapted (not copied) from: `cavit99/deep-research-gemini` (MIT — breadth/depth
params, iterative query loop), `langchain-ai/open_deep_research` (MIT — scope→research→write,
supervisor/sub-agent parallelism, eval-bench thinking), `lorenzofavaro/deep-research`
and `iflytek/DeepResearch` (general pipeline ideas surveyed). No code was copied;
all implementation here is original under Apache-2.0. Runtime dependency:
`express` (MIT). See `docs/attribution.md`.
