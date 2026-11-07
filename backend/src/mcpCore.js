// Shared MCP server factory: the real research pipeline behind one tool.
// Used by both the stdio server (npm run mcp) and the HTTP /mcp endpoint.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import { runResearch } from './engine/orchestrator.js';
import { getKeys } from './gemini.js';

export const RESEARCH_TOOL = {
  name: 'research',
  description: 'Evidence-first deep research. Searches the live web, evaluates source quality, extracts claims with auditable confidence, actively hunts contradicting evidence, and analyzes whether apparently independent sources share a common origin. Returns a structured, machine-readable research result with claim-level evidence, contradictions, provenance, and source relationships.',
};

export function createResearchMcpServer({ runFn = runResearch, keys } = {}) {
  const server = new McpServer(
    { name: 'evidence-researcher', version: '1.0.0' },
    { capabilities: { logging: {} } },
  );
  server.registerTool(RESEARCH_TOOL.name, {
    description: RESEARCH_TOOL.description,
    inputSchema: {
      question: z.string().min(3).describe('Research question'),
      mode: z.enum(['quick', 'standard', 'deep', 'exhaustive']).default('standard').describe('Research depth/budget'),
      stance: z.enum(['neutral', 'lean', 'adversarial', 'steelman', 'comparative']).default('neutral').describe('Investigation stance'),
      hypothesis: z.string().max(2000).optional().describe('Optional hypothesis for the stance'),
    },
    // Shape of the delivered result — marketplaces check every delivery
    // against this. Loose on the report prose, strict on the evidence model.
    outputSchema: {
      id: z.string(),
      task: z.record(z.string(), z.any()),
      plan: z.record(z.string(), z.any()),
      report: z.record(z.string(), z.any()),
      claims: z.array(z.object({
        id: z.string(), text: z.string(), state: z.string(),
        supporting: z.array(z.string()), contradicting: z.array(z.string()),
        confidence: z.number().nullable(), confidence_label: z.string(),
        confidence_factors: z.array(z.object({ name: z.string(), value: z.number() })),
        status: z.enum(['supported', 'partially-supported', 'mixed', 'contradicted', 'insufficient-evidence']),
        evidence: z.array(z.record(z.string(), z.any())),
        contradicting_evidence: z.array(z.record(z.string(), z.any())),
        independence: z.record(z.string(), z.any()),
        reasoning: z.string(),
      })),
      sources: z.array(z.record(z.string(), z.any())),
      contradictions: z.array(z.record(z.string(), z.any())),
      provenance: z.record(z.string(), z.any()),
      relations: z.array(z.record(z.string(), z.any())),
      completedAt: z.string(),
    },
  }, async ({ question, mode, stance, hypothesis }) => {
    const keyList = keys !== undefined ? keys : getKeys([]);
    if (!keyList.length) {
      return { isError: true, content: [{ type: 'text', text: 'No Gemini API key configured on the server (GEMINI_API_KEY).' }] };
    }
    try {
      const result = await runFn(
        { question, mode, stance, hypothesis: hypothesis || '' },
        { key: keyList, emit: () => {} },
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    } catch (e) {
      return { isError: true, content: [{ type: 'text', text: `research failed: ${String(e?.message || e).slice(0, 500)}` }] };
    }
  });
  return server;
}
