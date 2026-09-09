// OpenAPI 3.0 spec for the Evidence Researcher API — served at /api/openapi.json
// and used for docs generation. No external deps.

export const openapiSpec = {
  openapi: '3.0.3',
  info: {
    title: 'Evidence Researcher API',
    version: '1.0.0',
    description: 'Evidence-first deep research agent. Gemini is the reasoning engine; the orchestrator owns planning, search, provenance, and synthesis.',
  },
  servers: [{ url: '/' }],
  paths: {
    '/api/health': {
      get: {
        summary: 'Liveness + model info',
        responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } } },
      },
    },
    '/api/config': {
      get: {
        summary: 'Public config (modes, stances, server key presence)',
        responses: { '200': { description: 'OK' } },
      },
    },
    '/api/research': {
      post: {
        summary: 'Start a research run (SSE stream)',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['question'],
                properties: {
                  question: { type: 'string', minLength: 3, maxLength: 5000 },
                  mode: { type: 'string', enum: ['quick', 'standard', 'deep', 'exhaustive'], default: 'standard' },
                  stance: { type: 'string', enum: ['neutral', 'lean', 'adversarial', 'steelman', 'comparative'], default: 'neutral' },
                  hypothesis: { type: 'string', maxLength: 2000 },
                  documentary: { type: 'boolean', default: false },
                },
              },
            },
          },
        },
        parameters: [{ name: 'x-gemini-key', in: 'header', description: 'BYOK Gemini API key (overrides server key)', schema: { type: 'string' } }],
        responses: {
          '200': { description: 'SSE stream (text/event-stream)', content: { 'text/event-stream': { schema: { type: 'string' } } } },
          '400': { description: 'Bad request' },
          '401': { description: 'Missing API key' },
          '429': { description: 'Rate limited' },
          '503': { description: 'Too many concurrent runs' },
        },
      },
    },
    '/api/history': { get: { summary: 'List recent runs', responses: { '200': { description: 'OK' } } } },
    '/api/history/{id}': {
      get: { summary: 'Get a run by id', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } } },
      delete: { summary: 'Delete a run', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'OK' } } },
    },
    '/api/export/{id}': {
      get: {
        summary: 'Export a run',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'format', in: 'query', schema: { type: 'string', enum: ['md', 'html', 'json'], default: 'md' } }],
        responses: { '200': { description: 'OK' } },
      },
    },
  },
};
