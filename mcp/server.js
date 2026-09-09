#!/usr/bin/env node
// Minimal MCP server stub — exposes evidence-researcher as a tool.
// Requires @modelcontextprotocol/sdk when actually used; this stub documents
// the interface and fails gracefully if the SDK is not installed.
// Tool: research(question, mode, stance, hypothesis)

import { loadEnv } from '../backend/src/env.js';
loadEnv();

const TOOL_SPEC = {
  name: 'research',
  description: 'Evidence-first deep research: searches web, evaluates sources, extracts claims, hunts contradictions, returns cited report.',
  inputSchema: {
    type: 'object',
    required: ['question'],
    properties: {
      question: { type: 'string', minLength: 3, description: 'Research question' },
      mode: { type: 'string', enum: ['quick','standard','deep','exhaustive'], default: 'standard' },
      stance: { type: 'string', enum: ['neutral','lean','adversarial','steelman','comparative'], default: 'neutral' },
      hypothesis: { type: 'string', description: 'Optional hypothesis for stance' },
    },
  },
};

async function main() {
  let SDK;
  try {
    SDK = await import('@modelcontextprotocol/sdk/server/index.js');
  } catch {
    console.log(JSON.stringify({ tool: TOOL_SPEC }, null, 2));
    console.log('\nMCP stub: install @modelcontextprotocol/sdk to run as a server.');
    console.log('This file documents the tool interface for future MCP search providers.');
    process.exit(0);
  }
  // If SDK present, wire up real server (left as integration point)
  console.log('MCP server would start here with SDK:', !!SDK);
}

main();
