// Audit-score CLI for saved research result JSON.
// Usage: node eval/run.js <result.json> | node eval/run.js --all [dir] | node eval/run.js --help
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { score } from './score.js';

const q = JSON.parse(readFileSync(new URL('./questions.json', import.meta.url), 'utf8'));

function scoreFile(file) {
  const result = JSON.parse(readFileSync(file, 'utf8'));
  const { checks, score: s } = score(result);
  console.log(`\n== ${file} → audit ${s} (${result.task?.mode || '?'})`);
  for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? 'PASS' : 'FAIL'}  ${k}`);
  return Object.values(checks).every(Boolean);
}

const arg = process.argv[2];
if (!arg || arg === '--help') {
  console.log('Usage:\n  node eval/run.js <result.json>\n  node eval/run.js --all [dir]   (score every result JSON in a directory)\nBenchmark questions live in eval/questions.json (10 items: easy/medium/hard/adversarial/provenance/contradiction/books).\nRun research via the UI or API, save the result JSON, then score it here.');
  console.log(`\nBenchmark covers ${q.questions.length} questions across levels: ${[...new Set(q.questions.map((x) => x.level))].join(', ')}`);
  process.exit(0);
}

if (arg === '--all') {
  const dir = process.argv[3] || './data';
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => path.join(dir, f));
  if (!files.length) {
    console.log(`No result files in ${dir}.`);
    process.exit(2);
  }
  let pass = 0;
  for (const f of files) {
    try { if (scoreFile(f)) pass++; }
    catch (e) { console.log(`\n== ${f} → ERROR: ${(e.message || '').slice(0, 120)}`); }
  }
  console.log(`\n${pass}/${files.length} files fully audited.`);
  process.exit(pass === files.length ? 0 : 1);
}

process.exit(scoreFile(arg) ? 0 : 1);
