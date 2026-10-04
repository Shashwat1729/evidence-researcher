// Report exporters (Markdown / HTML) — pure, dependency-free, browser-safe.
// Used by the server routes AND the static Pages build (frontend/direct.js).

/** Strip markdown link metachars so model titles can't break links. Exported for tests. */
export function mdLinkText(s) {
  return String(s ?? '').replace(/[\[\]()]/g, '');
}

/** Link target for Markdown: only http(s), with the chars that would end or
 *  break a Markdown link target percent-encoded. Non-web schemes (javascript:,
 *  data:) become '#' so an exported report can never carry a script link.
 *  Exported for tests. */
export function mdUrl(u) {
  const s = String(u ?? '').trim();
  if (!/^https?:\/\//i.test(s)) return '#';
  return s.replace(/[\s()<>"'\\]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

export function exportMarkdown(r) {
  // One-liner: model text with stray newlines must not break list structure.
  const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const byId = new Map((r.sources || []).map((s) => [s.id, s]));
  const cite = (ids = []) => ids.map((id) => {
    const s = byId.get(id);
    if (!s) return null;
    return `[${mdLinkText(oneLine(s.title || s.domain))}](${mdUrl(s.url)})`;
  }).filter(Boolean).join('; ');
  const L = [];
  L.push(`# Research: ${oneLine(r.task?.question) || ''}`, '');
  if ((r.report?.findings || []).length > 1) {
    L.push('## Contents', '');
    for (const f of r.report.findings) L.push(`- ${oneLine(f.heading) || 'Finding'}`);
    L.push('');
  }
  L.push(`- Mode: ${r.task?.mode} · Stance: ${r.task?.stance} · Date: ${r.completedAt || ''}`);
  if (oneLine(r.stanceDisclosure)) L.push(`- ${oneLine(r.stanceDisclosure)}`, ''); else L.push('');
  L.push(`## Executive summary`, '', r.report?.executiveSummary || '_No summary produced._', '');
  if (r.report?.established?.length) { L.push('## What we can establish', ''); for (const e of r.report.established) L.push(`- ${oneLine(e)}`); L.push(''); }
  L.push('## Major findings', '');
  const figsBySection = new Map();
  for (const f of r.report?.figures || []) {
    const k = Number(f.section);
    figsBySection.set(k, [...(figsBySection.get(k) || []), f]);
  }
  for (const [i, f] of (r.report?.findings || []).entries()) {
    L.push(`### ${oneLine(f.heading) || 'Finding'}`, '', f.body || '', '');
    // Figures sit with the prose they illustrate, not in a gallery at the end —
    // that is what makes the export read like a chapter.
    for (const fig of figsBySection.get(i) || []) {
      L.push(`![${mdLinkText(oneLine(fig.caption))}](${mdUrl(fig.url)})`, '');
      L.push(`*${oneLine(fig.caption)}* — ${oneLine(fig.author)}, ${oneLine(fig.license)} (${mdUrl(fig.sourcePage)})`, '');
    }
    if (f.cite?.length) L.push(`Sources: ${cite(f.cite)}`, '');
    const v = (r.report?.verification || []).find((x) => x.n === i);
    if (v) L.push(`Cross-check: ${v.supported} — ${oneLine(v.note)}`, '');
  }
  if (r.report?.competing?.length) { L.push('## Competing explanations', ''); for (const c of r.report.competing) L.push(`- ${oneLine(c)}`); L.push(''); }
  if (r.report?.contradictions?.length) { L.push('## Contradictory evidence', ''); for (const c of r.report.contradictions) L.push(`- ${oneLine(c)}`); L.push(''); }
  if (r.report?.timeline?.length) {
    L.push('## Chronology', '');
    L.push('| Date | Event |', '| --- | --- |');
    // A literal pipe inside a cell would split it into extra columns.
    const cellText = (v) => oneLine(v).replace(/\|/g, '/');
    for (const t of r.report.timeline) L.push(`| ${cellText(t.date)} | ${cellText(t.event)} |`);
    L.push('');
  }
  L.push('## Claim confidence', '');
  for (const c of r.claims || []) L.push(`- **${c.state}** — ${oneLine(c.text)}${c.confidenceWhy ? ` (${oneLine(c.confidenceWhy)})` : ''}`);
  L.push('', '## Source quality', '', r.report?.sourceQuality || '', '', '## Source independence', '', r.report?.independence || r.provenance?.note || '');
  if (r.report?.books?.length) { L.push('', '## Books and scholarly literature', ''); for (const b of r.report.books) L.push(`- ${oneLine(b)}`); }
  if (r.report?.primarySources?.length) { L.push('', '## Primary sources', ''); for (const p of r.report.primarySources) L.push(`- ${oneLine(p)}`); }
  if (r.report?.uncertainty?.length) { L.push('', '## Uncertainty', ''); for (const u of r.report.uncertainty) L.push(`- ${oneLine(u)}`); }
  if (r.report?.gaps?.length) { L.push('', '## Research gaps', ''); for (const g of r.report.gaps) L.push(`- ${oneLine(g)}`); }
  L.push('', '## Methodology', '', r.report?.methodology || '', '');
  if ((r.report?.appendix || []).length) {
    L.push('## Evidence appendix', '');
    L.push('Every extracted claim with its linked sources (assembled deterministically — no model prose).', '');
    for (const a of r.report.appendix) {
      L.push(`### ${a.n}. ${oneLine(a.text)}`, '');
      L.push(`State: ${a.state}${a.why ? ` — ${oneLine(a.why)}` : ''}`, '');
      for (const s of a.supporting || []) L.push(`- Supports: [${mdLinkText(oneLine(s.title))}](${mdUrl(s.url)}) (tier ${s.tier ?? '?'})`);
      for (const s of a.contradicting || []) L.push(`- Contradicts: [${mdLinkText(oneLine(s.title))}](${mdUrl(s.url)}) (tier ${s.tier ?? '?'})`);
      L.push('');
    }
  }
  L.push('## Sources', '');
  for (const s of r.sources || []) {
    L.push(`- [${mdLinkText(oneLine(s.title || s.url))}](${mdUrl(s.url)}) — tier ${s.tier ?? '?'} (${s.sourceType}, ${s.accessibility}${s.verified ? ', inspected' : ', not inspected'})`);
  }
  if ((r.report?.figures || []).length) {
    L.push('', '## Figure credits', '');
    for (const f of r.report.figures) {
      L.push(`- ${oneLine(f.caption)} — ${oneLine(f.author)} / ${oneLine(f.license)}${f.licenseUrl ? ` (${mdUrl(f.licenseUrl)})` : ''} — ${mdUrl(f.sourcePage)}`);
    }
  }
  return L.join('\n');
}

/**
 * NotebookLM handoff dossier.
 *
 * NotebookLM exposes no public write API, so "send to NotebookLM" cannot be a
 * server-side push — pretending otherwise would be the worst kind of feature
 * stub. The honest, working version is one file the user uploads, containing
 * everything a notebook needs to produce a grounded audio/video overview, notes,
 * a quiz or a briefing. Deliberately NOT a copy of the report export:
 *   • citations are emitted as bare URLs, because NotebookLM resolves and
 *     re-cites source URLs but leaves inline markdown links inert;
 *   • every claim keeps its evidence STATE, so generated audio cannot quietly
 *     upgrade a "disputed" claim into a settled fact;
 *   • figures travel with author + licence, so any video it renders still
 *     credits the photographer.
 */
export function exportNotebookLm(r) {
  const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const byId = new Map((r.sources || []).map((s) => [s.id, s]));
  const url = (id) => byId.get(id)?.url || '';
  const L = [];
  L.push(`# Research dossier: ${oneLine(r.task?.question) || 'Untitled research'}`, '');
  L.push('Prepared for NotebookLM. Upload this file to ground an audio/video overview,',
    'study notes, a quiz or a briefing on this research. Every claim below is listed',
    'with its evidence state and the URLs it rests on — the notebook should treat',
    '"disputed" and "unsupported" claims as open questions, not facts.', '');
  L.push(`- Research question: ${oneLine(r.task?.question) || 'n/a'}`);
  L.push(`- Mode: ${r.task?.mode} · Stance: ${r.task?.stance}`);
  if (r.plan?.domain) L.push(`- Domain: ${r.plan.domain}${r.plan.complexity ? ` · complexity: ${r.plan.complexity}` : ''}`);
  L.push(`- Completed: ${r.completedAt || 'n/a'}`);
  L.push(`- Evidence: ${(r.sources || []).length} sources, ${(r.claims || []).length} claims, ${(r.report?.findings || []).length} findings`);
  if (r.report?.synthesisFallback) L.push('- Note: the write-up ran on cited extracts (model quota exhausted), so interpretation is limited.');
  L.push('');
  if (oneLine(r.stanceDisclosure)) { L.push('## Research stance', '', oneLine(r.stanceDisclosure), ''); }
  if (r.report?.executiveSummary) L.push('## Executive summary', '', oneLine(r.report.executiveSummary), '');

  L.push('## Findings', '');
  for (const [i, f] of (r.report?.findings || []).entries()) {
    L.push(`### ${i + 1}. ${oneLine(f.heading) || 'Finding'}`, '', oneLine(f.body), '');
    const figs = (r.report?.figures || []).filter((g) => Number(g.section) === i);
    for (const fig of figs) {
      // Bare URL, not markdown image syntax: a notebook resolves plain source
      // URLs and leaves inline markdown as inert text.
      L.push(`Figure: ${oneLine(fig.caption)} — ${oneLine(fig.author)}, ${oneLine(fig.license)}`, `- ${fig.url}`);
    }
    if (figs.length) L.push('');
    const urls = (f.cite || []).map(url).filter(Boolean);
    if (urls.length) { L.push('Evidence:', ''); for (const u of urls) L.push(`- ${u}`); L.push(''); }
  }

  if ((r.claims || []).length) {
    L.push('## Claims and their evidence state', '');
    for (const c of r.claims) {
      L.push(`- [${c.state || 'unknown'}] ${oneLine(c.text)}`);
      if (c.confidenceWhy) L.push(`  - why: ${oneLine(c.confidenceWhy)}`);
      for (const u of (c.supporting || []).map(url).filter(Boolean)) L.push(`  - supports: ${u}`);
      for (const u of (c.contradicting || []).map(url).filter(Boolean)) L.push(`  - contradicts: ${u}`);
    }
    L.push('');
  }

  if (r.report?.timeline?.length) {
    L.push('## Chronology', '');
    for (const t of r.report.timeline) L.push(`- ${oneLine(t.date)}: ${oneLine(t.event)}`);
    L.push('');
  }
  if (r.report?.competing?.length) { L.push('## Competing explanations', ''); for (const c of r.report.competing) L.push(`- ${oneLine(c)}`); L.push(''); }
  if (r.report?.contradictions?.length) { L.push('## Contradictory evidence', ''); for (const c of r.report.contradictions) L.push(`- ${oneLine(c)}`); L.push(''); }
  if (r.report?.uncertainty?.length) { L.push('## What is NOT established', ''); for (const u of r.report.uncertainty) L.push(`- ${oneLine(u)}`); L.push(''); }
  if (r.report?.gaps?.length) { L.push('## Open research gaps', ''); for (const g of r.report.gaps) L.push(`- ${oneLine(g)}`); L.push(''); }
  if ((r.report?.figures || []).length) {
    L.push('## Figures (attribution required)', '');
    for (const f of r.report.figures) {
      L.push(`- ${oneLine(f.caption)} — ${oneLine(f.author)}, ${oneLine(f.license)} (${f.sourcePage})`);
      L.push(`  - image: ${f.url}`);
    }
    L.push('');
  }
  if (r.report?.sourceQuality) L.push('## Source quality', '', oneLine(r.report.sourceQuality), '');
  if (r.report?.independence) L.push('## Source independence', '', oneLine(r.report.independence), '');
  L.push('## Methodology', '', oneLine(r.report?.methodology), '');
  L.push('## Source list', '');
  for (const s of r.sources || []) {
    L.push(`- ${oneLine(s.title || s.url)} — ${s.url}`);
    L.push(`  - tier ${s.tier ?? '?'} · ${s.sourceType || 'webpage'} · ${s.verified ? 'inspected' : 'not inspected'}${s.domain ? ` · ${s.domain}` : ''}`);
  }
  return L.join('\n');
}

/**
 * Media brief: the report turned into a production outline — narration per
 * section, on-screen text, citations to display, and the figure to show. This is
 * what you hand someone scripting a documentary or a YouTube video from this
 * research: it sequences the material and keeps every beat traceable to a source
 * while it does.
 */
export function exportMediaBrief(r) {
  const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const byId = new Map((r.sources || []).map((s) => [s.id, s]));
  const findings = r.report?.findings || [];
  const figsBySection = new Map();
  for (const f of r.report?.figures || []) {
    const k = Number(f.section);
    figsBySection.set(k, [...(figsBySection.get(k) || []), f]);
  }
  // ~150 words/minute read-aloud, floored so a thin section still gets a slot.
  const spokenSeconds = (text) => Math.max(20, Math.round(String(text || '').split(/\s+/).filter(Boolean).length / 150 * 60));
  const L = [];
  L.push(`# Media brief: ${oneLine(r.task?.question) || 'Untitled research'}`, '');
  L.push('A production outline for turning this research into a narrated piece (video,',
    'podcast or deck). Each block gives the narration, the on-screen text, the',
    'citations to display and the figure to show, so nothing appears unsourced.', '');
  const total = findings.reduce((n, f) => n + spokenSeconds(f.body), 0);
  L.push(`- Sections: ${findings.length}`);
  L.push(`- Estimated narration: ${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s at 150 wpm`);
  L.push(`- Sources available: ${(r.sources || []).length} · Claims: ${(r.claims || []).length} · Figures: ${(r.report?.figures || []).length}`);
  if (r.report?.synthesisFallback) L.push('- Note: written from cited extracts — narration should stay descriptive, not interpretive.');
  L.push('');
  L.push('## Cold open', '', `> ${oneLine(r.report?.executiveSummary).slice(0, 400)}`, '');
  L.push('Open on the most concrete finding; hold the question on screen until beat 1 lands.', '');

  findings.forEach((f, i) => {
    const figs = figsBySection.get(i) || [];
    const cites = (f.cite || []).map((id) => byId.get(id)).filter(Boolean);
    const secs = spokenSeconds(f.body);
    L.push(`## Beat ${i + 1}: ${oneLine(f.heading) || 'Finding'}`, '');
    L.push(`- Runtime: ~${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`);
    L.push(`- On-screen title: ${(oneLine(f.heading) || 'Finding').slice(0, 70)}`);
    L.push('- Narration:', '', `  ${oneLine(f.body)}`, '');
    if (figs.length) {
      L.push('- Show:', '');
      for (const fig of figs) L.push(`  - ${fig.caption} — credit on screen: "${fig.author} / ${fig.license}"\n    ${fig.url}`);
      L.push('');
    }
    if (cites.length) {
      L.push('- Cite on screen:', '');
      for (const s of cites) L.push(`  - ${oneLine(s.title || s.domain)} — ${s.url}`);
      L.push('');
    }
  });

  if (r.report?.timeline?.length) {
    L.push('## Closing timeline', '');
    for (const t of r.report.timeline) L.push(`- ${oneLine(t.date)} — ${oneLine(t.event)}`);
    L.push('');
  }
  if (r.report?.uncertainty?.length) {
    L.push('## Required caveats (do not cut)', '');
    for (const u of r.report.uncertainty) L.push(`- ${oneLine(u)}`);
    L.push('');
  }
  L.push('## Source credits', '');
  for (const s of r.sources || []) L.push(`- ${oneLine(s.title || s.url)} — ${s.url}`);
  return L.join('\n');
}

export function exportHtml(r) {
  const md = exportMarkdown(r)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
    // Markdown images (report figures) become real <figure>/<img>, with the
    // credit line Wikimedia licensing requires kept visible. MUST run BEFORE the
    // anchor conversion: that pattern would otherwise match the `[alt](url)` half
    // of `![alt](url)` and turn every figure into a broken link.
    .replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)\s*\n\s*\n\*([^*]+)\* — ([^*]+), ([^*]+) \((https?:\/\/[^)\s]+)\)/g,
      '<figure><img src="$2" alt="$1" loading="lazy" referrerpolicy="no-referrer"><figcaption>$3 — $4, $5. <a href="$6" rel="noopener noreferrer">source</a></figcaption></figure>')
    // Citations must stay clickable: markdown links become real anchors
    // (previously exported as literal "[Title](https://…)" dead text).
    // Targets were made safe by mdUrl (http(s) only, quotes encoded).
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>')
    .replace(/\[([^\]]+)\]\(#\)/g, '$1')
    // Pipe tables (chronology) become real tables instead of literal pipes.
    .replace(/((?:^\|.*\|$\n?)+)/gm, (block) => {
      const rows = block.trim().split('\n')
        .map((l) => l.trim().split('|').slice(1, -1).map((c) => c.trim()))
        .filter((cells) => cells.length && !cells.every((c) => /^[\s:|-]*$/.test(c)));
      if (!rows.length) return block;
      const [head, ...body] = rows;
      const cell = (c, tag) => `<${tag}>${c}</${tag}>`;
      return `<table><tr>${head.map((c) => cell(c, 'th')).join('')}</tr>${body.map((row) => `<tr>${row.map((c) => cell(c, 'td')).join('')}</tr>`).join('')}</table>`;
    })
    .replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>')
    .replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/^- \s*$/gm, '')
    .replace(/^- (.*)$/gm, '<li>$1</li>')
    .replace(/((?:<li>.*?<\/li>)(?:\n<li>.*?<\/li>)*)/g, '<ul>$1</ul>')
    .replace(/\n\n/g, '</p><p>');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeText(r.task?.question || "Research report").slice(0, 120)}</title><style>body{font-family:system-ui;max-width:800px;margin:2rem auto;padding:0 1rem;line-height:1.6}li{margin:.3rem 0}table{border-collapse:collapse;margin:.6rem 0}th,td{border:1px solid #445;text-align:left;padding:.3rem .6rem;font-size:.9rem}figure{margin:1.4rem 0}figure img{max-width:100%;height:auto;border-radius:8px}figcaption{font-size:.82rem;opacity:.75;margin-top:.4rem}</style></head><body><p>${md}</p></body></html>`;
}

function escapeText(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
