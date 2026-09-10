// Entry: local / Docker server. `npm run dev` / `npm start`.
import { loadEnv } from './env.js';
import { createApp } from './app.js';
import { logger } from './logger.js';

loadEnv();

const app = createApp();
const PORT = process.env.PORT || 8787;
const server = app.listen(PORT, () => {
  logger.info(`Evidence Researcher running at http://localhost:${PORT}`);
  logger.info(`Server-side Gemini key: ${process.env.GEMINI_API_KEY ? 'configured' : 'NOT set — enter a key in the UI (BYOK, local only)'}`);
});

// Graceful shutdown: stop accepting, drain in-flight SSE, then exit.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`Received ${signal} — draining…`);
  server.close(() => {
    logger.info('Server closed cleanly.');
    process.exit(0);
  });
  // Force-exit if connections hang (SSE streams can be long-lived).
  setTimeout(() => {
    logger.warn('Forcing exit with open connections.');
    process.exit(0);
  }, 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => {
  logger.error('Unhandled rejection', { error: String(err?.message || err).slice(0, 300) });
});
