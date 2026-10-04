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

// Root index document.
//
// The artifact root is what GitHub Pages serves, and it looks for index.html
// THERE. Copying frontend/ to site/frontend/ therefore left the published site
// with no document at its root: every deploy reported success and every URL
// 404'd. Two deploys "succeeded" before this was noticed.
//
// The frontend keeps using relative asset paths, and app.js imports the engine
// as ../backend/src/*.js — so the modules must stay in frontend/ and
// backend/src/ side by side. Only index.html's OWN references need the
// frontend/ prefix, which is what this rewrite does.
const srcHtml = path.join(OUT, 'frontend', 'index.html');
const rootHtml = path.join(OUT, 'index.html');
const html = (await fs.readFile(srcHtml, 'utf8'))
  .replace(/(src|href)="([A-Za-z0-9_.-]+\.(?:js|css|svg|png|webp|ico|json)(?:\?[^"]*)?)"/g, (m, attr, file) => `${attr}="frontend/${file}"`);
await fs.writeFile(rootHtml, html, 'utf8');

// Servability gate. A static build that cannot be served must fail CI, not
// ship: assert the root document exists and that every asset it references
// actually landed in the artifact.
let missingAssets = 0;
const refRe = /(?:src|href)="([^"]+)"/g;
let m;
while ((m = refRe.exec(html))) {
  const ref = m[1];
  if (/^(https?:)?\/\//.test(ref) || ref.startsWith('data:') || ref.startsWith('#')) continue;
  const target = path.join(OUT, ref.split('?')[0]);
  try { await fs.access(target); } catch {
    missingAssets++;
    console.error(`MISSING ASSET index.html -> ${ref}`);
  }
}
if (!html.includes('frontend/app.js')) {
  console.error('ROOT INDEX does not reference frontend/app.js');
  missingAssets++;
}

// Import-integrity: every relative `from '...'` / `import '...'` must resolve.
// Also covers versioned template imports: import(`../x.js${suffix}`) is
// checked against ../x.js (query strings and ${} parts stripped).
const files = await collectJs(OUT);
let missing = 0;
for (const f of files) {
  const src = await fs.readFile(f, 'utf8');
  const re = /(?:import|export)[^'"`]*from\s*['"](\.[^'"]+)['"]|import\s*\(\s*['"](\.[^'"]+)['"]\s*\)|import\s*['"](\.[^'"]+)['"]|import\s*\(\s*`(\.[^`$]+)(?:\$\{[^`]*\})?[^`]*`\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    let spec = m[1] || m[2] || m[3] || m[4];
    spec = spec.split('?')[0];
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
console.log(`pages: staged ${files.length} JS files, ${missing} broken imports, ${missingAssets} missing asset(s) from the root index`);
process.exit(missing || missingAssets ? 1 : 0);
