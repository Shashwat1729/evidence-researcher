// Central configuration: models, research modes, budgets, stance.
// All Gemini model names are configurable via env; no other provider is required.
// Browser-safe: `process` is guarded so these modules also run in the
// GitHub-Pages static build (see frontend/direct.js).

const env = (typeof process !== 'undefined' && process.env) || {};

export const MODEL_CONFIG = {
  // Verified live 2026-10-04 with REAL generate + google_search grounding calls
  // against ten keys across several projects — not just ListModels, which lies
  // by omission:
  //   gemini-flash-latest        6/6 keys OK, grounding OK
  //   gemini-flash-lite-latest   6/6 keys OK
  //   gemini-3.5-flash           6/6 keys OK
  //   gemini-2.5-flash           404 on a NEWER project: "no longer available
  //                              to new users" — it was the old default, which
  //                              meant every synthesis call on such a project
  //                              died and the run degraded to an inventory.
  //
  // Quota, measured on the same free-tier project's rate-limit dashboard:
  //   full flash models -> 5 RPM, 250K TPM,  20 requests/DAY
  //   flash-LITE models  -> 15 RPM, 250K TPM, 500 requests/DAY
  // Limits are per model per PROJECT, so planning, analysis and the many cheap
  // extraction calls ride the lite alias (500/day) while search and writing use
  // flash. That split is what keeps a standard run inside its daily budget
  // instead of exhausting 20 requests and producing an inventory.
  // Search grounding has its own, far larger daily budget (1500/day), so the
  // searches are not the bottleneck — the generation calls are.
  planner: env.PLANNER_MODEL || env.DEFAULT_MODEL || 'gemini-flash-lite-latest',
  research: env.RESEARCH_MODEL || env.DEFAULT_MODEL || 'gemini-flash-latest',
  analysis: env.ANALYSIS_MODEL || env.DEFAULT_MODEL || 'gemini-flash-lite-latest',
  synthesis: env.SYNTHESIS_MODEL || env.DEFAULT_MODEL || 'gemini-flash-latest',
};

export const MODES = {
  quick: {
    label: 'Quick',
    description: 'Rapid answer with limited search and basic verification.',
    maxIterations: 1,
    maxSearches: 2,
    maxSources: 12,
    maxFetches: 3,
    maxModelCalls: 6,
    maxRuntimeMs: 90_000,
    maxTokensOut: 40_000,
    reportTokens: 2048,
    sections: 1,
    contradictionPasses: 0,
    academic: false,
    books: false,
  },
  standard: {
    label: 'Standard',
    description: 'Multiple searches, source diversity, cross-checking, contradiction search.',
    maxIterations: 2,
    maxSearches: 10,
    maxSources: 30,
    maxFetches: 12,
    maxModelCalls: 24,
    // 25 minutes: time is cheap, the chapter is mandatory — quota waits ride
    // out per-minute refills instead of surrendering to inventory. Quick keeps
    // its 90s fast-check contract; deeper modes scale up from here.
    maxRuntimeMs: 1_500_000,
    maxTokensOut: 150_000,
    reportTokens: 8192,
    sections: 7,
    contradictionPasses: 1,
    bookLimit: 6,
    academic: true,
    books: true,
  },
  deep: {
    label: 'Deep',
    description: 'Iterative research: books, academic + primary sources, provenance, contradiction hunting.',
    maxIterations: 4,
    maxSearches: 24,
    maxSources: 60,
    maxFetches: 25,
    maxModelCalls: 50,
    maxRuntimeMs: 2_700_000,
    maxTokensOut: 500_000,
    // Deep sections get a bigger per-call budget than standard (was equal at
    // 8192 — same synthesis depth for 2.4x the evidence made no sense).
    reportTokens: 10240,
    sections: 8,
    contradictionPasses: 2,
    bookLimit: 10,
    academic: true,
    books: true,
  },
  exhaustive: {
    label: 'Exhaustive',
    description: 'Documentary-grade: substantially more iterations and source gathering. Slow and API-heavy.',
    maxIterations: 7,
    maxSearches: 50,
    maxSources: 120,
    maxFetches: 50,
    maxModelCalls: 100,
    maxRuntimeMs: 5_400_000,
    maxTokensOut: 1_200_000,
    reportTokens: 12000,
    sections: 8,
    contradictionPasses: 3,
    bookLimit: 14,
    academic: true,
    books: true,
  },
};

export const STANCES = ['neutral', 'lean', 'adversarial', 'steelman', 'comparative'];

// Curated Gemini models offered in the UI picker (alongside the API key).
// Verified live 2026-10-04 with REAL generate calls on six independent keys
// (see MODEL_CONFIG). Every id below answered 200 on all of them.
// The 1.5/2.0 families are retired (canonicalized to Auto below); the 2.5
// family now 404s on newer projects ("no longer available to new users"), so
// it is NOT offered — but stays accepted for old keys that still have access
// (COMPAT_MODELS), with automatic fallback down MODEL_FALLBACK_LADDER on 404.
export const AVAILABLE_MODELS = [
  { id: 'gemini-flash-latest', label: 'Gemini Flash (latest)', blurb: 'Default — newest flash, best balance of depth and free-tier quota.', curated: true },
  { id: 'gemini-flash-lite-latest', label: 'Gemini Flash-Lite (latest)', blurb: 'Fastest, most quota headroom — verified on new keys, best for planning.', curated: true },
  { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', blurb: 'Pinned 3.5 flash — a second research bucket that does not move under you.', curated: true },
];

// Ordered recovery path when a model is unavailable (404 / not supported) or its
// DAILY request cap is spent. The requested id is always tried first; this list
// is what comes after.
//
// Order is quota-driven, measured on a real free-tier project's rate-limit
// dashboard (2026-10-04):
//   gemini-flash-latest      5 RPM,  250K TPM,  20 requests/day
//   gemini-3.5-flash         5 RPM,  250K TPM,  20 requests/day
//   gemini-3.1-flash-lite   15 RPM,  250K TPM, 500 requests/day
//   gemini-flash-lite-latest 15 RPM, 250K TPM, 500 requests/day
// So when a full-flash daily cap is spent, falling back to LITE keeps the run
// alive on a 25x larger budget. Lite is therefore the LAST rung, not the first:
// it is the fallback that keeps working when everything else is dry. Every entry
// was verified callable on six independent keys.
export const MODEL_FALLBACK_LADDER = [
  'gemini-flash-latest',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
  'gemini-flash-lite-latest',
];

// Legacy ids: accepted (old keys may still resolve them) but never offered
// and never defaulted. A 404 on these triggers automatic fallback, never a
// dead run. Kept for reference/telemetry only — isKnownModel() is now
// pattern-based, so these are not a gate.
const COMPAT_MODELS = new Set(['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro', ...MODEL_FALLBACK_LADDER]);
export { COMPAT_MODELS };

// Retired model ids (verified gone 2026-09-16). Saved preferences and old
// clients may still send them — map to '' (Auto) instead of failing, so a
// stale picker value degrades to server defaults rather than a dead run.
const RETIRED_MODELS = new Set([
  'gemini-1.5-flash', 'gemini-1.5-flash-8b', 'gemini-1.5-pro',
  'gemini-2.0-flash', 'gemini-2.0-flash-lite',
]);
/** Map a model id to itself, '' for retired/empty (Auto), else unchanged. */
export function canonicalizeModel(id) {
  const v = String(id || '').trim();
  if (!v || RETIRED_MODELS.has(v)) return '';
  return v;
}

/**
 * Accept ANY well-formed Gemini id, not just the curated list.
 *
 * This is the difference between this app aging gracefully and not. The old
 * allow-list meant a model Google shipped yesterday returned
 * "400 Unknown model" until somebody edited this file — the exact failure the
 * user hit when 2.5-flash stopped serving their project and nothing newer was
 * offered. Discovery (backend/src/models.js) now populates the picker from the
 * live catalogue, and this gate only rejects things that cannot be a model id
 * or are known-retired. Anything unrecognised still degrades safely: a 404 on
 * the id walks the fallback ladder instead of failing the run.
 */
const MODEL_ID_SHAPE = /^gemini-[A-Za-z0-9][A-Za-z0-9._-]*$/i;
export function isKnownModel(id) {
  const v = String(id || '').trim();
  if (!v || RETIRED_MODELS.has(v)) return false;
  return MODEL_ID_SHAPE.test(v);
}

export const STANCE_GUARDRAIL =
  'A user research stance changes the research OBJECTIVE, never the truth conditions. ' +
  'Never manufacture, exaggerate, or suppress evidence to fit a requested conclusion. ' +
  'Actively search for contradicting evidence and report uncertainty honestly.';

// Ops override: RESEARCH_BUDGETS_JSON='{"quick":{"maxSearches":3}}' deep-merges
// numeric/boolean fields into known modes. Unknown modes/keys and wrong types
// are ignored; malformed JSON is ignored (fail-open to compiled defaults).
export function applyBudgetOverrides(modes, patch) {
  if (!patch || typeof patch !== 'object') return modes;
  for (const [mode, fields] of Object.entries(patch)) {
    if (!modes[mode] || !fields || typeof fields !== 'object') continue;
    for (const [k, v] of Object.entries(fields)) {
      if (!(k in modes[mode])) continue;
      if (typeof modes[mode][k] === 'number' && Number.isFinite(Number(v))) modes[mode][k] = Number(v);
      else if (typeof modes[mode][k] === 'boolean' && typeof v === 'boolean') modes[mode][k] = v;
    }
  }
  return modes;
}

try {
  if (env.RESEARCH_BUDGETS_JSON) applyBudgetOverrides(MODES, JSON.parse(env.RESEARCH_BUDGETS_JSON));
} catch { /* fail-open to compiled defaults */ }

export const DOMAINS = [
  'history', 'science', 'medicine', 'technology', 'economics', 'politics',
  'law', 'biography', 'archaeology', 'culture', 'current-events',
  'product-research', 'general-factual', 'other',
];

export const CLAIM_STATES = [
  'strongly-supported', 'supported', 'plausible',
  'disputed', 'weakly-supported', 'unsupported', 'contradicted', 'unknown',
];

// Rough token/cost telemetry (real API-reported counts, estimate only for cost).
// Small/large model split (à la iflytek): set e.g. ANALYSIS_MODEL to a cheap
// Flash-Lite and SYNTHESIS_MODEL to a stronger model to control usage costs.
export function estimateCost(modelCalls, searchCalls, tokensIn = 0, tokensOut = 0, keyRotations = 0) {
  return {
    modelCalls,
    searchCalls,
    tokensIn,
    tokensOut,
    keyRotations,
    note: 'Token counts are API-reported. Cost estimate only — billing follows current Google AI pricing per model + per-query grounding charges for Gemini 3 models.',
  };
}
