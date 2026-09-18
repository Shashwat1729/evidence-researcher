// Contradiction + gap detection (Gemini structured output).
// Anti-confirmation-bias: every major claim asks "what would make this wrong?"

import { generateJson } from '../gemini.js';

const SCHEMA = {
  type: 'object',
  properties: {
    contradictions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claimId: { type: 'string' },
          against: { type: 'string' },
          sources: { type: 'array', items: { type: 'string' } },
          severity: { type: 'string' },
        },
        required: ['against'],
      },
    },
    gaps: { type: 'array', items: { type: 'string' } },
    sufficient: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['contradictions', 'gaps', 'sufficient'],
};

export function normalizeReview(data, sources, iteration) {
  const valid = new Set(sources.map((s) => s.id));
  return {
    contradictions: (data.contradictions || []).map((c, i) => ({
      id: `contra_${Date.now().toString(36)}_${i}`,
      claimId: c.claimId || '',
      against: String(c.against || '').slice(0, 500),
      sources: (c.sources || []).filter((id) => valid.has(id)),
      severity: ['high', 'medium', 'low'].includes(c.severity) ? c.severity : 'medium',
    })).filter((c) => c.against),
    gaps: (data.gaps || []).map(String).slice(0, 12),
    sufficient: !!data.sufficient,
    reason: String(data.reason || ''),
  };
}

export async function findContradictionsAndGaps({ key, model, question, claims, sources, iteration, onKeyEvent }) {
  // Whole claim objects only (never slice JSON mid-object) — cap by COUNT.
  const claimObjs = claims.slice(0, 15).map((c) => ({ id: c.id, text: c.text, state: c.state }));
  const prompt = `You are a skeptical reviewer. Given the research so far, find contradictions and knowledge gaps.

Question: ${question}
Iteration: ${iteration}
Claims: ${JSON.stringify(claimObjs)}
Source ids available: ${sources.map((s) => s.id).join(', ')}

Tasks:
1. For each major claim, state what evidence would make it WRONG and whether any source provides it.
2. List knowledge gaps: what was searched vs found vs verified vs still uncertain.
3. sufficient: true only if the evidence genuinely answers the question (not merely "many pages agree").
Return JSON: {"contradictions": [{"claimId": "...", "against": "counter-claim text", "sources": ["id"], "severity": "high|medium|low"}], "gaps": ["..."], "sufficient": false, "reason": "..."}`;
  try {
    const { data } = await generateJson({ key, model, prompt, schema: SCHEMA, maxTokens: 3072, thinking: 'low', onKeyEvent });
    return normalizeReview(data, sources, iteration);
  } catch {
    // A failed review must NEVER declare the evidence sufficient — that
    // would skip contradiction hunting on the model's silence. Stay
    // provisional; maxIterations still bounds the loop.
    return { contradictions: [], gaps: ['Model review unavailable — treating evidence as provisional.'], sufficient: false, reason: 'fallback' };
  }
}
