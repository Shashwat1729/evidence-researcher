import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { heuristicGroups } from '../backend/src/engine/provenance.js';
import { createSource } from '../backend/src/schemas.js';

const mk = (id, text) => ({ ...createSource({ url: `https://x.com/${id}`, title: id }), id, passages: [{ text }] });

describe('provenance heuristics', () => {
  it('groups sources sharing a long verbatim span', () => {
    const shared = 'historians now believe the antonine plague swept through legions stationed along the danube frontier during marcus aurelius reign '.repeat(4);
    const a = mk('a', shared + ' unique alpha words here');
    const b = mk('b', 'different intro entirely ' + shared);
    const c = mk('c', 'a completely unrelated article about grain prices in ostia harbor records daily trade winds');
    const groups = heuristicGroups([a, b, c]);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].map((s) => s.id).sort(), ['a', 'b']);
  });
  it('does not group independent texts', () => {
    const a = mk('a', 'the senate debated grain subsidies while the treveri revolted in gaul province');
    const b = mk('b', 'archaeological surveys of villa abandonment suggest gradual rural transformation processes');
    assert.equal(heuristicGroups([a, b]).length, 0);
  });
});
