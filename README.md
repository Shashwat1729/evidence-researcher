# Evidence Researcher

[![CI](https://github.com/Shashwat1729/evidence-researcher/actions/workflows/ci.yml/badge.svg)](https://github.com/Shashwat1729/evidence-researcher/actions/workflows/ci.yml)
[![Pages](https://github.com/Shashwat1729/evidence-researcher/actions/workflows/pages.yml/badge.svg)](https://github.com/Shashwat1729/evidence-researcher/actions/workflows/pages.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

**An evidence-first deep research agent powered by Gemini.** Ask anything from
*"When was X founded?"* to *"What caused the collapse of the Western Roman Empire?"*
and get an auditable, citation-backed research report — not a chatbot answer.

It searches the live web broadly, discovers books and scholarship, evaluates source
quality, extracts claims with claim-level confidence, hunts contradictory evidence,
checks whether "independent" sources actually copy one another, and tells you what
remains uncertain — with every conclusion traceable to its sources.

## Live demo (no install)

**Try it now: https://shashwat1729.github.io/evidence-researcher/frontend/** —
the page detects the static host and runs the **full pipeline in your browser**
with your own Gemini key — grounding search, academic discovery, claims,
provenance, cited report, exports. No server, no signup; page fetches may be
limited by site CORS policies (recorded honestly, never bypassed).

## Quickstart (local, 2 minutes)

Requirements: Node.js ≥ 20. Get a free Gemini key at https://aistudio.google.com/apikey.

```bash
npm install
cp .env.example .env   # then set GEMINI_API_KEY=... (fallback key optional)
npm run keys           # validate keys without burning quota (read-only call)
npm run dev            # http://localhost:8787
```

Or one command, no server:

```bash
npm run research -- "When was the University of Bologna founded?" --mode quick
```

Or with Docker:

```bash
docker build -t evidence-researcher .
docker run -p 8787:8787 -e GEMINI_API_KEY=... -v er-data:/data evidence-researcher
```

## How it works

```
USER → ORCHESTRATOR → PLAN → SEARCH → COLLECT → CLAIMS → GAPS →
CONTRADICTIONS → PROVENANCE → DECIDE → SYNTHESIZE → REPORT
```

**Gemini is the reasoning engine, not the system.** The orchestrator owns planning,
budgets, classification, dedup, provenance, and synthesis; Gemini is called for
planning, queries, claims, review, and report writing — every structured call uses
JSON schemas, and every cited id is integrity-checked against retrieved sources.

| Layer | Implementation |
|---|---|
| Search | Gemini grounding (`google_search` → `groundingMetadata` chunks become Sources). Registry in `providers/registry.js` — Tavily/Exa/SearXNG/Brave/MCP addable without touching the engine. |
| Academic/books | Free, keyless: OpenAlex, Crossref, arXiv, Semantic Scholar, PubMed, Open Library, Google Books, Internet Archive (metadata = discovery, never "read"; 20-min LRU cache). |
| Fetch | Dependency-free HTML extraction: charset-aware decoding, robots.txt respect, timeouts, size caps, final-URL citation, no paywall/auth/CAPTCHA bypass. |
| Engine | Budgets (iterations, searches, sources, fetches, model calls, runtime, output tokens), early stopping, adaptive escalation on disagreement, per-claim confidence, provenance graph, post-synthesis cross-check. |
| API | Express + SSE (`POST /api/research` streams progress, never chain-of-thought). Validation, per-IP rate limiting, concurrency guard, singleflight dedup, result cache, OpenAPI at `/api/openapi.json`. |
| Frontend | Zero-build HTML/CSS/JS: ask form, live progress, 10-tab dashboard, SVG source graph, Markdown/HTML/JSON export, print/PDF, keyboard tabs, ARIA live regions. Static mode runs everything in-browser. |
| Persistence | Atomic JSON file store (`DATA_DIR`); browser localStorage history. Swappable for a real DB. |
| Ops | Structured logs, `/api/health` + `/api/metrics`, CLI, MCP tool stub, GitHub Actions CI + Pages deploy. |

Methodology rules enforced in code: search-result ≠ evidence · `.edu` ≠ auto-trust ·
Wikipedia/Reddit = discovery, not proof · books are *discovered* until *inspected* ·
copies don't count as confirmations · confidence is per-claim, qualitative ·
a user stance changes the objective, never the truth conditions.

## Research modes & stance

Modes: **Quick** (~2 searches, template queries, ~1 min) · **Standard** (~10 + academic/books,
cross-checking) · **Deep** (~24, books/academic/primary/provenance) · **Exhaustive**
(~50, documentary-grade). Every run is budget-enforced and stops early when evidence
suffices; disagreement auto-escalates depth. Deeper modes cost more API quota and time —
the UI says so up front.

Stances: Neutral · Lean · Adversarial · Steelman · Comparative. Always disclosed in
the report; counter-evidence is always hunted; evidence is never manufactured.

## Configuration

All in `.env` (never committed — see `.gitignore` + `.dockerignore`):

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | — | Primary key (required unless BYOK per request) |
| `GEMINI_API_KEY_FALLBACK` | — | Second key: auto-rotation on 429 + doubled RPM |
| `DEFAULT_MODEL` | `gemini-2.5-flash` | Base model; override per role (`PLANNER/RESEARCH/ANALYSIS/SYNTHESIS_MODEL`) |
| `PORT` / `DATA_DIR` | `8787` / `./data` | Server port / persistence volume |
| `MAX_CONCURRENT_RUNS` | `8` | Concurrent-run guard (503 beyond) |
| `RATE_LIMIT_MAX` | `30` | Per-IP research POSTs per minute |
| `SEARCH_STAGGER_MS` | `350` | Spacing between parallel search bursts |
| `RESULT_CACHE_TTL_MS` | `7200000` | Identical-repeat cache TTL (`0` disables; `fresh: true` bypasses) |
| `RESEARCH_BUDGETS_JSON` | — | Override mode budgets, e.g. `{"quick":{"maxSearches":3}}` |
| `CORS_ORIGIN` / `LOG_LEVEL` | `*` / `info` | Deployment hardening |

## Deployment

- **GitHub Pages (static demo):** push to `master` — `.github/workflows/pages.yml` stages
  `frontend/` + engine JS, verifies every static import resolves, and deploys. No secrets
  involved (keys stay in visitors' browsers).
- **Vercel:** `vercel.json` + `api/index.js` Express-as-function adapter (Quick/Standard fit
  the hobby 60s cap; use Docker/VPS for Deep/Exhaustive).
- **Docker/VPS/Fly/Render:** `npm install && npm start` with secret env vars; mount `DATA_DIR`.
- Set keys as **secrets**, never in code. BYOK keys travel in `x-gemini-key`, live in
  memory per run, and are never logged or persisted.

## Security & privacy

No analytics. External traffic only: Google Gemini API, Google Search (via grounding),
and the free metadata APIs above. No paywall/auth/CAPTCHA/robots bypass — blocked pages
are recorded as inaccessible. See `docs/production-checklist.md` before going public.

## Testing & evaluation

```bash
npm test        # 140+ tests: units + offline full-pipeline E2E (15/15 audit) + HTTP/SSE
                # + infra, cancellation, result-cache, static-mode, perf budgets — no key needed
npm run lint    # syntax gate over every JS file (runs in CI)
node eval/run.js result.json        # audit-score a saved run
node eval/run.js --all ./data      # batch-score every saved run
```

The eval bank (`eval/questions.json`, 14 items) spans easy/medium/hard/adversarial/
provenance/contradiction/books. Scoring rewards **auditability** (resolvable citations,
source diversity, stated uncertainty), never prose beauty.

## Project structure

```
backend/src/{engine,providers,middleware}  pipeline, search, hardening
backend/src/{config,schemas,gemini,store,routes,app,cache,logger,openapi,export}.js
frontend/{index.html,styles.css,app.js,direct.js}   UI + static-mode runner
api/index.js           Vercel adapter (same middleware stack)
eval/                  benchmark questions + audit scorer
scripts/               CLI (research/live), key validator, lint, Pages builder
tests/                 110+ offline tests (no key/network required)
docs/                  architecture, methodology, api, deployment, attribution
mcp/server.js          MCP `research` tool stub for future search providers
```

## Contributing & license

PRs welcome: keep dependencies tiny, add tests for engine changes, run `npm test`
and `npm run lint`, never commit keys. Licensed **Apache-2.0** (see `LICENSE`).
Research ideas adapted (not copied) from `cavit99/deep-research-gemini` and
`langchain-ai/open_deep_research` (both MIT) — details in `docs/attribution.md`.
