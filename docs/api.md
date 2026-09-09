# API reference

Base URL locally: `http://localhost:8787`. All JSON unless noted.

## Authentication

- Server mode: `GEMINI_API_KEY` env var on the backend.
- Private (BYOK) mode: send your key per request in the `x-gemini-key` header.
  Used in-memory for that run only — never logged or persisted.
- If neither is present, `POST /api/research` returns `401`.

## Endpoints

### `GET /api/health`
Liveness. → `{ ok: true, time }`

### `GET /api/config`
`{ serverKey: bool, modes: [...], stances: [...] }` — lets the UI explain
whether a key is needed. Never exposes any key material.

### `POST /api/research` — Server-Sent Events
Body: `{ question, mode?, stance?, hypothesis?, documentary? }`
(`mode`: quick|standard|deep|exhaustive, default standard;
`stance`: neutral|lean|adversarial|steelman|comparative, default neutral.)

Streams `text/event-stream` frames (`data: {...}\n\n`):

| type | meaning |
|---|---|
| `start` | run accepted (`task`) |
| `progress` | concise activity/tool status (never chain-of-thought) |
| `plan` | research plan (`domain`, `complexity`, steps, lines of inquiry) |
| `sources` | sources discovered so far (`count`) |
| `claims` | claims extracted (`count`) |
| `warning` | non-fatal issue (search/fetch/unavailable) |
| `done` | finished (`stats`: modelCalls, searchCalls, fetches, tokensIn/Out, runtimeMs, escalated) |
| `result` | full `ResearchResult` (plan, claims, sources, contradictions, relations, report, stats, stanceDisclosure) |
| `error` | fatal (rate-limit / invalid key / budget exhausted — safe messages only) |

Error status codes before streaming starts: `400` (bad question/mode/stance),
`401` (no key).

### `GET /api/history` · `GET /api/history/:id` · `DELETE /api/history/:id`
Local run persistence (file store; `DATA_DIR`). List returns summaries;
get returns the full `ResearchResult`.

### `GET /api/export/:id?format=md|html|json`
Download the report. Markdown is the clean documentary/essay format;
HTML is self-contained; JSON is the full result object. PDF: open the Final
Report tab → **Print / PDF** → Save as PDF (print stylesheet included).

## Core schemas

- **Source**: `{ id, url, canonicalUrl, title, author, publisher, publishedDate,
  sourceType, domain, discoveredVia, tier (1–7|null), tierReason, authority,
  proximity (primary|secondary|tertiary|unknown), independence,
  accessibility (full|partial|metadata-only|unavailable), passages, verified }`
- **Claim**: `{ id, text, state, supporting[], contradicting[], confidenceWhy }`
  with `state ∈ strongly-supported|supported|plausible|disputed|
  weakly-supported|unsupported|contradicted|unknown`.
- **Relation**: `{ from, to, kind, evidence }` where `kind ∈ supports|
  contradicts|quotes|cites|summarizes|copies|references|derived_from|discusses`.
- **ResearchResult**: `{ id, task, plan, report, claims, sources,
  contradictions, provenance, relations, iterations, stats, stanceDisclosure,
  completedAt }`. Every `cite`/link id is guaranteed to resolve to a retrieved
  source (ghost ids are filtered by the engine).
