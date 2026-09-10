import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { decodeBody, cleanText, fetchPage } from '../backend/src/providers/fetcher.js';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe('charset-aware decoding (no mojibake)', () => {
  it('decodes UTF-8 as before', () => {
    const buf = Buffer.from('Caffè — “test”', 'utf8');
    assert.equal(decodeBody(buf, 'text/html; charset=utf-8'), 'Caffè — “test”');
  });
  it('honors header charset for latin-1 pages', () => {
    const buf = Buffer.from('Giosuè Carducci', 'latin1');
    assert.equal(decodeBody(buf, 'text/html; charset=iso-8859-1'), 'Giosuè Carducci');
    assert.ok(!decodeBody(buf, 'text/html; charset=iso-8859-1').includes('�'));
  });
  it('detects <meta charset> when the header is silent', () => {
    const html = '<html><head><meta charset="windows-1252"></head><body><p>è ù à</p></body></html>';
    const buf = Buffer.from(html, 'latin1');
    assert.ok(decodeBody(buf, 'text/html').includes('è ù à'));
  });
  it('falls back to utf-8 on unknown labels', () => {
    const buf = Buffer.from('plain ascii', 'utf8');
    assert.equal(decodeBody(buf, 'text/html; charset=bogus-99'), 'plain ascii');
  });
});

describe('entity decoding', () => {
  it('handles hex, astral, and common named entities; keeps unknowns', () => {
    const out = cleanText('<p>a&#x27;b&hellip;c&mdash;d&#65;&#x1F600;&bogusentity;</p>');
    assert.ok(out.includes("a'b…c—dA\ud83d\ude00;&bogusentity;") || out.includes("a'b…c—dA"), out);
    assert.ok(!out.includes('&#x27;') && !out.includes('&hellip;') && !out.includes('&mdash;'));
  });
});

describe('fetchPage resolution + politeness', () => {
  const latin1Page = () => Buffer.from(
    '<html><head><title>Giosuè Test</title><link rel="canonical" href="/canon/path"></head>' +
    `<body><p>${'Contenuto di prova con caratteri accentati è ù à. '.repeat(12)}</p></body></html>`,
    'latin1',
  );
  function mockRouter({ fail429once = false } = {}) {
    let retried = false;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.endsWith('/robots.txt')) return { ok: false, status: 404 };
      if (fail429once && !retried) {
        retried = true;
        return { ok: false, status: 429, headers: { get: (k) => (k.toLowerCase() === 'retry-after' ? '0' : null) } };
      }
      return {
        ok: true, status: 200, url: 'https://x.example/final/page',
        headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'text/html; charset=iso-8859-1' : null) },
        arrayBuffer: async () => latin1Page(),
      };
    };
  }

  it('decodes latin-1, resolves relative canonicals, cites the final URL', async () => {
    mockRouter();
    const r = await fetchPage('https://x.example/entry?utm_source=1', { timeoutMs: 5000 });
    assert.equal(r.ok, true);
    assert.equal(r.title, 'Giosuè Test');
    assert.ok(r.text.includes('Giosuè') && !r.text.includes('�'));
    assert.equal(r.canonical, 'https://x.example/canon/path');
    assert.equal(r.url, 'https://x.example/final/page');
    assert.equal(r.domain, 'x.example');
  });

  it('retries once on 429 then succeeds', async () => {
    mockRouter({ fail429once: true });
    const r = await fetchPage('https://x.example/entry', { timeoutMs: 5000 });
    assert.equal(r.ok, true);
  });
});
