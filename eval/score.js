// Audit-score heuristic for a research result object.
// Scores traceability (can another researcher audit this?), not prose quality.
// Shared by the CLI (eval/run.js) and the E2E test.

export function score(result) {
  const sources = result.sources || [];
  const claims = result.claims || [];
  const ids = new Set(sources.map((s) => s.id));
  const cited = new Set();
  for (const f of result.report?.findings || []) for (const id of f.cite || []) cited.add(id);
  const anyInspected = sources.some((s) => s.verified || s.accessibility === 'partial');
  const anyUninspected = sources.some((s) => !s.verified);

  const checks = {
    'has sources': sources.length > 0,
    'has claims': claims.length > 0,
    'citations resolve to real sources': cited.size > 0 && [...cited].every((id) => ids.has(id)),
    'no invented urls (all http)': sources.every((s) => /^https?:\/\//.test(s.url || '')),
    'source diversity (3+ domains)': new Set(sources.map((s) => s.domain)).size >= 3,
    'tier spread (authoritative + general)': new Set(sources.map((s) => s.tier)).size >= 2,
    'claims have states + rationale': claims.length > 0 && claims.every((c) => c.state && c.state !== 'unknown' && c.confidenceWhy),
    'contradictions section present': (result.contradictions || []).length > 0 || (result.report?.contradictions || []).length > 0 || (result.iterations || []).some((it) => (it.gaps || []).length > 0),
    'uncertainty stated': (result.report?.uncertainty || []).length > 0,
    'gaps stated': (result.report?.gaps || []).length > 0,
    'provenance addressed': !!(result.report?.independence || result.provenance?.note),
    'books discovered (deep+)': ['deep', 'exhaustive'].includes(result.task?.mode) ? sources.some((s) => s.sourceType === 'book') : true,
    'inspected vs metadata distinguished': (anyInspected && anyUninspected) || (!anyInspected && sources.some((s) => (s.passages || []).length > 0)),
    'post-synthesis verification recorded': (result.report?.verification || []).length > 0 || !!result.stats?.fetchIssues,
    'no global fake-precision confidence': !JSON.stringify(result.report || '').match(/confidence:\s*\d{2}(\.\d+)?%/i),
  };
  const passed = Object.values(checks).filter(Boolean).length;
  return { checks, score: `${passed}/${Object.keys(checks).length}` };
}
