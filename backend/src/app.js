// Express app factory (no listening here — see index.js for local,
// api/index.js for Vercel). Injectable runFn/store enable HTTP-level tests
// without network or disk side effects.
import express from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { apiRouter } from './routes.js';
import { runResearch } from './engine/orchestrator.js';
import { saveResult, getResult, listResults, deleteResult, findCached, saveCacheEntry } from './store.js';
import { requestId, securityHeaders, cors } from './middleware/security.js';
import { validateMiddleware } from './middleware/validate.js';
import { openapiSpec } from './openapi.js';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

// Shared middleware stack — used by the local server AND the Vercel entry
// so both deployments get identical security/validation/observability.
export function applyApiMiddleware(app) {
  // Behind one proxy hop (Vercel, Docker ingress): req.ip must be the client,
  // not the proxy — otherwise every user shares one rate-limit bucket.
  app.set('trust proxy', 1);
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

/** Unknown /api/* routes answer JSON 404 (they used to fall through to the
 *  SPA catch-all and return index.html with HTTP 200). */
export function apiNotFound(req, res) {
  res.status(404).json({ error: `Unknown API route: ${req.method} ${req.originalUrl.split('?')[0].slice(0, 120)}` });
}

export function createApp({ runFn = runResearch, store = null } = {}) {
  const app = express();
  applyApiMiddleware(app);
  // Note: the BYOK key arrives in the x-gemini-key header, is used for the
  // research run only, and is never logged or persisted (see routes.js).
  app.use('/api', apiRouter({
    runFn,
    store: store || { saveResult, getResult, listResults, deleteResult, findCached, saveCacheEntry },
  }));
  app.use('/api', apiNotFound);

  // Static frontend when present (local/Docker). On Vercel the CDN serves
  // `frontend/` directly, so this is skipped if the directory is absent.
const staticDir = path.join(ROOT, 'frontend');
const indexHtml = path.join(staticDir, 'index.html');
if (existsSync(staticDir)) app.use(express.static(staticDir));

// Serve the shared engine modules the browser imports directly.
//
// frontend/app.js already tries to `import('../backend/src/export.js')` to
// render Markdown/HTML/media-brief/NotebookLM exports in-page, and
// `import('../backend/src/config.js')` / `models.js` for model discovery. The
// static Pages build stages backend/src so those imports resolve — but the
// express host served ONLY frontend/, so on every Docker/VPS/npm-start
// deployment the import 404'd, export fell through to window.open(), and the
// click opened a tab instead of downloading the file. Nothing here is secret
// (the same tree is published on Pages); keys arrive in request headers.
const sharedSrcDir = path.join(ROOT, 'backend', 'src');
if (existsSync(sharedSrcDir)) app.use('/backend/src', express.static(sharedSrcDir, { extensions: ['js'] }));
  if (existsSync(indexHtml)) {
    // SPA catch-all. Must NOT answer asset requests: returning index.html with a
// 200 for a missing /backend/src/*.js makes the browser report "Failed to fetch
// dynamically imported module" (a MIME error) instead of a plain 404, and the
// response gets CACHED — so fixing the route later still leaves broken tabs
// until a hard reload. Unknown .js/.css/.json now fail honestly.
app.get('*', (req, res, next) => {
  if (/\.(?:js|mjs|css|json|map|svg|png|jpe?g|webp|ico|woff2?)$/i.test(req.path)) return next();
  res.sendFile(indexHtml);
});
  }
  return app;
}
