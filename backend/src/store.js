// File persistence (JSON). Local-first; swap for a real DB later.
// Data dir configurable via DATA_DIR. History lists recent runs.

import { promises as fs } from 'node:fs';
import path from 'node:path';

const DIR = process.env.DATA_DIR || './data';

async function ensureDir() {
  await fs.mkdir(DIR, { recursive: true });
}

function file(id) {
  return path.join(DIR, `${String(id).replace(/[^a-zA-Z0-9_-]/g, '')}.json`);
}

export async function saveResult(result) {
  await ensureDir();
  await fs.writeFile(file(result.id), JSON.stringify(result, null, 2), 'utf8');
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
  for (const f of files.slice(-limit * 2)) {
    try {
      const raw = await fs.readFile(path.join(DIR, f), 'utf8');
      const r = JSON.parse(raw);
      items.push({
        id: r.id,
        question: r.task?.question || '',
        mode: r.task?.mode || '',
        stance: r.task?.stance || '',
        createdAt: r.task?.createdAt || r.completedAt || '',
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
