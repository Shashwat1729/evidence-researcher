import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Regression guard for the live-site "Error: step is not defined" crash:
// step() is run-scoped (defined in run/runDirectFlow/handleEvent). Any other
// top-level frontend function calling step() throws a ReferenceError that
// discards an otherwise completed result. Syntax lint cannot catch this.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(path.join(ROOT, 'frontend', 'app.js'), 'utf8');

function topLevelFunctions(text) {
  // Strip comments first: the guard checks code references, not prose.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const out = [];
  const re = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
  let m;
  while ((m = re.exec(code))) {
    const open = code.indexOf('{', m.index);
    let depth = 0;
    let i = open;
    for (; i < code.length; i++) {
      if (code[i] === '{') depth++;
      else if (code[i] === '}') { depth--; if (!depth) break; }
    }
    out.push({ name: m[1], body: code.slice(open, i + 1) });
  }
  return out;
}

describe('frontend scope safety (no out-of-scope step() calls)', () => {
  it('only run-scoped functions reference step()', () => {
    const allowed = new Set(['run', 'runDirectFlow', 'handleEvent']);
    const fns = topLevelFunctions(src);
    assert.ok(fns.length > 5, 'expected to find app.js functions');
    const bad = fns
      .filter((f) => /\bstep\s*\(/.test(f.body) && !allowed.has(f.name))
      .map((f) => f.name);
    assert.deepEqual(bad, [], `out-of-scope step() call in: ${bad.join(', ')}`);
  });

  it('showResult renders fallback reports with globals only', () => {
    const fns = topLevelFunctions(src);
    const show = fns.find((f) => f.name === 'showResult');
    assert.ok(show, 'showResult must exist');
    assert.ok(/showNotice/.test(show.body), 'fallback must surface via showNotice');
    assert.ok(!/\bstep\s*\(/.test(show.body), 'showResult must never call run-scoped step()');
  });
});
