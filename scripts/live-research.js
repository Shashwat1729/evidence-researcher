// One-shot live research run using .env keys (primary + automatic fallback).
// Usage: npm run live -- "<question>" [quick|standard|deep|exhaustive]
// Saves the full result to DATA_DIR and prints the audit score.
import { loadEnv } from '../backend/src/env.js';

loadEnv();
const { runResearch } = await import('../backend/src/engine/orchestrator.js');
const { saveResult } = await import('../backend/src/store.js');
const { score } = await import('../eval/score.js');
const { getKeys } = await import('../backend/src/gemini.js');
const { writeFile } = await import('node:fs/promises');

const question = process.argv[2] || 'In what year was the University of Bologna traditionally founded, and what evidence supports that date?';
const mode = process.argv[3] || 'quick';
const keys = getKeys('');
if (!keys.length) {
  console.log('No keys configured.');
  process.exitCode = 2;
} else {
  console.log(`Live run: mode=${mode} keys=${keys.length} (values never printed)`);
  console.log(`Q: ${question}`);
  try {
  const result = await runResearch(
    { question, mode, stance: 'neutral', hypothesis: '', documentary: false },
    {
      key: keys[0],
      emit: (e) => {
        if (['start', 'plan', 'sources', 'claims', 'done', 'warning'].includes(e.type)) {
          console.log(`[${e.type}] ${e.message}`);
        }
      },
    },
  );
  const id = await saveResult(result);
  await writeFile(`./live-result-${id}.json`, JSON.stringify(result, null, 2), 'utf8');
  const { checks, score: s } = score(result);
  console.log(`\nSaved: ${id} | sources=${result.sources.length} claims=${result.claims.length} ` +
    `modelCalls=${result.stats.modelCalls} searches=${result.stats.searchCalls} ` +
    `tokens=${result.stats.tokensIn}/${result.stats.tokensOut} rotations=${result.stats.keyRotations} ` +
    `runtime=${(result.stats.runtimeMs / 1000).toFixed(0)}s`);
  console.log(`Audit score: ${s}`);
  for (const [k, v] of Object.entries(checks)) console.log(`  ${v ? 'PASS' : 'FAIL'}  ${k}`);
  } catch (e) {
    console.log(`\nRun failed cleanly: ${(e.message || String(e)).slice(0, 200)}${e.status ? ` (HTTP ${e.status})` : ''}`);
    console.log('Tip: free-tier quotas are tiny (a few requests/min). Wait a minute and retry — the fallback key engages automatically.');
    process.exitCode = 1;
  }
}
