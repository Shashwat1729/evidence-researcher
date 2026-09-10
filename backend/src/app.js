// Express app factory (no listening here — see index.js for local,
// api/index.js for Vercel). Injectable runFn/store enable HTTP-level tests
// without network or disk side effects.
import express from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { apiRouter } from './routes.js';
import { runResearch } from './engine/orchestrator.js';
import { saveResult, getResult, listResults, deleteResult } from './store.js';
import { requestId, securityHeaders, cors } from './middleware/security.js';
import { validateMiddleware } from './middleware/validate.js';
import { openapiSpec } from './openapi.js';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

// Shared middleware stack — used by the local server AND the Vercel entry
// so both deployments get identical security/validation/observability.
export function applyApiMiddleware(app) {
  app.use(requestId);
  app.use(securityHeaders);
  app.use(cors);
  app.use(express.json({ limit: '256kb' }));
  app.use(validateMiddleware);
  // Structured request logging (never logs keys)
  app.use((req, _res, next) => {
    logger.info(`${req.method} ${req.path}`, { id: req.id, ip: req.ip });
    next();
  });
  app.get('/api/openapi.json', (_req, res) => res.json(openapiSpec));
}

export function createApp({ runFn = runResearch, store = null } = {}) {
  const app = express();
  app.set('trust proxy', 1);
  applyApiMiddleware(app);
  // Note: the BYOK key arrives in the x-gemini-key header, is used for the
  // research run only, and is never logged or persisted (see routes.js).
  app.use('/api', apiRouter({
    runFn,
    store: store || { saveResult, getResult, listResults, deleteResult },
  }));

  // Static frontend when present (local/Docker). On Vercel the CDN serves
  // `frontend/` directly, so this is skipped if the directory is absent.
  const staticDir = path.join(ROOT, 'frontend');
  const indexHtml = path.join(staticDir, 'index.html');
  if (existsSync(staticDir)) app.use(express.static(staticDir));
  if (existsSync(indexHtml)) {
    app.get('*', (_req, res) => res.sendFile(indexHtml));
  }
  return app;
}
