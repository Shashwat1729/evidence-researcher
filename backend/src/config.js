// Central configuration: models, research modes, budgets, stance.
// All Gemini model names are configurable via env; no other provider is required.
// Browser-safe: `process` is guarded so these modules also run in the
// GitHub-Pages static build (see frontend/direct.js).

const env = (typeof process !== 'undefined' && process.env) || {};

export const MODEL_CONFIG = {
  // Verified live 2026-09-18 with real generate calls on a NEW free-tier key
  // (not just ListModels, which lies by omission): gemini-2.5-flash,
  // gemini-flash-latest, and gemini-flash-lite-latest all return 200 (lite
  // answered fastest at ~0.9s); gemini-2.5-flash-lite AND gemini-2.5-pro both
  // 404 ("no longer available to new users"). Limits are per model per
  // project, so planning/analysis ride the lite alias while research and
  // synthesis use flash — two live buckets instead of one.
  planner: env.PLANNER_MODEL || env.DEFAULT_MODEL || 'gemini-flash-lite-latest',
  research: env.RESEARCH_MODEL || env.DEFAULT_MODEL || 'gemini-2.5-flash',
  analysis: env.ANALYSIS_MODEL || env.DEFAULT_MODEL || 'gemini-flash-lite-latest',
  synthesis: env.SYNTHESIS_MODEL || env.DEFAULT_MODEL || 'gemini-2.5-flash',
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
// Verified live 2026-09-18 with REAL generate calls on a new free-tier key:
// every id below returned HTTP 200 (flash-lite-latest fastest at ~0.9s).
// The 1.5/2.0 families are retired (canonicalized to Auto below); 2.5-lite
// and 2.5-pro 404 for new keys ("no longer available to new users") so they
// are NOT offered — but stay accepted for old keys that still have access
// (COMPAT_MODELS), with automatic fallback to the default on 404.
export const AVAILABLE_MODELS = [
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', blurb: 'Default — best balance of depth and free-tier quota (10 RPM).' },
  { id: 'gemini-flash-lite-latest', label: 'Gemini Flash-Lite (latest)', blurb: 'Fastest, most quota headroom — verified on new keys, best for planning.' },
  { id: 'gemini-flash-latest', label: 'Gemini Flash (latest)', blurb: 'Tracks the newest flash — an extra quota bucket for research.' },
];

// Legacy ids: accepted (old keys may still resolve them) but never offered
// and never defaulted. A 404 on these triggers automatic fallback, never a
// dead run.
const COMPAT_MODELS = new Set(['gemini-2.5-flash-lite', 'gemini-2.5-pro']);

export function isKnownModel(id) {
  return AVAILABLE_MODELS.some((m) => m.id === id) || COMPAT_MODELS.has(id);
}

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
