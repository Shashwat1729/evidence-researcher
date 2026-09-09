// Typed internal schemas (plain JS factories + validators).
// ResearchTask → ResearchPlan → SearchTask → Source → Claim → Evidence →
// Contradiction → ResearchIteration → ResearchResult → ResearchReport

import { CLAIM_STATES } from './config.js';

let seq = 0;
export function uid(prefix = 'id') {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq}`;
}

export function createTask({ question, mode = 'standard', stance = 'neutral', hypothesis = '', documentary = false }) {
  return {
    id: uid('task'),
    question: String(question || '').trim(),
    mode, stance,
    hypothesis: String(hypothesis || '').trim(),
    documentary: !!documentary,
    createdAt: new Date().toISOString(),
  };
}

export function createPlan({ domain = 'general-factual', complexity = 'medium', steps = [], linesOfInquiry = [], valid = true, clarify = '' } = {}) {
  return { domain, complexity, steps, linesOfInquiry, valid, clarify };
}

export function createSource(partial = {}) {
  return {
    id: partial.id || uid('src'),
    url: partial.url || '',
    canonicalUrl: partial.canonicalUrl || partial.url || '',
    relatedCopies: partial.relatedCopies || [],
    title: partial.title || '',
    author: partial.author || '',
    publisher: partial.publisher || '',
    publishedDate: partial.publishedDate || '',
    sourceType: partial.sourceType || 'webpage', // webpage|book|paper|primary|institutional|news|dataset|reference|social|video|other
    domain: partial.domain || '',
    discoveredVia: partial.discoveredVia || '', // grounding|academic|books|fetch|user
    tier: partial.tier ?? null, // 1..7, null = unclassified
    tierReason: partial.tierReason || '',
    authority: partial.authority || 'unknown', // high|medium|low|unknown
    proximity: partial.proximity || 'unknown', // primary|secondary|tertiary|unknown
    independence: partial.independence || 'unknown', // independent|derived|copy|unknown + group ids in relations
    accessibility: partial.accessibility || 'unknown', // full|partial|metadata-only|unavailable
    passages: partial.passages || [], // [{ text, claimHint }]
    claimsSupported: partial.claimsSupported || [],
    verified: partial.verified || false, // content actually retrieved/inspected
    note: partial.note || '',
  };
}

export function createClaim({ text, state = 'unknown', supporting = [], contradicting = [], confidenceWhy = '' } = {}) {
  return { id: uid('claim'), text, state, supporting, contradicting, confidenceWhy };
}

export function createRelation({ from, to, kind, evidence = '' }) {
  // kind: supports|contradicts|quotes|cites|summarizes|copies|references|derived_from|discusses
  return { from, to, kind, evidence };
}

export function isValidClaimState(s) {
  return CLAIM_STATES.includes(s);
}

export function validateTask(t) {
  const errors = [];
  if (!t.question || t.question.length < 3) errors.push('question too short');
  if (!['quick', 'standard', 'deep', 'exhaustive'].includes(t.mode)) errors.push('bad mode');
  if (!['neutral', 'lean', 'adversarial', 'steelman', 'comparative'].includes(t.stance)) errors.push('bad stance');
  return errors;
}
