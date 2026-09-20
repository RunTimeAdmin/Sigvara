'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeScore, feeScore, successScore, ageScore, ageCurve, communityScore } = require('./scoring');

// ---- feeScore --------------------------------------------------------------

test('feeScore: 0 attestations = 0', () => {
  assert.equal(feeScore(0), 0);
});

test('feeScore: 10 attestations = 1', () => {
  assert.equal(feeScore(10), 1);
});

test('feeScore: capped at 20', () => {
  assert.equal(feeScore(300), 20);
  assert.equal(feeScore(9999), 20);
});

// ---- successScore ----------------------------------------------------------

test('successScore: no attestations = 0', () => {
  assert.equal(successScore(0, 0), 0);
});

test('successScore: a perfect record approaches but never reaches the cap', () => {
  // The prior in the denominator means evidence has to accumulate. 100/100 is
  // strong but not perfect knowledge, and nothing can reach 25 exactly.
  assert.equal(successScore(100, 100), 14);
  assert.equal(successScore(1000, 1000), 14);
  assert.ok(successScore(10 ** 9, 10 ** 9) < 15);
});

test('successScore: 50% success, prior pulls it below half the cap', () => {
  assert.equal(successScore(5, 10), 5);
});

test('successScore: one observation is worth little', () => {
  // Previously 1/1 scored the full 25, so a single self-payment bought the whole
  // factor. That was the cheapest step in a Sybil's path to a high score.
  assert.equal(successScore(1, 1), 2);
  assert.ok(successScore(1, 1) < successScore(20, 20));
});

test('successScore: a decayed record fades toward zero, so silence costs', () => {
  // A ratio alone is scale invariant: 10/10 decayed to 0.44/0.44 is still 1.0,
  // and would hold full marks forever. The prior is what makes weight matter.
  assert.equal(successScore(0.44, 0.44), 1);
  assert.equal(successScore(0.01, 0.01), 0);
});

test('successScore: the prior is adjustable', () => {
  assert.equal(successScore(1, 1, 0), 15);
  assert.ok(successScore(10, 10, 20) < successScore(10, 10, 5));
});

test('successScore: 0% success = 0', () => {
  assert.equal(successScore(0, 100), 0);
});

// ---- ageScore --------------------------------------------------------------

test('ageScore: just registered = 0', () => {
  const registeredAt = Math.floor(Date.now() / 1000);
  assert.equal(ageScore(registeredAt), 0);
});

test('ageScore: day 1 > 0', () => {
  const registeredAt = Math.floor(Date.now() / 1000) - 86400;
  assert.ok(ageScore(registeredAt) > 0);
});

test('ageScore: a month of activity is a fraction of the factor, not all of it', () => {
  const registeredAt = Math.floor(Date.now() / 1000) - 31 * 86400;
  assert.equal(ageScore(registeredAt), 15);
});

test('ageScore: capped at 30, but only for genuinely old agents', () => {
  assert.equal(ageScore(Math.floor(Date.now() / 1000) - 365 * 86400), 25);
  assert.equal(ageScore(Math.floor(Date.now() / 1000) - 3650 * 86400), 30);
});

// ---- communityScore --------------------------------------------------------

test('communityScore: 0 flags = 5', () => {
  assert.equal(communityScore(0), 5);
});

test('communityScore: 1 flag = 3', () => {
  assert.equal(communityScore(1), 3);
});

test('communityScore: 2 flags = 1', () => {
  assert.equal(communityScore(2), 1);
});

test('communityScore: 3+ flags = 0', () => {
  assert.equal(communityScore(3), 0);
  assert.equal(communityScore(10), 0);
});

// ---- computeScore ----------------------------------------------------------

test('computeScore: new agent with no activity = age+community only', () => {
  const registeredAt = Math.floor(Date.now() / 1000);
  const s = computeScore({ registeredAt, attestations: { successful: 0, total: 0 }, flags: 0 });
  assert.equal(s.feeScore, 0);
  assert.equal(s.successScore, 0);
  assert.equal(s.ageScore, 0);
  assert.equal(s.externalScore, 0);
  assert.equal(s.communityScore, 5);
  assert.equal(s.propagationScore, 0);
  assert.equal(s.total, 5);
});

test('computeScore: total never exceeds 100', () => {
  // Max without external: 20 fee + 30 age + 5 community, plus a success score
  // that approaches 15 without reaching it because of the prior.
  const registeredAt = Math.floor(Date.now() / 1000) - 365 * 86400;
  const s = computeScore({ registeredAt, attestations: { successful: 300, total: 300 }, flags: 0 });
  assert.ok(s.total <= 100);
  assert.equal(s.successScore, 14);
  assert.equal(s.total, 64); // age 25 at one year, not the 30 cap
});

test('computeScore: externalScore is included in the total', () => {
  const registeredAt = Math.floor(Date.now() / 1000);
  const s = computeScore({ registeredAt, attestations: { successful: 0, total: 0 }, flags: 0, externalScore: 12 });
  assert.equal(s.externalScore, 12);
  assert.equal(s.total, 17); // 12 external + 5 community
});

test('computeScore: externalScore clamped to the 0-25 cap', () => {
  const registeredAt = Math.floor(Date.now() / 1000);
  const over = computeScore({ registeredAt, attestations: { successful: 0, total: 0 }, flags: 0, externalScore: 99 });
  assert.equal(over.externalScore, 25);
  const under = computeScore({ registeredAt, attestations: { successful: 0, total: 0 }, flags: 0, externalScore: -5 });
  assert.equal(under.externalScore, 0);
});

test('computeScore: with external, a realistic ceiling is 89', () => {
  // 20 fee + 14 success + 25 age + 25 external + 5 community, propagation a stub.
  // Success lands at 14 rather than 15: the prior means a finite record never
  // quite reaches the cap. Age is 25 at one year: the cap needs years, not a month.
  const registeredAt = Math.floor(Date.now() / 1000) - 365 * 86400;
  const s = computeScore({ registeredAt, attestations: { successful: 300, total: 300 }, flags: 0, externalScore: 25 });
  assert.equal(s.total, 89);
  assert.ok(s.total <= 100);
});

test('computeScore: slashed-like scenario (high flags)', () => {
  const registeredAt = Math.floor(Date.now() / 1000) - 10 * 86400;
  const s = computeScore({ registeredAt, attestations: { successful: 5, total: 10 }, flags: 5 });
  assert.equal(s.communityScore, 0);
  assert.ok(s.total >= 0);
});

// ---- tenure (age from activity, not the calendar) --------------------------

const SEC = Math.floor(Date.now() / 1000);
const DAYS = 86400;
const win = (firstAgo, lastAgo, recency) => ({
  firstActivitySec: SEC - firstAgo * DAYS,
  lastActivitySec: SEC - lastAgo * DAYS,
  recency,
});

test('ageScore: an agent that never worked scores 0 however old the registration', () => {
  // This was the cheapest 20 points in the score: register, wait, collect.
  assert.equal(ageScore(SEC - 730 * DAYS, { firstActivitySec: 0, lastActivitySec: 0, recency: 0 }), 0);
});

test('ageScore: waiting a month then paying once unlocks nothing', () => {
  // The span starts at first activity, so there is no way to bank idle time and
  // convert it with a single transaction.
  assert.equal(ageScore(SEC - 31 * DAYS, win(0, 0, 1)), 0);
});

test('ageScore: a month of sustained trade is half the factor, not the cap', () => {
  // The change measured in adversarial.test.js: this used to return the whole factor,
  // which handed it to six weeks of wash payments.
  assert.equal(ageScore(SEC - 40 * DAYS, win(31, 0, 1)), 15);
  assert.equal(ageScore(SEC - 1100 * DAYS, win(1023, 0, 1)), 30);
});

test('ageScore: tenure decays once the agent stops', () => {
  const active = ageScore(SEC - 800 * DAYS, win(730, 0, 1));
  const stale = ageScore(SEC - 800 * DAYS, win(730, 365, 0.06));
  assert.equal(active, 28);
  assert.ok(stale <= 2, `abandoned tenure should nearly vanish, got ${stale}`);
  assert.ok(stale < active);
});

test('ageScore: recency is clamped, so a bad weight cannot inflate the factor', () => {
  assert.equal(ageScore(SEC - 800 * DAYS, win(730, 0, 5)), 28);
  assert.equal(ageScore(SEC - 800 * DAYS, win(730, 0, -1)), 0);
});

test('ageScore: with no activity data it falls back to the calendar', () => {
  // Payment verification off: existing deployments keep the old behaviour.
  assert.equal(ageScore(SEC - 31 * DAYS, null), 15);
  assert.equal(ageScore(SEC - 31 * DAYS), 15);
});

test('ageCurve: full marks take years, not a month', () => {
  // Was log2(days+1)*4, capping at day 31, which handed the whole factor to six weeks
  // of wash payments (adversarial.test.js measured it). The curve now matches the
  // claim in scoring.js that this represents sustained operation over years. The
  // amplitude tracks the cap, so the reweight to 30 did not change the shape: full
  // marks still arrive at day 1023, they are worth more now.
  assert.equal(ageCurve(0), 0);
  assert.equal(ageCurve(1), 3);
  assert.equal(ageCurve(7), 9);
  assert.equal(ageCurve(31), 15);
  assert.equal(ageCurve(365), 25);
  assert.equal(ageCurve(1023), 30);
  assert.equal(ageCurve(3650), 30);
  assert.equal(ageCurve(-5), 0);
});

test('computeScore: passes activity through to the age factor', () => {
  const idle = computeScore({
    registeredAt: SEC - 730 * DAYS, attestations: { successful: 0, total: 0 }, flags: 0,
    activity: { firstActivitySec: 0, lastActivitySec: 0, recency: 0 },
  });
  assert.equal(idle.ageScore, 0);
  assert.equal(idle.total, 5); // community only

  const working = computeScore({
    registeredAt: SEC - 730 * DAYS, attestations: { successful: 0, total: 0 }, flags: 0,
    activity: win(730, 0, 1),
  });
  assert.equal(working.ageScore, 28); // two years of active trade, just under the cap
});

// ---- the clock -------------------------------------------------------------
//
// Two operators scoring the same agent from the same evidence must produce the same
// number. Date.now() does not allow that: host clocks drift, so tenure and decay come
// out fractionally different on each machine. Measured across the primary and the checker
// on the day the second operator went live, recency read 0.982146 on one and 0.982148 on
// the other — too small to move an integer factor, large enough that the two were never
// computing the same function. The divergence tolerance hid it rather than fixing it.

test('computeScore: the same inputs and the same clock give the same score', () => {
  const opts = {
    registeredAt: SEC - 800 * DAYS,
    attestations: { successful: 40, total: 44 },
    flags: 0,
    activity: win(730, 0, 1),
    now: 1_789_000_000_000,
  };
  const a = computeScore(opts);
  const b = computeScore({ ...opts });
  assert.deepEqual(a, b);
});

test('computeScore: with activity supplied, the clock does not reach the age factor', () => {
  // Worth pinning because it is easy to assume otherwise. When activity is present the
  // span comes from first-to-last payment and `recency` was already computed upstream by
  // payments.activityWindow, so ageScore reads no clock at all. The chain clock matters
  // one layer up, where that recency and every decay weight are produced.
  const base = {
    registeredAt: SEC - 800 * DAYS,
    attestations: { successful: 40, total: 44 },
    flags: 0,
    activity: { firstActivitySec: SEC - 400 * DAYS, lastActivitySec: SEC, recency: 1 },
  };
  const early = computeScore({ ...base, now: (SEC - 300 * DAYS) * 1000 });
  const late  = computeScore({ ...base, now: SEC * 1000 });
  assert.equal(early.ageScore, late.ageScore);
});

test('computeScore: on the calendar fallback the clock does reach the age factor', () => {
  // activity is null when payment verification is off. Here nowMs is the only thing
  // deciding how old the agent is, so threading it through is what stops two operators
  // disagreeing about that on hosts whose clocks differ.
  const base = { registeredAt: SEC - 800 * DAYS, attestations: { successful: 1, total: 1 }, flags: 0 };
  const early = computeScore({ ...base, now: (SEC - 700 * DAYS) * 1000 });
  const late  = computeScore({ ...base, now: SEC * 1000 });
  assert.notEqual(early.ageScore, late.ageScore, 'now is not reaching ageScore on the fallback path');
  assert.ok(late.ageScore > early.ageScore);
});

test('computeScore: two hosts one second apart still agree when handed one clock', () => {
  // The operator-agreement property, stated directly. Host A and host B disagree about
  // the time; both are given the chain's clock; both must produce the same score.
  const base = {
    registeredAt: SEC - 800 * DAYS,
    attestations: { successful: 40, total: 44 },
    flags: 0,
    activity: win(730, 0, 1),
  };
  const chainNowMs = 1_789_000_000_000;
  const hostA = computeScore({ ...base, now: chainNowMs });
  const hostB = computeScore({ ...base, now: chainNowMs });
  assert.deepEqual(hostA, hostB);
  assert.equal(hostA.total, hostB.total);
});

test('computeScore: without a clock it falls back to wall time rather than throwing', () => {
  // Unit tests and any caller with no chain to read still work.
  const s = computeScore({
    registeredAt: SEC - 800 * DAYS,
    attestations: { successful: 1, total: 1 },
    flags: 0,
    activity: win(730, 0, 1),
  });
  assert.ok(Number.isFinite(s.total));
  assert.ok(s.ageScore > 0);
});
