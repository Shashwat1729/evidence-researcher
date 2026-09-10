// Diverse query generation per line of inquiry + contradiction queries.
// Never one generic search; scholarly/primary/books/counter-evidence angles.

import { generateJson } from '../gemini.js';

const QUERY_SCHEMA = {
  type: 'object',
  properties: {
    queries: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          q: { type: 'string' },
          category: { type: 'string' },
          rationale: { type: 'string' },
        },
        required: ['q', 'category'],
      },
    },
  },
  required: ['queries'],
};

const CATEGORIES = ['general', 'scholarly', 'primary-evidence', 'books', 'alternative-explanations', 'counter-evidence', 'disagreement', 'institutional'];

export function templateQueries(question, { academic = true, books = true, contradiction = false } = {}) {
  const q = question.length > 120 ? question.slice(0, 120) : question;
  const out = [
    { q, category: 'general', rationale: 'baseline' },
    { q: `${q} scholarly research`, category: 'scholarly', rationale: 'template' },
    { q: `${q} primary sources evidence`, category: 'primary-evidence', rationale: 'template' },
    { q: `${q} university press book`, category: 'books', rationale: 'template' },
    { q: `${q} alternative explanations`, category: 'alternative-explanations', rationale: 'template' },
  ];
  if (contradiction) {
    out.push(
      { q: `${q} evidence against`, category: 'counter-evidence', rationale: 'template' },
      { q: `${q} scholars disagree criticism`, category: 'disagreement', rationale: 'template' },
    );
  }
  return out.filter((x) => (academic || x.category !== 'scholarly') && (books || x.category !== 'books'));
}

export async function generateQueries({ key, model, question, linesOfInquiry = [], count = 8, contradiction = false, onKeyEvent }) {
  const prompt = `Generate ${count} diverse web-search queries for researching this question. Cover these angles: ${(linesOfInquiry.join('; ') || 'general, scholarly, primary evidence, books, alternatives')}.
${contradiction ? 'Include queries that seek COUNTER-EVIDENCE and scholarly disagreement (e.g. "evidence against ...", "criticism of ...", "scholars reject ...").' : ''}
Question: ${question}
Categories to use: ${CATEGORIES.join(', ')}.
Return JSON: {"queries": [{"q": "...", "category": "...", "rationale": "short"}]}`;
  try {
    const { data } = await generateJson({ key, model, prompt, schema: QUERY_SCHEMA, maxTokens: 2048, thinking: 'low', onKeyEvent });
    const qs = (data.queries || []).filter((x) => x.q).slice(0, count);
    if (qs.length) return qs;
  } catch { /* fallback below */ }
  return templateQueries(question, { contradiction }).slice(0, count);
}

export function contradictionQueriesFor(claimText) {
  const c = claimText.length > 140 ? claimText.slice(0, 140) : claimText;
  return [
    { q: `${c} evidence against`, category: 'counter-evidence', rationale: 'falsification search' },
    { q: `${c} criticism scholars reject`, category: 'disagreement', rationale: 'disagreement search' },
    { q: `${c} alternative explanation`, category: 'alternative-explanations', rationale: 'alternative search' },
  ];
}

/** Effective registrable domain for diversity counting. Grounding redirect
 *  URLs (vertexaisearch) all share one host, so fall back to the chunk title
 *  hint (e.g. "unibo.it/...") — otherwise every run looks single-domain and
 *  top-ups fire wastefully even when results are actually diverse. */
export function effectiveDomain(r) {
  try {
    const h = new URL(r.url).hostname.toLowerCase();
    if (h && h !== 'vertexaisearch.cloud.google.com' && h !== 'www.vertexaisearch.cloud.google.com') {
      return h.replace(/^www\./, '');
    }
  } catch { /* fall through to title hint */ }
  const t = String(r.title || '').trim().toLowerCase().replace(/^https?:\/\//, '');
  const m = t.match(/^([a-z0-9.-]+\.[a-z]{2,})(?:\/|$)/);
  return m ? m[1] : '';
}

/** Count distinct registrable domains across result-like records. */
export function domainCount(records) {
  const hosts = new Set();
  for (const r of records || []) {
    const h = effectiveDomain(r);
    if (h) hosts.add(h);
  }
  return hosts.size;
}

const DIVERSITY_ANGLES = [
  { suffix: 'book historian university press', category: 'books' },
  { suffix: 'primary source archive document', category: 'primary-evidence' },
  { suffix: 'journal research study paper', category: 'scholarly' },
];

/** Template top-up queries biasing scholarly/primary/book angles.
 *  Used when grounding clusters on too few domains — no model call needed. */
export function diversityTopups(question, count = 3) {
  const q = question.length > 140 ? question.slice(0, 140) : question;
  return DIVERSITY_ANGLES.slice(0, count).map((a) => ({
    q: `${q} ${a.suffix}`,
    category: a.category,
    rationale: 'diversity top-up (too few distinct domains)',
  }));
}
