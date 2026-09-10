// Source classification: tiers 1–7 by EVIDENCE, not by domain alone.
// A random .edu blog ≠ peer-reviewed paper; Wikipedia = discovery, not evidence;
// Reddit = lead, not historical proof. Heuristics here are a first pass — the
// engine may upgrade/downgrade via Gemini analysis of fetched content.

const DOMAIN_TIER_HINTS = [
  // [regex, tier, reason]
  [/\.gov(\.|$)|archives\.gov|loc\.gov|bl\.uk|gallica\.bnf|d-nb\.de/i, 3, 'government / national archive or library domain'],
  [/\.edu(\.|$)|\.ac\.[a-z]+$/i, null, null], // evaluated per-page, never auto-trusted
  [/arxiv\.org|doi\.org|pubmed|jstor|springer|nature\.com|science\.org|plos\.org|ieee|acm\.org/i, 2, 'scholarly publisher / repository domain'],
  [/wikipedia\.org/i, 6, 'tertiary reference — discovery value, not primary evidence'],
  [/reddit\.com|quora\.com|stackexchange|facebook\.com|twitter\.com|x\.com|tiktok|instagram|medium\.com.*@|tumblr/i, 7, 'user-generated content — lead only'],
  [/britannica\.com|encyclopedia/i, 6, 'tertiary encyclopedia'],
  [/openlibrary\.org|archive\.org|hathitrust|gutenberg\.org/i, 1, 'digitized primary / archival collection (verify edition)'],
  [/books\.google/i, 2, 'book metadata (text not inspected)'],
  [/nytimes|bbc\.|reuters|apnews|theguardian|washingtonpost|economist|propublica/i, 4, 'established newsroom with editorial standards'],
];

const PATH_HINTS = [
  // [regex, minTier, reason]: blog/opinion paths cap evidentiary value at
  // general-website level regardless of domain prestige (declared papers/books exempt).
  [/\/blog\//i, 6, 'blog/opinion path — discovery value, not evidence'],
];

export function classifySource({ url = '', title = '', snippet = '', text = '', sourceType = 'webpage' }) {
  const u = String(url || '');
  const hay = `${title} ${snippet} ${text.slice(0, 2000)}`.toLowerCase();
  let tier = 6;
  let reason = 'general website — discovery/background; evidentiary value to be established';
  let authority = 'unknown';
  let proximity = 'unknown';

  if (sourceType === 'paper') { tier = 2; reason = 'declared scholarly paper (verify peer review)'; authority = 'medium'; proximity = 'secondary'; }
  if (sourceType === 'book') { tier = 2; reason = 'book/monograph (verify publisher + whether text inspected)'; authority = 'medium'; proximity = 'secondary'; }
  if (sourceType === 'primary') { tier = 1; reason = 'declared primary evidence'; authority = 'medium'; proximity = 'primary'; }

  for (const [re, t, r] of DOMAIN_TIER_HINTS) {
    if (re.test(u)) {
      if (t === null) {
        // .edu/.ac: only scholarly paths earn tier 2; blogs stay tier 6.
        if (/arxiv|jstor|pubmed|doi|repository|journals?|press|scholar/i.test(u + ' ' + hay)) {
          tier = 2; reason = 'academic domain with scholarly path — treat as scholarly SECONDARY until verified';
          authority = 'medium'; proximity = 'secondary';
        } else {
          tier = 6; reason = 'academic domain but general page — .edu alone confers no authority';
          authority = 'low';
        }
      } else { tier = t; reason = r; }
      break;
    }
  }

  // Scholarly markers in text/snippet can promote general domains.
  if (tier >= 5 && /peer-reviewed|doi:|peer review|university press|monograph|dissertation/i.test(hay)) {
    tier = 2; reason = 'scholarly markers found (peer review / DOI / university press) — verify before citing as evidence';
    authority = 'medium'; proximity = 'secondary';
  }
  // Primary-evidence markers.
  if (/archaeological report|excavation|chronicle|manuscript|archival|court record|treaty text|inscription|census data|original dataset/i.test(hay)) {
    if (tier > 3) { tier = Math.min(tier, 3); reason += '; primary-evidence markers present — inspect original before tier-1 claim'; }
    proximity = 'primary';
  }
  if (/museum\.|archive|national library|smithsonian/i.test(u + ' ' + hay) && tier > 3) {
    tier = 3; reason = 'museum/archive/library institutional source';
    authority = 'medium'; proximity = tier === 3 ? proximity : 'secondary';
  }
  // Blog/opinion paths cap the tier (applied last so it wins over markers above).
  for (const [re, minTier, r] of PATH_HINTS) {
    if (re.test(u) && (sourceType === 'webpage' || sourceType === 'news' || sourceType === 'social')) {
      if (tier < minTier) { tier = minTier; reason = r; authority = 'low'; }
    }
  }

  return {
    tier, tierReason: reason, authority, proximity,
    discoveryValue: tier >= 6 ? 'high (background/leads)' : 'medium',
    evidentiaryValue: tier <= 2 ? 'potentially high — verify' : tier === 3 ? 'medium-high' : tier === 4 ? 'medium (newsroom)' : 'low until corroborated',
  };
}
