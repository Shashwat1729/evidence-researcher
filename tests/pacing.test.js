import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  paceFloorMs, currentPaceGap, notePaceBackoff, notePaceSuccess, resetKeyState,
  noteSharedBackoff, paceForModel, PACE_MAX_WAIT_MS, roundWaitMs,
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

  it('a 429 pauses ALL keys for that model (shared project bucket)', async (t) => {
    // Node 24 mock timers: sync tick() fires mocked sleeps; the returned
    // `waited` is the computed stall another key would have sat through.
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      noteSharedBackoff('m', 5000);
      const p = paceForModel('m', 'OTHER_KEY');
      t.mock.timers.tick(6000);
      const waited = await p;
      assert.ok(waited >= 4500 && waited <= 5500, `shared pause honored, waited ${waited}ms`);
    } finally {
      t.mock.timers.reset();
    }
  });

  it('single pace waits are capped (no unbounded silent reservation growth)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      // Drive the multiplier to max, then stack reservations rapidly (the old
      // divergence: each round reserved further ahead than real time).
      notePaceBackoff('m', 'K');
      notePaceBackoff('m', 'K');
      notePaceBackoff('m', 'K');
      for (let i = 0; i < 5; i++) {
        const p = paceForModel('m', 'K');
        t.mock.timers.tick(PACE_MAX_WAIT_MS + 1000);
        await p;
      }
      const p = paceForModel('m', 'K');
      t.mock.timers.tick(PACE_MAX_WAIT_MS + 1000);
      const waited = await p;
      assert.ok(waited <= PACE_MAX_WAIT_MS, `capped at ${PACE_MAX_WAIT_MS}, got ${waited}`);
    } finally {
      t.mock.timers.reset();
    }
  });

  it('pace waits are reported via rate-wait events (no silent stalls)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      noteSharedBackoff('m', 2000);
      const seen = [];
      const p = paceForModel('m', 'K', (info) => seen.push(info));
      t.mock.timers.tick(3000);
      await p;
      assert.equal(seen.length, 1, 'exactly one rate-wait event');
      assert.equal(seen[0].type, 'rate-wait');
      assert.ok(seen[0].waitMs >= 1500, `waitMs surfaced, got ${seen[0].waitMs}`);
    } finally {
      t.mock.timers.reset();
    }
  });

  it('round waits honor Retry-After first, then escalate (anti-hammer)', () => {
    // Measured live: constant short rounds EXTEND a server throttle (key
    // healthy the moment hammering stops), so sustained failure must collapse
    // request rate instead of holding it.
    assert.equal(roundWaitMs(5000, 9000, 1), 5000, 'round 1 honors server');
    assert.equal(roundWaitMs(5000, 9000, 2), 5000, 'round 2 honors server');
    assert.equal(roundWaitMs(5000, 9000, 3), 30000, 'round 3+ escalates past hint');
    assert.equal(roundWaitMs(0, 9000, 1), 9000, 'no hint → jitter first');
    assert.equal(roundWaitMs(0, 9000, 4), 60000);
    assert.equal(roundWaitMs(0, 9000, 99), 120000, 'capped at 120s');
    assert.equal(roundWaitMs(200000, 9000, 1), 60000, 'hint capped at 60s');
  });

  it('resetKeyState clears the shared pause too', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    try {
      noteSharedBackoff('m', 60000);
      resetKeyState();
      const t0 = Date.now();
      await paceForModel('m', 'K');
      assert.ok(Date.now() - t0 < 1000, 'no pause after reset');
    } finally {
      t.mock.timers.reset();
    }
  });
});
