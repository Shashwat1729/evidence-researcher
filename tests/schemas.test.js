import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createTask, validateTask, isValidClaimState } from '../backend/src/schemas.js';
import { MODES } from '../backend/src/config.js';
import { templatePlan } from '../backend/src/engine/planner.js';
import { templateQueries, contradictionQueriesFor } from '../backend/src/engine/queries.js';

describe('schemas, budgets, planning fallbacks', () => {
  it('rejects empty questions and bad modes', () => {
    assert.ok(validateTask(createTask({ question: '' })).length > 0);
    assert.ok(validateTask(createTask({ question: 'When was Rome founded?', mode: 'warp' })).length > 0);
    assert.deepEqual(validateTask(createTask({ question: 'When was Rome founded?' })), []);
  });
  it('every mode has finite budgets (loop cannot run forever)', () => {
    for (const [name, m] of Object.entries(MODES)) {
      for (const k of ['maxIterations', 'maxSearches', 'maxSources', 'maxModelCalls', 'maxRuntimeMs', 'maxTokensOut', 'reportTokens', 'sections']) {
        assert.ok(Number.isFinite(m[k]) && m[k] > 0, `${name}.${k} must be a positive finite budget`);
      }
    }
    assert.ok(MODES.quick.maxSearches < MODES.standard.maxSearches);
    assert.ok(MODES.standard.maxSearches < MODES.deep.maxSearches);
    assert.ok(MODES.deep.maxSearches < MODES.exhaustive.maxSearches);
  });
  it('template plan is domain-adaptable and non-empty', () => {
    const p = templatePlan('anything');
    assert.ok(p.steps.length >= 6 && p.linesOfInquiry.length >= 3);
  });
  it('template queries cover diverse categories incl. counter-evidence', () => {
    const qs = templateQueries('fall of rome', { contradiction: true });
    const cats = new Set(qs.map((q) => q.category));
    assert.ok(cats.has('counter-evidence') && cats.has('scholarly'));
  });
  it('contradiction queries ask what would falsify the claim', () => {
    const qs = contradictionQueriesFor('Drought caused the collapse');
    assert.ok(qs.some((q) => /against|reject|alternative/i.test(q.q)));
  });
  it('claim states are a closed vocabulary', () => {
    assert.ok(isValidClaimState('disputed') && !isValidClaimState('definitely-true'));
  });
});
