// Entry: local / Docker server. `npm run dev` / `npm start`.
import { loadEnv } from './env.js';
import { createApp } from './app.js';

loadEnv();

const app = createApp();
const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`Evidence Researcher running at http://localhost:${PORT}`);
  console.log(`Server-side Gemini key: ${process.env.GEMINI_API_KEY ? 'configured' : 'NOT set — enter a key in the UI (BYOK, local only)'}`);
});
