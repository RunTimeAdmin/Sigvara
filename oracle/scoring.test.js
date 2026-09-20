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

test('feeScore: capped at 30', () => {
  assert.equal(feeScore(300), 30);
  assert.equal(feeScore(9999), 30);
});

// ---- successScore ----------------------------------------------------------

test('successScore: no attestations = 0', () => {
  assert.equal(successScore(0, 0), 0);
});

test('successScore: a perfect record approaches but never reaches the cap', () => {
  // The prior in the denominator means evidence has to accumulate. 100/100 is
  // strong but not perfect knowledge, and nothing can reach 25 exactly.
  assert.equal(successScore(100, 100), 23);
  assert.equal(successScore(1000, 1000), 24);
  assert.ok(successScore(10 ** 9, 10 ** 9) <= 25);
});

test('successScore: 50% success, prior pulls it below half the cap', () => {
  assert.equal(successScore(5, 10), 8);
});

test('successScore: one observation is worth little', () => {
  // Previously 1/1 scored the full 25, so a single self-payment bought the whole
  // factor. That was the cheapest step in a Sybil's path to a high score.
  assert.equal(successScore(1, 1), 4);
  assert.ok(successScore(1, 1) < successScore(20, 20));
});

test('successScore: a decayed record fades toward zero, so silence costs', () => {
  // A ratio alone is scale invariant: 10/10 decayed to 0.44/0.44 is still 1.0,
  // and would hold full marks forever. The prior is what makes weight matter.
  assert.equal(successScore(0.44, 0.44), 2);
  assert.equal(successScore(0.01, 0.01), 0);
});

test('successScore: the prior is adjustable', () => {
  assert.equal(successScore(1, 1, 0), 25);
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
  assert.equal(ageScore(registeredAt), 10);
});

test('ageScore: capped at 20, but only for genuinely old agents', () => {
  assert.equal(ageScore(Math.floor(Date.now() / 1000) - 365 * 86400), 17);
  assert.equal(ageScore(Math.floor(Date.now() / 1000) - 3650 * 86400), 20);
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
  // Max without external: 30 fee + 20 age + 5 community, plus a success score
  // that approaches 25 without reaching it because of the prior.
  const registeredAt = Math.floor(Date.now() / 1000) - 365 * 86400;
  const s = computeScore({ registeredAt, attestations: { successful: 300, total: 300 }, flags: 0 });
  assert.ok(s.total <= 100);
  assert.equal(s.successScore, 24);
  assert.equal(s.total, 76); // age 17 at one year, not 20
});

test('computeScore: externalScore is included in the total', () => {
  const registeredAt = Math.floor(Date.now() / 1000);
  const s = computeScore({ registeredAt, attestations: { successful: 0, total: 0 }, flags: 0, externalScore: 12 });
  assert.equal(s.externalScore, 12);
  assert.equal(s.total, 17); // 12 external + 5 community
});

test('computeScore: externalScore clamped to the 0-15 cap', () => {
  const registeredAt = Math.floor(Date.now() / 1000);
  const over = computeScore({ registeredAt, attestations: { successful: 0, total: 0 }, flags: 0, externalScore: 99 });
  assert.equal(over.externalScore, 15);
  const under = computeScore({ registeredAt, attestations: { successful: 0, total: 0 }, flags: 0, externalScore: -5 });
  assert.equal(under.externalScore, 0);
});

test('computeScore: with external, a realistic ceiling is 94', () => {
  // 30 fee + 24 success + 17 age + 15 external + 5 community, propagation a stub.
  // Success lands at 24 rather than 25: the prior means a finite record never
  // quite reaches the cap. Age is 17 at one year: the cap needs years, not a month.
  const registeredAt = Math.floor(Date.now() / 1000) - 365 * 86400;
  const s = computeScore({ registeredAt, attestations: { successful: 300, total: 300 }, flags: 0, externalScore: 15 });
  assert.equal(s.total, 91);
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
  // The change measured in adversarial.test.js: this used to return 20, which handed
  // the whole factor to six weeks of wash payments.
  assert.equal(ageScore(SEC - 40 * DAYS, win(31, 0, 1)), 10);
  assert.equal(ageScore(SEC - 1100 * DAYS, win(1023, 0, 1)), 20);
});

test('ageScore: tenure decays once the agent stops', () => {
  const active = ageScore(SEC - 800 * DAYS, win(730, 0, 1));
  const stale = ageScore(SEC - 800 * DAYS, win(730, 365, 0.06));
  assert.equal(active, 19);
  assert.ok(stale <= 2, `abandoned tenure should nearly vanish, got ${stale}`);
  assert.ok(stale < active);
});

test('ageScore: recency is clamped, so a bad weight cannot inflate the factor', () => {
  assert.equal(ageScore(SEC - 800 * DAYS, win(730, 0, 5)), 19);
  assert.equal(ageScore(SEC - 800 * DAYS, win(730, 0, -1)), 0);
});

test('ageScore: with no activity data it falls back to the calendar', () => {
  // Payment verification off: existing deployments keep the old behaviour.
  assert.equal(ageScore(SEC - 31 * DAYS, null), 10);
  assert.equal(ageScore(SEC - 31 * DAYS), 10);
});

test('ageCurve: full marks take years, not a month', () => {
  // Was log2(days+1)*4, capping at day 31, which handed the whole factor to six weeks
  // of wash payments (adversarial.test.js measured it). The curve now matches the
  // claim in scoring.js that this represents sustained operation over years.
  assert.equal(ageCurve(0), 0);
  assert.equal(ageCurve(1), 2);
  assert.equal(ageCurve(7), 6);
  assert.equal(ageCurve(31), 10);
  assert.equal(ageCurve(365), 17);
  assert.equal(ageCurve(1023), 20);
  assert.equal(ageCurve(3650), 20);
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
  assert.equal(working.ageScore, 19); // two years of active trade, just under the cap
});
