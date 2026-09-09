// Audit-score CLI for a saved research result JSON.
// Usage: node eval/run.js <result.json>  |  node eval/run.js --help
import { readFileSync } from 'node:fs';
import { score } from './score.js';

const q = JSON.parse(readFileSync(new URL('./questions.json', import.meta.url), 'utf8'));

const arg = process.argv[2];
if (!arg || arg === '--help') {
  console.log('Usage: node eval/run.js <result.json>\nBenchmark questions live in eval/questions.json (10 items: easy/medium/hard/adversarial/provenance/contradiction/books).\nRun research via the UI or API, save the result JSON, then score it here.');
  console.log(`\nBenchmark covers ${q.questions.length} questions across levels: ${[...new Set(q.questions.map((x) => x.level))].join(', ')}`);
  process.exit(0);
}

const result = JSON.parse(readFileSync(arg, 'utf8'));
const { checks, score: s } = score(result);
console.log(`Audit score: ${s}`);
for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? 'PASS' : 'FAIL'}  ${k}`);
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
