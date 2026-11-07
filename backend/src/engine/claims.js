// Claim extraction + claim-level confidence (Gemini structured output).
// Claims link to real source ids only — enforced by citation-integrity check.

import { generateJson } from '../gemini.js';
import { isValidClaimState } from '../schemas.js';
import { normalizeReview } from './contradictions.js';
import { wrapEvidenceBlock } from '../trust.js';

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

export function buildClaimsPrompt(question, srcJson, minClaims = 6, withReview = false) {
  const base = `Extract the key factual claims relevant to the research question, with claim-level confidence${withReview ? ' — then review them skeptically' : ''}.

Question: ${question}

Sources (use ONLY these ids when linking evidence; never invent source ids):
${wrapEvidenceBlock([{ text: srcJson }])}

Rules:
- Extract AT LEAST ${minClaims} distinct claims when the evidence supports that many — cover the most important factual assertions for the question's domain (dates/chronology, key entities and places, mechanisms or reasoning, major interpretations, and points of disagreement as appropriate). Fewer is acceptable ONLY if the sources genuinely contain less.
- Each claim: one verifiable assertion.`;
  if (!withReview) {
    return `${base}
- state ∈ strongly-supported|supported|plausible|disputed|weakly-supported|unsupported|contradicted|unknown.
- "many mentions" ≠ strong evidence: require source QUALITY + INDEPENDENCE for supported/strongly-supported.
- confidenceWhy: one sentence naming what establishes or undermines the claim.
- supporting/contradicting: arrays of source ids from the list above.
Return JSON: {"claims": [{"text": "...", "state": "...", "supporting": ["id"], "contradicting": ["id"], "confidenceWhy": "..."}]}`;
  }
  return `${base}
- state ∈ strongly-supported|supported|plausible|disputed|weakly-supported|unsupported|contradicted|unknown.
- "many mentions" ≠ strong evidence: require source QUALITY + INDEPENDENCE for supported/strongly-supported.
- confidenceWhy: one sentence naming what establishes or undermines the claim.
- supporting/contradicting: arrays of source ids from the list above.

Part 2 — review. For each major claim, state what evidence would make it WRONG
and whether any source provides it. List knowledge gaps (searched vs found vs
verified vs uncertain). Set sufficient true only if the evidence genuinely
answers the question.

Return JSON: {"claims": [{"text": "...", "state": "...", "supporting": ["id"], "contradicting": ["id"], "confidenceWhy": "..."}], "contradictions": [{"claimId": "...", "against": "...", "sources": ["id"], "severity": "high|medium|low"}], "gaps": ["..."], "sufficient": false, "reason": "..."}`;
}

// HiSS-style decomposition (Zeng et al., 2208.10060): compound claims such as
// "Harappans traded X via Y route" hide several verifiable sub-facts. Verifying
// leaves then aggregating is strictly more accurate than scoring the compound
// whole. Deterministic splitter (no extra model calls): splits on strong
// coordinators, filters trivial fragments, caps at 4 leaves.
/** Split a claim text into atomic sub-claims (pure). */
export function decomposeClaim(text, maxLeaves = 4) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  if (!t || t.length <= 80) return [t].filter(Boolean);
  const parts = t
    .split(/\s*[;—]\s*|\s+(?:and|while|whereas)\s+(?=[A-Z0-9])|\s+which\s+(?=[a-z])/)
    .map((p) => p.trim())
    .filter((p) => p.length >= 25);
  if (parts.length <= 1) return [t];
  return parts.slice(0, maxLeaves);
}

/** Attach decomposition tree to claims (pure). */
export function attachDecomposition(claims) {
  return (claims || []).map((c) => ({
    ...c,
    subClaims: decomposeClaim(c.text).map((sub, i) => ({
      id: `${c.id}.s${i + 1}`,
      text: sub,
      // Leaves inherit the parent's links (safest offline approximation);
      // verification refines them downstream.
      supporting: [...(c.supporting || [])],
      contradicting: [...(c.contradicting || [])],
    })),
  }));
}

/** Aggregate leaf verdicts into a parent state (pure). Any contradicted leaf
 *  caps the parent at disputed; any unsupported leaf caps at plausible. */
export function aggregateSubClaims(leafStates) {
  const set = new Set(leafStates || []);
  if (set.has('contradicted')) return 'disputed';
  if (set.has('unsupported')) return 'plausible';
  if (set.has('unknown')) return 'supported';
  if (set.size === 1) return leafStates[0];
  return 'supported';
}

/** Fit whole source records into a char budget (best-first; sources arrive
 *  tier-sorted). Never slices mid-record — the old `.slice(0, 12000)` cut
 *  JSON mid-object and silently dropped the tail. Smaller prompts also burn
 *  less TPM quota, which is what throttles big late-phase calls. Exported
 *  for tests. */
export function fitSourcesBudget(sources, budgetChars = 12000) {
  const picked = [];
  let used = 0;
  for (const s of sources) {
    const rec = {
      id: s.id, title: s.title, url: s.url, tier: s.tier,
      excerpt: (s.passages?.[0]?.text || s.snippet || '').slice(0, 600),
    };
    const j = JSON.stringify(rec);
    if (used + j.length > budgetChars && picked.length) break;
    picked.push(rec);
    used += j.length;
  }
  return picked;
}

export async function extractClaims({ key, model, question, sources, onKeyEvent, minClaims = 6, maxTokens = 4096 }) {
  const prompt = buildClaimsPrompt(question, JSON.stringify(fitSourcesBudget(sources)), minClaims, false);
  const { data } = await generateJson({ key, model, prompt, schema: CLAIMS_SCHEMA, maxTokens, thinking: 'low', onKeyEvent });
  return normalizeClaims(data, sources);
}

export function normalizeClaims(data, sources) {
  const validIds = new Set(sources.map((s) => s.id));
  const claims = (data.claims || []).slice(0, 30).map((c, i) => ({
    // Counter + random suffix: Date.now() alone collides when two iterations
    // run in the same millisecond, producing duplicate claim ids.
    id: `claim_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}_${i}`,
    text: String(c.text || '').slice(0, 500),
    state: isValidClaimState(c.state) ? c.state : 'unknown',
    // citation integrity: drop links to non-existent sources
    supporting: (c.supporting || []).filter((id) => validIds.has(id)),
    contradicting: (c.contradicting || []).filter((id) => validIds.has(id)),
    confidenceWhy: String(c.confidenceWhy || ''),
  })).filter((c) => c.text);
  return attachDecomposition(claims);
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

export async function extractClaimsWithReview({ key, model, question, sources, onKeyEvent, minClaims = 6, maxTokens = 5120 }) {
  const prompt = buildClaimsPrompt(question, JSON.stringify(fitSourcesBudget(sources)), minClaims, true);
  const { data } = await generateJson({ key, model, prompt, schema: CLAIMS_REVIEW_SCHEMA, maxTokens, thinking: 'low', onKeyEvent });
  return {
    claims: normalizeClaims(data, sources),
    review: normalizeReview(data, sources, 1),
  };
}
