import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
const versionOf = (src, name) => {
  const m = src.match(new RegExp(`(?:const|export const)\\s+${name}\\s*=\\s*['"]([^'"]+)['"]`));
  return m ? m[1] : null;
};

describe('static cache-busting versions stay in sync', () => {
  it('STATIC_V (app.js) matches ENGINE_V (direct.js) and the index.html tag', () => {
    // A mismatch ships mixed old/new bundles — the exact failure mode behind
    // confusing post-deploy "process is not defined" reports.
    const app = read('frontend/app.js');
    const direct = read('frontend/direct.js');
    const index = read('frontend/index.html');
    const staticV = versionOf(app, 'STATIC_V');
    const engineV = versionOf(direct, 'ENGINE_V');
    assert.ok(staticV, 'STATIC_V defined in app.js');
    assert.ok(engineV, 'ENGINE_V defined in direct.js');
    assert.equal(staticV, engineV, 'version constants must match');
    assert.ok(index.includes(`app.js?v=${staticV}`), 'index.html script tag carries the version');
    assert.ok(app.includes('staticSuffix()'), 'dynamic imports use the versioned suffix');
    assert.ok(direct.includes('engineSuffix()'), 'engine import uses the versioned suffix');
  });
});
