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
  return L.join('\n');
}

export function exportHtml(r) {
  const md = exportMarkdown(r)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
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
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeText(r.task?.question || "Research report").slice(0, 120)}</title><style>body{font-family:system-ui;max-width:800px;margin:2rem auto;padding:0 1rem;line-height:1.6}li{margin:.3rem 0}table{border-collapse:collapse;margin:.6rem 0}th,td{border:1px solid #445;text-align:left;padding:.3rem .6rem;font-size:.9rem}</style></head><body><p>${md}</p></body></html>`;
}

function escapeText(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
