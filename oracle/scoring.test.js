'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeScore, feeScore, successScore, ageScore, communityScore } = require('./scoring');

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

test('ageScore: day 31 reaches max of 20', () => {
  const registeredAt = Math.floor(Date.now() / 1000) - 31 * 86400;
  assert.equal(ageScore(registeredAt), 20);
});

test('ageScore: capped at 20 for very old agents', () => {
  const registeredAt = Math.floor(Date.now() / 1000) - 365 * 86400;
  assert.equal(ageScore(registeredAt), 20);
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
  assert.equal(s.total, 79);
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
  // 30 fee + 24 success + 20 age + 15 external + 5 community, propagation a stub.
  // Success lands at 24 rather than 25: the prior means a finite record never
  // quite reaches the cap.
  const registeredAt = Math.floor(Date.now() / 1000) - 365 * 86400;
  const s = computeScore({ registeredAt, attestations: { successful: 300, total: 300 }, flags: 0, externalScore: 15 });
  assert.equal(s.total, 94);
  assert.ok(s.total <= 100);
});

test('computeScore: slashed-like scenario (high flags)', () => {
  const registeredAt = Math.floor(Date.now() / 1000) - 10 * 86400;
  const s = computeScore({ registeredAt, attestations: { successful: 5, total: 10 }, flags: 5 });
  assert.equal(s.communityScore, 0);
  assert.ok(s.total >= 0);
});
