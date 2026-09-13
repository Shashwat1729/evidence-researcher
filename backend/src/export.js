// Report exporters (Markdown / HTML) — pure, dependency-free, browser-safe.
// Used by the server routes AND the static Pages build (frontend/direct.js).

export function exportMarkdown(r) {
  // One-liner: model text with stray newlines must not break list structure.
  const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const byId = new Map((r.sources || []).map((s) => [s.id, s]));
  const cite = (ids = []) => ids.map((id) => {
    const s = byId.get(id);
    if (!s) return null;
    // Strip markdown metachars from link text so model titles can't break links.
    const text = oneLine(s.title || s.domain).replace(/[\[\]()]/g, '');
    return `[${text}](${s.url})`;
  }).filter(Boolean).join('; ');
  const L = [];
  L.push(`# Research: ${oneLine(r.task?.question) || ''}`, '');
  L.push(`- Mode: ${r.task?.mode} · Stance: ${r.task?.stance} · Date: ${r.completedAt || ''}`);
  if (oneLine(r.stanceDisclosure)) L.push(`- ${oneLine(r.stanceDisclosure)}`, ''); else L.push('');
  L.push(`## Executive summary`, '', r.report?.executiveSummary || '_No summary produced._', '');
  if (r.report?.established?.length) { L.push('## What we can establish', ''); for (const e of r.report.established) L.push(`- ${oneLine(e)}`); L.push(''); }
  L.push('## Major findings', '');
  for (const [i, f] of (r.report?.findings || []).entries()) {
    L.push(`### ${oneLine(f.heading) || 'Finding'}`, '', f.body || '', '');
    if (f.cite?.length) L.push(`Sources: ${cite(f.cite)}`, '');
    const v = (r.report?.verification || []).find((x) => x.n === i);
    if (v) L.push(`Cross-check: ${v.supported} — ${oneLine(v.note)}`, '');
  }
  if (r.report?.competing?.length) { L.push('## Competing explanations', ''); for (const c of r.report.competing) L.push(`- ${oneLine(c)}`); L.push(''); }
  if (r.report?.contradictions?.length) { L.push('## Contradictory evidence', ''); for (const c of r.report.contradictions) L.push(`- ${oneLine(c)}`); L.push(''); }
  if (r.report?.timeline?.length) {
    L.push('## Chronology', '');
    L.push('| Date | Event |', '| --- | --- |');
    for (const t of r.report.timeline) L.push(`| ${oneLine(t.date)} | ${oneLine(t.event)} |`);
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
  L.push('## Sources', '');
  for (const s of r.sources || []) {
    L.push(`- [${oneLine(s.title || s.url)}](${s.url}) — tier ${s.tier ?? '?'} (${s.sourceType}, ${s.accessibility}${s.verified ? ', inspected' : ', not inspected'})`);
  }
  return L.join('\n');
}

export function exportHtml(r) {
  const md = exportMarkdown(r)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>')
    .replace(/^# (.*)$/gm, '<h1>$1</h1>')
    .replace(/^- \s*$/gm, '')
    .replace(/^- (.*)$/gm, '<li>$1</li>')
    .replace(/((?:<li>.*?<\/li>)(?:\n<li>.*?<\/li>)*)/g, '<ul>$1</ul>')
    .replace(/\n\n/g, '</p><p>');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Research report</title><style>body{font-family:system-ui;max-width:800px;margin:2rem auto;padding:0 1rem;line-height:1.6}li{margin:.3rem 0}</style></head><body><p>${md}</p></body></html>`;
}
