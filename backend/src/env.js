// Minimal .env loader (no dependency): KEY=VALUE lines, `#` comments,
// quoted values unwrapped. Never overrides real environment variables,
// so platform-provided secrets always win. Never logs values.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function loadEnv() {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const f = path.join(root, '.env');
    if (!existsSync(f)) return false;
    for (const line of readFileSync(f, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i < 0) continue;
      const k = t.slice(0, i).trim();
      const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
      if (k && !(k in process.env)) process.env[k] = v;
    }
    return true;
  } catch {
    return false; // fail-open: platform may provide env directly
  }
}
