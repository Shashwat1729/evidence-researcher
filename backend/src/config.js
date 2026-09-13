// Central configuration: models, research modes, budgets, stance.
// All Gemini model names are configurable via env; no other provider is required.
// Browser-safe: `process` is guarded so these modules also run in the
// GitHub-Pages static build (see frontend/direct.js).

const env = (typeof process !== 'undefined' && process.env) || {};

export const MODEL_CONFIG = {
  planner: env.PLANNER_MODEL || env.DEFAULT_MODEL || 'gemini-2.5-flash',
  research: env.RESEARCH_MODEL || env.DEFAULT_MODEL || 'gemini-2.5-flash',
  analysis: env.ANALYSIS_MODEL || env.DEFAULT_MODEL || 'gemini-2.5-flash',
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
    maxRuntimeMs: 600_000,
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
    maxRuntimeMs: 1_200_000,
    maxTokensOut: 500_000,
    reportTokens: 8192,
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
    maxRuntimeMs: 2_400_000,
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
// Free-tier limits differ per model: flash = most headroom, pro = deepest
// reasoning but much tighter free limits. Served via /api/config; a per-run
// override applies to all four model roles (planner/research/analysis/synthesis).
export const AVAILABLE_MODELS = [
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', blurb: 'Default — best balance of depth and free-tier quota.' },
  { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash', blurb: 'Lighter and faster; generous limits, slightly less depth.' },
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', blurb: 'Deepest reasoning; much lower free-tier limits — prefer paid keys.' },
];

export function isKnownModel(id) {
  return AVAILABLE_MODELS.some((m) => m.id === id);
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
