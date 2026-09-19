'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decideAction, epochIntervalError, MAX_TIMER_MS, MIN_EPOCH_MS } = require('./epoch-policy');

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
