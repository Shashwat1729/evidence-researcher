import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  KEY_SHAPE, dedupeKeys, keyKind, keyKindLabel, looksLikeKey, maskKey,
  maxKeys, normalizeKeys, splitKeyInput,
} from '../backend/src/keys.js';
import { mergeModels, validateKey } from '../backend/src/routes.js';
import { getKeys, isModelNotFound, modelLadder, withModelFallback } from '../backend/src/gemini.js';
import {
  MODEL_ID_SHAPE, UNUSABLE_PATTERN, clearModelCache, compareModels, discoverModels, discoverModelsCached, parseModelEntry, selectResearchModels, titleizeModel,
} from '../backend/src/models.js';
import { isKnownModel, canonicalizeModel, MODEL_FALLBACK_LADDER, AVAILABLE_MODELS } from '../backend/src/config.js';

// SYNTHETIC, correctly-shaped credentials — never real ones.
//
// This file previously held four LIVE keys. That is not a style nit: GitHub
// push protection REJECTED the push ("Push cannot contain secrets"), and
// independently a credential that reaches a git remote must be treated as
// compromised and rotated. If you ever paste a real key here, revoke it.
//
// The values are assembled from parts so that no key-shaped literal exists
// anywhere in the repository — which also keeps secret scanners quiet on a
// string that is not a secret. Tests only need the SHAPE; whether a key works
// is decided by a live call, which these deliberately never make.
const AQ = `AQ.Ab8RN${'a'.repeat(40)}`;
const AQ2 = `AQ.Ab8RN${'b'.repeat(40)}`;
const AIZA = `AIza${'c'.repeat(37)}`;
const AIZA2 = `AIza${'d'.repeat(37)}`;

describe('key formats: both formats Google issues are accepted', () => {
  // THE regression. Google moved AI Studio to AQ. authorization keys in June
  // 2026; this repo gated on "AIza" and reported four working keys as invalid,
  // then told the user it had removed them.
  it('accepts AQ. authorization keys and AIza standard keys alike', () => {
    assert.ok(looksLikeKey(AQ), 'AQ. auth key accepted');
    assert.ok(looksLikeKey(AIZA), 'AIza standard key accepted');
    assert.equal(keyKind(AQ), 'auth');
    assert.equal(keyKind(AIZA), 'standard');
    assert.match(keyKindLabel(keyKind(AQ)), /authorization/i);
  });

  it('still rejects obvious junk (cheap typo filter, not the arbiter)', () => {
    for (const bad of ['', 'hello', 'AIza', 'AQ.', 'sk-ant-api03-xyz', 'Bearer abcdefghijklmnopqrstuvwxyz']) {
      assert.equal(looksLikeKey(bad), false, `rejects ${JSON.stringify(bad)}`);
    }
    assert.equal(keyKind('nope'), 'unknown');
  });

  it('does not pin a key length — Google has shipped several', () => {
    assert.ok(looksLikeKey(`AQ.${'a'.repeat(30)}`));
    assert.ok(looksLikeKey(`AQ.${'a'.repeat(80)}`));
    assert.ok(looksLikeKey(`AIza${'b'.repeat(33)}`));
  });

  it('masks without leaking key material', () => {
    // Derived rather than hardcoded, so swapping the synthetic key above can
    // never make this test quietly assert the wrong thing.
    assert.equal(maskKey(AQ), `${AQ.slice(0, 6)}…${AQ.slice(-4)}`);
    assert.equal(maskKey(AIZA), `${AIZA.slice(0, 6)}…${AIZA.slice(-4)}`);
    assert.ok(maskKey(AQ).length < AQ.length, 'mask is shorter than the key');
    assert.ok(!maskKey(AQ).includes(AQ.slice(7, 24)), 'the middle of the key is never shown');
    assert.equal(maskKey('short'), 'sh…');
    assert.equal(maskKey(''), '(empty)');
  });

  it('FRONTEND/BACKEND shape checks cannot drift apart', () => {
    // The frontend mirrors KEY_SHAPE because the express server does not serve
    // backend/src. That duplication is exactly what caused the original bug, so
    // it is pinned by a test rather than by a comment.
    const src = readFileSync(new URL('../frontend/app.js', import.meta.url), 'utf8');
    const m = src.match(/const KEY_SHAPE = (\/\^.*\/);/);
    assert.ok(m, 'frontend declares KEY_SHAPE as a regex literal');
    const frontendShape = new RegExp(m[1].slice(1, -1));
    for (const k of [AQ, AQ2, AIZA, AIZA2, '', 'nope', 'AIza', 'sk-ant-xyz']) {
      assert.equal(frontendShape.test(k), KEY_SHAPE.test(k), `frontend/backend agree on ${JSON.stringify(k.slice(0, 12))}`);
    }
  });
});

describe('key input parsing and duplicates', () => {
  it('parses every paste shape: JSON array, commas, spaces, newlines', () => {
    assert.deepEqual(splitKeyInput(`[${JSON.stringify([AQ, AIZA]).slice(1, -1)}]`).length, 2);
    assert.deepEqual(splitKeyInput(`${AQ},${AIZA}`), [AQ, AIZA]);
    assert.deepEqual(splitKeyInput(`${AQ} ${AIZA}`), [AQ, AIZA]);
    assert.deepEqual(splitKeyInput(`${AQ}\n${AIZA}\n`), [AQ, AIZA]);
    assert.deepEqual(splitKeyInput(`${AQ};${AIZA}`), [AQ, AIZA]);
    assert.deepEqual(splitKeyInput('   '), []);
  });

  it('counts duplicates instead of silently swallowing them', () => {
    // The user pasted one key twice and had no way to learn it counted once.
    const r = normalizeKeys([AQ, AQ2, AQ, AIZA, AQ]);
    assert.deepEqual(r.keys, [AQ, AQ2, AIZA]);
    assert.equal(r.duplicates, 2);
    assert.equal(r.dropped, 0);
  });

  it('reports how many keys the cap dropped rather than losing them', () => {
    const many = Array.from({ length: 8 }, (_, i) => `AQ.Ab8RN${'x'.repeat(20)}${i}`);
    const r = normalizeKeys(many, 5);
    assert.equal(r.keys.length, 5);
    assert.equal(r.dropped, 3);
  });

  it('dedupeKeys preserves order', () => {
    assert.deepEqual(dedupeKeys(['b', 'a', 'b', '', null, 'a']).keys, ['b', 'a']);
  });

  it('maxKeys is dynamic and bounded', () => {
    const def = maxKeys();
    assert.ok(def >= 10, `default cap must exceed the old hardcoded 5 (got ${def})`);
    assert.ok(def <= 200);
  });
});

describe('getKeys rotation pool', () => {
  it('returns every supplied key, not the first six', () => {
    const many = Array.from({ length: 12 }, (_, i) => `AQ.Ab8RN${'y'.repeat(20)}${i}`);
    assert.equal(getKeys(many).length, 12);
  });
  it('de-duplicates (a repeated key shares one quota)', () => {
    assert.equal(getKeys([AQ, AQ, AQ2]).length, 2);
  });
  it('splits a pasted blob into individual keys', () => {
    assert.equal(getKeys(`${AQ},${AIZA}`).length, 2);
  });
});

describe('validateKey accepts the AQ format (live-call arbiter)', () => {
  it('does not reject an AQ key on format alone', async () => {
    const seen = [];
    const r = await validateKey(AQ, {
      fetchFn: async (url, o) => { seen.push(o.headers['x-goog-api-key']); return { ok: true, status: 200, json: async () => ({ models: [] }) }; },
    });
    assert.equal(r.valid, true);
    assert.equal(r.kind, 'auth');
    assert.deepEqual(seen, [AQ], 'key travelled in the header, and was actually checked');
  });
  it('treats a quota 429 as valid-but-hot, for both formats', async () => {
    for (const k of [AQ, AIZA]) {
      const r = await validateKey(k, { fetchFn: async () => ({ ok: false, status: 429, json: async () => ({}) }) });
      assert.equal(r.valid, true, `${keyKind(k)} key 429 → still valid`);
      assert.ok(r.warning);
    }
  });
  it('names the unrestricted-key rejection instead of shrugging', async () => {
    const r = await validateKey(AIZA, {
      fetchFn: async () => ({ ok: false, status: 403, json: async () => ({ error: { message: 'API keys is not allowed for this API.' } }) }),
    });
    assert.equal(r.valid, false);
    assert.match(r.error, /unrestricted|restrict/i, 'actionable message for the 2026 key-restriction change');
  });
  it('reports a short key without a network call', async () => {
    let called = false;
    const r = await validateKey('AQ.short', { fetchFn: async () => { called = true; return { ok: true }; } });
    assert.equal(r.valid, false);
    assert.equal(called, false);
  });
});

describe('model availability is per-project, not per-key-set', () => {
  it('isModelNotFound recognises the 2.5 retirement message', () => {
    const err = { status: 404, message: 'This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash' };
    assert.equal(isModelNotFound(err), true);
    assert.equal(isModelNotFound({ status: 429, message: 'quota' }), false);
    assert.equal(isModelNotFound({ status: 400, message: 'bad request' }), false);
  });

  it('the ladder starts at the requested model and ends at verified ids', () => {
    const l = modelLadder('gemini-9.9-imaginary');
    assert.equal(l[0], 'gemini-9.9-imaginary', 'requested id is always tried first');
    assert.ok(l.length >= 2, 'has somewhere to fall back to');
    assert.equal(new Set(l).size, l.length, 'no duplicates in the ladder');
    for (const id of MODEL_FALLBACK_LADDER) assert.ok(l.includes(id), `${id} reachable`);
  });

  it('walks the whole ladder instead of retrying one dead id', async () => {
    // The old code retried ONCE onto MODEL_CONFIG.research — frequently the
    // very id that had just 404'd, so a dead model ended the run.
    const tried = [];
    const out = await withModelFallback('gemini-dead', null, async (m) => {
      tried.push(m);
      if (tried.length < 3) throw Object.assign(new Error('gone'), { status: 404, message: 'no longer available to new users' });
      return 'ok:' + m;
    });
    assert.equal(tried.length, 3, 'kept walking after two dead rungs');
    assert.match(out, /^ok:/);
    assert.notEqual(tried[1], 'gemini-dead', 'never retried the same dead id');
  });

  it('announces each fallback so a substituted model is never silent', async () => {
    const events = [];
    await withModelFallback('gemini-dead', (e) => events.push(e), async (m) => {
      if (m === 'gemini-dead') throw Object.assign(new Error('gone'), { status: 404, message: 'not found' });
      return 'ok';
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'model-fallback');
    assert.equal(events[0].from, 'gemini-dead');
    assert.ok(events[0].to, 'says which model it moved to');
  });

  it('does not walk the ladder for a quota or key error', async () => {
    let calls = 0;
    await assert.rejects(
      withModelFallback('gemini-flash-latest', null, async () => { calls++; throw Object.assign(new Error('quota'), { status: 429 }); }),
      /quota/,
    );
    assert.equal(calls, 1, 'a 429 must fail fast, not burn calls on other models');
  });

  // THE daily-cap fix. Google's real message names the metric and often carries a
  // SHORT Retry-After, so the old hours-based detection missed it, the error
  // message was overwritten, and a spent 20/day bucket ended the run instead of
  // continuing on Flash-Lite (500/day).
  it('a spent DAILY cap walks the ladder, even with a short Retry-After', async () => {
    const googleMsg = "Quota exceeded for quota metric 'Generate Content API requests per day'. Limit: 20 per day.";
    const tried = [];
    const reasons = [];
    const out = await withModelFallback('gemini-flash-latest', (e) => reasons.push(e.reason), async (m) => {
      tried.push(m);
      if (tried.length < 3) {
        throw Object.assign(new Error('Gemini quota exhausted'), { status: 429, code: 'RPD_EXHAUSTED', dailyCap: true, retryAfter: 60000, original: googleMsg });
      }
      return 'ok:' + m;
    });
    assert.equal(tried.length, 3, 'kept going after two spent daily buckets');
    assert.match(out, /^ok:/);
    assert.deepEqual(reasons, ['daily-cap', 'daily-cap'], 'announced as a quota move, not a silent substitution');
    // And it must land somewhere that still has budget.
    assert.match(tried[tried.length - 1], /lite/, 'final rung is a Flash-Lite model (500 req/day)');
  });

  it('the per-MINUTE message never triggers a model swap', async () => {
    // "requests per minute" must not match a day-specific pattern, or every
    // brief rate-limit would abandon the requested model.
    let calls = 0;
    await assert.rejects(
      withModelFallback('gemini-flash-latest', null, async () => {
        calls++;
        throw Object.assign(new Error("Quota exceeded for quota metric 'Generate Content API requests per minute'"), { status: 429 });
      }),
      /per minute/,
    );
    assert.equal(calls, 1, 'a per-minute limit fails fast without swapping models');
  });
});

describe('model acceptance is open-ended (no code change needed for new models)', () => {
  it('accepts any well-formed gemini id, including ones this build predates', () => {
    // The curated allow-list used to 400 on anything it had not heard of, so a
    // brand-new Google model was unusable until someone edited the source.
    for (const id of ['gemini-4.0-flash', 'gemini-9.9-ultra-preview', 'gemini-flash-latest', 'gemini-3.1-flash-lite']) {
      assert.equal(isKnownModel(id), true, `${id} accepted`);
    }
  });
  it('rejects non-models and known-retired ids', () => {
    for (const id of ['', 'gpt-4', 'flash', 'models/gemini-2.5-flash-x', 'gemini-1.5-pro', 'gemini-2.0-flash']) {
      assert.equal(isKnownModel(id), false, `${JSON.stringify(id)} rejected`);
    }
  });
  it('canonicalizes retired ids to Auto instead of failing a saved preference', () => {
    assert.equal(canonicalizeModel('gemini-1.5-flash'), '');
    assert.equal(canonicalizeModel('gemini-4.0-flash'), 'gemini-4.0-flash');
  });
  it('no offered model is a known-retired id', () => {
    for (const m of AVAILABLE_MODELS) assert.equal(isKnownModel(m.id), true, `${m.id} is selectable`);
  });
});

describe('live model discovery', () => {
  const catalogue = [
    { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'], description: 'Old flash.' },
    { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportedGenerationMethods: ['generateContent'], description: 'Newest flash. Fast. Cheap.' },
    { name: 'models/gemini-3.8-flash-lite', displayName: '', supportedGenerationMethods: ['generateContent'], description: '' },
    { name: 'models/gemini-3.8-pro-preview', supportedGenerationMethods: ['generateContent'], description: '' },
    { name: 'models/gemini-4.0-flash', supportedGenerationMethods: ['generateContent'], description: 'A model released after this build.' },
    { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.8-live-extended-thinking', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemma-3-27b-it', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
  ];

  it('keeps text models and drops everything this app cannot use for prose', () => {
    const ids = selectResearchModels(catalogue).map((m) => m.id);
    assert.ok(ids.includes('gemini-4.0-flash'), 'a model newer than this build is offered');
    assert.ok(ids.includes('gemini-3.8-flash'));
    for (const bad of ['gemini-embedding-001', 'text-embedding-004', 'gemini-2.5-flash-image', 'gemini-2.5-flash-preview-tts', 'gemini-3.8-live-extended-thinking', 'gemma-3-27b-it']) {
      assert.ok(!ids.includes(bad), `${bad} filtered out`);
    }
  });

  it('ranks newest first, flash before pro before lite, stable before preview', () => {
    const ids = selectResearchModels(catalogue).map((m) => m.id);
    assert.ok(ids.indexOf('gemini-4.0-flash') < ids.indexOf('gemini-3.8-flash'), 'newer family first');
    assert.ok(ids.indexOf('gemini-3.8-flash') < ids.indexOf('gemini-3.8-flash-lite'), 'flash before lite');
    assert.ok(ids.indexOf('gemini-3.8-flash-lite') < ids.indexOf('gemini-3.8-pro-preview'), 'lite before pro');
  });

  it('puts curated suggestions first and keeps their written blurbs', () => {
    const list = selectResearchModels(catalogue, ['gemini-3.8-flash']);
    assert.equal(list[0].id, 'gemini-3.8-flash');
    assert.equal(list[0].curated, true);
  });

  it('de-duplicates the same id across keys', () => {
    const once = selectResearchModels(catalogue);
    const twice = selectResearchModels([...catalogue, ...catalogue]);
    assert.deepEqual(twice.map((m) => m.id), once.map((m) => m.id));
  });

  it('unions catalogues across keys — availability is per-project', async () => {
    const calls = [];
    const fetchFn = async (_url, o) => {
      calls.push(o.headers['x-goog-api-key']);
      const body = o.headers['x-goog-api-key'] === AQ
        ? { models: [{ name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] }] }
        : { models: [{ name: 'models/gemini-4.0-flash', supportedGenerationMethods: ['generateContent'] }] };
      return { ok: true, status: 200, json: async () => body };
    };
    const ids = (await discoverModels([AQ, AQ2], { fetchFn })).map((m) => m.id);
    assert.equal(calls.length, 2);
    assert.ok(ids.includes('gemini-3.8-flash') && ids.includes('gemini-4.0-flash'), 'union across projects');
  });

  it('one dead key does not hide the others', async () => {
    const fetchFn = async (_url, o) => {
      if (o.headers['x-goog-api-key'] === AQ) throw new Error('network down');
      return { ok: true, status: 200, json: async () => ({ models: [{ name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] }] }) };
    };
    assert.equal((await discoverModels([AQ, AQ2], { fetchFn })).length, 1);
  });

  it('never throws — an empty list lets the caller keep the curated picker', async () => {
    const fetchFn = async () => { throw new Error('offline'); };
    assert.deepEqual(await discoverModels([AQ], { fetchFn }), []);
    assert.deepEqual(await discoverModels([], { fetchFn }), []);
  });

  it('parses defensively', () => {
    assert.equal(parseModelEntry(null), null);
    assert.equal(parseModelEntry({ name: 'models/text-embedding-004' }), null);
    assert.equal(titleizeModel('gemini-3.8-flash-lite'), 'Gemini 3.8 Flash Lite');
    assert.ok(MODEL_ID_SHAPE.test('gemini-4.0-flash'));
    assert.ok(compareModels('gemini-3.8-flash', 'gemini-3.5-flash') < 0);
  });

  // The frontend mirrors the module's UNUSABLE filter and id shape, because the
  // express server does not serve backend/src and Pages needs a local fallback.
  // That duplication is exactly what caused the original key bug, so it is
  // pinned here rather than left to a comment.
  it('FRONTEND/BACKEND model filters cannot drift apart', () => {
    // Verbatim literal comparison. Re-parsing regex literals out of the source
    // and re-constructing them is how a drift test itself goes wrong, so this
    // compares the text of the two literals instead.
    const src = readFileSync(new URL('../frontend/app.js', import.meta.url), 'utf8');
    const grab = (name) => {
      const m = src.match(new RegExp(`const ${name} = (/.*?/[a-z]*);`));
      assert.ok(m, `frontend declares ${name}`);
      return m[1];
    };
    assert.equal(grab('UNUSABLE'), String(UNUSABLE_PATTERN),
      'frontend UNUSABLE literal must match backend/src/models.js UNUSABLE_PATTERN exactly');
    assert.equal(grab('SHAPE'), String(MODEL_ID_SHAPE),
      'frontend SHAPE literal must match backend/src/models.js MODEL_ID_SHAPE exactly');

    // And the shared filter behaves: usable in, unusable out.
    const usable = ['gemini-3.8-flash', 'gemini-flash-latest', 'gemini-3.1-flash-lite', 'gemini-3-flash-preview'];
    const unusableIds = [
      'gemini-embedding-001', 'text-embedding-004', 'gemini-2.5-flash-image',
      'gemini-2.5-flash-preview-tts', 'gemini-3.8-live-extended-thinking',
      'gemini-omni-flash', 'gemma-3-27b-it',
    ];
    for (const id of usable) {
      assert.equal(UNUSABLE_PATTERN.test(id), false, `${id} is not filtered out`);
      assert.ok(parseModelEntry({ name: `models/${id}`, supportedGenerationMethods: ['generateContent'] }), `backend accepts ${id}`);
    }
    for (const id of unusableIds) {
      assert.ok(UNUSABLE_PATTERN.test(id) || !MODEL_ID_SHAPE.test(id), `${id} is filtered out`);
      assert.equal(parseModelEntry({ name: `models/${id}`, supportedGenerationMethods: ['generateContent'] }), null, `backend rejects ${id}`);
    }
  });

  it('the cache wrapper fetches the key ARRAY, not its own cache key', async () => {
    // Regression: the wrapper used to pass the joined cache string straight to
    // discoverModels, so it sent one bogus key ("AQ.a|AQ.b") and discovery always
    // came back empty — /api/models reported live:false with nothing logged.
    // Unit tests missed it because only a real request exposed it.
    clearModelCache();
    const seen = [];
    const fetchFn = async (_url, o) => {
      seen.push(o.headers['x-goog-api-key']);
      return { ok: true, status: 200, json: async () => ({ models: [{ name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] }] }) };
    };
    const first = await discoverModelsCached([AQ, AQ2], 60_000, fetchFn);
    assert.deepEqual(seen, [AQ, AQ2], 'both real keys were sent, not a joined string');
    assert.equal(first.length, 1);
    const second = await discoverModelsCached([AQ, AQ2], 60_000, fetchFn);
    assert.equal(seen.length, 2, 'second call served from cache');
    assert.deepEqual(second, first, 'cache returns the same models');
    assert.deepEqual(await discoverModelsCached([], 0, fetchFn), [], 'no keys short-circuits');
    clearModelCache();
  });
});

describe('mergeModels (curated first, discovery appended)', () => {
  it('keeps curated order and appends new models', () => {
    const merged = mergeModels(
      [{ id: 'a', label: 'A', curated: true }, { id: 'b', label: 'B', curated: true }],
      [{ id: 'b', label: 'B dup' }, { id: 'c', label: 'C' }],
    );
    assert.deepEqual(merged.map((m) => m.id), ['a', 'b', 'c']);
    assert.equal(merged[1].label, 'B', 'curated entry wins over the discovered duplicate');
  });
  it('never returns an empty picker', () => {
    assert.ok(mergeModels(AVAILABLE_MODELS, []).length > 0);
    assert.ok(mergeModels([], []).length === 0);
  });
});