// Typed internal schemas (plain JS factories + validators).
// ResearchTask → ResearchPlan → SearchTask → Source → Claim → Evidence →
// Contradiction → ResearchIteration → ResearchResult → ResearchReport

import { CLAIM_STATES, isKnownModel } from './config.js';

let seq = 0;
export function uid(prefix = 'id') {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${seq}`;
}

export function createTask({ question, mode = 'standard', stance = 'neutral', hypothesis = '', documentary = false, model = '' }) {
  return {
    id: uid('task'),
    question: String(question || '').trim(),
    mode, stance,
    hypothesis: String(hypothesis || '').trim(),
    documentary: !!documentary,
    model: String(model || '').trim(),
    createdAt: new Date().toISOString(),
  };
}

export function createPlan({ domain = 'general-factual', complexity = 'medium', steps = [], linesOfInquiry = [], valid = true, clarify = '', queries = [], bookVariants = [], arc = [] } = {}) {
  const cleanQueries = Array.isArray(queries)
    ? queries.filter((q) => q && String(q.q || '').trim()).slice(0, 24)
    : [];
  const cleanVariants = Array.isArray(bookVariants)
    ? bookVariants.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 4)
    : [];
  const cleanArc = Array.isArray(arc)
    ? arc
        .map((b) => ({ title: String(b?.title || '').trim().slice(0, 120), focus: String(b?.focus || '').trim().slice(0, 300) }))
        .filter((b) => b.title && b.focus)
        .slice(0, 8)
    : [];
  return { domain, complexity, steps, linesOfInquiry, valid, clarify, queries: cleanQueries, bookVariants: cleanVariants, arc: cleanArc };
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
  if (t.model && !isKnownModel(t.model)) errors.push('unknown model');
  return errors;
}
