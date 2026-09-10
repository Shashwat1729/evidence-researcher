// Shared CLI runner — single implementation behind `npm run research`
// and `npm run live`. Pure-ish and injectable for tests: pass fakes via
// the second arg, capture output via `out` instead of console.
import { getKeys } from '../backend/src/gemini.js';
import { runResearch } from '../backend/src/engine/orchestrator.js';
import { saveResult } from '../backend/src/store.js';
import { score } from '../eval/score.js';

export const SSE_TYPES = ['start', 'plan', 'sources', 'claims', 'warning', 'done'];

export function usage() {
  return 'Usage: npm run research -- "question" [--mode quick|standard|deep|exhaustive] [--stance neutral|lean|adversarial|steelman|comparative] [--hypothesis "..."] [--documentary]';
}

export function parseResearchArgs(argv) {
  const args = { question: '', mode: 'standard', stance: 'neutral', hypothesis: '', documentary: false };
  const rest = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode' && argv[i + 1]) args.mode = argv[++i];
    else if (a === '--stance' && argv[i + 1]) args.stance = argv[++i];
    else if (a === '--hypothesis' && argv[i + 1]) args.hypothesis = argv[++i];
    else if (a === '--documentary') args.documentary = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else rest.push(a);
  }
  if (rest.length) args.question = rest.join(' ');
  return args;
}

export function validateCliArgs(o) {
  if (!o.question || o.question.trim().length < 3) return 'question is required (≥3 chars)';
  if (!['quick', 'standard', 'deep', 'exhaustive'].includes(o.mode)) return `unknown mode "${o.mode}"`;
  if (!['neutral', 'lean', 'adversarial', 'steelman', 'comparative'].includes(o.stance)) return `unknown stance "${o.stance}"`;
  return null;
}

/**
 * @returns {Promise<{exitCode:number, result?:object}>}
 */
export async function executeResearch(opts, {
  runFn = runResearch,
  saveFn = saveResult,
  keys = getKeys(''),
  out = console.log,
  onEvent,
} = {}) {
  if (!keys.length) {
    out('Error: GEMINI_API_KEY not configured. Set in .env or env.');
    return { exitCode: 1 };
  }
  out(`Research: mode=${opts.mode} stance=${opts.stance} keys=${keys.length}`);
  out(`Q: ${opts.question}`);
  const t0 = Date.now();
  try {
    const result = await runFn(opts, {
      key: keys[0],
      emit: (e) => {
        if (SSE_TYPES.includes(e.type)) out(`[${e.type}] ${e.message}`);
        onEvent?.(e);
      },
    });
    await saveFn(result);
    const { score: s, checks } = score(result);
    out(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s — sources=${result.sources.length} claims=${result.claims.length} audit=${s}`);
    for (const [k, v] of Object.entries(checks)) if (!v) out(`  FAIL ${k}`);
    out(`\nReport saved: data/${result.id}.json`);
    return { exitCode: 0, result };
  } catch (e) {
    out(`Failed: ${(e.message || String(e)).slice(0, 200)}${e.status ? ` (HTTP ${e.status})` : ''}`);
    return { exitCode: 1 };
  }
}
