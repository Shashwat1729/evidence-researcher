# Production Checklist

Use before deploying a public instance.

- [ ] `GEMINI_API_KEY` set as secret env (never in repo, never in client bundle)
- [ ] `GEMINI_API_KEY_FALLBACK` set if you have a second project (doubles free-tier RPM)
- [ ] `DATA_DIR` points to persistent volume (or external DB via `store.js` swap)
- [ ] `RATE_LIMIT_MAX` tuned (default 30 req/min/IP for POST /api/research)
- [ ] `MAX_CONCURRENT_RUNS` tuned (default 8; lower for free-tier, higher for paid)
- [ ] `CORS_ORIGIN` set to your frontend origin (default `*` is permissive)
- [ ] `LOG_LEVEL` set to `info` or `warn` in prod (not `debug`)
- [ ] `NODE_ENV=production` (enables HSTS, JSON logs, static caching)
- [ ] Health check wired: `GET /api/health`
- [ ] OpenAPI docs at `GET /api/openapi.json` (for integrations)
- [ ] Validate keys without burning quota: `npm run keys`
- [ ] Run tests: `npm test` (65 tests, includes SSE + export + quota)
- [ ] Verify no secrets in repo: `git ls-files | xargs grep -l "AIzaSy" || echo clean`
- [ ] Frontend `localStorage` clear works (Privacy: user can clear history)
- [ ] Print/PDF works (Final Report → Print)
- [ ] History export MD/HTML/JSON tested
- [ ] Rate limiter + concurrency guard tested under load
- [ ] Academic cache hit rate observed (should warm after a few queries)
