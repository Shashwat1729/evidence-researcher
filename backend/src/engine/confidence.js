// Deterministic, explainable claim confidence.
// NOT an LLM self-assessment: computed from independent factors so a caller
// can audit exactly why a claim scores what it does.

const TIER_VALUE = { 1: 1.0, 2: 0.9, 3: 0.75, 4: 0.55, 5: 0.4, 6: 0.25, 7: 0.15 };

function avg(values, fallback = 0.5) {
  if (!values.length) return fallback;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * scoreClaimConfidence({ claim, sources, relations, provenance, contradictions })
 * returns { score (0..1|null), label, factors } where factors lists the
 * contributing signals (name + value) so the number is auditable.
 */
export function scoreClaimConfidence({ claim, sources = [], relations = [], provenance = null, contradictions = [] } = {}) {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const supIds = new Set(claim.supporting || []);
  const conIds = new Set(claim.contradicting || []);
  const supSources = [...supIds].map((id) => byId.get(id)).filter(Boolean);
  const conSources = [...conIds].map((id) => byId.get(id)).filter(Boolean);

  const factors = [];
  const add = (name, value) => factors.push({ name, value: Math.round(value * 100) / 100 });

  if (!supSources.length && !conSources.length) {
    add('supporting_sources', 0);
    add('contradictions', conIds.size);
    return { score: null, label: 'insufficient-evidence', factors };
  }

  // 1. Support breadth, discounted for copying: two derived copies of one
  //    source must not count as two confirmations.
  const derivedTargets = new Set();
  const derivedSources = new Set();
  for (const r of relations || []) {
    if (r.kind === 'derived_from' || r.kind === 'copies') {
      derivedTargets.add(r.to);
      derivedSources.add(r.from);
    }
  }
  // Derived copies (from) are excluded; the root (to) is a genuine
  // independent source and must count. Excluding both inverted the logic:
  // a valid root + its copies scored independentSupport=0.
  const independentSupport = supSources.filter((s) => !derivedSources.has(s.id));
  const breadthRaw = supSources.length ? Math.min(1, supSources.length / 4) : 0;
  const breadthAdj = supSources.length ? Math.min(1, independentSupport.length / 4) : 0;
  add('supporting_sources', supSources.length);
  add('independent_supporting_sources', independentSupport.length);

  // 2. Source quality: mean tier mapped to 0..1. Tier 1 (primary/official)
  //    maps highest; tiers are 1..7.
  const quality = avg(supSources.map((s) => TIER_VALUE[s.tier] ?? 0.5));
  add('mean_source_quality', quality);

  // 3. Proximity: primary vs secondary vs tertiary.
  const proximity = avg(supSources.map((s) => (s.proximity === 'primary' ? 1 : s.proximity === 'secondary' ? 0.7 : s.proximity === 'tertiary' ? 0.45 : 0.6)));
  add('primary_proximity', proximity);

  // 4. Diversity of provenance groups (distinct domains as a proxy for
  //    distinct outlets).
  const domains = new Set(supSources.map((s) => s.domain).filter(Boolean));
  const diversity = supSources.length ? Math.min(1, domains.size / Math.max(1, Math.min(3, supSources.length))) : 0;
  add('domain_diversity', diversity);

  // 5. Contradiction penalty: strength by severity of linked contradictions.
  const sevWeight = { high: 1, medium: 0.6, low: 0.3 };
  const claimContrads = (contradictions || []).filter((c) => !c.claimId || c.claimId === claim.id);
  const contraStrength = claimContrads.reduce((a, c) => a + (sevWeight[c.severity] || 0.6), 0)
    + conSources.length * 0.5;
  const contraPenalty = Math.min(0.85, contraStrength / 3);
  add('contradiction_penalty', contraPenalty);

  // 6. LLM state as a weak prior only (never the score).
  const statePrior = {
    'strongly-supported': 0.9, supported: 0.75, plausible: 0.55, disputed: 0.4,
    'weakly-supported': 0.35, unsupported: 0.15, contradicted: 0.1, unknown: 0.4,
  }[claim.state] ?? 0.4;
  add('state_prior', statePrior);

  const raw = 0.3 * breadthAdj + 0.25 * quality + 0.15 * proximity
    + 0.1 * diversity + 0.1 * statePrior + 0.1 * (1 - contraPenalty);
  let score = Math.round(raw * 100) / 100;
  // A claim whose only support derives from one root cannot be high.
  if (independentSupport.length === 0 && supSources.length > 0) score = Math.min(score, 0.4);
  // Explicit contradiction caps the score.
  if (claimContrads.length > 0 || conSources.length > 0) score = Math.min(score, 0.6);
  const label = score >= 0.8 ? 'high' : score >= 0.6 ? 'medium' : score >= 0.4 ? 'low' : 'very-low';
  return { score, label, factors };
}

/** Map a claim state to the task's required status vocabulary. */
export function claimStatus(state) {
  return {
    'strongly-supported': 'supported', supported: 'supported', plausible: 'partially-supported',
    disputed: 'mixed', 'weakly-supported': 'partially-supported', unsupported: 'insufficient-evidence',
    contradicted: 'contradicted', unknown: 'insufficient-evidence',
  }[state] || 'insufficient-evidence';
}

/** Independence summary for a claim: the provenance groups of its supporting sources. */
export function independenceFor(claim, provenance, sources) {
  const byId = new Map((sources || []).map((s) => [s.id, s]));
  const supIds = new Set(claim.supporting || []);
  const groups = new Set();
  for (const g of provenance?.groups || []) {
    if (g.ids.some((id) => supIds.has(id))) groups.add(g.verdict || 'unclear');
  }
  const supSources = [...supIds].map((id) => byId.get(id)).filter(Boolean);
  const allDerived = supSources.length > 0 && supSources.every((s) => s.independence === 'derived' || s.independence === 'copy');
  return {
    supporting_source_groups: [...groups],
    all_support_possibly_derived: allDerived,
    verdict: groups.has('derived') ? 'dependent' : groups.has('unclear') ? 'uncertain' : groups.has('independent') ? 'independent' : 'unclear',
  };
}
