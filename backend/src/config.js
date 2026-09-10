// Central configuration: models, research modes, budgets, stance.
// All Gemini model names are configurable via env; no other provider is required.

export const MODEL_CONFIG = {
  planner: process.env.PLANNER_MODEL || process.env.DEFAULT_MODEL || 'gemini-2.5-flash',
  research: process.env.RESEARCH_MODEL || process.env.DEFAULT_MODEL || 'gemini-2.5-flash',
  analysis: process.env.ANALYSIS_MODEL || process.env.DEFAULT_MODEL || 'gemini-2.5-flash',
  synthesis: process.env.SYNTHESIS_MODEL || process.env.DEFAULT_MODEL || 'gemini-2.5-flash',
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
    maxRuntimeMs: 300_000,
    maxTokensOut: 150_000,
    reportTokens: 4096,
    contradictionPasses: 1,
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
    maxRuntimeMs: 900_000,
    maxTokensOut: 500_000,
    reportTokens: 8192,
    contradictionPasses: 2,
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
    maxRuntimeMs: 1_800_000,
    maxTokensOut: 1_200_000,
    reportTokens: 8192,
    contradictionPasses: 3,
    academic: true,
    books: true,
  },
};

export const STANCES = ['neutral', 'lean', 'adversarial', 'steelman', 'comparative'];

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
  if (process.env.RESEARCH_BUDGETS_JSON) applyBudgetOverrides(MODES, JSON.parse(process.env.RESEARCH_BUDGETS_JSON));
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
