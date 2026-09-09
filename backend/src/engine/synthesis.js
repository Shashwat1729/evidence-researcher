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
  },
  required: ['executiveSummary', 'findings', 'uncertainty', 'methodology'],
};

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
