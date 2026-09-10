// One-shot live research run using .env keys (primary + automatic fallback).
// Usage: npm run live -- "<question>" [quick|standard|deep|exhaustive]
// Saves the full result to DATA_DIR and prints the audit score.
import { loadEnv } from '../backend/src/env.js';
import { executeResearch } from './run.js';

loadEnv();

const question = process.argv[2] || 'In what year was the University of Bologna traditionally founded, and what evidence supports that date?';
const mode = process.argv[3] || 'quick';
console.log(`Live run (values never printed)`);
const { exitCode } = await executeResearch(
  { question, mode, stance: 'neutral', hypothesis: '', documentary: false },
);
process.exitCode = exitCode;
