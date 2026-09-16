import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  paceFloorMs, currentPaceGap, notePaceBackoff, notePaceSuccess, resetKeyState,
} from '../backend/src/gemini.js';

describe('adaptive pacing (dynamic rate limits)', () => {
  beforeEach(() => resetKeyState());

  it('floors are class-based, never per-version (future models pace sanely)', () => {
    assert.equal(paceFloorMs('gemini-2.5-flash-lite'), 3000);
    assert.equal(paceFloorMs('gemini-2.5-flash'), 7000);
    assert.equal(paceFloorMs('gemini-2.5-pro'), 12000);
    // A hypothetical future model still gets a sane conservative floor.
    assert.equal(paceFloorMs('gemini-9-flash'), 7000);
    assert.equal(paceFloorMs('gemini-9-flash-lite'), 3000);
    assert.equal(paceFloorMs('something-entirely-new'), 7000);
  });

  it('starts at the floor (multiplier 1, no waiting on first use)', () => {
    assert.equal(currentPaceGap('gemini-2.5-flash', 'K1'), 7000);
    assert.equal(currentPaceGap('gemini-2.5-flash-lite', 'K1'), 3000);
  });

  it('backs off exponentially per 429 and caps at 8x', () => {
    notePaceBackoff('gemini-2.5-flash', 'K1');
    assert.equal(currentPaceGap('gemini-2.5-flash', 'K1'), 14000);
    notePaceBackoff('gemini-2.5-flash', 'K1');
    assert.equal(currentPaceGap('gemini-2.5-flash', 'K1'), 28000);
    for (let i = 0; i < 10; i++) notePaceBackoff('gemini-2.5-flash', 'K1');
    assert.equal(currentPaceGap('gemini-2.5-flash', 'K1'), 56000, 'capped at 8x floor');
  });

  it('tracks per key+model independently (one hot key does not punish others)', () => {
    notePaceBackoff('gemini-2.5-flash', 'K_HOT');
    assert.equal(currentPaceGap('gemini-2.5-flash', 'K_HOT'), 14000);
    assert.equal(currentPaceGap('gemini-2.5-flash', 'K_COLD'), 7000);
    assert.equal(currentPaceGap('gemini-2.5-flash-lite', 'K_HOT'), 3000);
  });

  it('successes ease the gap back toward the floor (no permanent penalty)', () => {
    notePaceBackoff('gemini-2.5-flash', 'K1');
    notePaceBackoff('gemini-2.5-flash', 'K1');
    assert.equal(currentPaceGap('gemini-2.5-flash', 'K1'), 28000);
    notePaceSuccess('gemini-2.5-flash', 'K1');
    assert.equal(currentPaceGap('gemini-2.5-flash', 'K1'), 14000);
    notePaceSuccess('gemini-2.5-flash', 'K1');
    assert.equal(currentPaceGap('gemini-2.5-flash', 'K1'), 7000, 'back at floor, entry cleared');
    notePaceSuccess('gemini-2.5-flash', 'K1');
    assert.equal(currentPaceGap('gemini-2.5-flash', 'K1'), 7000, 'never below floor');
  });

  it('resetKeyState clears pacing (no cross-run leakage)', () => {
    notePaceBackoff('gemini-2.5-flash', 'K1');
    assert.equal(currentPaceGap('gemini-2.5-flash', 'K1'), 14000);
    resetKeyState();
    assert.equal(currentPaceGap('gemini-2.5-flash', 'K1'), 7000);
  });
});
