// Claim extraction + claim-level confidence (Gemini structured output).
// Claims link to real source ids only — enforced by citation-integrity check.

import { generateJson } from '../gemini.js';
import { isValidClaimState } from '../schemas.js';
import { normalizeReview } from './contradictions.js';

const CLAIMS_SCHEMA = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          state: { type: 'string' },
          supporting: { type: 'array', items: { type: 'string' } },
          contradicting: { type: 'array', items: { type: 'string' } },
          confidenceWhy: { type: 'string' },
        },
        required: ['text', 'state'],
      },
    },
  },
  required: ['claims'],
};

export async function extractClaims({ key, model, question, sources, onKeyEvent }) {
  const srcList = sources.map((s) => ({
    id: s.id, title: s.title, url: s.url, tier: s.tier,
    excerpt: (s.passages?.[0]?.text || s.snippet || '').slice(0, 600),
  }));
  const prompt = `Extract the key factual claims relevant to the research question, with claim-level confidence.

Question: ${question}

Sources (use ONLY these ids when linking evidence; never invent source ids):
${JSON.stringify(srcList).slice(0, 12000)}

Rules:
- Each claim: one verifiable assertion.
- state ∈ strongly-supported|supported|plausible|disputed|weakly-supported|unsupported|contradicted|unknown.
- "many mentions" ≠ strong evidence: require source QUALITY + INDEPENDENCE for supported/strongly-supported.
- confidenceWhy: one sentence naming what establishes or undermines the claim.
- supporting/contradicting: arrays of source ids from the list above.
Return JSON: {"claims": [{"text": "...", "state": "...", "supporting": ["id"], "contradicting": ["id"], "confidenceWhy": "..."}]}`;
  const { data } = await generateJson({ key, model, prompt, schema: CLAIMS_SCHEMA, maxTokens: 4096, thinking: 'low', onKeyEvent });
  return normalizeClaims(data, sources);
}

export function normalizeClaims(data, sources) {
  const validIds = new Set(sources.map((s) => s.id));
  return (data.claims || []).slice(0, 30).map((c, i) => ({
    id: `claim_${Date.now().toString(36)}_${i}`,
    text: String(c.text || '').slice(0, 500),
    state: isValidClaimState(c.state) ? c.state : 'unknown',
    // citation integrity: drop links to non-existent sources
    supporting: (c.supporting || []).filter((id) => validIds.has(id)),
    contradicting: (c.contradicting || []).filter((id) => validIds.has(id)),
    confidenceWhy: String(c.confidenceWhy || ''),
  })).filter((c) => c.text);
}

// Merged extract + skeptical review in ONE model call (quick mode).
// Same inputs as running extractClaims then findContradictionsAndGaps, one
// round-trip instead of two. Saves 1 call/run where quota is the constraint;
// deeper modes keep the separate two-pass review for higher rigor.
const CLAIMS_REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    claims: CLAIMS_SCHEMA.properties.claims,
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
  required: ['claims'],
};

export async function extractClaimsWithReview({ key, model, question, sources, onKeyEvent }) {
  const srcList = sources.map((s) => ({
    id: s.id, title: s.title, url: s.url, tier: s.tier,
    excerpt: (s.passages?.[0]?.text || s.snippet || '').slice(0, 600),
  }));
  const prompt = `Extract the key factual claims relevant to the research question, with claim-level confidence — then review them skeptically.

Question: ${question}

Sources (use ONLY these ids when linking evidence; never invent source ids):
${JSON.stringify(srcList).slice(0, 12000)}

Part 1 — claims. Rules:
- Each claim: one verifiable assertion.
- state ∈ strongly-supported|supported|plausible|disputed|weakly-supported|unsupported|contradicted|unknown.
- "many mentions" ≠ strong evidence: require source QUALITY + INDEPENDENCE for supported/strongly-supported.
- confidenceWhy: one sentence naming what establishes or undermines the claim.
- supporting/contradicting: arrays of source ids from the list above.

Part 2 — review. For each major claim, state what evidence would make it WRONG
and whether any source provides it. List knowledge gaps (searched vs found vs
verified vs uncertain). Set sufficient true only if the evidence genuinely
answers the question.

Return JSON: {"claims": [{"text": "...", "state": "...", "supporting": ["id"], "contradicting": ["id"], "confidenceWhy": "..."}], "contradictions": [{"claimId": "...", "against": "...", "sources": ["id"], "severity": "high|medium|low"}], "gaps": ["..."], "sufficient": false, "reason": "..."}`;
  const { data } = await generateJson({ key, model, prompt, schema: CLAIMS_REVIEW_SCHEMA, maxTokens: 5120, thinking: 'low', onKeyEvent });
  return {
    claims: normalizeClaims(data, sources),
    review: normalizeReview(data, sources, 1),
  };
}
