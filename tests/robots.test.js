import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseRobots, isPathAllowed, allowedByRobots } from '../backend/src/providers/fetcher.js';

describe('robots.txt handling', () => {
  it('parses wildcard groups and ignores comments', () => {
    const d = parseRobots(`
      # comment
      User-agent: *
      Disallow: /private/
      Disallow: /tmp
    `);
    assert.deepEqual(d, ['/private/', '/tmp']);
    assert.ok(!isPathAllowed(d, '/private/x'));
    assert.ok(isPathAllowed(d, '/public/x'));
  });
  it('ignores groups for other bots, honors groups naming us', () => {
    const d = parseRobots(`
      User-agent: otherbot
      Disallow: /
      User-agent: evidence-researcher
      Disallow: /nope
    `);
    assert.deepEqual(d, ['/nope']);
  });
  it('empty robots allows everything', () => {
    assert.deepEqual(parseRobots(''), []);
    assert.ok(isPathAllowed([], '/anything'));
  });
  it('fail-open on malformed URLs (no network)', async () => {
    assert.equal(await allowedByRobots('not a url'), true);
  });
});
