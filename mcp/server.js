#!/usr/bin/env node
// MCP server (stdio) exposing the research pipeline as the `research` tool.
// Run: npm run mcp

import { loadEnv } from '../backend/src/env.js';
loadEnv();

const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
const { createResearchMcpServer } = await import('../backend/src/mcpCore.js');

const server = createResearchMcpServer();
await server.connect(new StdioServerTransport());
console.error('evidence-researcher MCP server ready (stdio). Tool: research');
