'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  decideAction, decideCheckerAction, scoreDivergence,
  epochIntervalError, divergenceToleranceError, MAX_TIMER_MS, MIN_EPOCH_MS,
} = require('./epoch-policy');

const CHALLENGE_WINDOW = 3600; // 1 hour

test('decideAction: nothing pending -> propose', () => {
  const pending = { exists: false, proposedAt: 0 };
  assert.equal(decideAction(pending, CHALLENGE_WINDOW, 1_000_000), 'propose');
});

test('decideAction: pending, window just opened -> skip', () => {
  const now = 1_000_000;
  const pending = { exists: true, proposedAt: now };
  assert.equal(decideAction(pending, CHALLENGE_WINDOW, now), 'skip');
});

test('decideAction: pending, window almost elapsed -> skip', () => {
  const proposedAt = 1_000_000;
  const now = proposedAt + CHALLENGE_WINDOW - 1;
  const pending = { exists: true, proposedAt };
  assert.equal(decideAction(pending, CHALLENGE_WINDOW, now), 'skip');
});

test('decideAction: pending, window exactly elapsed -> finalize-then-propose', () => {
  const proposedAt = 1_000_000;
  const now = proposedAt + CHALLENGE_WINDOW;
  const pending = { exists: true, proposedAt };
  assert.equal(decideAction(pending, CHALLENGE_WINDOW, now), 'finalize-then-propose');
});

test('decideAction: pending, window well past -> finalize-then-propose', () => {
  const proposedAt = 1_000_000;
  const now = proposedAt + CHALLENGE_WINDOW * 10;
  const pending = { exists: true, proposedAt };
  assert.equal(decideAction(pending, CHALLENGE_WINDOW, now), 'finalize-then-propose');
});

test('decideAction: repeated propose while pending never advances past skip until window elapses', () => {
  // Regression test for the exact bug this module exists to prevent: if the
  // epoch interval is shorter than the challenge window, naively re-proposing
  // every tick would perpetually reset proposedAt and the score would never
  // finalize. Simulate several epoch ticks against a FIXED proposedAt (as if
  // the oracle correctly skipped instead of re-proposing) and confirm the
  // decision eventually flips to finalize once real time catches up.
  const proposedAt = 1_000_000;
  const epochIntervalSeconds = 60; // epoch far shorter than the challenge window

  let now = proposedAt;
  let sawSkip = false;
  for (let tick = 0; tick < 100; tick++) {
    const pending = { exists: true, proposedAt }; // proposedAt never changes — oracle didn't re-propose
    const action = decideAction(pending, CHALLENGE_WINDOW, now);
    if (action === 'finalize-then-propose') {
      assert.ok(sawSkip, 'expected at least one skip before the window elapsed');
      assert.ok(now >= proposedAt + CHALLENGE_WINDOW);
      return;
    }
    assert.equal(action, 'skip');
    sawSkip = true;
    now += epochIntervalSeconds;
  }
  assert.fail('window never elapsed within 100 epoch ticks');
});

test('decideAction: null pending is treated as nothing pending', () => {
  assert.equal(decideAction(null, CHALLENGE_WINDOW, 1_000_000), 'propose');
});

// --- epochIntervalError ----------------------------------------------------
// Node coerces any timer delay outside the signed 32-bit range, and any value that is
// not a positive number, to 1ms instead of rejecting it. The epoch loop then runs
// continuously against the RPC with nothing logged to explain it. These cases are the
// ways EPOCH_HOURS can land there.

const H = 3_600_000;

test('epochIntervalError: ordinary intervals are accepted', () => {
  assert.equal(epochIntervalError(1 * H), null, '1 hour, what production runs');
  assert.equal(epochIntervalError(24 * H), null, '24 hours, the default');
  assert.equal(epochIntervalError(MIN_EPOCH_MS), null, 'exactly the minimum');
  assert.equal(epochIntervalError(MAX_TIMER_MS), null, 'exactly the maximum');
});

test('epochIntervalError: past Node\'s timer limit is refused', () => {
  const err = epochIntervalError(MAX_TIMER_MS + 1);
  assert.ok(err, 'one millisecond over the limit must be caught');
  assert.match(err, /timer limit/);
  // The operator set EPOCH_HOURS, so the message has to name it in those units.
  assert.match(err, /EPOCH_HOURS/);
  assert.match(err, /596/, 'says what the maximum actually is');
});

test('epochIntervalError: a 30-day epoch is refused, not silently run every 1ms', () => {
  const err = epochIntervalError(720 * H);
  assert.ok(err, '720 hours looks reasonable and is the trap');
  assert.match(err, /continuously/);
});

test('epochIntervalError: NaN is refused', () => {
  // The likeliest route here: EPOCH_HOURS="1h" or "" goes through Number() as NaN,
  // and NaN as a timer delay is 1ms. Comparisons against NaN are all false, so a
  // range check written without this branch would let it straight through.
  assert.ok(epochIntervalError(Number('1h') * H), 'EPOCH_HOURS="1h"');
  assert.ok(epochIntervalError(NaN));
  assert.match(epochIntervalError(NaN), /did not parse/);
});

test('epochIntervalError: Infinity is refused', () => {
  assert.ok(epochIntervalError(Infinity));
  assert.match(epochIntervalError(Infinity), /did not parse/);
});

test('epochIntervalError: zero and negatives are refused', () => {
  // setInterval(fn, 0) and setInterval(fn, -1) both fire about every millisecond.
  assert.ok(epochIntervalError(0), 'EPOCH_HOURS=0');
  assert.ok(epochIntervalError(-1 * H), 'a negative value');
  assert.match(epochIntervalError(0), /Below/);
});

test('epochIntervalError: a too-short interval is refused', () => {
  const err = epochIntervalError(30_000);
  assert.ok(err, '30 seconds is below the floor');
  assert.match(err, /Below/);
});

// --- checker mode -----------------------------------------------------------------
//
// The rule these pin: a checker may cover for a silent primary, and may finalize a score
// it agrees with, but must never finalize or overwrite one it disputes. Overwriting
// restarts the challenge window, which would buy a bad proposal another six hours beyond
// the slashing committee's reach — the checker would be protecting what it exists to catch.

const WINDOW = 21600; // the live challenge window on Arc: 6 hours
const agreed = { feeScore: 0, successScore: 7, ageScore: 0, externalScore: 0, communityScore: 5, propagationScore: 0 };
const pendingAt = (t, data = agreed) => ({ exists: true, proposedAt: t, data });

test('decideCheckerAction: nothing pending -> propose, covering a silent primary', () => {
  assert.equal(decideCheckerAction({ exists: false }, agreed, WINDOW, 1_000_000), 'propose');
});

test('decideCheckerAction: agrees, window open -> skip', () => {
  const now = 1_000_000;
  assert.equal(decideCheckerAction(pendingAt(now), agreed, WINDOW, now), 'skip');
});

test('decideCheckerAction: agrees, window elapsed -> finalize', () => {
  const t = 1_000_000;
  assert.equal(decideCheckerAction(pendingAt(t), agreed, WINDOW, t + WINDOW), 'finalize');
});

test('decideCheckerAction: disputes the score -> diverged, never finalize', () => {
  // The important one. The window being over is exactly when finalizing is possible,
  // and exactly when doing so would cement a number this oracle thinks is wrong.
  const t = 1_000_000;
  const mine = { ...agreed, successScore: 25 };
  assert.equal(decideCheckerAction(pendingAt(t), mine, WINDOW, t + WINDOW), 'diverged');
  assert.equal(decideCheckerAction(pendingAt(t), mine, WINDOW, t + WINDOW * 100), 'diverged');
});

test('decideCheckerAction: disputes the score -> never proposes over it', () => {
  // Overwriting restarts the window. A checker that disagrees must leave the proposal
  // where the committee can still reject it.
  const t = 1_000_000;
  const mine = { ...agreed, feeScore: 20 };
  for (const now of [t, t + 1, t + WINDOW - 1, t + WINDOW, t + WINDOW * 10]) {
    assert.equal(decideCheckerAction(pendingAt(t), mine, WINDOW, now), 'diverged');
  }
});

test('decideCheckerAction: small skew between honest oracles is not a divergence', () => {
  // Two operators scan at different moments; a payment landing between them moves the
  // total by a point. Alerting on that would train the committee to ignore alerts.
  const t = 1_000_000;
  const mine = { ...agreed, successScore: 9 }; // +2, inside the default tolerance of 3
  assert.equal(decideCheckerAction(pendingAt(t), mine, WINDOW, t), 'skip');
});

test('decideCheckerAction: tolerance is a boundary, not a range', () => {
  const t = 1_000_000;
  assert.equal(decideCheckerAction(pendingAt(t), { ...agreed, successScore: 10 }, WINDOW, t), 'skip');      // exactly 3
  assert.equal(decideCheckerAction(pendingAt(t), { ...agreed, successScore: 11 }, WINDOW, t), 'diverged');  // 4
});

test('decideCheckerAction: offsetting factor errors do not cancel into agreement', () => {
  // successScore +8 and communityScore -8 sum to the same total. The score a consumer
  // reads is identical, but the two oracles do not agree about the agent, and a checker
  // that waved this through could be silenced by any error with a compensating partner.
  const t = 1_000_000;
  const offsetting = { ...agreed, successScore: 12, communityScore: 0 }; // +5 / -5
  assert.equal(scoreDivergence(agreed, offsetting).total, 0);
  assert.equal(decideCheckerAction(pendingAt(t), offsetting, WINDOW, t), 'diverged');
});

test('scoreDivergence: reports only what actually differs', () => {
  const mine = { ...agreed, feeScore: 4 };
  const d = scoreDivergence(agreed, mine);
  assert.deepEqual(Object.keys(d.factors), ['feeScore']);
  assert.equal(d.factors.feeScore.delta, 4);
  assert.equal(d.total, 4);
  assert.equal(d.maxFactor, 4);
});

test('scoreDivergence: identical scores diverge by nothing', () => {
  const d = scoreDivergence(agreed, { ...agreed });
  assert.deepEqual(d.factors, {});
  assert.equal(d.total, 0);
  assert.equal(d.maxFactor, 0);
});

test('scoreDivergence: an incomparable factor is reported, not silently zeroed', () => {
  // Was asserted the other way round until the security review: a missing factor used to
  // read as 0 via `?? 0`, which invents agreement out of a decode that returned nothing.
  const d = scoreDivergence({ successScore: 7 }, agreed);
  assert.equal(d.comparable, false);
  assert.equal(Number.isNaN(d.total), false);
});

test('decideCheckerAction: fails CLOSED on anything it cannot compare', () => {
  // The bug this pins: every comparison in the function is `>`, and `>` against NaN is
  // false, so a single unparseable number used to fall through to 'finalize'. The
  // checker was most willing to make a score live exactly when it understood it least.
  const t = 1_000_000;
  const elapsed = t + WINDOW;
  const maxed = { feeScore: 30, successScore: 25, ageScore: 20, externalScore: 15, communityScore: 5, propagationScore: 5 };

  assert.equal(decideCheckerAction(pendingAt(t, maxed), agreed, WINDOW, elapsed, Number('three')), 'diverged');
  assert.equal(decideCheckerAction(pendingAt(t, maxed), agreed, WINDOW, elapsed, undefined && 3), 'diverged');
  assert.equal(decideCheckerAction(pendingAt(t, maxed), { ...agreed, feeScore: NaN }, WINDOW, elapsed, 3), 'diverged');
  assert.equal(decideCheckerAction(pendingAt(t, { successScore: 7 }), agreed, WINDOW, elapsed, 3), 'diverged');
});

test('decideCheckerAction: a NaN tolerance never yields agreement, at any window position', () => {
  const t = 1_000_000;
  for (const now of [t, t + 1, t + WINDOW - 1, t + WINDOW, t + WINDOW * 10]) {
    assert.equal(decideCheckerAction(pendingAt(t), agreed, WINDOW, now, NaN), 'diverged');
  }
});

test('divergenceToleranceError: rejects what would silently disable the check', () => {
  assert.equal(divergenceToleranceError(3), null);
  assert.equal(divergenceToleranceError(0), null);
  assert.match(divergenceToleranceError(Number('3 points')), /did not parse/);
  assert.match(divergenceToleranceError(NaN), /did not parse/);
  assert.match(divergenceToleranceError(Infinity), /did not parse/);
  assert.match(divergenceToleranceError(-1), /negative/);
  assert.match(divergenceToleranceError(100), /past the maximum/);
});
