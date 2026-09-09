// Post-synthesis cross-evaluation (inspired by iflytek/DeepResearch):
// an independent pass checks whether each finding's cited excerpts actually
// support it. Catches synthesis-time drift/hallucination. Never fatal —
// returns [] when the model is unavailable.

import { generateJson } from '../gemini.js';

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          n: { type: 'number' },
          supported: { type: 'string' },
          note: { type: 'string' },
        },
        required: ['n', 'supported'],
      },
    },
  },
  required: ['results'],
};

export async function verifyFindings({ key, model, findings, sources, onKeyEvent }) {
  const byId = new Map((sources || []).map((s) => [s.id, s]));
  const items = (findings || []).slice(0, 8).map((f, n) => ({
    n,
    heading: f.heading || '',
    body: String(f.body || '').slice(0, 800),
    excerpts: (f.cite || []).map((id) => {
      const s = byId.get(id);
      const txt = s ? ((s.passages || []).map((p) => p.text).join(' ').slice(0, 600)) : '';
      return { id, excerpt: txt };
    }),
  }));
  if (!items.length) return [];
  const prompt = `You are a strict fact-checker. For each finding below, judge whether its cited excerpts DIRECTLY support the finding text.
supported: "yes" (excerpts establish it), "partial" (excerpts support part of it), "no" (excerpts missing, irrelevant, or contradicting). Be strict — a plausible-sounding finding with thin excerpts is "partial" at best.
Findings: ${JSON.stringify(items).slice(0, 12000)}
Return JSON: {"results": [{"n": 0, "supported": "yes|partial|no", "note": "one sentence"}]}`;
  try {
    const { data } = await generateJson({ key, model, prompt, schema: VERIFY_SCHEMA, maxTokens: 2048, thinking: 'low', onKeyEvent });
    return (data.results || []).slice(0, 8).map((r) => ({
      n: Number.isFinite(+r.n) ? +r.n : 0,
      supported: ['yes', 'partial', 'no'].includes(r.supported) ? r.supported : 'partial',
      note: String(r.note || '').slice(0, 300),
    }));
  } catch {
    return [];
  }
}
