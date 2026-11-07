# Evidence Researcher — Architecture v2 (production overhaul)

Status: implemented v2.0 (2026-11-07). This document supersedes the v1
sketch in `docs/architecture.md`. It records (1) the full defect register
found by a line-by-line audit, (2) the corrected architecture, and (3) the
2025–2026 SOTA techniques adopted or rejected, with reasons.

Goal: auditable, citation-backed reports correct enough for school chapters,
with zero bias in Neutral mode, no flaky "works sometimes" behavior.

## 1. Defect register (fixed vs accepted)

### Critical — wrong evidence / citation / security (all fixed)

| # | Defect | Root cause | Fix |
|---|--------|-----------|-----|
| C1 | Grounding snippets misattributed: whole model text returned as every chunk's snippet | `geminiSearch.js` fell back to `segs \|\| text` | Unsupported chunks get title-only snippet or none |
| C2 | URL-context enrichment shifted passages onto wrong sources | positional split, no count check | Unequal section count → discard all, never shift |
| C3 | Provenance emitted `derived_from` for sources the model never saw | 6k budget dropped tail, relations for full group | Relations only for seen subset |
| C4 | Confidence inverted root logic: valid root + copies scored `independentSupport=0` | excluded both `from` and `to` | Only `from` (copies) excluded; root counts |
| C5 | Trust tag breakout: `</untrusted_content>` inside fetched text escaped prompt wrapping | no tag escaping | Strip close-tag → `[closed-untrusted-tag]` |
| C6 | SSRF via DNS rebinding + octal/hex IP bypass | literal IP regex only | Resolve hostname, reject private IPs; octal/hex octet reject; redirect hops re-checked; streamed size cap |
| C7 | Singleflight cross-tenant leak: second tenant joined first tenant's run | key omitted key-set | Key includes masked key-set fingerprint |
| C8 | BYOK mixed with server keys (quota + tenant bleed) | `getKeys` always appended env keys | Explicit keys are exclusive |

### High — wrong results / hangs / quota bleed (fixed)

- Orchestrator swallowed `CANCELLED` in synthesis + claims retries → dead runs
  returned "successful" results. Cancel now rethrows everywhere.
- `QUOTA_WAIT_BUDGET_MS=NaN` poisoned the circuit breaker into infinite wait.
  Non-finite values now fall back to the deadline-derived budget.
- Planner template fallback masked 429/cancel. Quota/cancel now rethrow.
- Contradiction reviewer saw only ids, no excerpts → hallucinated counters.
  Now receives fitted excerpts per claim; hallucinated `claimId`s dropped.
- Contradiction fallback gap text became a nonsense follow-up search query.
  Fallback gaps are now `[]`.
- Claim id collision (`Date.now()` same-ms across iterations). Now counter+random.
- Evidence strength for unclassified tier defaulted to 0.5, outranking tier 6/7.
  Default is now 0.1; tertiary directness fixed.
- Classify over-promotion: bare `brief|order|act|standard` matched nearly every
  page; bare `archive` matched archive.today mirrors. Word boundaries +
  institutional-signal requirement added.
- Query dedup missing → duplicate searches burned quota. Dedup added.
- Cache thundering herd: concurrent identical `cached()` calls each fired
  upstream. Singleflight coalescing added.
- `pool()` orphan workers kept burning quota after first rejection. Abort
  flag stops new work on first rejection.
- `claimDerivedFinding` map bug dropped all source context from fallback
  findings when passed an array. Map now built internally.
- CSE fetch had no timeout → hung run. 15s abort added.
- Idempotent replay with different body silently returned wrong result.
  Body fingerprint + 409 added.
- CSP blocked Wikimedia figures in hosted frontend. `upload.wikimedia.org`
  + `commons.wikimedia.org` allowed.

### Accepted / deferred (documented, not silently skipped)

- `synthesizeReport` mid-JSON `.slice()` truncation in prompts: prompts are
  advisory; retrieval sets are already whole-record fitted. Full prompt
  rewrite deferred to the extraction-layer refactor (below).
- `verifyFindings` tail truncation (>16 findings unchecked): acceptable —
  partial verdicts demote into uncertainty; full coverage needs bigger budget.
- `MAX_CONCURRENT_RUNS=0` now means explicit pause (503). Negative values
  fall back to 8.

## 2. Corrected pipeline

```
PLAN → SEARCH (Gemini grounding + academic/books/CSE, deduped queries)
     → COLLECT (dedup + tier classify, evidence-based not domain-based)
     → FETCH (SSRF-safe, robots-honoring, size-capped; URL-context fallback
       only on exact section-count match)
     → CLAIMS (HiSS-ready atomic claims, citation-integrity filtered)
     → GAPS → CONTRADICTIONS (excerpts visible, symmetric for/against)
     → PROVENANCE (seen-only relations, hash-backed derivation)
     → DECIDE (deterministic confidence: breadth/quality/proximity/
       diversity/contradiction-prior; root counts, copies don't)
     → SYNTHESIZE (extractive-pinned; IDs integrity-checked)
     → VERIFY (post-generation entailment; "no" demotes to uncertainty)
     → REPORT (appendix ledger, figures with structural attribution,
       exports; receipt on sync delivery)
```

Cross-cutting: BYOK isolation · singleflight keyed by input+key-set ·
idempotency with body hash · cancel-aware everywhere · quota-wait breaker
finite-parse-safe · method/uncertainty appendix always present.

## 3. SOTA adoption matrix (from 2025–2026 research brief)

Adopted now (code): post-generation entailment loop (verify-acts), symmetric
contradiction search, excerpt-visible reviewer, seen-only provenance,
root-preserving confidence, query dedup, cache coalescing, pool abort,
SSRF DNS validation.

Adopted by design already: citation-integrity filter (ALCE-style),
claim support rate (FActScore-style), zero-call quality metrics,
tier-by-evidence, stance-disclosure, extractive pinning.

Next wave (specified, not yet built): Tavily second lane + RRF fusion;
citation recall metric; HiSS sub-claim decomposition; compression cards
before synthesis; eval +4 items (taxonomy, post-cutoff, contradiction pair,
provenance trap); Exa publication lane on Deep+.

Rejected: SearXNG as primary, Exa `deep` synthesis (delegates audit away),
domain-only ranking boosts, GAIA/BrowseComp as primary score, DualSpec
speculation (latency ≠ correctness).

## 4. Neutrality guarantee

Procedural, not prompt-based: in Neutral mode every major claim gets
symmetric for/against searches with identical budgets; stance changes the
search objective only (truth states computed from evidence alone);
steel-manned counter included in every report; stance-swap must not flip
truth verdicts (asserted in eval's contradiction-pair item).

## 5. Tests

387 passing (`node --test tests/*.test.js`). Updated: rotation (BYOK
exclusive), diversity (ambiguous-split discard), claims (empty fallback
gaps). New coverage targets listed in OVERHAUL follow-ups: NaN budget,
key-set singleflight isolation, pool abort, trust breakout, DNS SSRF,
idempotency body-hash.
