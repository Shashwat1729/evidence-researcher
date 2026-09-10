// Request validation — zero deps, explicit error messages.
// Validates POST /api/research body before any model/network work.
import { isKnownModel } from '../config.js';

const MODES = new Set(['quick', 'standard', 'deep', 'exhaustive']);
const STANCES = new Set(['neutral', 'lean', 'adversarial', 'steelman', 'comparative']);

export function validateResearchBody(body) {
  const errors = [];
  const q = String(body?.question ?? '').trim();
  if (!q || q.length < 3) errors.push('question is required (≥3 chars)');
  if (q.length > 5000) errors.push('question too long (max 5000 chars)');
  if (body?.mode !== undefined && !MODES.has(body.mode)) errors.push(`mode must be one of ${[...MODES].join(', ')}`);
  if (body?.stance !== undefined && !STANCES.has(body.stance)) errors.push(`stance must be one of ${[...STANCES].join(', ')}`);
  if (body?.hypothesis !== undefined && String(body.hypothesis).length > 2000) errors.push('hypothesis too long (max 2000 chars)');
  if (body?.documentary !== undefined && typeof body.documentary !== 'boolean') errors.push('documentary must be boolean');
  if (body?.fresh !== undefined && typeof body.fresh !== 'boolean') errors.push('fresh must be boolean');
  if (body?.model !== undefined && body.model !== '' && !isKnownModel(body.model)) errors.push('model must be one of the offered models');
  // Prompt-injection guard: stance/hypothesis must not look like system override
  const suspicious = /ignore previous instructions|system prompt|you are now/i;
  if (suspicious.test(q) || suspicious.test(String(body?.hypothesis ?? ''))) {
    errors.push('question contains disallowed instruction-like content');
  }
  return errors;
}

export function validateMiddleware(req, res, next) {
  if (!req.path.includes('/research') || req.method !== 'POST') return next();
  const errors = validateResearchBody(req.body);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  next();
}
