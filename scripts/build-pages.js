// Stages a self-contained static site for GitHub Pages and verifies that
// every relative ES-module import resolves inside the staged tree.
// Usage: node scripts/build-pages.js [outDir=site]
// The Pages workflow runs this, then uploads the artifact — so a broken
// static import fails CI instead of shipping a dead demo.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(process.argv[2] || path.join(ROOT, 'site'));

async function copyDir(src, dest, { jsOnly = false } = {}) {
  await fs.mkdir(dest, { recursive: true });
  for (const e of await fs.readdir(src, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) await copyDir(s, d, { jsOnly });
    else if (!jsOnly || s.endsWith('.js')) await fs.copyFile(s, d);
  }
}

async function collectJs(dir, out = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) await collectJs(f, out);
    else if (f.endsWith('.js')) out.push(f);
  }
  return out;
}

await fs.rm(OUT, { recursive: true, force: true });
await copyDir(path.join(ROOT, 'frontend'), path.join(OUT, 'frontend'));
await copyDir(path.join(ROOT, 'backend', 'src'), path.join(OUT, 'backend', 'src'), { jsOnly: true });
for (const f of ['LICENSE', 'README.md']) {
  try { await fs.copyFile(path.join(ROOT, f), path.join(OUT, f)); } catch { /* optional */ }
}

// Import-integrity: every relative `from '...'` / `import '...'` must resolve.
const files = await collectJs(OUT);
let missing = 0;
for (const f of files) {
  const src = await fs.readFile(f, 'utf8');
  const re = /(?:import|export)[^'"]*from\s*['"](\.[^'"]+)['"]|import\s*\(\s*['"](\.[^'"]+)['"]\s*\)|import\s*['"](\.[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    const spec = m[1] || m[2] || m[3];
    const target = path.resolve(path.dirname(f), spec);
    let ok = false;
    for (const cand of [target, target + '.js', path.join(target, 'index.js')]) {
      try { await fs.access(cand); ok = true; break; } catch { /* try next */ }
    }
    if (!ok) {
      missing++;
      console.error(`BROKEN IMPORT ${path.relative(OUT, f)} -> ${spec}`);
    }
  }
}
console.log(`pages: staged ${files.length} JS files, ${missing} broken imports`);
process.exit(missing ? 1 : 0);
