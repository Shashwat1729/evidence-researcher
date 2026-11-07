# API reference

Base URL locally: `http://localhost:8787`. All JSON unless noted.

## Authentication

- Server mode: `GEMINI_API_KEY` env var on the backend.
- Private (BYOK) mode: send your key per request in the `x-gemini-key` header.
  Used in-memory for that run only — never logged or persisted.
- If neither is present, `POST /api/research` returns `401`.

## Endpoints

### `GET /api/health`
Liveness + ops telemetry → `{ ok, time, uptime, version, memory, model, cache }`.
Wire your orchestrator/load-balancer checks here.

### `GET /api/openapi.json`
Machine-readable OpenAPI 3.0 spec for all endpoints above.

### `GET /api/config`
`{ serverKey: bool, hasFallback: bool, modes: [...], stances: [...] }` —
lets the UI explain whether a key is needed. Never exposes any key material.

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
`401` (no key), `503` (too many concurrent runs — see `MAX_CONCURRENT_RUNS`,
default 8; quota is per project, so parallel runs would 429 everyone).

### `GET /api/history` · `GET /api/history/:id` · `DELETE /api/history/:id`
Local run persistence (file store; `DATA_DIR`). List returns summaries;
`?limit=` clamps to 1–200 (default 50). Get returns the full `ResearchResult`.

### `GET /api/export/:id?format=md|html|json`
Download the report **as a file attachment** (`research-<id>.md/html/json`).
Markdown is the clean documentary/essay format; HTML is self-contained with
valid `<ul>` lists; JSON is the full result object. PDF: open the Final
Report tab → **Print / PDF** → Save as PDF (print stylesheet included).

Identical concurrent `POST /api/research` bodies share one execution
(singleflight): joiners receive a `progress` note plus the same `result`
event, burning quota only once. Disconnecting all clients cancels the run
cooperatively (no new model/search work starts; in-flight calls drain).

## Core schemas

- **Source**: `{ id, url, canonicalUrl, title, author, publisher, publishedDate,
  sourceType, domain, discoveredVia, tier (1–7|null), tierReason, authority,
  proximity (primary|secondary|tertiary|unknown), independence,
  accessibility (full|partial|metadata-only|unavailable), passages, verified }`
- **Claim**: `{ id, text, state, supporting[], contradicting[], confidenceWhy,
  evidence[], contradicting_evidence[], confidence, confidence_label,
  confidence_factors[], status, independence, reasoning }`
  with `state \^^ strongly-supported|supported|plausible|disputed|
  weakly-supported|unsupported|contradicted|unknown`, `status` in
  `supported|partially-supported|mixed|contradicted|insufficient-evidence`,
  and `confidence` computed deterministically from source count/quality,
  independence, contradiction strength, and copy-detection (never the LLM's
  self-assessment). `confidence_factors` lists each contributing signal so
  the number is auditable.
- **Evidence**: `{ evidence_id, source_id, type (supporting|contradicting),
  excerpt, location, supports_claim, strength, directness, retrieved_at, notes }`.
- **Relation**: `{ from, to, kind, evidence }` where `kind \^^ supports|
  contradicts|quotes|cites|summarizes|copies|references|derived_from|discusses`.
- **ResearchResult**: `{ id, task, plan, report, claims, sources,
  contradictions, provenance, relations, iterations, quality, stats,
  stanceDisclosure, completedAt }`. Every `cite`/link id is guaranteed to
  resolve to a retrieved source (ghost ids are filtered by the engine).

## Sync delivery, MCP, receipts

### `POST /api/research` with `{"stream": false}`
Same body as SSE mode; returns the full `ResearchResult` as a single JSON
response. The result carries `receipt` — an Ed25519-signed delivery receipt:
`{ v, issuer, kid, order, listing, seller, buyer, amount_minor, currency,
delivered_at, input_sha256, delivery_sha256, sig }`. `delivery_sha256` is the
sha256 of the result *before* the receipt was attached (hash the result minus
`receipt` to verify). `Idempotency-Key` header replays the same result without
re-running.

### `POST /mcp`, `npm run mcp`
Stateless Streamable HTTP MCP endpoint (or stdio via `npm run mcp`) exposing
the `research` tool: `{ question, mode?, stance?, hypothesis? }` → structured
result. Invalid arguments and research failures return `isError` content.

### `GET /.well-known/receipts.json`
Public keys for receipt verification: `{ issuer, alg, canonical, keys: [{ kid,
kty, crv, x }] }`.

### `GET /api/service`
Service metadata for autonomous discovery: `{ name, description, price_minor,
currency, endpoints, modes, stances }` (env-configurable).
