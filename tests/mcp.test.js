// MCP tool wiring: valid invocation, invalid args, research failure, output shape.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createResearchMcpServer } from '../backend/src/mcpCore.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

async function withClient(runFn, fn, keys = ['test-key']) {
  const server = createResearchMcpServer({ runFn, keys });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.1' });
  await server.connect(serverT);
  await client.connect(clientT);
  try { await fn(client); } finally { await client.close(); await server.close(); }
}

describe('MCP research tool', () => {
  it('lists the research tool', async () => {
    await withClient(async () => ({}), async (client) => {
      const { tools } = await client.listTools();
      assert.equal(tools[0].name, 'research');
      assert.ok(tools[0].description.length > 20);
      assert.ok(tools[0].inputSchema.properties.question);
    });
  });
  it('runs the pipeline and returns structured content', async () => {
    const fake = async () => ({
      id: 't1', task: {}, plan: {}, report: {}, claims: [{
        id: 'c1', text: 'X.', state: 'supported', supporting: [], contradicting: [],
        confidence: 0.8, confidence_label: 'high', confidence_factors: [], status: 'supported',
        evidence: [], contradicting_evidence: [], independence: {}, reasoning: '',
      }], sources: [], contradictions: [], provenance: {}, relations: [], completedAt: 'now',
    });
    await withClient(fake, async (client) => {
      const out = await client.callTool({ name: 'research', arguments: { question: 'q q?', mode: 'quick' } });
      assert.equal(out.isError, undefined);
      assert.equal(out.structuredContent.id, 't1');
      assert.ok(out.content[0].text.includes('t1'));
    });
  });
  it('maps research failure to isError content', async () => {
    await withClient(async () => { throw new Error('boom'); }, async (client) => {
      const out = await client.callTool({ name: 'research', arguments: { question: 'q q?', mode: 'quick' } });
      assert.equal(out.isError, true);
      assert.match(out.content[0].text, /boom/);
    });
  });
  it('rejects invalid arguments', async () => {
    await withClient(async () => ({}), async (client) => {
      const out = await client.callTool({ name: 'research', arguments: { question: 'x' } });
      assert.equal(out.isError, true);
    });
  });
  it('reports missing server key honestly', async () => {
    await withClient(async () => ({}), async (client) => {
      const out = await client.callTool({ name: 'research', arguments: { question: 'q q?', mode: 'quick' } });
      assert.equal(out.isError, true);
      assert.match(out.content[0].text, /No Gemini API key/);
    }, []);
  });
});
