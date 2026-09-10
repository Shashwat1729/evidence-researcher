// Research orchestrator: PLAN → SEARCH → COLLECT → EXTRACT → EVALUATE →
// GAPS → SEARCH GAPS → CONTRADICTIONS → PROVENANCE → DECIDE → SYNTHESIZE.
// Budget-enforced, early-stopping, adaptive escalation (simple question that
// hits disagreement escalates to academic/primary passes automatically).
//
// All model/network steps go through `deps` so the full pipeline can run
// offline in tests with deterministic fakes (see tests/e2e.test.js).
// Pure logic (dedup, classification, budgets, citation filtering) always runs.

import { MODES, MODEL_CONFIG, estimateCost } from '../config.js';
import { getKeys, urlContext } from '../gemini.js';
import { createTask, createPlan, createSource, validateTask } from '../schemas.js';
import { planResearch } from './planner.js';
import { generateQueries, contradictionQueriesFor, diversityTopups, domainCount, templateQueries } from './queries.js';
import { geminiSearchProvider } from '../providers/geminiSearch.js';
import { sleep } from '../util.js';
import { pool } from './pool.js';
import { searchAcademic, searchBooks } from '../providers/academic.js';
import { fetchPage } from '../providers/fetcher.js';
import { classifySource } from './classify.js';
import { deduplicate, canonicalize } from './dedup.js';
import { extractClaims } from './claims.js';
import { analyzeProvenance, heuristicGroups } from './provenance.js';
import { findContradictionsAndGaps } from './contradictions.js';
import { synthesizeReport } from './synthesis.js';
import { verifyFindings } from './verify.js';
import { splitEnrichment } from './enrich.js';

export const defaultDeps = {
  plan: (args) => planResearch(args),
  queries: (args) => generateQueries(args),
  search: async (q, _category, { key, onUsage, onKeyEvent }) =>
    geminiSearchProvider.search(q.q || q, { key, model: MODEL_CONFIG.research, onUsage, onKeyEvent }),
  academic: (question) => searchAcademic(question),
  books: (question) => searchBooks(question),
  fetch: (url) => fetchPage(url),
  claims: (args) => extractClaims(args),
  provenance: (args) => analyzeProvenance(args),
  review: (args) => findContradictionsAndGaps(args),
  synthesize: (args) => synthesizeReport(args),
  urlContext: (args) => urlContext(args),
  verify: (args) => verifyFindings(args),
};

function domainOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

export async function runResearch(input, { key, emit = () => {}, deps = {}, isCancelled = () => false } = {}) {
  const D = { ...defaultDeps, ...deps };
  const cancelledErr = () => Object.assign(new Error('client disconnected — run cancelled'), { status: 499, code: 'CANCELLED' });
  const throwIfCancelled = () => { if (isCancelled()) throw cancelledErr(); };
  const started = Date.now();
  const task = createTask(input);
  const errors = validateTask(task);
  if (errors.length) throw Object.assign(new Error('invalid task: ' + errors.join(', ')), { status: 400 });
  if (!getKeys(key).length) throw Object.assign(new Error('GEMINI_API_KEY is required'), { status: 401 });

  const budget = { ...MODES[task.mode] };
  const stats = { modelCalls: 0, searchCalls: 0, fetches: 0, tokensIn: 0, tokensOut: 0, keyRotations: 0, phases: {}, fetchIssues: {}, startedAt: new Date(started).toISOString() };
  const track = (u) => { if (u) { stats.tokensIn += u.in || 0; stats.tokensOut += u.out || 0; } };
  const overTokenCap = () => stats.tokensOut >= budget.maxTokensOut;
  // usage auto-tracked: every model-returning dep reports { usage } with real API counts
  // Cancellation is cooperative: checked before every model call and loop —
  // a disconnected client stops burning quota within seconds.
  const call = async (fn) => { throwIfCancelled(); stats.modelCalls++; const r = await fn(); track(r?.usage); return r; };
  const deadline = started + budget.maxRuntimeMs;

  const ev = (type, message, data = {}) => emit({ type, message, ...data, at: new Date().toISOString() });
  const keyEvent = (info) => {
    if (info?.type === 'rotated') {
      stats.keyRotations++;
      ev('progress', `API key ${info.reason === 'rate-limit' ? 'rate-limited' : 'rejected'} — switched to fallback key`);
    } else if (info?.type === 'rate-wait') {
      ev('progress', `Quota limited — waiting ~${Math.ceil((info.waitMs || 0) / 1000)}s for the per-minute bucket, then retrying`);
    }
  };
  // Phase timing (observability): accumulates wall-clock ms per pipeline stage.
  const phase = async (name, fn) => {
    const t0 = Date.now();
    try { return await fn(); }
    finally { stats.phases[name] = (stats.phases[name] || 0) + (Date.now() - t0); }
  };
  const fetchBucket = (reason) => /robots/i.test(reason || '') ? 'robots.txt' : /timeout/i.test(reason || '') ? 'timeout' : /access|denied|paywall|401|403|rate/i.test(reason || '') ? 'blocked' : 'other';
  const alive = () => {
    if (Date.now() > deadline) throw Object.assign(new Error('research time budget exhausted'), { code: 'TIMEOUT' });
    if (stats.modelCalls >= budget.maxModelCalls) throw Object.assign(new Error('model-call budget exhausted'), { code: 'BUDGET' });
    if (stats.searchCalls >= budget.maxSearches) return false;
    return true;
  };

  ev('start', `Research started (${budget.label} mode)`, { task });

  // ---- PLAN ----
  ev('progress', 'Creating research plan…');
  // Quick keeps the model planner (1 call): the classification gate must run
  // before any search budget burns. Query generation uses templates in quick.
  const planData = await phase('plan', () => call(() => D.plan({ key, model: MODEL_CONFIG.planner, question: task.question, stance: task.stance, hypothesis: task.hypothesis, onKeyEvent: keyEvent })));
  // Classification gate: non-questions abort before burning search budget.
  if (planData.valid === false) {
    throw Object.assign(new Error('Not a research question. ' + (planData.clarify || 'Please ask something to investigate.')), { status: 400 });
  }
  const plan = createPlan(planData);
  // adaptive: low-complexity quick stays quick; disagreement later escalates
  let escalated = false;
  ev('plan', 'Research plan created', { plan });

  // ---- SEARCH (parallel grounding ×5, academic/books overlapped) ----
  let allResults = [];
  const doSearch = async (q, category, explicitKey = key) => {
    // check+reserve is synchronous (no await between) → race-free under pool()
    throwIfCancelled();
    if (!alive() || overTokenCap()) return [];
    stats.searchCalls++;
    ev('progress', `Searching: ${q.q || q}`, { category });
    try {
      const rs = await D.search(q, category, { key: explicitKey, onUsage: track, onKeyEvent: keyEvent });
      return rs.map((r) => ({ ...r, category }));
    } catch (e) {
      ev('warning', `Search failed (${(e.message || '').slice(0, 100)})`, { query: q.q || q });
      return [];
    }
  };

  const initialCount = task.mode === 'quick' ? 2 : task.mode === 'standard' ? 8 : task.mode === 'deep' ? 14 : 20;
  const queries = task.mode === 'quick'
    ? templateQueries(task.question, { academic: budget.academic, books: budget.books, contradiction: false }).slice(0, initialCount)
    : await call(() => D.queries({ key, model: MODEL_CONFIG.planner, question: task.question, linesOfInquiry: plan.linesOfInquiry, count: initialCount, onKeyEvent: keyEvent }));
  ev('progress', `${queries.length} search queries generated`, { queries: queries.map((q) => q.q) });

  // academic + books discovery (free APIs, no key) runs OVERLAPPED with the
  // grounding searches instead of sequentially after them.
  const extraJobs = [];
  if (budget.academic && alive()) {
    ev('progress', 'Searching academic literature (OpenAlex, Crossref, arXiv)…');
    extraJobs.push(
      D.academic(task.question)
        .then((a) => { allResults.push(...a.map((r) => ({ ...r, category: 'scholarly' }))); return a.length; })
        .then((n) => ev('progress', `${n} scholarly records discovered`))
        .catch((e) => ev('warning', 'Academic search unavailable', { error: String(e.message).slice(0, 120) })),
    );
  }
  if (budget.books && alive()) {
    ev('progress', 'Discovering books and monographs…');
    extraJobs.push(
      D.books(task.question)
        .then((b) => { allResults.push(...b.map((r) => ({ ...r, category: 'books' }))); return b.length; })
        .then((n) => ev('progress', `${n} book records discovered`))
        .catch((e) => ev('warning', 'Book discovery unavailable', { error: String(e.message).slice(0, 120) })),
    );
  }
  // Gentle stagger (env SEARCH_STAGGER_MS, default 350ms) spaces burst starts:
  // tiny quotas punish 5-wide parallel bursts; ~1s total cost, large
  // reliability win. Raise via env on heavily constrained keys. For
  // free-tier quick mode, keep it sequential to avoid bursting past per-minute
  // quotas even with 2-key rotation (10 RPM effective).
  const searchConcurrency = task.mode === 'quick' ? 2 : task.mode === 'standard' ? 3 : 5;
  const searchStagger = Math.max(0, Number(process.env.SEARCH_STAGGER_MS || 350));
  const batch = queries.slice(0, Math.max(0, budget.maxSearches - stats.searchCalls));
  let searchIdx = 0;
  const doSearchWithKey = async (q, cat) => {
    const keys = getKeys(key);
    // Round-robin explicit key per search call to spread load across keys
    // preemptively (not just on 429), doubling effective RPM with 2 keys.
    const explicit = keys.length > 1 ? keys[(searchIdx++) % keys.length] : key;
    return doSearch(q, cat, explicit);
  };
  const found = await phase('search', () => pool(batch, searchConcurrency, (q, i) => sleep(Math.min(i, searchConcurrency - 1) * searchStagger).then(() => doSearchWithKey(q, q.category))));
  for (const rs of found) allResults.push(...rs);
  await phase('search', () => Promise.all(extraJobs));
  // Diversity guarantee: if grounding clustered on <3 domains, top up with
  // scholarly/primary/book angles (template queries — no extra model call).
  // Skip for quick: quota is too tight for top-ups.
  if (task.mode !== 'quick' && domainCount(allResults) < 3) {
    const room = Math.max(0, budget.maxSearches - stats.searchCalls);
    const topups = diversityTopups(task.question, Math.min(3, room));
    if (topups.length) {
      ev('progress', `Low source diversity — running ${topups.length} top-up searches`);
      const extra = await phase('search', () => pool(topups, Math.min(3, searchConcurrency), (q, i) => sleep(Math.min(i, 2) * searchStagger).then(() => doSearchWithKey(q, q.category))));
      for (const rs of extra) allResults.push(...rs);
    }
  }
  ev('progress', `${allResults.length} raw results collected`);

  // ---- COLLECT: dedup → sources → classify → fetch ----
  const toSources = (results) => {
    const { unique, duplicates } = deduplicate(results.map((r) => ({ url: r.url, title: r.title, text: r.snippet || '', snippet: r.snippet || '', via: r.via, category: r.category })));
    if (duplicates.length) ev('progress', `Deduplicated ${duplicates.length} copy/track-variant URL(s)`);
    return unique.slice(0, budget.maxSources).map((r) => {
      const isBook = /books|openlibrary|google.*books/i.test(r.via || '') || r.category === 'books';
      const isPaper = /academic|arxiv|crossref|openalex|doi/i.test(r.via || '');
      const cls = classifySource({ url: r.url, title: r.title, snippet: r.snippet || '', sourceType: isBook ? 'book' : isPaper ? 'paper' : 'webpage' });
      // Redirect URLs carry no real domain; hint it from the chunk title (e.g. "unibo.it").
      const rawHost = domainOf(r.url);
      const hinted = (rawHost === 'vertexaisearch.cloud.google.com' && r.title) ? (r.title.split('/')[0].toLowerCase().replace(/^www\./, '') || rawHost) : rawHost;
      const src = createSource({
        url: r.url, canonicalUrl: canonicalize(r.url), relatedCopies: r.relatedCopies || [], title: r.title || r.url,
        domain: hinted || rawHost, discoveredVia: r.via,
        sourceType: isBook ? 'book' : isPaper ? 'paper' : /reddit|quora|twitter|x\.com|facebook/i.test(r.url + ' ' + hinted) ? 'social' : 'webpage',
        tier: cls.tier, tierReason: cls.tierReason, authority: cls.authority, proximity: cls.proximity,
        accessibility: isBook || isPaper ? 'metadata-only' : 'unknown',
      });
      if (r.snippet) src.passages = [{ text: r.snippet.slice(0, 900), claimHint: 'grounding excerpt' }];
      return src;
    });
  };

  let sources = toSources(allResults);
  ev('sources', `${sources.length} sources discovered`, { count: sources.length });

  // fetch top candidates: prefer low-tier (authoritative) + diverse domains.
  // Grounding redirects (vertexaisearch) carry no fetchable URL — they already
  // have a grounded excerpt as fallback passage, so skip the network fetch.
  const isRedirect = (u) => u.includes('vertexaisearch.cloud.google.com');
  const fetchTargets = [...sources]
    .sort((a, b) => (a.tier ?? 9) - (b.tier ?? 9))
    .filter((s) => s.sourceType !== 'book' && !isRedirect(s.url))
    .slice(0, budget.maxFetches);
  ev('progress', `Fetching ${fetchTargets.length} high-value page(s)…`);
  // source diversity: pre-select max 2 per domain SEQUENTIALLY (deterministic),
  // then fetch the selected set in parallel (×4).
  const perDomain = new Map();
  const allowed = fetchTargets.filter((s) => {
    const d = (s.domain || '').replace(/^www\./, '');
    const n = perDomain.get(d) || 0;
    if (n >= 2) return false;
    perDomain.set(d, n + 1);
    return true;
  });
  // Grounding-only sources already have passages; mark them as grounded evidence
  // so the audit distinguishes grounded excerpts from unavailable metadata.
  for (const s of sources) {
    if (isRedirect(s.url) && s.passages?.length) {
      s.accessibility = 'grounding';
      s.note = s.note || 'Evidence from Gemini grounding excerpt (redirect not fetchable).';
    }
  }
  const applyFetch = (s, p) => {
    if (p.ok) {
      s.verified = true;
      s.accessibility = 'full';
      s.title = p.title || s.title;
      s.author = p.author || s.author;
      s.publishedDate = p.publishedDate || s.publishedDate;
      s.canonicalUrl = p.canonical || s.canonicalUrl;
      s.domain = (p.domain || domainOf(p.canonical || s.canonicalUrl)) || s.domain;
      s.url = p.url || s.url; // capture final URL after redirect
      s.passages = [{ text: p.text.slice(0, 1500), claimHint: 'page extract' }];
      // Re-classify after we know the real host/content (redirect URLs start tier 6).
      const re = classifySource({ url: s.url, title: s.title, snippet: p.text.slice(0, 1000), text: p.text.slice(0, 2000), sourceType: s.sourceType });
      if ((re.tier ?? 9) < (s.tier ?? 9)) { s.tier = re.tier; s.tierReason = re.tierReason; }
      s.authority = re.authority || s.authority;
      s.proximity = re.proximity !== 'unknown' ? re.proximity : s.proximity;
    } else {
      const b = fetchBucket(p.reason);
      stats.fetchIssues[b] = (stats.fetchIssues[b] || 0) + 1;
      s.accessibility = s.accessibility === 'metadata-only' ? 'metadata-only' : 'unavailable';
      s.note = p.reason === 'access denied (auth/paywall/robots)' ? 'Not retrieved: access-controlled (no bypass attempted).' : `Not retrieved: ${p.reason}.`;
      if (!s.passages?.length && p.text) s.passages = [{ text: p.text.slice(0, 800), claimHint: 'grounding excerpt (fetch failed)' }];
    }
  };
  await phase('fetch', () => pool(allowed, 4, async (s) => {
    if (isCancelled() || Date.now() > deadline || overTokenCap()) return;
    stats.fetches++;
    try {
      applyFetch(s, await D.fetch(s.url));
    } catch (e) {
      applyFetch(s, { ok: false, reason: String(e.message || 'fetch failed').slice(0, 120) });
    }
  }));
  const fetched = sources.filter((s) => s.verified).length;
  const books = sources.filter((s) => s.sourceType === 'book').length;
  const scholarly = sources.filter((s) => s.sourceType === 'paper').length;
  ev('progress', `${sources.length} sources · ${fetched} inspected · ${books} books · ${scholarly} scholarly`, { fetched, books, scholarly });
  if (Object.keys(stats.fetchIssues).length) {
    ev('progress', `Fetch issues: ${Object.entries(stats.fetchIssues).map(([k, v]) => `${v}× ${k}`).join(', ')}`);
  }

  // URL-context enrichment: when NO direct fetch succeeded (blocks/paywalls),
  // consult top sources via Google URL context — legitimate retrieval, no bypass.
  // Result is honestly labeled partial access, never "inspected".
  if (fetched === 0 && sources.some((s) => s.sourceType !== 'book') && !overTokenCap() && task.mode !== 'quick') {
    // Redirect URLs aren't resolvable by URL context either — only real hosts.
    const top = sources.filter((s) => s.sourceType !== 'book' && !s.verified && !isRedirect(s.url)).slice(0, 5);
    if (top.length >= 2) {
      ev('progress', 'Direct fetch blocked — consulting sources via Google URL context…');
      try {
        const enriched = await phase('enrich', () => call(() => D.urlContext({
          key,
          model: MODEL_CONFIG.research,
          prompt: `For the research question below, summarize per URL the key facts relevant to it. Keep each URL's facts separate under "URL 1:", "URL 2:" headings. Be faithful; do not invent.\n\nQuestion: ${task.question}`,
          urls: top.map((s) => s.url),
          onKeyEvent: keyEvent,
        })));
        const parts = splitEnrichment(enriched.text, top.length);
        let n = 0;
        top.forEach((s, i) => {
          if (parts[i]) {
            s.accessibility = 'partial';
            s.passages = [{ text: parts[i].slice(0, 1500), claimHint: 'URL-context summary — open the source for full text' }];
            s.note = ((s.note ? s.note + ' ' : '') + 'Content summarized via Google URL context.').trim();
            n++;
          }
        });
        if (n) ev('progress', `${n} source(s) enriched via URL context (partial access)`);
      } catch (e) { ev('warning', `URL-context enrichment unavailable (${(e.message || '').slice(0, 80)})`); }
    }
  }

  // ---- ITERATIVE LOOP: claims → review → gaps/contradictions → more search ----
  let claims = [];
  let contradictions = [];
  let gaps = [];
  let provenance = { groups: [], relations: [], note: '' };
  const iterations = [];
  const maxIter = plan.complexity === 'low' && task.mode === 'quick' ? 1 : budget.maxIterations;

  const tAnalyze = Date.now();
  for (let i = 1; i <= maxIter; i++) {
    throwIfCancelled();
    if (Date.now() > deadline) break;
    if (overTokenCap()) { ev('progress', 'Token budget reached — synthesizing from gathered evidence'); break; }
    ev('progress', `Analysis pass ${i}/${maxIter}…`);
    try {
      claims = await call(() => D.claims({ key, model: MODEL_CONFIG.analysis, question: task.question, sources, onKeyEvent: keyEvent }));
    } catch (e) {
      ev('warning', `Claim extraction failed (${(e.message || '').slice(0, 100)}) — retrying with fewer sources`);
      try {
        claims = await call(() => D.claims({ key, model: MODEL_CONFIG.analysis, question: task.question, sources: sources.slice(0, 12), onKeyEvent: keyEvent }));
      } catch { claims = []; }
    }
    ev('claims', `${claims.length} claims extracted`, { count: claims.length });

    let review;
    try {
      review = await call(() => D.review({ key, model: MODEL_CONFIG.analysis, question: task.question, claims, sources, iteration: i, onKeyEvent: keyEvent }));
    } catch (e) {
      ev('warning', `Review failed (${(e.message || '').slice(0, 100)}) — treating evidence as provisional`);
      review = { contradictions: [], gaps: [], sufficient: i >= maxIter, reason: 'review failed' };
    }
    contradictions = review.contradictions || [];
    gaps = review.gaps || [];
    iterations.push({ n: i, gaps, sufficient: review.sufficient, reason: review.reason });
    if (contradictions.length) ev('progress', `${contradictions.length} contradiction(s) flagged — hunting counter-evidence`);

    const last = i === maxIter;
    const sufficient = review.sufficient && contradictions.length === 0;
    if (sufficient || last) break;

    // gap + contradiction searches (bounded)
    const followups = [];
    for (const g of gaps.slice(0, 3)) followups.push({ q: `${task.question} ${g}`.slice(0, 160), category: 'gap' });
    for (const c of claims.filter((c) => ['supported', 'strongly-supported', 'plausible'].includes(c.state)).slice(0, budget.contradictionPasses > 0 ? 3 : 0)) {
      followups.push(...contradictionQueriesFor(c.text).slice(0, 2));
    }
    // adaptive escalation: disagreement on a "simple" question triggers deeper passes
    if (!escalated && contradictions.length > 0 && (task.mode === 'quick' || plan.complexity === 'low')) {
      escalated = true;
      plan.complexity = 'medium';
      ev('progress', 'Sources disagree — escalating to primary-source + academic verification');
      followups.push({ q: `${task.question} primary sources`, category: 'primary-evidence' });
    }
    // follow-up searches run in parallel (×4); merging stays sequential
    // so dedup/canonicalization sees a stable source list.
    let added = 0;
    const followResults = await pool(followups.slice(0, 6), Math.min(4, searchConcurrency), (f, i) => sleep(Math.min(i, 3) * searchStagger).then(() => doSearchWithKey(f, f.category)));
    for (const rs of followResults) {
      const fresh = rs.filter((r) => !sources.some((s) => canonicalize(s.url) === canonicalize(r.url)));
      for (const r of fresh.slice(0, 4)) {
        if (sources.length >= budget.maxSources) break;
        const cls = classifySource({ url: r.url, title: r.title, snippet: r.snippet || '' });
        const ns = createSource({ url: r.url, canonicalUrl: canonicalize(r.url), relatedCopies: r.relatedCopies || [], title: r.title || r.url, domain: domainOf(r.url), discoveredVia: r.via, tier: cls.tier, tierReason: cls.tierReason, authority: cls.authority, proximity: cls.proximity });
        if (r.snippet) ns.passages = [{ text: r.snippet.slice(0, 900), claimHint: 'grounding excerpt' }];
        sources.push(ns);
        added++;
      }
    }
    if (added) ev('progress', `${added} additional source(s) from gap/contradiction search`);
    if (!added && !contradictions.length) break;
  }
  stats.phases.analyze = Date.now() - tAnalyze;

  // ---- citation integrity: drop links to sources that were never retrieved ----
  {
    const validIds = new Set(sources.map((s) => s.id));
    for (const c of contradictions) c.sources = (c.sources || []).filter((id) => validIds.has(id));
    for (const c of claims) {
      c.supporting = (c.supporting || []).filter((id) => validIds.has(id));
      c.contradicting = (c.contradicting || []).filter((id) => validIds.has(id));
    }
  }

  // ---- PROVENANCE ----
  ev('progress', 'Checking source independence…');
  if (task.mode === 'quick') {
    // Quick: heuristic only, no model call to stay under free-tier quota.
    const groups = heuristicGroups(sources);
    provenance = {
      groups: groups.map((g) => ({ ids: g.map((s) => s.id), verdict: 'unclear', explanation: 'heuristic overlap — model verification skipped in quick mode' })),
      relations: [],
      note: groups.length ? 'Heuristic overlap detected; model verification skipped in quick mode — source independence could not be fully determined.' : 'No textual overlap detected; source independence could not be determined beyond this check.',
    };
  } else {
    provenance = await phase('provenance', () => call(() => D.provenance({ key, model: MODEL_CONFIG.analysis, sources, onKeyEvent: keyEvent }))
      .catch(() => ({ groups: [], relations: [], note: 'Source independence could not be determined (analysis unavailable).' })));
  }
  ev('progress', provenance.note);

  // ---- SYNTHESIS ----
  ev('progress', 'Synthesizing final report…');
  const report = await phase('synthesis', () => call(() => D.synthesize({
    key, model: MODEL_CONFIG.synthesis, task, plan, claims, sources,
    contradictions, provenance, stats: { ...stats, runtimeMs: Date.now() - started }, documentary: task.documentary, onKeyEvent: keyEvent,
    maxTokens: budget.reportTokens,
  })));

  // citation-integrity: strip cites pointing at unknown ids
  const validIds = new Set(sources.map((s) => s.id));
  for (const f of report.findings || []) {
    f.cite = (f.cite || []).filter((id) => validIds.has(id));
  }

  // Cross-evaluation: verify findings against their cited excerpts (1 call, skip in quick).
  let verification = [];
  if (task.mode !== 'quick') {
    ev('progress', 'Cross-checking findings against cited excerpts…');
    try {
      verification = await phase('verify', () => call(() => D.verify({ key, model: MODEL_CONFIG.analysis, findings: report.findings || [], sources, onKeyEvent: keyEvent })));
    } catch { verification = []; }
  }
  report.verification = verification;

  // Cost snapshot LAST: estimateCost's keys overlap stats', so spreading it
  // earlier would freeze modelCalls/searchCalls/tokens at pre-synthesis values
  // and silently drop the synthesis (+verification) usage from the report.
  const cost = estimateCost(stats.modelCalls, stats.searchCalls, stats.tokensIn, stats.tokensOut, stats.keyRotations);
  const result = {
    id: task.id,
    task, plan, report,
    claims, sources, contradictions, provenance,
    relations: provenance.relations || [],
    iterations,
    stats: { ...stats, ...cost, runtimeMs: Date.now() - started, escalated },
    stanceDisclosure: task.stance !== 'neutral'
      ? `Research stance: user requested "${task.stance}" investigation${task.hypothesis ? ` ("${task.hypothesis}")` : ''}. Contradicting evidence was actively searched for and is reported; the stance changed the research objective, not the truth conditions.`
      : 'Research stance: neutral.',
    completedAt: new Date().toISOString(),
  };
  ev('done', 'Research complete', { stats: result.stats });
  return result;
}
