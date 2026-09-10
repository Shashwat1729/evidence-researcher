# Changelog

## Unreleased
- Shared CLI runner (`scripts/run.js`) behind both CLIs, with arg parsing + exit codes tested
- Graceful shutdown (SIGTERM/SIGINT drain) + unhandled-rejection logging in server entry
- Process tab surfaces phase timings, fetch-issue breakdown, key rotations
- Eval `--all [dir]` batch scoring; API docs cover OpenAPI/singleflight/attachments
- Singleflight: identical concurrent runs share one execution (no extra quota)
- Export downloads as attachments; markdown link text sanitized; valid `<ul>` HTML
- Follow-up sources keep grounding excerpts + related copies (parity with initial batch)
- Enrichment skips unresolvable redirect URLs; review step has try/catch parity with claims
- Request validation middleware (length caps, mode/stance enums, prompt-injection guard)
- Infra tests: registry, logger redaction, OpenAPI shape, rate limiter, singleflight, attachments
- Follow-up parity test, latency budget tests (dedup volume, pool overlap)
- Docs: production checklist, quota operations guide, OpenAPI additions, README sync

## 1.0.0
- Evidence-first pipeline: plan → search → collect → claims → gaps → contradictions → provenance → synthesize
- Gemini grounding search + free academic providers (OpenAlex, Crossref, arXiv, Semantic Scholar, PubMed, books, Internet Archive) with LRU cache
- Key rotation (primary + fallback), RetryInfo per-minute waits, sticky preferred key
- Tier 1–7 source classification, canonical dedup with related copies, claim-level confidence
- Contradiction engine, adaptive escalation, provenance analysis, post-synthesis verification
- SSE progress UI with 10-tab dashboard, source graph, exports (MD/HTML/JSON, print/PDF)
- Security: headers, CORS, rate limiting, concurrency guard, atomic store, structured logs
- CLI (`npm run research`), MCP tool stub, GitHub Actions CI, Vercel + Docker deploy
