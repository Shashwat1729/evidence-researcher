// Contradiction + gap detection (Gemini structured output).
// Anti-confirmation-bias: every major claim asks "what would make this wrong?"

import { generateJson } from '../gemini.js';
import { UNTRUSTED_BANNER } from '../trust.js';

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

export function normalizeReview(data, sources, claimsOrIteration) {
  const valid = new Set(sources.map((s) => s.id));
  const claims = Array.isArray(claimsOrIteration) ? claimsOrIteration : [];
  const claimIds = new Set(claims.map((c) => c.id));
  return {
    // Drop contradictions whose claimId the model hallucinated — an
    // unknown claimId otherwise penalizes every claim's confidence.
    contradictions: (data.contradictions || []).filter((c) => !c.claimId || claimIds.size === 0 || claimIds.has(c.claimId)).map((c, i) => ({
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
  // Reviewer gets fitted excerpts per claim (not just ids) so it can judge
  // contradictions against evidence instead of hallucinating counter-claims.
  const exById = new Map((sources || []).map((s) => [s.id, ((s.passages || []).map((p) => p.text).join(' ') || s.snippet || '').slice(0, 600)]));
  const claimObjs = claims.slice(0, 15).map((c) => ({
    id: c.id, text: c.text, state: c.state,
    evidence: [...(c.supporting || []), ...(c.contradicting || [])].slice(0, 3).map((id) => ({ id, excerpt: exById.get(id) || '' })).filter((e) => e.excerpt),
  }));
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
  // Trust: claims/source text are model+web output — data, never instructions.
  const guardedPrompt = `${prompt}\n${UNTRUSTED_BANNER}`;
  try {
    const { data } = await generateJson({ key, model, prompt: guardedPrompt, schema: SCHEMA, maxTokens: 3072, thinking: 'low', onKeyEvent });
    return normalizeReview(data, sources, claims);
  } catch {
    // A failed review must NEVER declare the evidence sufficient — that
    // would skip contradiction hunting on the model's silence. Empty gaps:
    // a sentinel sentence here became a nonsense follow-up search query.
    return { contradictions: [], gaps: [], sufficient: false, reason: 'fallback' };
  }
}
