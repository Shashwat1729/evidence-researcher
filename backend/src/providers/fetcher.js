// URL fetching + content extraction (dependency-free).
// Respects timeouts, size caps, and never bypasses auth/paywalls/CAPTCHAs:
// non-200, non-HTML, or blocked responses are recorded as inaccessible.

const MAX_BYTES = 1_500_000;
const FETCH_TIMEOUT = 25_000;

function domainOf(url) {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

function decodeHtml(s) {
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[e]));
}

function extractMeta(html, name) {
  const m = html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*>`, 'i'));
  const c = m?.[0]?.match(/content=["']([^"']{1,500})["']/i);
  return c ? decodeHtml(c[1].trim()) : '';
}

export function cleanText(html) {
  let h = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ');
  h = h.replace(/<[^>]+>/g, ' ');
  return decodeHtml(h).replace(/\s+/g, ' ').trim();
}

// Minimal robots.txt support: honor Disallow for the `*` group (and groups
// naming our UA). Cached per host for 24h. Fail-open everywhere: a missing
// or unfetchable robots.txt never blocks research.
export function parseRobots(txt, ua = 'evidence-researcher') {
  const disallowed = [];
  const me = ua.toLowerCase();
  let applies = false;
  let sawRule = false;
  for (const raw of String(txt || '').split('\n')) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === 'user-agent') {
      if (sawRule) { applies = false; sawRule = false; } // new group starts
      const v = value.toLowerCase();
      if (v === '*' || me.includes(v) || v.includes(me)) applies = true;
    } else if (field === 'disallow') {
      sawRule = true;
      if (value && applies) disallowed.push(value);
    }
  }
  return disallowed;
}

export function isPathAllowed(disallowed, path) {
  return !disallowed.some((d) => d && path.startsWith(d));
}

const robotsCache = new Map(); // host -> { at, disallowed }
const ROBOTS_TTL = 24 * 3600 * 1000;

export async function allowedByRobots(url) {
  let proto, host, path;
  try {
    const u = new URL(url);
    proto = u.protocol; host = u.hostname.toLowerCase(); path = u.pathname || '/';
  } catch { return true; }
  // Grounding redirect hosts carry no real content; the eventual target's
  // robots.txt is checked after we follow the redirect, not before.
  if (host === 'vertexaisearch.cloud.google.com' || host === 'www.vertexaisearch.cloud.google.com') return true;
  const cached = robotsCache.get(`${proto}//${host}`);
  if (cached && Date.now() - cached.at < ROBOTS_TTL) return isPathAllowed(cached.disallowed, path);
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    let text = '';
    try {
      const res = await fetch(`${proto}//${host}/robots.txt`, {
        signal: ctrl.signal, headers: { 'User-Agent': 'evidence-researcher/1.0 (independent research bot)' },
      });
      if (res.ok) text = (await res.text()).slice(0, 100_000);
    } finally { clearTimeout(t); }
    const disallowed = parseRobots(text);
    robotsCache.set(`${proto}//${host}`, { at: Date.now(), disallowed });
    return isPathAllowed(disallowed, path);
  } catch {
    return true; // fail-open
  }
}

/** Fetch a URL and extract title/author/date/text. Never throws. */
export async function fetchPage(url, { timeoutMs = FETCH_TIMEOUT } = {}) {
  if (!(await allowedByRobots(url))) {
    return { url, ok: false, status: 0, title: '', author: '', publishedDate: '', text: '', reason: 'blocked by robots.txt (crawl not permitted)' };
  }
  // One retry on timeout only — 403/404/empty responses are final.
  let out = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    out = await attemptFetch(url, timeoutMs);
    if (out.ok || out.reason !== 'timeout') break;
  }
  return out;
}

async function attemptFetch(url, timeoutMs) {
  const result = { url, ok: false, status: 0, title: '', author: '', publishedDate: '', text: '', reason: '' };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        signal: ctrl.signal, redirect: 'follow',
        headers: { 'User-Agent': 'evidence-researcher/1.0 (independent research bot; contact: local install)', Accept: 'text/html,application/xhtml+xml' },
      });
    } finally { clearTimeout(t); }
    result.status = res.status;
    if (res.status === 401 || res.status === 403) { result.reason = 'access denied (auth/paywall/robots)'; return result; }
    if (res.status === 429) { result.reason = 'rate limited'; return result; }
    if (!res.ok) { result.reason = `HTTP ${res.status}`; return result; }
    const ctype = res.headers.get('content-type') || '';
    if (!/html|text/i.test(ctype)) { result.reason = `unsupported content-type ${ctype}`; return result; }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) { result.reason = 'page too large'; return result; }
    const html = buf.toString('utf8');
    const title = (html.match(/<title[^>]*>([\s\S]{1,300})<\/title>/i) || [])[1] || '';
    result.title = decodeHtml(title.replace(/\s+/g, ' ').trim());
    result.author = extractMeta(html, 'author') || extractMeta(html, 'article:author') || '';
    result.publishedDate = extractMeta(html, 'article:published_time') || extractMeta(html, 'date') || extractMeta(html, 'publish_date') || '';
    result.canonical = (html.match(/<link[^>]+rel=["']canonical["'][^>]*>/i)?.[0]?.match(/href=["']([^"']+)["']/i) || [])[1] || url;
    result.text = cleanText(html).slice(0, 20_000);
    result.ok = result.text.length > 200;
    if (!result.ok) result.reason = 'no extractable text';
    result.domain = domainOf(url);
    return result;
  } catch (e) {
    result.reason = e.name === 'AbortError' ? 'timeout' : (e.message || 'fetch failed').slice(0, 120);
    return result;
  }
}

/** Preferred domain for a redirect URL before it's resolved (e.g. title "unibo.it"). */
export function domainHintFor(url, titleHint = '') {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host !== 'vertexaisearch.cloud.google.com' && host !== 'www.vertexaisearch.cloud.google.com') return host.replace(/^www\./, '');
  } catch { /* fallback to title */ }
  const t = String(titleHint || '').trim().toLowerCase().replace(/^https?:\/\//, '');
  const m = t.match(/^([a-z0-9.-]+\.[a-z]{2,})(?:\/|$)/);
  return m ? m[1] : '';
}
