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
  it('does not group same-topic independents (shared vocab below 0.7)', () => {
    // Jaccard 0.6 by construction (12 shared / 20 union), no 12-word span:
    // the old 0.55 bar grouped these independents and burned model calls on
    // "unclear" verdicts; the 0.7 bar leaves them alone.
    const shared = 'harappan civilization seals weights trade urban streets bricks towns water planning drainage granary';
    const a = mk('a', `${shared} mohenjo daro citadel granaries`);
    const b = mk('b', `dholavira lothal cotton beads ${shared.split(' ').reverse().join(' ')}`);
    assert.equal(heuristicGroups([a, b]).length, 0);
  });
});
