# Changelog

## 2026-10-07 - figures on the degraded path, and an academic filter that actually filtered

Two defects found by reading an actual report rather than trusting it.

### Figures were skipped whenever a run degraded on quota

The figure step was inline in the normal path only. The quota catch block below
it rebuilt the report, added the evidence appendix and the guaranteed
uncertainty/gaps — and then skipped figures entirely. So the runs *least* able to
afford to look thin were precisely the ones that shipped with no images. A live
run recorded `plan -> search -> fetch` and no figures phase at all, with 14
usable claims sitting in the result.

The step is now a function declared outside the `try` and called from both
paths. (Declaring it *inside* the try was the same scoping mistake as the earlier
`arc is not defined` bug — the catch block could not see it, which is how the
first attempt at this fix silently did nothing.)

### Off-topic papers were becoming cited findings

A report about Harappan drainage contained sections titled *"Network analysis of
undeciphered Indus civilization script"*, *"Quantum field theories and London
dispersion"* and *"Urban parks and specific green spaces"*. Physics papers, cited,
in a chapter on ancient water management.

The relevance gate was `score > 0` over a term list — and the list contained
**"and"**, because the stopword set was missing every function word. "and" occurs
in essentially every academic title, so every record scored a title hit and the
filter was a no-op. This is the same class of bug as the missing `AQ.` key
prefix: an over-permissive filter that silently admits everything.

Two changes:
- The stopword list now covers function words and generic scholarly nouns, so
  "and", "did", "study", "analysis" and friends no longer count as topics.
- A record must earn its place: it either names the topic in its **title**, or
  its abstract covers (almost) every query term. A couple of hits in an abstract
  proves nothing, because "water" and "cities" appear in almost any paper.

Verified on the exact records that leaked: the physics and urban-parks papers are
now dropped. A paper titled "Network analysis of undeciphered Indus civilization
script" is deliberately **kept** — it names the Indus civilization, and a
title-level lexical gate cannot tell "Indus script" from "Indus drainage".
Discarding genuine subject evidence to avoid a near-miss is the worse error, and
it now ranks below the on-topic work.

Result of the re-run, in a browser: 4 sections with real prose, 0 off-topic,
3 figures, all attributed and all on-topic.

## 2026-10-05 - provider overload is not a key problem

Quota reset, which made the difference between a quota wall and an overload wall
visible. A live probe of all eight keys:

```
gemini-flash-latest      TIMEOUT ERR503 TIMEOUT ERR503 ERR503 ERR503  OK  ERR503
gemini-3.5-flash         OK OK OK OK OK OK OK OK
gemini-3.1-flash-lite    OK OK OK OK OK OK OK OK
gemini-flash-lite-latest OK OK OK OK OK OK OK OK
```

`gemini-flash-latest` — the default for search and writing — was answering
**503 Service Unavailable**, while every other model on the ladder answered 200
on all eight keys. Two bugs followed from that:

- **5xx was treated as key-scoped.** The old path rotated keys on any transient
  status, so one call against an overloaded model cost eight attempts (times
  retries) before giving up. Rotating keys cannot fix an overloaded *server*.
  A 5xx now fails the model immediately and walks the ladder: one wasted call
  instead of eight. Per-key `429` and per-project `404` still rotate keys,
  because those really are scoped to a key or a project.
- **The overloaded model was re-probed on every call.** The ladder is rebuilt
  per call, so the same dead model was tested ~20 times a run, each time costing
  a request and about a second to learn nothing. An overloaded model is now
  demoted for two minutes — moved to the end of the ladder, not dropped — and the
  cooldown is ignored when every rung is cooled, because trying something beats
  failing. Every model move is still announced, so a substituted model is never
  silent.

Net effect on the observed failure: synthesis ground for 7+ minutes on a model
that was never going to answer. It now moves once, then leaves it alone.

## 2026-10-04 (later) - figures, Pages, evidence metrics

Found by real end-to-end runs, not by unit tests.

### Wrong and unlicensed images

A live run put **"Major Arcana" (a tarot deck)** under a heading about Harappan
water management and **"Collapse of the World Trade Center"** under the Late
Harappan phase, both credited "Unknown / see source". Four distinct bugs:

- **A one-word query matches that word anywhere.** "Urban Planning, Architecture,
  and Water Management Systems of Major Cities" reduced to the single identifying
  token "major", and Wikipedia's top hit was the Tarot article. A short generic
  token is no longer searched at all; the guard sits at the search boundary and
  short-circuits before any network call.
- **Word length is not specificity.** "legacy transitions" matched "Microsoft Edge
  Legacy"; "chronological phases transition" matched "Demographic transition".
  Queries are now derived from capitalised non-sentence-initial words in the
  section body, which is where the subject is actually named.
- **Licence metadata lives on the FILE, not the article.** When `pageimages`
  returned no file name the code fell back to the article title, so the lookup
  missed and the image shipped unattributed. Attribution is now a hard gate: a
  figure whose licence cannot be resolved is **dropped**.
- **One bad title killed the whole batch.** A single unresolvable title failed the
  multi-title licence request and took every other figure with it, so runs rendered
  with no photos at all. Requests are chunked with a per-title retry.

Also accepted `thumb.wikimedia.org`, which was silently rejecting every
thumb-scaled lead image. Verified against a real report: water management →
a Mohenjo-daro photograph; society/trade → the Akkadian seal of the Meluhhan
interpreter; Iron Age legacy → Painted Grey Ware.

### GitHub Pages served 404 for everyone

`build-pages.js` staged `frontend/` and `backend/src/` but never wrote an index
document at the artifact root — the only path Pages serves. Every deploy reported
success and every URL 404'd; two deploys went unnoticed. The build now writes a
root `index.html` with prefixed asset paths and **fails if that document or any
asset it references is missing**, so an unservable static build cannot ship again.

### Heading repair

The section-writing call leaked structural debris into titles (a trailing
`”, "`) and echoed its own placeholders ("Finding 2", "Finding 4", "Finding 6").
Debris is stripped, dangling punctuation trimmed, and a bare "Finding N" replaced
from the plan's arc. Run-together words ("CivilizationSafe Zone") are deliberately
**not** split in the heading: a lowercase→capitalised boundary mangles `eBay` and
`openAI` and broke a third of the suite.

### Evidence-quality metrics

The run reported cost telemetry but nothing about whether the output was
evidence-backed. `backend/src/quality.js` adds, with **zero** extra model calls:
attributable-finding rate (~Auto-AIS), claim support rate + histogram
(~FActScore), citation precision (~ALCE, flagging sources that support no claim),
independence-adjusted support (no published analogue; two pages of one site are
not cross-verification), and inspected-source rate. A rate with no denominator is
`null`, never `0`. There is no letter grade — `weakestLink` names the actual
shortfall. A degraded write-up still surfaces even when every rate looks clean.

## 2026-10-04 - keys, models, figures, exports (all API formats work)

### The reported bug: "6 keys, 1 valid, 4 removed"

Root-caused with live calls against all ten supplied keys. Three independent bugs
stacked up; none of them were the user's keys.

- **`AQ.` keys were rejected on a string-prefix test.** Google moved AI Studio to
  `AQ.` authorization keys in June 2026 (the `AIza...` format is now legacy).
  `validateKey()` gated on `startsWith('AIza')`, so four working keys were
  reported invalid and then deleted. Both formats are accepted now; the format
  check is a typo filter only, and the live call is the arbiter.
- **The UI silently dropped keys past the fifth.** `parseKeyInputs(...).slice(0, 5)`
  discarded the rest with no message. The limit is now dynamic
  (`MAX_KEYS_PER_REQUEST`, default 25), published by `/api/config` and rendered by
  the UI. Pasting several keys into one box expands them into one row per key.
- **Duplicates were swallowed.** A repeated key shares one quota, so counting it
  twice is a configuration mistake worth surfacing; duplicates are now reported
  (`duplicates`/`dropped` in the response and in the save notice).
- Verified: all 10 keys validate `valid=true` through `POST /api/keys/validate`.

### Reports were dying on quota, not just failing over

- **Model-404 no longer kills a run.** Model availability is per-PROJECT, so a
  404 on one key says nothing about the next. It previously fell through to a
  bare `throw`, silencing every other key and degrading the run to an evidence
  inventory. It now rotates to the next key, and only reports a typed
  `MODEL_UNAVAILABLE` when *every* key 404s.
- **A spent daily cap walks the ladder instead of failing.** Google's free tiers
  are wildly uneven (measured on a live project's rate-limit dashboard: full
  Flash models 20 requests/day, Flash-LITE 500/day, search grounding 1500/day).
  `RPD_EXHAUSTED` used to be fatal; now it continues on the next model, whose
  daily bucket is independent. This was the main cause of "model synthesis
  unavailable, no report" late in the day.
- **Defaults moved off the dying 2.5 family.** `gemini-2.5-flash` returns
  "no longer available to new users" on newer projects. Defaults are
  `gemini-flash-latest` (research/writing) and `gemini-flash-lite-latest`
  (planning/analysis), split so cheap calls ride the 500/day bucket.
- **Searches use the whole key pool.** One key was pinned per search, which
  disabled mid-call failover. Rotation in `post()` already spreads load evenly.

### Models: dynamic, and future-proof

- **Any well-formed `gemini-*` id is accepted.** The curated allow-list returned
  "400 Unknown model" for anything it had not heard of, so a new Google model was
  unusable until someone edited the source.
- **Live discovery.** `GET /api/models` returns what the supplied keys can
  actually call, newest first, unioned across up to three keys (availability is
  per project). Verified returning 16 models including `gemini-3.8-flash`, which
  this build predates. Curated ids keep their written blurbs and lead the list.
- The model picker shows every model the key can call, marks the discovered ones,
  and re-discovers after keys change.

### Figures (free-licensed Wikimedia, never generated)

- One or more photographs/diagrams per section, placed between the prose and its
  citations so the report reads like a chapter.
- Attribution is structural, not decorative: author, licence and Commons file page
  are stored and rendered in the app, the Markdown, the HTML, the NotebookLM
  dossier and the media brief. Unattributed media may not be redistributed.
- Matching is deliberately strict: a candidate must overlap an IDENTIFYING query
  token, because search rank alone put a photograph of Chang'an under a heading
  about Mohenjo-daro. A missing photo is cheaper than a wrong one.
- Licence metadata is fetched in one batched `prop=imageinfo` call (it lives on
  the FILE, not the article). Never throws: a failed lookup just means no photo.

### Exports

- `?format=notebooklm` - an uploadable dossier for NotebookLM: bare URLs (which a
  notebook resolves; inline markdown stays inert), every claim's evidence state,
  and figure credits. NotebookLM has no public write API, so this is the honest
  form of "send to NotebookLM".
- `?format=brief` - a per-section media brief: narration, on-screen titles,
  runtime, citations to display, figure to show, required caveats.

### UI

- Fixed invisible dropdown text: native select popups were painted by the browser
  with no colour of their own, so light theme ink landed on a light list and was
  only visible on hover. Every popup colour is now explicit, with the selected row
  themed (the platform highlight is not themeable). Verified >= 7.76:1 contrast on
  every text/background pair in both themes.
- The fallback report states its limitation once instead of stamping "synthesis
  unavailable" into the summary, competing-interpretations, uncertainty and
  methodology.

## 2026-09-24 — "reading room" UI/UX overhaul

- New information architecture: a persistent sidebar of your research runs replaces the separate history page; "New research" is always one click away.
- Home is a single question composer — depth, stance and options live inside it; first-run visitors get an inline "Connect Gemini" prompt instead of a surprise dialog.
- Research progress is a live stage timeline (plan → search → read → analyze → independence → write → verify) with per-stage logs, live counts and an explicit "waits are normal" explainer when quota pauses.
- Results are report-first: 10 tabs became 4 (Report · Evidence · Sources · Method). The report opens with a "Bottom line" and a claim-confidence bar; numbered citations open the exact passage in a side rail (a bottom sheet on phones).
- Evidence groups claims by confidence with contradictions first; Sources has type chips (web/academic/books/primary), a tier filter, search, access status and citation counts.
- New visual system: warm paper light theme and matching dark theme (toggle, remembered per browser), Newsreader serif for reading and IBM Plex for the interface, export menu, print stylesheet.
- Accessibility: real buttons for every citation, stage and run; screen-reader phase announcements; Escape closes menus, the source rail and the mobile menu; no horizontal scroll at 390 px.

## 2026-09-24 — end-to-end hardening + frontend redesign

### Backend
- Security: server-side page fetches are SSRF-guarded (no loopback/private/link-local/metadata hosts; every redirect hop re-checked).
- Security: Gemini keys travel in the `x-goog-api-key` header, never in URLs (logs, proxies, error text).
- Security: exported Markdown/HTML only link http(s) URLs and escape quotes (no `javascript:` links or attribute breakout).
- Security: CSP without inline scripts; sanitized `X-Request-Id`; `/api/keys/validate` is rate-limited.
- Fix: the local/Docker server never used the result cache (`createApp` passed a store without cache functions).
- Fix: a Quick run whose planner ran past the deadline threw away all gathered evidence; searches now stop gracefully.
- Fix: CORS preflight rejected the multi-key and model headers the UI sends.
- Fix: unknown `/api/*` routes returned the SPA page with HTTP 200; now JSON 404. Unknown export formats are 400.
- Fix: SSE streams send a heartbeat every 15s so proxies don't drop runs that are waiting on quota.
- Fix: network errors and Gemini 500/504 are retried; key state no longer collides between keys sharing a prefix.
- Fix: quadratic JSON-repair loop could freeze the event loop on long responses.
- Fix: concurrent saves could share one temp file; stale cache entries are pruned; cache keys include the model.
- Fix: quota-fallback reports now include the evidence appendix and uncertainty/gaps.

### Frontend
- Redesigned ask, progress (live stage tracker + counters), result header, tabs with counts, report typography, history.
- Light theme (follows the OS); graph colors now theme-aware; mobile layout without horizontal overflow.
- Fix: key dialog closed before validation finished; now validates inline (directly against Google in static mode).
- Fix: keys/model names were injected into HTML unescaped; history rows too.
- Fix: reopening a run from history duplicated it; runs can be deleted; clearing history also clears saved results.
- Fix: a closed stream with no result stranded the progress view; mid-stream network retries started a duplicate run.
- Fix: static mode silently failed to save a second report (localStorage full) — oldest results are evicted.
- Deep links (`#run=<id>`), Ctrl+Enter to start, source filter, client-side exports, no blocking `alert()`s.
- CI now fails on lint errors and verifies the Pages build.

## Unreleased
- Verification acts (a "no" verdict demotes the finding into uncertainty), verify fits whole findings and covers 16, cached inventories labeled honestly (never masquerade as fresh reports)
- Live-verified model catalog (real generate calls, not ListModels): planner/analysis default to gemini-flash-lite-latest (fastest on new keys), picker offers only working ids, legacy lite/pro stay accepted for old keys, and any model 404 automatically retries once on the default with a loud warning — a stale picker choice can no longer kill a run
- Export honesty: HTML citations are real anchors (were dead literal text), chronology renders as a table (was literal pipes), appendix link text sanitized; claim prompts fit whole source records (was mid-JSON truncation); failed reviews stay provisional (never declare sufficiency on silence); docs corrected (mode time budgets, quota philosophy, same-project keys, Vercel cap)
- Full-run priority (time is cheap, the chapter is mandatory): sections/assembly retry refillable quota until the mode deadline (no 5-attempt surrender; RPD hard caps still break fast), deadlines raised (standard 25min, deep 45min, exhaustive 90min; quick keeps 90s), quota-wait budget defaults to remaining mode time
- Anti-hammer escalation: constant short retry rounds EXTEND server throttles (measured: key healthy the moment hammering stops) — round waits now honor Retry-After first, then back off 30s→60s→120s
- Billing fail-fast corrected: ordinary per-minute 429s carry the billing text AND RetryInfo — only absent/huge refill times prove a hard cap
- Synonym recall: plan vocabulary (queries/variants/lines of inquiry) feeds relevance scoring across academic/books/collect, so "Mohenjo-daro" isn't scored 0 for a Harappan question
- Ranking overhaul: academic bundle ranked by question overlap (PubMed keyword noise sinks instead of parading as tier 2), declared books/papers keep tier 2 (archive.org books no longer tier-1 "primary"), zero-overlap keyword matches demoted to tier 5 with explicit reason, sources sorted by tier/relevance before the maxSources cut, merges keep the best tier, short-text dedup bar 0.7→0.8, book authors/publishers/years rescued from provider metadata (no more "unknown author (n.d.)")
- Static Pages model picker now loads the backend catalog (was Auto-only); empty report sections hidden instead of bare headers; Process tab crash-proofed for old stored results; graph tab explains empty state
- Synthesis success path hardened so the chapter actually gets written: global per-model shared pause (a 429 pauses ALL keys — same-project keys share one bucket), pacing waits capped at 60s + budgeted/surfaced (fixes silent unbounded stall), exact server Retry-After attached to quota errors and honored by section retries, searches capped at 40% of the wait budget (synthesis reserve), partial results preserved on pool abort, billing fail-fast now requires absent RetryInfo (ordinary per-minute throttles carry the billing text AND a refill time — never give up on those), one coordinated refill pause + wait-counter reset before the late phase, hot quota collapses to max 3 bigger sections
- Per-mode standards differentiated: deep sections get bigger budgets (10240), finding-body minimums strictly increase (900→1100→1200); cold-open story hook in synthesis/assembly prompts for chapter modes (quick stays lean)
- Fallback report now reads like a book chapter: claim-derived findings expanded with supporting passages and source tiers (no heading/body echo, derived timeline, richer summary), so even quota-dead standard runs feel substantive
- Quota-dead search phase no longer discards free evidence: grounding pool abort settles academic/book jobs and degrades to inventory; all-quota-failed batches report QUOTA_EXHAUSTED (not NO_EVIDENCE); futile top-ups skipped; quota messages now explain same-project shared quota + minute vs daily resets
- Fixed live-site "Error: step is not defined" crash: showResult called run-scoped step(), discarding completed fallback reports back to home; now uses globals only, plus a scope regression test
- Dynamic rate limiting: adaptive AIMD pacing per key+model (429s double the gap up to 8x, successes ease back; class-based floors, never per-version hardcodes); pacing state reset between runs (also halved rotation test time)
- Verified-live model catalog (2.5-flash/lite/pro; retired 1.5/2.0 ids map to Auto via canonicalizeModel so stale saved preferences never dead-run); defaults corrected to 2.5-flash for ALL roles after a live run showed 2.5-flash-lite is unavailable to new free-tier keys (lite stays in the picker for keys that have it)
- Graceful quota degradation: mid-run quota exhaustion after evidence gathered yields an evidence inventory (synthesisFallback) instead of "api limit exceeded" with no result; UI shows inventory banner
- Empty-grounding guard: sources with no excerpt text still carry a title fallback so passages are never silently empty
- Global quota budget aligned to 300s (was 120s, starving patient synthesis retries)
- Single waiting indicator per episode (no "Brief pause" spam, no silence); resumed clears it; per-operation re-arm
- Per-call wait budgets: searches fail fast (45s quick / 90s), synthesis stays patient; resumed event on recovery
- Honest research progress: backend phase + live stats on every event, phase-anchored bar, elapsed timer, auto-scroll
- Follow-up source parity: shared record builder + intra-batch dedup + bounded full-text top-up fetch
- Fixed grounding snippet misattribution (chunk-index shift after filtering)
- Fixed charset meta-scan on ArrayBuffers (mojibake path); uid uniqueness across processes
- Static-mode Cancel actually stops the run (signal → engine isCancelled); terminal errors clean up timers
- Patient quota handling: multi-round rate-waits until budget spent (never one-and-done skips)
- Section rate-limit + thin-prose retries with explicit expansion nudges; longer runtimes
- Per-section graceful degradation; template fallbacks when sections or assembly fail
- Richer synthesis input (per-source excerpts, higher caps) at zero extra calls
- Deterministic evidence appendix: every claim + linked sources, no model cost
- Contents + chronology rendering in UI report and Markdown export; audit now 16/16
- Narrative arc: planner designs ordered beats per domain; synthesis follows them like chapters
- Timeline section with per-mode minimums; annotated books and tier-coverage rule
- Chapter-grade reports: per-mode depth contract (findings × body minimums, books/primary minimums)
- Claim yield minimums per mode with facet coverage and larger analysis budgets
- Process-talk ban in synthesis prompt (no grounding-API/meta language, domain terms only)
- Cache-busted static bundles (versioned imports + lazy engine load) with build stamp in footer
- Version-sync test guarantees app/direct/index stay on one build id
- Fixed "process is not defined" crash in static Pages builds (browser-safe env + process shim)
- Planner-query acceptance now requires category diversity (≥3) so call savings never reduce accuracy
- Planner now emits search queries + book variants: saves 2 model calls per non-quick run (query-gen + expansion merged in)
- Book expansion reserved for deep/exhaustive fallback; standard uses planner/heuristic variants (zero extra calls)
- Quick mode fits ~5 calls: plan + 2 searches + merged claims/review + synthesis
- Navigation safety: cancel/errors always land home with the question preserved (no more stranded progress view)
- Abort-aware retry sleeps; dead showError path removed (wrote into hidden view)
- Fixed Promise paren crash in retry helper found via bisect debugging
- Finding cite repair + claim-derived findings fallback (empty model findings never go uncited)
- Hinted-domain classification already live; verified live 15/15 via synthesis fallback path
- Report completeness guard: uncertainty/gaps never empty, derived honestly from run state
- Stronger synthesis prompt: cites mandatory, uncertainty/gaps minimums
- Model picker (UI + `x-gemini-model` + body) routed to all four roles with allowlist validation
- Multi-key rotation pool: N keys via UI/header/env multiply effective quota on 429
- Dynamic rate limiter: sliding window, downstream-429 backoff, Retry-After, gradual recovery
- Synthesis fallback: quota/outage yields honest evidence inventory instead of failed run
- Quota circuit breaker: caps total quota-wait per run, fails fast with clear message
- Cancel button with AbortController; server aborts on client disconnect (refcount)
- Per-angle book queries with mode-scaled `bookLimit`; compact `topicOf` for keyword APIs
- Free-provider fallback: empty grounding triggers zero-quota academic/book rescue (heuristic only)
- 9.5/10 UI redesign: hero layout, mode cards, segmented stance, model picker, multi-key manager, cancel flow
- Static Pages mode: full pipeline runs in-browser (shared engine, BYOK), client-side exports, local history reopen
- Pages deploy workflow with static import-integrity gate; local `site/` staging via `scripts/build-pages.js`
- Exporters moved to dependency-free `backend/src/export.js`; fixed re-export binding crash
- Browser-safe guards (`process`, ArrayBuffer decoding) across config/gemini/orchestrator/fetcher
- Result cache: identical repeats served from disk (zero quota), `{ fresh: true }` bypass + UI checkbox
- History reads all summaries (no lost newest runs), skips cache files, cleans stale tmp leftovers
- OpenAPI covers metrics/openapi/fresh/limit; package version read from package.json
- Charset-aware page decoding (kills U+FFFD mojibake from latin-1 pages); hex/astral/common-named entities
- Relative canonical resolution + final-URL citation; single polite 429 retry honoring Retry-After
- Redirect-aware domain counting (title hints) so diversity top-ups fire on merit, not redirect-host clustering
- `/api/metrics` run counters (started/completed/failed/cancelled/byMode)
- Env-overridable mode budgets (`RESEARCH_BUDGETS_JSON`, numbers/booleans on known keys only)
- Blog-path tier cap, generic-title + URL-less dedup guards, memoized provenance with root-id validation
- Pool limit sanitization; scorer strictness + readability; eval bank grown to 14 questions
- Shared CLI runner (`scripts/run.js`) behind both CLIs, with arg parsing + exit codes tested
- Graceful shutdown (SIGTERM/SIGINT drain) + unhandled-rejection logging in server entry
- Process tab surfaces phase timings, fetch-issue breakdown, key rotations
- Eval `--all [dir]` batch scoring; API docs cover OpenAPI/singleflight/attachments
- Cooperative cancellation: disconnecting all clients stops new model/search work
- Rate limiter scoped to research runs; request IDs echoed; Vercel middleware parity
- History `?limit=` (1–200); health exposes academic cache stats
- `.dockerignore` + non-root Docker user; working cross-platform `npm run lint`
- Scorer requires states AND rationale; shared CLI runner tested
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
