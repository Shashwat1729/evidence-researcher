// Vercel serverless entry: the Express API as the function handler.
// Static frontend is served by Vercel's CDN (outputDirectory: frontend).
// Uses the SAME middleware stack as the local server (applyApiMiddleware),
// then mounts the router at several prefixes so /api/* works regardless of
// how the platform rewrites the URL onto this function.
import express from 'express';
import { loadEnv } from '../backend/src/env.js';
import { applyApiMiddleware } from '../backend/src/app.js';
import { apiRouter } from '../backend/src/routes.js';

loadEnv(); // no-op on Vercel (dashboard env wins; no .env file shipped)

const app = express();
applyApiMiddleware(app);
const router = apiRouter();
app.use('/api', router);
app.use('/api/index', router);
app.use('/', router);

export default app;
