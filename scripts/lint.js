// Syntax check for all first-party JS — dependency-free lint gate.
// Usage: npm run lint (also runs in CI). Exits non-zero on first failure.
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const roots = ['backend/src', 'frontend', 'scripts', 'eval', 'mcp', 'api', 'tests'];
const files = [];
function walk(dir) {
  for (const e of readdirSync(dir)) {
    const f = path.join(dir, e);
    if (statSync(f).isDirectory()) {
      if (e === 'node_modules') continue;
      walk(f);
    } else if (f.endsWith('.js') && !f.endsWith('.min.js')) {
      files.push(f);
    }
  }
}
for (const r of roots) {
  try { walk(r); } catch { /* missing dir is fine */ }
}

let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    failed++;
    const out = String(e.stdout || '') + String(e.stderr || '');
    console.error(`SYNTAX FAIL ${f}\n${out.split('\n').slice(0, 5).join('\n')}`);
  }
}
console.log(`lint: ${files.length - failed}/${files.length} files OK`);
process.exit(failed ? 1 : 0);
