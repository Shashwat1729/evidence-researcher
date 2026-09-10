import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { cacheKeyFor, findCached, saveCacheEntry, listResults, deleteResult } from '../backend/src/store.js';
import { createApp } from '../backend/src/app.js';

const DIR = process.env.DATA_DIR || './data';

async function cleanCacheFiles() {
  try {
    for (const f of await fs.readdir(DIR)) {
      if (f.startsWith('cache_')) await fs.unlink(path.join(DIR, f)).catch(() => {});
    }
  } catch { /* ignore */ }
}

describe('result cache (store layer)', () => {
  const input = { question: 'Cached question here?', mode: 'quick', stance: 'neutral', hypothesis: '', documentary: false };
  const result = { id: 'cached1', task: { question: input.question, mode: 'quick' }, completedAt: new Date().toISOString(), report: {}, sources: [], claims: [] };

  it('round-trips identical inputs, misses on TTL expiry or different input', async () => {
    assert.equal(await findCached({ ...input, mode: 'standard' }, 60_000), null);
    await saveCacheEntry(input, result);
    const hit = await findCached(input, 60_000);
    assert.equal(hit?.id, 'cached1');
    assert.equal(await findCached(input, 0), null, 'TTL 0 disables');
    assert.equal(await findCached({ ...input, question: 'Different?' }, 60_000), null);
    // stale entries are misses
    const old = { ...result, completedAt: new Date(Date.now() - 10 * 3600_000).toISOString() };
    await saveCacheEntry({ ...input, mode: 'deep' }, old);
    assert.equal(await findCached({ ...input, mode: 'deep' }, 3600_000), null);
  });

  it('cache files never appear in history', async () => {
    const items = await listResults(200);
    assert.ok(items.every((i) => !String(i.id).startsWith('cache_')));
    assert.ok(!items.some((i) => i.id === 'cached1' && i.question === input.question && items.filter((x) => x.id === 'cached1').length > 1));
  });

  it('cache keys are stable and distinct per stance/mode', () => {
    assert.equal(cacheKeyFor(input), cacheKeyFor({ ...input }));
    assert.notEqual(cacheKeyFor(input), cacheKeyFor({ ...input, stance: 'lean' }));
    assert.notEqual(cacheKeyFor(input), cacheKeyFor({ ...input, hypothesis: 'h' }));
  });

  after(cleanCacheFiles);
});

describe('result cache (HTTP layer)', () => {
  let base;
  let server;
  let runs = 0;
  const createdIds = [];
  before(async () => {
    const app = createApp({
      runFn: async () => {
        runs++;
        const r = { id: `live-${runs}`, task: { question: 'Q', mode: 'quick' }, completedAt: new Date().toISOString(), report: {}, sources: [], claims: [] };
        createdIds.push(r.id);
        return r;
      },
      store: (await import('../backend/src/store.js')),
    });
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    await cleanCacheFiles();
    for (const id of createdIds) await deleteResult(id).catch(() => {});
  });

  async function runOnce(body) {
    const res = await fetch(`${base}/api/research`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-gemini-key': 'k' },
      body: JSON.stringify(body),
    });
    let buf = '';
    try {
      for await (const chunk of res.body) {
        buf += Buffer.from(chunk).toString();
        if (buf.includes('"type":"result"')) break;
      }
    } finally { await res.body.cancel().catch(() => {}); }
    const ev = buf.split('\n\n').map((p) => { try { return JSON.parse(p.split('data:')[1]); } catch { return null; } }).find((e) => e?.type === 'result');
    return ev?.result;
  }

  it('second identical run is served from cache without executing', async () => {
    const body = { question: 'What is cached answer number nine?', mode: 'quick', stance: 'neutral' };
    const first = await runOnce(body);
    assert.ok(first?.id);
    const before = runs;
    const second = await runOnce(body);
    assert.equal(second?.id, first.id);
    assert.equal(runs, before, 'no new execution for cache hit');
    const third = await runOnce({ ...body, fresh: true });
    assert.notEqual(third?.id, first.id);
    assert.equal(runs, before + 1, 'fresh bypass executes');
  });
});
