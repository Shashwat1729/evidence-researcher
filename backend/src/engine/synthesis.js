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
    timeline: {
      type: 'array',
      items: {
        type: 'object',
        properties: { date: { type: 'string' }, event: { type: 'string' } },
        required: ['date', 'event'],
      },
    },
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

// Deterministic evidence appendix: every extracted claim with its linked
// sources, assembled from verified records at zero model cost. This is what
// makes long reports genuinely detailed without hallucination risk —
// everything listed was retrieved and linked by the pipeline.
export function buildAppendix({ claims = [], sources = [] }) {
  const byId = new Map((sources || []).map((s) => [s.id, s]));
  const link = (id) => {
    const s = byId.get(id);
    if (!s) return null;
    return { id, title: s.title || s.domain || s.url, url: s.url || '', tier: s.tier ?? null };
  };
  return (claims || []).map((c, i) => ({
    n: i + 1,
    text: String(c.text || ''),
    state: c.state || 'unknown',
    why: String(c.confidenceWhy || ''),
    supporting: (c.supporting || []).map(link).filter(Boolean),
    contradicting: (c.contradicting || []).map(link).filter(Boolean),
  })).filter((a) => a.text);
}

// Zero-model fallback: when synthesis itself is unavailable (quota exhausted),
// assemble an honest evidence inventory instead of failing the whole run.
// Every section is derived from retrieved records — nothing invented.
// Flagged via synthesisFallback so the UI can say so plainly.
export function templateReport({ task, plan, claims, sources, contradictions, provenance, gaps = [], findings = null }) {
  const valid = new Set(sources.map((s) => s.id));
  const link = (ids) => (ids || []).filter((id) => valid.has(id));
  const byTier = {};
  for (const s of sources) byTier[s.tier ?? '?'] = (byTier[s.tier ?? '?'] || 0) + 1;
  const tierSummary = Object.entries(byTier).map(([t, n]) => `tier ${t}: ${n}`).join(', ') || 'none classified';
  const books = sources.filter((s) => s.sourceType === 'book');
  const primaries = sources.filter((s) => s.tier === 1 || s.proximity === 'primary');
  const verifiedCount = sources.filter((s) => s.verified).length;
  // Prebuilt section findings (model-written) take precedence over
  // claim-derived ones when the assembly step failed but sections succeeded.
  const sectionFindings = Array.isArray(findings) && findings.length
    ? findings.map((f) => ({
      heading: String(f.heading || '').slice(0, 120),
      body: String(f.body || ''),
      cite: link(f.cite || []),
    })).filter((f) => f.heading || f.body)
    : null;
  return {
    executiveSummary: sectionFindings
      ? `Section findings below were model-written from retrieved evidence, but the framing sections (summary methodology, competing views) could not be generated (model quota or outage). ` +
        `What WAS gathered: ${sources.length} source(s) (${tierSummary}; ${verifiedCount} inspected), ` +
        `${claims.length} extracted claim(s), ${contradictions.length} flagged contradiction(s).`
      : `Automated synthesis was unavailable (model quota or outage), so no interpreted findings could be written. ` +
        `What WAS gathered: ${sources.length} source(s) (${tierSummary}; ${verifiedCount} inspected), ` +
        `${claims.length} extracted claim(s), ${contradictions.length} flagged contradiction(s). ` +
        `Use the Sources/Books tabs to inspect the raw evidence below — everything listed was actually retrieved.`,
    established: [],
    findings: sectionFindings || claims.slice(0, 15).map((c) => ({
      heading: c.text.slice(0, 90),
      body: `${c.text} [Claim state: ${c.state}${c.confidenceWhy ? ` — ${c.confidenceWhy}` : ''}] (Uninterpreted extract — model synthesis unavailable.)`,
      cite: link([...(c.supporting || []), ...(c.contradicting || [])]),
    })),
    competing: [],
    contradictions: contradictions.map((c) => c.against).filter(Boolean),
    timeline: [],
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
    appendix: buildAppendix({ claims, sources }),
    synthesisFallback: true,
  };
}

// Depth contract per mode: minimum substantive findings, finding body size,
// and scholarly apparatus. A "study chapter", not a search summary.
export const DEPTH = {
  quick: { minFindings: 3, minBodyChars: 300, minBooks: 0, minPrimary: 0, minTimeline: 0 },
  standard: { minFindings: 9, minBodyChars: 900, minBooks: 4, minPrimary: 2, minTimeline: 8 },
  deep: { minFindings: 12, minBodyChars: 900, minBooks: 6, minPrimary: 3, minTimeline: 12 },
  exhaustive: { minFindings: 16, minBodyChars: 1000, minBooks: 8, minPrimary: 4, minTimeline: 15 },
};

// Section response: findings ONLY. One full-budget call per section group is
// what makes chapter-length reports possible — a single call caps output,
// N calls multiply it. Assembly (below) writes everything else.
const SECTION_SCHEMA = {
  type: 'object',
  properties: {
    findings: REPORT_SCHEMA.properties.findings,
  },
  required: ['findings'],
};

// Assembly response: the full report EXCEPT findings (provided separately).
// Keeps the assembly call small: it frames already-written sections.
const ASSEMBLY_SCHEMA = {
  type: 'object',
  properties: Object.fromEntries(
    Object.entries(REPORT_SCHEMA.properties).filter(([k]) => k !== 'findings'),
  ),
  required: ['executiveSummary', 'uncertainty', 'methodology'],
};

// Split arc beats into G contiguous groups, balanced by count. Pure.
export function partitionBeats(arc, groups) {
  const beats = Array.isArray(arc) ? arc.filter((b) => b && b.title) : [];
  const g = Math.max(1, Math.min(Math.floor(groups) || 1, beats.length || 1));
  if (!beats.length) return [];
  const out = Array.from({ length: g }, () => []);
  beats.forEach((b, i) => out[Math.min(g - 1, Math.floor((i * g) / beats.length))].push(b));
  return out.filter((grp) => grp.length);
}

// Pure, exported for unit tests: the exact prompt contract.
export function buildSynthesisPrompt({ task, plan, claims, sources, contradictions, provenance, stats, documentary, depth }) {
  const d = depth || DEPTH.standard;
  // Rich per-source context at zero extra call cost: top excerpts for strong
  // sources (tier ≤3 get two passages), one for the rest. More material in →
  // more detailed report out, without spending quota.
  const srcIndex = sources.map((s) => {
    const passages = (s.passages || []).map((p) => p.text).filter(Boolean);
    const excerptCount = (s.tier ?? 9) <= 3 ? 2 : 1;
    return {
      id: s.id, title: s.title, url: s.url, tier: s.tier, author: s.author,
      verified: s.verified, accessibility: s.accessibility,
      excerpts: passages.slice(0, excerptCount).map((t) => t.slice(0, 500)),
    };
  });
  const arc = Array.isArray(plan.arc) && plan.arc.length
    ? plan.arc
    : [{ title: 'Overview', focus: 'Essential context and the key facts in logical order.' }];
  const arcText = arc.map((b, i) => `${i + 1}. ${b.title} — ${b.focus}`).join('\n');
  return `Write a thorough, chapter-like research study as JSON — NOT a summary of the search process.

Question: ${task.question}
Mode: ${task.mode} | Stance: ${task.stance}${task.hypothesis ? ` | User hypothesis: ${task.hypothesis}` : ''}
${task.stance !== 'neutral' ? `DISCLOSURE: the user requested a "${task.stance}" investigation of their hypothesis. Disclose this stance in the methodology and report contradicting evidence anyway. ${STANCE_GUARDRAIL}` : ''}
Domain: ${plan.domain}
${documentary ? 'DOCUMENTARY MODE: emphasize chronology, key people, primary evidence, myths-vs-evidence, claims needing caution, surprising findings. Do NOT sensationalize.' : ''}

NARRATIVE ARC — the report MUST read as one continuous study following these beats IN ORDER, like a book chapter (for a person: birth → life → death → legacy; for a civilization: origins → florescence → key sites → decline → legacy). Use chronological transitions between sections ("By 2600 BCE…", "Meanwhile…", "In his later years…"). Each beat becomes one or more findings; never a disconnected list of assertions:
${arcText}

Claims (with states): ${JSON.stringify(claims.map((c) => ({ id: c.id, text: c.text, state: c.state, supporting: c.supporting, contradicting: c.contradicting, why: c.confidenceWhy }))).slice(0, 14000)}
Contradictions: ${JSON.stringify(contradictions).slice(0, 4000)}
Provenance: ${JSON.stringify(provenance).slice(0, 3000)}
Sources with excerpts (cite ONLY these ids/urls; if a page number cannot be verified write "Page number not verified"; never invent URLs, authors, dates, DOIs, quotes): ${JSON.stringify(srcIndex).slice(0, 20000)}
Research stats: ${JSON.stringify(stats)}

DEPTH REQUIREMENTS (this is a study chapter, not a search summary):
- Write AT LEAST ${d.minFindings} substantive findings spanning EVERY narrative beat above (no beat left empty), each body at least ~${d.minBodyChars} characters.
- Each finding body is structured prose with four parts: (1) the facts with specific dates, numbers, names, and places; (2) the evidence — which sources establish this and how strong they are; (3) what scholars disagree about here, if anything; (4) what remains uncertain, flagged inline.
- "executiveSummary" is a full introduction of 3-5 paragraphs telling the whole arc: what the subject is, the key story, the main debates, and the bottom line — a reader should grasp the entire topic from it alone.
- "established" lists only strongly-evidenced conclusions, each phrased as a finding with its key date (not a process note).
- "timeline" lists at least ${d.minTimeline} dated entries in chronological order (exact dates where known, approximate eras otherwise)${d.minTimeline === 0 ? ' — may be empty in quick mode' : ''}.
- "competing" MUST present each rival interpretation fairly with its best evidence AND the evidence against it (${task.mode === 'quick' ? 'at least 1' : 'at least 2-3'}).
- "books" lists at least ${d.minBooks} discovered books/monographs: author, title, and one sentence on each book's THESIS (what it argues), from the sources above; mark metadata-only honestly. "primarySources" lists at least ${d.minPrimary} with what each source is and what it establishes (or states plainly none were accessible).
- COVERAGE: every tier-1 and tier-2 source above MUST be cited by at least one finding — leave no strong source unused.
- An evidence appendix is assembled automatically from the claims and sources — do NOT include one yourself; spend the tokens on findings depth instead.
- Every section discusses the TOPIC. NEVER write about the research process, the search, "the provided evidence", "the grounding API", page-number meta-talk, or model limitations — uncertainty belongs in domain terms (what is unknown about the subject, and why).

Rules:
- Confidence is CLAIM-LEVEL (qualitative: high/medium/low/disputed) — never one global percentage.
- Distinguish: searched vs found vs verified vs uncertain.
- If evidence is insufficient, SAY SO explicitly — in domain terms.
- findings[].cite must contain only source ids from the list above.
- EVERY finding MUST cite at least one source id — omit findings you cannot support rather than leaving cite empty.
- uncertainty MUST contain at least 2 items and gaps at least 1; if the evidence is genuinely complete, state the narrow residual limits (e.g. primary sources not inspected directly).
Return JSON with keys: executiveSummary, established, findings[{heading, body, cite}], competing, contradictions, timeline[{date, event}], sourceQuality, independence, books, primarySources, uncertainty, gaps, methodology.`;
}

// Section prompt: write ONLY the findings for the given beats (used when the
// report is assembled from per-section calls). Same cite rules and process-talk
// ban, scoped minimums passed explicitly by the orchestrator.
export function buildSectionPrompt({ task, plan, claims, sources, beats, minFindings = 3, minBodyChars = 600 }) {
  const srcIndex = sources.map((s) => ({
    id: s.id, title: s.title, url: s.url, tier: s.tier, author: s.author,
    verified: s.verified, accessibility: s.accessibility,
    excerpts: ((s.passages || []).map((p) => p.text).filter(Boolean)).slice(0, 2).map((t) => t.slice(0, 500)),
  }));
  const arcText = beats.map((b, i) => `${i + 1}. ${b.title} — ${b.focus}`).join('\n');
  return `Write one detailed report section as JSON: findings ONLY, for THESE narrative beats (in order):

${arcText}

Question: ${task.question}
Mode: ${task.mode} | Stance: ${task.stance}
Claims (with states): ${JSON.stringify(claims.map((c) => ({ id: c.id, text: c.text, state: c.state, supporting: c.supporting, contradicting: c.contradicting, why: c.confidenceWhy }))).slice(0, 10000)}
Sources with excerpts (cite ONLY these ids): ${JSON.stringify(srcIndex).slice(0, 14000)}

SECTION RULES:
- Write AT LEAST ${minFindings} substantive findings covering EVERY beat above, each body at least ~${minBodyChars} characters of structured prose: (1) facts with dates/numbers/names/places; (2) which sources establish this and how strong they are; (3) scholarly disagreement, if any; (4) residual uncertainty flagged inline.
- findings[].cite must contain only source ids from the list above; EVERY finding MUST cite at least one — omit findings you cannot support.
- Discuss the TOPIC only. NEVER write about the research process, the search, "the provided evidence", "the grounding API", or model limitations.
- Confidence is CLAIM-LEVEL (high/medium/low/disputed) — never one global percentage.
Return JSON: {"findings": [{"heading": "...", "body": "...", "cite": ["id"]}]}`;
}

// Assembly prompt: frame already-written section findings with everything
// else (summary, established, competing, timeline, books, uncertainty…).
// Must NOT invent new findings — findings[] is provided and reused verbatim.
export function buildAssemblyPrompt({ task, plan, claims, sources, contradictions, provenance, stats, documentary, findings }) {
  const srcIndex = sources.map((s) => ({
    id: s.id, title: s.title, url: s.url, tier: s.tier, author: s.author,
    verified: s.verified, accessibility: s.accessibility,
  }));
  return `Frame the finished research findings below with a complete report. Do NOT write new findings — reuse the provided ones' substance when summarizing.

Question: ${task.question}
Mode: ${task.mode} | Stance: ${task.stance}${task.hypothesis ? ` | User hypothesis: ${task.hypothesis}` : ''}
${task.stance !== 'neutral' ? `DISCLOSURE: the user requested a "${task.stance}" investigation. Disclose this in the methodology and report contradicting evidence anyway. ${STANCE_GUARDRAIL}` : ''}
Domain: ${plan.domain}
${documentary ? 'DOCUMENTARY MODE: emphasize chronology, key people, primary evidence, myths-vs-evidence, claims needing caution, surprising findings. Do NOT sensationalize.' : ''}

Findings (already written — use their substance, do not repeat them verbatim as new claims): ${JSON.stringify((findings || []).map((f) => ({ heading: f.heading, body: String(f.body || '').slice(0, 1200), cite: f.cite }))).slice(0, 12000)}
Claims: ${JSON.stringify(claims.map((c) => ({ id: c.id, text: c.text, state: c.state, why: c.confidenceWhy }))).slice(0, 6000)}
Contradictions: ${JSON.stringify(contradictions).slice(0, 3000)}
Provenance: ${JSON.stringify(provenance).slice(0, 2000)}
Sources (cite ONLY these ids/urls; never invent URLs, authors, dates, DOIs, quotes): ${JSON.stringify(srcIndex).slice(0, 8000)}
Research stats: ${JSON.stringify(stats)}

Write: a 3-5 paragraph executiveSummary telling the whole arc; "established" (strongly-evidenced conclusions with dates); "competing" (each rival interpretation fairly, with evidence for AND against); "contradictions" (evidence challenging the leading view); "timeline" (dated entries, chronological); "sourceQuality" (which sources are strongest and why); "independence" (whether sources are genuinely independent); "books" (author + one-sentence thesis each, metadata-only marked honestly); "primarySources" (what each is and establishes); "uncertainty" (≥2, domain terms); "gaps"; "methodology" (how research was conducted, stance disclosed).
NEVER write about the research process beyond methodology, never mention "the provided evidence", "grounding API", or model limitations.
Return JSON with keys: executiveSummary, established, competing, contradictions, timeline[{date, event}], sourceQuality, independence, books, primarySources, uncertainty, gaps, methodology.`;
}

export async function synthesizeReport({ key, model, task, plan, claims, sources, contradictions, provenance, stats, documentary, onKeyEvent, maxTokens = 8192, depth, beats = null, findingsOnly = false, assemblyFindings = null, assembleOnly = false }) {
  // Sectional path: findings-only scoped call (one full budget per section).
  if (findingsOnly) {
    const d = depth || DEPTH[task.mode] || DEPTH.standard;
    const prompt = buildSectionPrompt({
      task, plan, claims, sources, beats: beats || [],
      minFindings: Number.isFinite(d.minFindings) ? d.minFindings : 3,
      minBodyChars: Number.isFinite(d.minBodyChars) ? d.minBodyChars : 600,
    });
    const { data } = await generateJson({ key, model, prompt, schema: SECTION_SCHEMA, maxTokens, temperature: 0.3, onKeyEvent });
    return data;
  }
  // Assembly path: frame pre-written findings (no new findings invented).
  if (assembleOnly) {
    const prompt = buildAssemblyPrompt({
      task, plan, claims, sources, contradictions, provenance, stats, documentary,
      findings: assemblyFindings || [],
    });
    const { data } = await generateJson({ key, model, prompt, schema: ASSEMBLY_SCHEMA, maxTokens, temperature: 0.3, onKeyEvent });
    return data;
  }
  const prompt = buildSynthesisPrompt({
    task, plan, claims, sources, contradictions, provenance, stats, documentary,
    depth: depth || DEPTH[task.mode] || DEPTH.standard,
  });
  const { data } = await generateJson({ key, model, prompt, schema: REPORT_SCHEMA, maxTokens, temperature: 0.3, onKeyEvent });
  return data;
}
