// First-class evidence objects, derived from sources already retrieved.
// Evidence is an excerpt pointing at a claim (supports or contradicts), with
// strength/directness derived from source tier and proximity — deterministic,
// no extra model calls.

let seq = 0;
function eid() {
  seq += 1;
  return `evidence_${Date.now().toString(36)}_${seq}_${Math.random().toString(36).slice(2, 6)}`;
}

const TIER_STRENGTH = { 1: 0.98, 2: 0.9, 3: 0.8, 4: 0.65, 5: 0.5, 6: 0.35, 7: 0.2 };

function strengthFor(source) {
  // Unclassified (missing tier) must score BELOW tier 7, not between
  // tier 5 and 6 — a null tier previously defaulted to 0.5, outranking
  // legitimate tier-6/7 sources.
  const base = TIER_STRENGTH[source?.tier] ?? 0.1;
  // Primary sources are the most direct possible; tertiary get a haircut.
  const proximityMul = source?.proximity === 'primary' ? 1.0
    : source?.proximity === 'secondary' ? 0.9
    : source?.proximity === 'tertiary' ? 0.75
    : 0.85;
  const round = (v) => Math.round(v * 100) / 100;
  return round(Math.min(0.99, base * proximityMul));
}

function directnessFor(source) {
  if (source?.proximity === 'primary') return 'direct';
  if (source?.proximity === 'secondary') return 'indirect';
  if (source?.proximity === 'tertiary') return 'tertiary';
  return 'unknown';
}

/** Build evidence objects for one claim from its supporting/contradicting source id lists. */
export function evidenceForClaim(claim, sources) {
  const byId = new Map((sources || []).map((s) => [s.id, s]));
  const out = [];
  for (const sid of claim.supporting || []) {
    const s = byId.get(sid);
    if (!s) continue;
    const passage = (s.passages || [])[0];
    out.push({
      evidence_id: eid(),
      source_id: s.id,
      type: 'supporting',
      excerpt: String(passage?.text || s.snippet || '').slice(0, 500),
      location: passage?.claimHint || s.url || '',
      supports_claim: claim.id,
      strength: strengthFor(s),
      directness: directnessFor(s),
      retrieved_at: s.retrievedAt || null,
      notes: s.tierReason || s.note || '',
    });
  }
  return out;
}

export function contradictingEvidenceForClaim(claim, sources) {
  const byId = new Map((sources || []).map((s) => [s.id, s]));
  const out = [];
  for (const sid of claim.contradicting || []) {
    const s = byId.get(sid);
    if (!s) continue;
    const passage = (s.passages || [])[0];
    out.push({
      evidence_id: eid(),
      source_id: s.id,
      type: 'contradicting',
      excerpt: String(passage?.text || s.snippet || '').slice(0, 500),
      location: passage?.claimHint || s.url || '',
      supports_claim: claim.id,
      strength: strengthFor(s),
      directness: directnessFor(s),
      retrieved_at: s.retrievedAt || null,
      notes: s.tierReason || s.note || '',
    });
  }
  return out;
}
