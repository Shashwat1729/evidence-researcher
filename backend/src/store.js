// File persistence (JSON). Local-first; swap for a real DB later.
// Data dir configurable via DATA_DIR. History lists recent runs.

import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const DIR = process.env.DATA_DIR || './data';

async function ensureDir() {
  await fs.mkdir(DIR, { recursive: true });
  // Hygiene: remove stale atomic-write leftovers from crashed runs.
  try {
    const files = await fs.readdir(DIR);
    const cutoff = Date.now() - 3600_000;
    for (const f of files) {
      if (!/\.tmp\.\d+$/.test(f)) continue;
      const st = await fs.stat(path.join(DIR, f)).catch(() => null);
      if (st && st.mtimeMs < cutoff) await fs.unlink(path.join(DIR, f)).catch(() => {});
    }
  } catch { /* best effort */ }
}

function file(id) {
  return path.join(DIR, `${String(id).replace(/[^a-zA-Z0-9_-]/g, '')}.json`);
}

export async function saveResult(result) {
  await ensureDir();
  const dest = file(result.id);
  // Atomic write: crash mid-write leaves the previous file intact, never a
  // half-written JSON that breaks history/export.
  const tmp = `${dest}.tmp.${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(result, null, 2), 'utf8');
  await fs.rename(tmp, dest);
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
  const dest = file(cacheKeyFor(input));
  const tmp = `${dest}.tmp.${process.pid}`;
  await fs.writeFile(tmp, JSON.stringify(result, null, 2), 'utf8');
  await fs.rename(tmp, dest);
}
