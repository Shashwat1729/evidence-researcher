// Split a per-URL enrichment summary back into per-source passages.
// The model is asked for "URL 1: ... URL 2: ..." sections; parsing is lenient:
// numbered sections map positionally, unnumbered text goes to the first source
// rather than being lost. Pure and unit-tested.

export function splitEnrichment(text, count) {
  const t = String(text || '').trim();
  if (!t || !(count > 0)) return [];
  const lines = t.split('\n');
  const segs = [];
  let cur = '';
  const isHead = (l) => /^\s*(?:URL\s*)?\d+\s*[:.)-]\s*\S/i.test(l);
  for (const l of lines) {
    if (isHead(l) && cur.trim()) { segs.push(cur.trim()); cur = ''; }
    cur += (cur ? '\n' : '') + l;
  }
  if (cur.trim()) segs.push(cur.trim());
  if (!segs.length) return [t];
  const out = segs.slice(0, count);
  while (out.length < count) out.push('');
  return out;
}
