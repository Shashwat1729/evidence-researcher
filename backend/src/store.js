// File persistence (JSON). Local-first; swap for a real DB later.
// Data dir configurable via DATA_DIR. History lists recent runs.

import { promises as fs } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

const DIR = process.env.DATA_DIR || './data';

async function ensureDir() {
  await fs.mkdir(DIR, { recursive: true });
  // Hygiene: remove stale atomic-write leftovers from crashed runs.
  try {
    const files = await fs.readdir(DIR);
    const cutoff = Date.now() - 3600_000;
    for (const f of files) {
      if (!/\.tmp\.[\w-]+$/.test(f)) continue;
      const st = await fs.stat(path.join(DIR, f)).catch(() => null);
      if (st && st.mtimeMs < cutoff) await fs.unlink(path.join(DIR, f)).catch(() => {});
    }
  } catch { /* best effort */ }
}

function file(id) {
  return path.join(DIR, `${String(id).replace(/[^a-zA-Z0-9_-]/g, '')}.json`);
}

// Atomic write: crash mid-write leaves the previous file intact, never a
// half-written JSON that breaks history/export. The temp name is unique per
// write — a pid-only suffix let two concurrent saves in one process
// interleave into the same temp file.
async function writeAtomic(dest, value) {
  const tmp = `${dest}.tmp.${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await fs.rename(tmp, dest);
  } catch (e) {
    await fs.unlink(tmp).catch(() => {});
    throw e;
  }
}

export async function saveResult(result) {
  if (!result?.id) throw new Error('result.id is required');
  await ensureDir();
  await writeAtomic(file(result.id), result);
  return result.id;
}

export async function getResult(id) {
  const raw = await fs.readFile(file(id), 'utf8');
  return JSON.parse(raw);
}

export async function listResults(limit = 50) {
  await ensureDir();
  const files = (await fs.readdir(DIR)).filter((f) => f.endsWith('.json'));
  const items = [];
  // Read all summaries: readdir order is arbitrary, so slicing BEFORE sorting
  // could drop the newest runs once the directory grows past 2× limit.
  for (const f of files) {
    if (f.startsWith('cache_')) continue; // result-cache entries: same content, never listed
    try {
      const raw = await fs.readFile(path.join(DIR, f), 'utf8');
      const r = JSON.parse(raw);
      if (!r.id) continue;
      items.push({
        id: r.id,
        question: r.task?.question || '',
        mode: r.task?.mode || '',
        stance: r.task?.stance || '',
        createdAt: r.completedAt || r.task?.createdAt || '',
        sources: r.sources?.length || 0,
        claims: r.claims?.length || 0,
      });
    } catch { /* skip corrupt */ }
  }
  return items.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, limit);
}

export async function deleteResult(id) {
  await fs.unlink(file(id));
}

// Result cache: identical question+mode+stance+hypothesis repeats served from
// disk instead of burning quota again. Entries are full results keyed by a
// hash (never listed in history). TTL via RESULT_CACHE_TTL_MS (0 = off).
export function cacheKeyFor(input) {
  const norm = [
    String(input.question || '').trim().toLowerCase(),
    input.mode || '',
    input.stance || '',
    String(input.hypothesis || '').trim().toLowerCase(),
    input.documentary ? 'doc' : '',
    // Different models produce different work: a run on one model must not
    // be served as a cache hit for another (singleflight keys on it too).
    String(input.model || ''),
  ].join('|');
  return `cache_${createHash('sha256').update(norm).digest('hex').slice(0, 32)}`;
}

export async function findCached(input, maxAgeMs) {
  if (!(maxAgeMs > 0)) return null;
  try {
    const raw = await fs.readFile(file(cacheKeyFor(input)), 'utf8');
    const r = JSON.parse(raw);
    const at = new Date(r.completedAt || 0).getTime();
    if (r.id && Number.isFinite(at) && Date.now() - at <= maxAgeMs) return r;
  } catch { /* miss */ }
  return null;
}

export async function saveCacheEntry(input, result) {
  await ensureDir();
  await writeAtomic(file(cacheKeyFor(input)), result);
  await pruneCache().catch(() => {});
}

// Cache entries were never deleted, so DATA_DIR grew without bound. Drop
// entries older than the max TTL (by mtime — no JSON parse needed).
const CACHE_PRUNE_AGE_MS = Math.max(24 * 3600_000, Number(process.env.RESULT_CACHE_TTL_MS) || 0);
let lastPrune = 0;
export async function pruneCache({ maxAgeMs = CACHE_PRUNE_AGE_MS, force = false } = {}) {
  if (!force && Date.now() - lastPrune < 10 * 60_000) return 0;
  lastPrune = Date.now();
  let removed = 0;
  for (const f of await fs.readdir(DIR)) {
    if (!f.startsWith('cache_') || !f.endsWith('.json')) continue;
    const st = await fs.stat(path.join(DIR, f)).catch(() => null);
    if (st && Date.now() - st.mtimeMs > maxAgeMs) {
      await fs.unlink(path.join(DIR, f)).catch(() => {});
      removed++;
    }
  }
  return removed;
}
