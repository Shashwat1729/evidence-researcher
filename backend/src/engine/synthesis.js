// Final report synthesis. Structured sections per spec §21.
// Every factual claim must cite real source ids (citation-integrity checked
// by the orchestrator after generation). No invented URLs/pages/DOIs.

import { generateJson } from '../gemini.js';
import { STANCE_GUARDRAIL } from '../config.js';

const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    executiveSummary: { type: 'string' },
    established: { type: 'array', items: { type: 'string' } },
    findings: { type: 'array', items: { type: 'object', properties: { heading: { type: 'string' }, body: { type: 'string' }, cite: { type: 'array', items: { type: 'string' } } } } },
    competing: { type: 'array', items: { type: 'string' } },
    contradictions: { type: 'array', items: { type: 'string' } },
    sourceQuality: { type: 'string' },
    independence: { type: 'string' },
    books: { type: 'array', items: { type: 'string' } },
    primarySources: { type: 'array', items: { type: 'string' } },
    uncertainty: { type: 'array', items: { type: 'string' } },
    gaps: { type: 'array', items: { type: 'string' } },
    methodology: { type: 'string' },
    synthesisFallback: { type: 'boolean' },
  },
  required: ['executiveSummary', 'findings', 'uncertainty', 'methodology'],
};

// Zero-model fallback: when synthesis itself is unavailable (quota exhausted),
// assemble an honest evidence inventory instead of failing the whole run.
// Every section is derived from retrieved records — nothing invented.
// Flagged via synthesisFallback so the UI can say so plainly.
export function templateReport({ task, plan, claims, sources, contradictions, provenance, gaps = [] }) {
  const valid = new Set(sources.map((s) => s.id));
  const link = (ids) => (ids || []).filter((id) => valid.has(id));
  const byTier = {};
  for (const s of sources) byTier[s.tier ?? '?'] = (byTier[s.tier ?? '?'] || 0) + 1;
  const tierSummary = Object.entries(byTier).map(([t, n]) => `tier ${t}: ${n}`).join(', ') || 'none classified';
  const books = sources.filter((s) => s.sourceType === 'book');
  const primaries = sources.filter((s) => s.tier === 1 || s.proximity === 'primary');
  const verifiedCount = sources.filter((s) => s.verified).length;
  return {
    executiveSummary:
      `Automated synthesis was unavailable (model quota or outage), so no interpreted findings could be written. ` +
      `What WAS gathered: ${sources.length} source(s) (${tierSummary}; ${verifiedCount} inspected), ` +
      `${claims.length} extracted claim(s), ${contradictions.length} flagged contradiction(s). ` +
      `Use the Sources/Books tabs to inspect the raw evidence below — everything listed was actually retrieved.`,
    established: [],
    findings: claims.slice(0, 15).map((c) => ({
      heading: c.text.slice(0, 90),
      body: `${c.text} [Claim state: ${c.state}${c.confidenceWhy ? ` — ${c.confidenceWhy}` : ''}] (Uninterpreted extract — model synthesis unavailable.)`,
      cite: link([...(c.supporting || []), ...(c.contradicting || [])]),
    })),
    competing: [],
    contradictions: contradictions.map((c) => c.against).filter(Boolean),
    sourceQuality: `Gathered ${sources.length} source(s): ${tierSummary}. ${verifiedCount} page(s) fully inspected; the rest are metadata or grounding excerpts. Strongest available: ` +
      (sources.filter((s) => (s.tier ?? 9) <= 3).slice(0, 3).map((s) => s.title || s.domain).join('; ') || 'none above tier 3 — treat all findings as provisional.'),
    independence: provenance.note || 'Source independence could not be determined.',
    books: books.map((b) => `${b.title || 'Untitled'} — ${(b.meta?.authors || []).join(', ') || b.author || 'unknown author'} (${b.meta?.year || b.publishedDate || 'n.d.'}). ${b.url} (metadata only — text not inspected)`),
    primarySources: primaries.map((p) => `${p.title || p.url} — ${p.url}`),
    uncertainty: [
      'Model synthesis was unavailable, so no interpreted conclusions exist in this report.',
      ...gaps.map(String).slice(0, 8),
    ],
    gaps: gaps.map(String).slice(0, 10),
    methodology: `Research ran in ${task.mode} mode (${plan.domain} domain): planned, searched broadly with dedup, classified sources into tiers, extracted claims where possible. Synthesis fell back to an evidence inventory when the model was unreachable. Stance: ${task.stance}.`,
    synthesisFallback: true,
  };
}

export async function synthesizeReport({ key, model, task, plan, claims, sources, contradictions, provenance, stats, documentary, onKeyEvent, maxTokens = 8192 }) {
  const srcIndex = sources.map((s) => ({
    id: s.id, title: s.title, url: s.url, tier: s.tier, author: s.author,
    verified: s.verified, accessibility: s.accessibility,
  }));
  const prompt = `Write the final evidence-first research report as JSON.

Question: ${task.question}
Mode: ${task.mode} | Stance: ${task.stance}${task.hypothesis ? ` | User hypothesis: ${task.hypothesis}` : ''}
${task.stance !== 'neutral' ? `DISCLOSURE: the user requested a "${task.stance}" investigation of their hypothesis. Disclose this stance in the methodology and report contradicting evidence anyway. ${STANCE_GUARDRAIL}` : ''}
Domain: ${plan.domain}
${documentary ? 'DOCUMENTARY MODE: emphasize chronology, key people, primary evidence, myths-vs-evidence, claims needing caution, surprising findings. Do NOT sensationalize.' : ''}

Claims (with states): ${JSON.stringify(claims.map((c) => ({ id: c.id, text: c.text, state: c.state, supporting: c.supporting, contradicting: c.contradicting, why: c.confidenceWhy }))).slice(0, 10000)}
Contradictions: ${JSON.stringify(contradictions).slice(0, 4000)}
Provenance: ${JSON.stringify(provenance).slice(0, 3000)}
Sources (cite ONLY these ids/urls; if a page number cannot be verified write "Page number not verified"; never invent URLs, authors, dates, DOIs, quotes): ${JSON.stringify(srcIndex).slice(0, 12000)}
Research stats: ${JSON.stringify(stats)}

Rules:
- Confidence is CLAIM-LEVEL (qualitative: high/medium/low/disputed) — never one global percentage.
- Distinguish: searched vs found vs verified vs uncertain.
- If evidence is insufficient, SAY SO explicitly.
- findings[].cite must contain only source ids from the list above.
Return JSON with keys: executiveSummary, established, findings[{heading, body, cite}], competing, contradictions, sourceQuality, independence, books, primarySources, uncertainty, gaps, methodology.`;
  const { data } = await generateJson({ key, model, prompt, schema: REPORT_SCHEMA, maxTokens, temperature: 0.3, onKeyEvent });
  return data;
}
