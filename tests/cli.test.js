import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseResearchArgs, validateCliArgs, executeResearch } from '../scripts/run.js';

describe('CLI arg parsing + validation', () => {
  it('parses flags and joins positional words into the question', () => {
    const o = parseResearchArgs(['node', 'x', 'When', 'was', 'X', 'founded?', '--mode', 'quick', '--stance', 'lean', '--hypothesis', 'h', '--documentary']);
    assert.equal(o.question, 'When was X founded?');
    assert.equal(o.mode, 'quick');
    assert.equal(o.stance, 'lean');
    assert.equal(o.hypothesis, 'h');
    assert.equal(o.documentary, true);
    assert.equal(validateCliArgs(o), null);
  });
  it('rejects short questions and unknown enums', () => {
    assert.ok(validateCliArgs({ question: 'hi', mode: 'standard', stance: 'neutral' }));
    assert.ok(validateCliArgs({ question: 'Valid question?', mode: 'turbo', stance: 'neutral' }));
    assert.ok(validateCliArgs({ question: 'Valid question?', mode: 'quick', stance: 'nope' }));
  });
});

describe('executeResearch with fakes', () => {
  const fakeResult = {
    id: 'cli1', sources: [{ id: 's1' }], claims: [{ id: 'c1' }],
    task: { mode: 'quick' }, report: {}, stats: {},
  };
  it('runs, saves, scores, and reports exit 0', async () => {
    const lines = [];
    let saved = null;
    const { exitCode, result } = await executeResearch(
      { question: 'Q?', mode: 'quick', stance: 'neutral', hypothesis: '', documentary: false },
      {
        runFn: async () => fakeResult,
        saveFn: async (r) => { saved = r.id; },
        keys: ['k'],
        out: (l) => lines.push(l),
      },
    );
    assert.equal(exitCode, 0);
    assert.equal(result.id, 'cli1');
    assert.equal(saved, 'cli1');
    assert.ok(lines.some((l) => l.includes('audit=')));
  });
  it('exits 1 with no keys, and on run failure', async () => {
    const lines = [];
    const nokeys = await executeResearch({ question: 'Q?', mode: 'quick', stance: 'neutral' }, { keys: [], out: (l) => lines.push(l) });
    assert.equal(nokeys.exitCode, 1);
    const failed = await executeResearch(
      { question: 'Q?', mode: 'quick', stance: 'neutral' },
      { runFn: async () => { throw Object.assign(new Error('boom'), { status: 429 }); }, saveFn: async () => {}, keys: ['k'], out: (l) => lines.push(l) },
    );
    assert.equal(failed.exitCode, 1);
    assert.ok(lines.some((l) => l.includes('429')));
  });
});
