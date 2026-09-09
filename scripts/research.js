#!/usr/bin/env node
// CLI: npm run research -- "question" [--mode quick|standard|deep|exhaustive] [--stance neutral|lean|...] [--hypothesis "..."]
import { loadEnv } from '../backend/src/env.js';
loadEnv();
import { runResearch } from '../backend/src/engine/orchestrator.js';
import { getKeys } from '../backend/src/gemini.js';
import { saveResult } from '../backend/src/store.js';
import { score } from '../eval/score.js';

function parseArgs(argv) {
  const args = { question: '', mode: 'standard', stance: 'neutral', hypothesis: '', documentary: false };
  const rest = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode' && argv[i+1]) args.mode = argv[++i];
    else if (a === '--stance' && argv[i+1]) args.stance = argv[++i];
    else if (a === '--hypothesis' && argv[i+1]) args.hypothesis = argv[++i];
    else if (a === '--documentary') args.documentary = true;
    else if (a === '--help' || a === '-h') { console.log(`Usage: npm run research -- "question" [--mode quick|standard|deep|exhaustive] [--stance neutral|lean|adversarial|steelman|comparative] [--hypothesis "..."] [--documentary]`); process.exit(0); }
    else rest.push(a);
  }
  if (rest.length) args.question = rest.join(' ');
  return args;
}

const opts = parseArgs(process.argv);
if (!opts.question || opts.question.length < 3) {
  console.error('Error: question is required (≥3 chars). Example: npm run research -- "When was X founded?" --mode quick');
  process.exit(1);
}
const keys = getKeys('');
if (!keys.length) {
  console.error('Error: GEMINI_API_KEY not configured. Set in .env or env.');
  process.exit(1);
}
console.log(`Research: mode=${opts.mode} stance=${opts.stance} keys=${keys.length}`);
console.log(`Q: ${opts.question}`);
const t0 = Date.now();
try {
  const result = await runResearch(opts, {
    key: keys[0],
    emit: (e) => {
      if (['start','plan','sources','claims','warning','done'].includes(e.type)) {
        console.log(`[${e.type}] ${e.message}`);
      }
    },
  });
  await saveResult(result);
  const { score: s, checks } = score(result);
  console.log(`\nDone in ${((Date.now()-t0)/1000).toFixed(1)}s — sources=${result.sources.length} claims=${result.claims.length} audit=${s}`);
  for (const [k,v] of Object.entries(checks)) if (!v) console.log(`  FAIL ${k}`);
  console.log(`\nReport saved: data/${result.id}.json`);
  console.log(`Export: npm run live -- export? Use API /api/export/${result.id}?format=md`);
} catch (e) {
  console.error(`Failed: ${e.message}${e.status ? ` (HTTP ${e.status})` : ''}`);
  process.exit(1);
}
