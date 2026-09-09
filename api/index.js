// Vercel serverless entry: the Express API as the function handler.
// Static frontend is served by Vercel's CDN (outputDirectory: frontend).
// The router is mounted at several prefixes so /api/* works regardless of
// how the platform rewrites the URL onto this function.
import express from 'express';
import { loadEnv } from '../backend/src/env.js';
import { apiRouter } from '../backend/src/routes.js';

loadEnv(); // no-op on Vercel (dashboard env wins; no .env file shipped)

const app = express();
app.use(express.json({ limit: '256kb' }));
const router = apiRouter();
app.use('/api', router);
app.use('/api/index', router);
app.use('/', router);

export default app;
