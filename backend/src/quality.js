// Evidence-quality metrics.
//
// The gap this fills: the run reported COST telemetry (model calls, tokens,
// rotations) but nothing about whether the output was actually evidence-backed.
// A run can produce a handsome chapter with three citations and twelve
// uncited paragraphs, and nothing in the product said so.
//
// Every metric here is computed from data the run already has and costs ZERO
// extra model calls. They are the cheap analogues of the measures the
// literature uses for grounded generation:
//
//   attributable-finding ratio  ~ Auto-AIS (share of statements with citations)
//   claim support rate         ~ FActScore (share of atomic facts supported)
//   citation precision         ~ ALCE precision (are citations load-bearing?)
//   independence-adjusted      no published analogue; source independence is
//     support                   tracked here and nowhere else
//
// Honesty rules, because a vanity metric is worse than none:
//   • a rate with no denominator is null, never 0;
//   • nothing is invented to make a number look better;
//   • `weakestLink` names the actual shortfall rather than a grade.

const SUPPORTED = new Set(['strongly-supported', 'supported']);

/** @returns {object} metrics with nulls where the denominator is absent. */
export function evidenceQuality({ report = {}, claims = [], sources = [], provenance = null } = {}) {
  const findings = report.findings || [];
  const citedFindings = findings.filter((f) => (f.cite || []).length > 0).length;

  const stateCounts = {};
  for (const c of claims) {
    const s = String(c?.state || 'unknown');
    stateCounts[s] = (stateCounts[s] || 0) + 1;
  }
  const supportedClaims = claims.filter((c) => SUPPORTED.has(String(c?.state))).length;

  // A citation is load-bearing when the source it points to actually supports
  // (or contradicts) some claim. A source cited only by a finding, and by no
  // claim, is decoration — padding the source list.
  const usedByClaims = new Set();
  for (const c of claims) {
    for (const id of c?.supporting || []) usedByClaims.add(id);
    for (const id of c?.contradicting || []) usedByClaims.add(id);
  }
  const citedIds = new Set();
  for (const f of findings) for (const id of f.cite || []) citedIds.add(id);
  const loadBearing = [...citedIds].filter((id) => usedByClaims.has(id)).length;
  const decorative = citedIds.size - loadBearing;

  // Independence: a claim resting on two INDEPENDENT sources is far stronger than
  // one resting on two pages of the same site. `provenance.groups` already holds
  // the clustering.
  const groups = provenance?.groups || [];
  const groupOf = new Map();
  for (const g of groups) for (const id of g.ids || []) groupOf.set(id, g);
  let multiSourceClaims = 0;
  let independentClaims = 0;
  let provenanceKnown = 0;
  for (const c of claims) {
    const sup = (c?.supporting || []).filter((id) => groupOf.has(id));
    if (sup.length) {
      provenanceKnown++;
      if (sup.length >= 2) multiSourceClaims++;
      const distinct = new Set(sup.map((id) => groupOf.get(id)));
      if (distinct.size >= 2) independentClaims++;
    }
  }

  const inspected = sources.filter((s) => s?.verified).length;

  const metrics = {
    // ~Auto-AIS: share of findings that carry at least one citation.
    attributableFindingRate: findings.length ? citedFindings / findings.length : null,
    findingsTotal: findings.length,
    findingsCited: citedFindings,
    findingsUncited: findings.length - citedFindings,

    // ~FActScore: share of extracted claims that are supported rather than
    // disputed/unsupported. The closest analogue we can compute with zero calls.
    claimSupportRate: claims.length ? supportedClaims / claims.length : null,
    claimsTotal: claims.length,
    claimStates: stateCounts,

    // ~ALCE precision: of the sources cited by findings, how many carry claim
    // weight. Sources used by no claim are listed but support nothing.
    citationPrecision: citedIds.size ? loadBearing / citedIds.size : null,
    citationsTotal: citedIds.size,
    decorativeCitations: decorative,

    // Claims whose support spans >= 2 independent provenance groups.
    independenceAdjustedRate: provenanceKnown ? independentClaims / provenanceKnown : null,
    claimsWithProvenance: provenanceKnown,
    multiSourceClaims,
    independentClaims,

    // How much of the source set was actually read rather than skimmed.
    inspectedSourceRate: sources.length ? inspected / sources.length : null,
    sourcesTotal: sources.length,
    sourcesInspected: inspected,

    synthesisFallback: report.synthesisFallback === true,
  };

  metrics.weakestLink = weakestLink(metrics);
  return metrics;
}

/** Name the actual shortfall. A single letter grade would be pseudoscience. */
function weakestLink(m) {
  if (!m.findingsTotal && !m.claimsTotal) return 'No findings or claims were produced.';
  if (m.findingsUncited > 0) return `${m.findingsUncited} of ${m.findingsTotal} findings carry no citation.`;
  if (m.decorativeCitations > 0) return `${m.decorativeCitations} cited source(s) support no claim.`;
  if (m.claimSupportRate !== null && m.claimSupportRate < 0.6) {
    return `Only ${Math.round(m.claimSupportRate * 100)}% of claims are supported.`;
  }
  if (m.claimsWithProvenance && m.claimsWithProvenance < m.claimsTotal) {
    return `${m.claimsTotal - m.claimsWithProvenance} claim(s) rest on a single unclustered source.`;
  }
  if (m.synthesisFallback) return 'Findings are cited extracts: the model quota ran out before interpretation.';
  return null;
}