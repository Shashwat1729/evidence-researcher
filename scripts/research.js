#!/usr/bin/env node
// CLI: npm run research -- "question" [--mode quick|standard|deep|exhaustive] [--stance neutral|lean|...] [--hypothesis "..."]
import { loadEnv } from '../backend/src/env.js';
import { parseResearchArgs, validateCliArgs, executeResearch, usage } from './run.js';

loadEnv();

const opts = parseResearchArgs(process.argv);
if (opts.help) {
  console.log(usage());
  process.exit(0);
}
const err = validateCliArgs(opts);
if (err) {
  console.error(`Error: ${err}. Example: npm run research -- "When was X founded?" --mode quick`);
  process.exit(1);
}
const { exitCode } = await executeResearch(opts);
process.exitCode = exitCode;
