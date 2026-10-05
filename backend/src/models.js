// Live Gemini model discovery + selection.
//
// Why this exists: the model list used to be a hand-curated constant, and
// `isKnownModel()` REJECTED anything not on it. So the moment Google shipped a
// new model id this repo 400'd on it — a new model was unusable until someone
// edited the source. Combined with `gemini-2.5-flash` starting to 404 on newer
// projects, that is how a working key set turned into "model synthesis
// unavailable, no report".
//
// Two changes make the app future-proof without guessing at Google's roadmap:
//   1. config.js now ACCEPTS any well-formed gemini-* id (pattern, not list),
//      so an unreleased-to-us model id works the day it exists.
//   2. This module discovers what the user's own keys can actually call, so the
//      picker offers today's models — including ones this repo has never heard
//      of — instead of a frozen list.
//
// Browser-safe on purpose (no node built-ins, `process` guarded): the static
// Pages build runs discovery in the browser with no server at all.

const env = (typeof process !== 'undefined' && process.env) || {};

export const MODELS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * Catalogue entries this app cannot use for prose research, even though they
 * are real, callable models: embeddings have no generateContent, TTS/audio/
 * realtime/robotics/computer-use return the wrong shape, and image models
 * return pixels instead of a report. Everything else is fair game — including
 * previews and ids newer than anything hardcoded here.
 *
 * EXPORTED so the frontend's static-mode fallback can be pinned to it by a test
 * (tests/keyshape.test.js compares the two literals verbatim). The express
 * server does not serve backend/src, so the browser cannot import this module on
 * every host — which is precisely how duplicated filters drift apart.
 */
export const UNUSABLE_PATTERN = /(embedding|tts|transcribe|translat|native-audio|audio|image|vision|live|realtime|robotics|computer-use|omni|deep-research)/i;

/** Any plausible Gemini generation id. This is the gate that replaced the
 *  curated allow-list — see config.js isKnownModel(). */
export const MODEL_ID_SHAPE = /^gemini-[A-Za-z0-9][A-Za-z0-9._-]*$/i;

/** 'gemini-3.8-flash-lite' -> 'Gemini 3.8 Flash Lite'. Cosmetic only. */
export function titleizeModel(id) {
  const SPECIAL = { gemini: 'Gemini', flash: 'Flash', lite: 'Lite', pro: 'Pro', ultra: 'Ultra', latest: 'latest', preview: 'Preview', tts: 'TTS' };
  return String(id || '')
    .split('-')
    .filter(Boolean)
    .map((w) => SPECIAL[w.toLowerCase()] || (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

/** First sentence of Google's description, trimmed to a picker-sized blurb. */
function shortBlurb(description) {
  const t = String(description || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const stop = t.search(/\.\s|\. —|; /);
  const first = stop > 20 ? t.slice(0, stop) : t;
  return (first.length > 130 ? `${first.slice(0, 127).trimEnd()}…` : first);
}

/** Version number for ordering: gemini-3.8-flash -> [3, 8]. */
function versionOf(id) {
  const m = String(id || '').match(/gemini-(\d+)(?:[.-](\d+))?/i);
  return m ? [Number(m[1]) || 0, Number(m[2]) || 0] : [0, 0];
}

function compareVersions(a, b) {
  const va = versionOf(a);
  const vb = versionOf(b);
  return (vb[0] - va[0]) || (vb[1] - va[1]);
}

/** Family rank within a version: flash first (the research workhorse), then
 *  lite, then pro/ultra. Lite is the cheap planning model rather than the
 *  writing model, so it must not outrank same-version flash. */
function familyRank(id) {
  const s = String(id || '').toLowerCase();
  if (/pro|ultra/.test(s)) return 2;
  if (/lite/.test(s)) return 1;
  return 0;
}

/**
 * Comparator: newest family first, then flash-before-pro-before-lite, then
 * stable ids before `-preview` ones (a preview can change under you; a dated
 * release id cannot). Pure — exported for tests.
 */
export function compareModels(a, b) {
  const va = compareVersions(a, b);
  if (va !== 0) return va;
  const fa = familyRank(a);
  const fb = familyRank(b);
  if (fa !== fb) return fa - fb;
  const pa = /preview/i.test(a) ? 1 : 0;
  const pb = /preview/i.test(b) ? 1 : 0;
  if (pa !== pb) return pa - pb;
  return String(a).localeCompare(String(b));
}

/**
 * Raw API entry -> normalized picker item, or null when unusable.
 * `supportedGenerationMethods` is authoritative when present; when an entry
 * omits it we do NOT reject on that alone (a short catalogue from a proxy
 * would otherwise hide every model) — the id filter is the real gate.
 */
export function parseModelEntry(raw) {
  const id = String(raw?.name || raw?.modelId || raw?.id || '').replace(/^models\//, '').trim();
  if (!MODEL_ID_SHAPE.test(id)) return null;
  const methods = Array.isArray(raw?.supportedGenerationMethods) ? raw.supportedGenerationMethods : [];
  if (methods.length && !methods.includes('generateContent')) return null;
  if (UNUSABLE_PATTERN.test(id)) return null;
  return {
    id,
    label: String(raw?.displayName || '').trim() || titleizeModel(id),
    blurb: shortBlurb(raw?.description),
    inputTokenLimit: Number(raw?.inputTokenLimit) || 0,
    outputTokenLimit: Number(raw?.outputTokenLimit) || 0,
    curated: Boolean(raw?.curated),
  };
}

/**
 * Catalogue -> ordered, de-duplicated list of usable research models.
 * Hand-curated ids keep their written blurb and their curated position at the
 * top; everything discovered after them is appended in ranked order.
 */
export function selectResearchModels(entries, curatedIds = []) {
  const curatedSet = new Set(curatedIds || []);
  const byId = new Map();
  for (const raw of entries || []) {
    const m = parseModelEntry(raw);
    if (!m) continue;
    // An id can be curated either by flag or by membership of the curated list.
    m.curated = curatedSet.has(m.id) || Boolean(raw?.curated);
    const prev = byId.get(m.id);
    // Prefer the curated blurb over Google's generated description.
    if (!prev || (m.curated && !prev.curated)) byId.set(m.id, { ...prev, ...m });
  }
  const order = new Map([...curatedSet].map((id, i) => [id, i]));
  return [...byId.values()].sort((a, b) => {
    const oa = order.has(a.id) ? order.get(a.id) : Infinity;
    const ob = order.has(b.id) ? order.get(b.id) : Infinity;
    if (oa !== ob) return oa - ob;
    return compareModels(a.id, b.id);
  }).map(({ id, label, blurb, curated }) => ({ id, label, blurb, curated: Boolean(curated) }));
}

const cache = new Map(); // cacheKey -> { at, models }
const CACHE_TTL_MS = 10 * 60_000;

/**
 * Cached wrapper around discoverModels. Pure passthrough when ttlMs = 0.
 *
 * Takes the key ARRAY, not a pre-joined cache key. Passing the joined string
 * straight through to discoverModels looked harmless but silently handed the
 * fetcher one bogus key ("AQ.x|AQ.y|AQ.z"), so discovery always returned empty
 * and /api/models reported live:false with no error anywhere. The cache key is
 * derived here, from the same list that is fetched.
 */
export async function discoverModelsCached(keys, ttlMs = CACHE_TTL_MS, fetchFn = fetch, timeoutMs = undefined) {
  const list = (Array.isArray(keys) ? keys : [keys]).map((k) => String(k || '').trim()).filter(Boolean);
  if (!list.length) return [];
  const cacheKey = list.join('|');
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < ttlMs) return hit.models;
  const models = await discoverModels(list, { fetchFn, ...(timeoutMs ? { timeoutMs } : {}) });
  cache.set(cacheKey, { at: Date.now(), models });
  return models;
}
export function clearModelCache() { cache.clear(); }

/**
 * Ask Google which models these keys can actually call.
 * Model availability is per-PROJECT, so one key's catalogue is not the whole
 * story: we ask up to `maxKeys` keys and UNION the results, so a model that
 * only one of the user's projects serves still shows up. Never throws — a
 * failed probe yields an empty list and the caller falls back to the curated
 * catalog. Dedupes identical entries across keys.
 */
/** How many keys one discovery pass queries. A catalogue from one project is
 *  enough to populate the picker; asking ten keys costs ten requests for no
 *  extra information in practice. */
export const DISCOVERY_MAX_KEYS = 3;

export async function discoverModels(keys, { fetchFn = fetch, timeoutMs = 8000, maxKeys = DISCOVERY_MAX_KEYS } = {}) {
  const list = (Array.isArray(keys) ? keys : [keys]).map((k) => String(k || '').trim()).filter(Boolean).slice(0, Math.max(1, maxKeys));
  if (!list.length) return [];
  const found = [];
  await Promise.all(list.map(async (k) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchFn(`${MODELS_ENDPOINT}?pageSize=200`, { headers: { 'x-goog-api-key': k }, signal: ctrl.signal });
      if (!res.ok) return;
      const data = await res.json().catch(() => ({}));
      for (const m of data?.models || []) found.push(m);
    } catch { /* a dead key must not hide the others' catalogues */ }
    finally { clearTimeout(t); }
  }));
  return selectResearchModels(found);
}

/** Discovery TTL, env-tunable for ops. */
export function modelCacheTtlMs() {
  const raw = Number(env.MODEL_CACHE_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 10 * 60_000;
}