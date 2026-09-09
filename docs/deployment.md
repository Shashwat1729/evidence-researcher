# Deployment

## Local

```bash
npm install
cp .env.example .env   # GEMINI_API_KEY=...
npm run dev            # http://localhost:8787
```

## Docker (recommended for deep/exhaustive runs)

```bash
docker build -t evidence-researcher .
docker run -p 8787:8787 -e GEMINI_API_KEY=... -v er-data:/data evidence-researcher
```

Long research loops need a long-lived server — use Docker or a VPS/VM for
Deep and Exhaustive modes.

## Vercel (quick/standard modes)

The repo ships `vercel.json` + `api/index.js` (Express-as-function adapter):

- Import the repo, Framework Preset **Other** (settings come from `vercel.json`).
- Set `GEMINI_API_KEY` as an environment **secret** (or leave unset for BYOK-only).
- Caveat: Hobby functions cap at ~60s, so prefer **Quick/Standard** modes here;
  use Docker/VPS for Deep/Exhaustive. The API router is mounted at `/`, `/api`,
  and `/api/index` so rewrites resolve regardless of platform behavior.

## Fly.io / Render / Railway / VPS

`npm install && npm start` with env `GEMINI_API_KEY`, `PORT`, `DATA_DIR`
(persistent volume for history). No build step — the frontend is static files.

## Security notes

- `.env` is gitignored; only `.env.example` is committed. Never paste a real key
  into chat, docs, or client-side code.
- BYOK keys travel in the `x-gemini-key` header, are used in-memory per run, and
  are never logged, persisted, or sent to third parties (only Google's Gemini API).
- No analytics. External traffic: Gemini API, Google Search (via grounding), and
  free metadata APIs (OpenAlex, Crossref, arXiv, Open Library, Google Books).
