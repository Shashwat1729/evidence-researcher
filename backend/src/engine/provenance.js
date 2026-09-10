// Provenance: detect when N pages repeat ONE underlying source.
// Heuristics (shared quotes, shared citations, syndication markers) propose
// candidate relations; Gemini confirms derived_from vs independent.
// Never fabricate: unknown stays unknown.

import { generateJson } from '../gemini.js';
import { fingerprint, jaccardSets } from './dedup.js';

/** Heuristic pass: group sources sharing distinctive quoted strings. */
export function heuristicGroups(sources) {
  const groups = [];
  const used = new Set();
  // Fingerprints + joined text computed once per source (not per pair).
  const prepared = (sources || []).map((s) => {
    const text = ((s.passages || []).map((p) => p.text).join(' ')).slice(0, 3000);
    return { s, text, fp: fingerprint(text) };
  }).filter((p) => p.text.length > 0);
  for (let i = 0; i < prepared.length; i++) {
    if (used.has(prepared[i].s.id)) continue;
    const group = [prepared[i].s];
    for (let j = i + 1; j < prepared.length; j++) {
      if (used.has(prepared[j].s.id)) continue;
      const sim = jaccardSets(prepared[i].fp, prepared[j].fp);
      const sameQuote = sharedQuote(prepared[i].text, prepared[j].text);
      if (sim > 0.55 || sameQuote) {
        group.push(prepared[j].s);
        used.add(prepared[j].s.id);
      }
    }
    if (group.length > 1) { groups.push(group); used.add(prepared[i].s.id); }
  }
  return groups;
}

function sharedQuote(a, b) {
  // A shared verbatim span ≥ 12 words suggests copying/derivation.
  const words = (s) => s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const A = words(a), B = new Set();
  const bWords = words(b);
  for (let i = 0; i + 12 <= bWords.length; i++) B.add(bWords.slice(i, i + 12).join(' '));
  for (let i = 0; i + 12 <= A.length; i++) {
    if (B.has(A.slice(i, i + 12).join(' '))) return true;
  }
  return false;
}

export async function analyzeProvenance({ key, model, sources, onKeyEvent }) {
  const groups = heuristicGroups(sources);
  if (!groups.length) {
    return { groups: [], relations: [], note: 'No textual overlap detected; source independence could not be determined beyond this check.' };
  }
  const relations = [];
  // Confirm each candidate group with the model (bounded: max 6 groups).
  for (const g of groups.slice(0, 6)) {
    const ids = new Set(g.map((s) => s.id));
    const desc = g.map((s) => ({ id: s.id, title: s.title, url: s.url, excerpt: (s.passages || []).map((p) => p.text).join(' ').slice(0, 800) }));
    const prompt = `These web sources have overlapping text. Determine whether they are INDEPENDENT confirmations or DERIVED from a common source.
Sources: ${JSON.stringify(desc).slice(0, 6000)}
Return JSON: {"verdict": "independent|derived|unclear", "root": "<source id of likely original or ''>", "explanation": "one sentence"}`;
    try {
      const { data } = await generateJson({
        key, model, prompt, onKeyEvent, thinking: 'low',
        schema: { type: 'object', properties: { verdict: { type: 'string' }, root: { type: 'string' }, explanation: { type: 'string' } }, required: ['verdict'] },
        maxTokens: 512,
      });
      const verdict = data.verdict || 'unclear';
      // Integrity: only link a root that is actually in this group — a
      // hallucinated id must never enter the relation graph.
      if (verdict === 'derived' && data.root && ids.has(data.root)) {
        for (const s of g) {
          if (s.id !== data.root) relations.push({ from: s.id, to: data.root, kind: 'derived_from', evidence: data.explanation || 'textual overlap' });
        }
      }
      g.verdict = verdict;
      g.explanation = data.explanation || '';
    } catch {
      g.verdict = 'unclear';
    }
  }
  return {
    groups: groups.map((g) => ({ ids: g.map((s) => s.id), verdict: g.verdict || 'unclear', explanation: g.explanation || '' })),
    relations,
    note: relations.length
      ? `Although multiple pages repeat related claims, ${relations.length} derivation link(s) were found — they should not be counted as independent confirmations.`
      : 'Source independence could not be determined.',
  };
}
