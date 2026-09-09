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
