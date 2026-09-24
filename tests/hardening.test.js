// Security + robustness regressions: SSRF guard, export link safety,
// JSON repair performance, API 404s, CORS preflight, request ids, key checks.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { isPublicHttpUrl, fetchPage } from '../backend/src/providers/fetcher.js';
import { exportHtml, exportMarkdown, mdUrl } from '../backend/src/export.js';
import { parseJsonLenient } from '../backend/src/gemini.js';
import { createApp } from '../backend/src/app.js';
import { validateKey, maskKey } from '../backend/src/routes.js';
import { cacheKeyFor } from '../backend/src/store.js';

describe('SSRF guard', () => {
  it('allows public http(s) hosts', () => {
    assert.ok(isPublicHttpUrl('https://en.wikipedia.org/wiki/Rome'));
    assert.ok(isPublicHttpUrl('http://93.184.216.34/page'));
  });
  it('blocks loopback, private, link-local, metadata and non-web URLs', () => {
    for (const u of [
      'http://localhost:8787/api/metrics', 'http://127.0.0.1/', 'http://10.0.0.5/', 'http://172.20.1.1/',
      'http://192.168.1.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'http://[fd00::1]/',
      'http://[::ffff:127.0.0.1]/', 'http://2130706433/', 'http://0x7f000001/', 'http://intranet/',
      'http://db.internal/', 'file:///etc/passwd', 'ftp://x.example/', 'javascript:alert(1)', 'http://user:pw@x.example/',
    ]) assert.equal(isPublicHttpUrl(u), false, u);
  });
  it('fetchPage refuses private targets without any network call', async () => {
    const real = globalThis.fetch;
    let called = false;
    globalThis.fetch = async () => { called = true; throw new Error('should not fetch'); };
    try {
      const r = await fetchPage('http://169.254.169.254/latest/meta-data/');
      assert.equal(r.ok, false);
      assert.match(r.reason, /not a public/);
      assert.equal(called, false);
    } finally { globalThis.fetch = real; }
  });
  it('blocks a public page that redirects to a private address', async () => {
    const real = globalThis.fetch;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.endsWith('/robots.txt')) return { ok: false, status: 404 };
      return { ok: false, status: 302, headers: { get: (k) => (k.toLowerCase() === 'location' ? 'http://127.0.0.1/admin' : null) } };
    };
    try {
      const r = await fetchPage('https://public.example/redirector', { timeoutMs: 2000 });
      assert.equal(r.ok, false);
      assert.match(r.reason, /non-public/);
    } finally { globalThis.fetch = real; }
  });
});

describe('export link safety', () => {
  const base = {
    task: { question: 'Q <b>?', mode: 'quick', stance: 'neutral' },
    report: { executiveSummary: 'S', findings: [{ heading: 'H', body: 'B', cite: ['s1', 's2'] }] },
    claims: [],
    sources: [
      { id: 's1', title: 'Evil', url: 'javascript:alert(1)', tier: 6 },
      { id: 's2', title: 'Quote', url: 'https://x.example/"onmouseover=alert(1)', tier: 6 },
    ],
  };
  it('never emits script links or attribute breakouts', () => {
    const html = exportHtml(base);
    assert.ok(!/href="javascript:/i.test(html));
    assert.ok(!html.includes('"onmouseover'));
    assert.ok(html.includes('%22onmouseover'));
    assert.ok(!html.includes('<b>?'), 'question text is escaped in the title/body');
  });
  it('mdUrl keeps http(s) and neutralises everything else', () => {
    assert.equal(mdUrl('https://a.example/x(1)'), 'https://a.example/x%281%29');
    assert.equal(mdUrl('data:text/html,hi'), '#');
    assert.ok(!exportMarkdown(base).includes('javascript:'));
  });
  it('pipes inside chronology cells do not split the table', () => {
    const md = exportMarkdown({ ...base, report: { ...base.report, timeline: [{ date: '1901', event: 'A | B' }] } });
    assert.ok(md.includes('| 1901 | A / B |'));
  });
});

describe('parseJsonLenient', () => {
  it('extracts JSON wrapped in prose', () => {
    assert.deepEqual(parseJsonLenient('Sure! {"a":[1,2]} hope this helps'), { a: [1, 2] });
  });
  it('stays fast on long invalid input (no quadratic shrink)', () => {
    const junk = '{' + 'x'.repeat(200_000);
    const t0 = Date.now();
    assert.throws(() => parseJsonLenient(junk));
    assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0}ms`);
  });
});

describe('result cache key', () => {
  it('distinguishes models', () => {
    const q = { question: 'Q?', mode: 'quick', stance: 'neutral' };
    assert.notEqual(cacheKeyFor({ ...q, model: 'gemini-2.5-flash' }), cacheKeyFor({ ...q, model: 'gemini-flash-latest' }));
  });
});

describe('key validation helper', () => {
  it('masks without leaking short keys', () => {
    assert.equal(maskKey(''), '(empty)');
    assert.ok(!maskKey('AIzaSyShort').includes('Short'));
    assert.equal(maskKey('AIzaSyABCDEFGHIJKLMNOPQRSTU'), 'AIzaSy…RSTU');
  });
  it('rejects non-strings and sends the key in a header, not the URL', async () => {
    assert.equal((await validateKey({ not: 'a key' })).valid, false);
    let seenUrl = '';
    let seenHeader = '';
    const ok = await validateKey('AIzaSy' + 'a'.repeat(33), {
      fetchFn: async (url, opts) => { seenUrl = String(url); seenHeader = opts.headers['x-goog-api-key']; return { ok: true, status: 200 }; },
    });
    assert.equal(ok.valid, true);
    assert.ok(!seenUrl.includes('AIza'));
    assert.ok(seenHeader.startsWith('AIza'));
  });
  it('treats 429 as a valid-but-hot key', async () => {
    const r = await validateKey('AIzaSy' + 'b'.repeat(33), { fetchFn: async () => ({ ok: false, status: 429, json: async () => ({}) }) });
    assert.equal(r.valid, true);
    assert.ok(r.warning);
  });
});

describe('HTTP hardening', () => {
  let server;
  let base;
  before(async () => {
    server = createApp({ runFn: async () => ({ id: 'x' }), store: { saveResult: async () => {}, getResult: async () => null, listResults: async () => [], deleteResult: async () => {} } }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  });
  it('unknown /api routes are JSON 404s, not the SPA page', async () => {
    const res = await fetch(`${base}/api/does-not-exist`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get('content-type') || '', /json/);
  });
  it('missing history ids are 404s', async () => {
    const res = await fetch(`${base}/api/history/nope`);
    assert.equal(res.status, 404);
  });
  it('rejects unknown export formats', async () => {
    const res = await fetch(`${base}/api/export/abc?format=exe`);
    assert.equal(res.status, 400);
  });
  it('CORS preflight allows every header the frontend sends', async () => {
    const res = await fetch(`${base}/api/research`, { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    const allowed = (res.headers.get('access-control-allow-headers') || '').toLowerCase();
    for (const h of ['x-gemini-key', 'x-gemini-keys', 'x-gemini-model']) assert.ok(allowed.includes(h), h);
  });
  it('sanitises client request ids instead of echoing them raw', async () => {
    const good = await fetch(`${base}/api/health`, { headers: { 'x-request-id': 'trace-123' } });
    assert.equal(good.headers.get('x-request-id'), 'trace-123');
    const bad = await fetch(`${base}/api/health`, { headers: { 'x-request-id': 'a'.repeat(500) } });
    assert.equal(bad.status, 200);
    assert.notEqual(bad.headers.get('x-request-id'), 'a'.repeat(500));
  });
});
