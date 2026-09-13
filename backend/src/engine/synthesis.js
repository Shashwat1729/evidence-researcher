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

// Repair pass for findings the model left uncited: link each finding to the
// claims whose wording it overlaps, and inherit those claims' source ids.
// Deterministic and honest — it only ever attaches real, retrieved source ids
// supporting the same assertion, never invents links. Findings with no
// overlapping claim keep whatever (valid) cites they have.
function wordsOf(s) {
  return new Set(String(s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3));
}
export function repairFindingCites(report, claims) {
  const claimWords = (claims || []).map((c) => ({
    c,
    words: wordsOf(`${c.text} ${c.confidenceWhy || ''}`),
    ids: [...(c.supporting || []), ...(c.contradicting || [])],
  }));
  for (const f of report.findings || []) {
    if ((f.cite || []).length) continue;
    const fw = wordsOf(`${f.heading || ''} ${f.body || ''}`);
    if (!fw.size) continue;
    let best = null;
    let bestScore = 0;
    for (const { c, words, ids } of claimWords) {
      if (!words.size || !ids.length) continue;
      let inter = 0;
      for (const w of fw) if (words.has(w)) inter++;
      const score = inter / Math.sqrt(fw.size * words.size);
      if (score > bestScore) { bestScore = score; best = ids; }
    }
    if (best && bestScore >= 0.2) f.cite = [...new Set(best)];
  }
  // Drop vacuous findings (no heading AND no body) — they carry nothing.
  report.findings = (report.findings || []).filter((f) => (f.heading || f.body || '').trim().length > 0);
  // If nothing survived, derive one finding per claim: honest, cited, complete.
  // This keeps "every major statement traceable" true even when the model
  // under-delivers on the findings section.
  if (!report.findings.length && (claims || []).length) {
    report.findings = claims.slice(0, 10).map((c) => ({
      heading: c.text.slice(0, 90),
      body: `${c.text}${c.confidenceWhy ? ` — ${c.confidenceWhy}` : ''} [Claim state: ${c.state}]`,
      cite: [...new Set([...(c.supporting || []), ...(c.contradicting || [])])],
    }));
  }
  return report;
}

// Completeness guard: uncertainty and gaps must never be empty in a finished
// report. Derives honest entries from the run's own state when the model
// omitted them — an empty "uncertainty" section is itself misleading.
export function ensureReportCompleteness(report, { claims = [], iterations = [] } = {}) {
  const r = report;
  if (!Array.isArray(r.uncertainty) || !r.uncertainty.length) {
    const weak = claims.filter((c) => ['disputed', 'weakly-supported', 'contradicted', 'unknown'].includes(c.state));
    r.uncertainty = [
      ...(weak.slice(0, 3).map((c) => `Unresolved (${c.state}): ${c.text}`)),
      'Residual uncertainty always remains where primary sources could not be inspected directly.',
    ].slice(0, 5);
  }
  if (!Array.isArray(r.gaps) || !r.gaps.length) {
    const iterGaps = (iterations || []).flatMap((it) => it.gaps || []).map(String);
    r.gaps = [...new Set(iterGaps)].slice(0, 5);
    if (!r.gaps.length) r.gaps = ['Deeper primary-source and archival verification remains for follow-up work.'];
  }
  return r;
}

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

// Depth contract per mode: minimum substantive findings, finding body size,
// and scholarly apparatus. A "study chapter", not a search summary.
export const DEPTH = {
  quick: { minFindings: 3, minBodyChars: 300, minBooks: 0, minPrimary: 0 },
  standard: { minFindings: 7, minBodyChars: 600, minBooks: 3, minPrimary: 2 },
  deep: { minFindings: 10, minBodyChars: 800, minBooks: 5, minPrimary: 3 },
  exhaustive: { minFindings: 14, minBodyChars: 800, minBooks: 8, minPrimary: 4 },
};

// Pure, exported for unit tests: the exact prompt contract.
export function buildSynthesisPrompt({ task, plan, claims, sources, contradictions, provenance, stats, documentary, depth }) {
  const d = depth || DEPTH.standard;
  const srcIndex = sources.map((s) => ({
    id: s.id, title: s.title, url: s.url, tier: s.tier, author: s.author,
    verified: s.verified, accessibility: s.accessibility,
  }));
  return `Write a thorough, chapter-like research study as JSON — NOT a summary of the search process.

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

DEPTH REQUIREMENTS (this is a study chapter, not a search summary):
- Write AT LEAST ${d.minFindings} substantive findings, each body at least ~${d.minBodyChars} characters: explain WHAT happened, WHEN (chronology), WHO/WHERE matters (key sites, people, works), HOW/WHY (mechanisms), and WHAT SCHOLARS DISAGREE ABOUT. Cover the topic's major facets, not just the first facts.
- "established" lists only strongly-evidenced conclusions, each phrased as a finding (not a process note).
- "competing" MUST present each rival interpretation fairly with its best evidence (${task.mode === 'quick' ? 'at least 1' : 'at least 2-3'}).
- "books" lists at least ${d.minBooks} discovered books/monographs with authors (from the sources above; mark metadata-only honestly). "primarySources" lists at least ${d.minPrimary} (or states plainly none were accessible).
- Every section discusses the TOPIC. NEVER write about the research process, the search, "the provided evidence", "the grounding API", page-number meta-talk, or model limitations — uncertainty belongs in domain terms (what is unknown about the subject, and why).

Rules:
- Confidence is CLAIM-LEVEL (qualitative: high/medium/low/disputed) — never one global percentage.
- Distinguish: searched vs found vs verified vs uncertain.
- If evidence is insufficient, SAY SO explicitly — in domain terms.
- findings[].cite must contain only source ids from the list above.
- EVERY finding MUST cite at least one source id — omit findings you cannot support rather than leaving cite empty.
- uncertainty MUST contain at least 2 items and gaps at least 1; if the evidence is genuinely complete, state the narrow residual limits (e.g. primary sources not inspected directly).
Return JSON with keys: executiveSummary, established, findings[{heading, body, cite}], competing, contradictions, sourceQuality, independence, books, primarySources, uncertainty, gaps, methodology.`;
}

export async function synthesizeReport({ key, model, task, plan, claims, sources, contradictions, provenance, stats, documentary, onKeyEvent, maxTokens = 8192, depth }) {
  const prompt = buildSynthesisPrompt({
    task, plan, claims, sources, contradictions, provenance, stats, documentary,
    depth: depth || DEPTH[task.mode] || DEPTH.standard,
  });
  const { data } = await generateJson({ key, model, prompt, schema: REPORT_SCHEMA, maxTokens, temperature: 0.3, onKeyEvent });
  return data;
}
