'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { rootFor } = require('./merkle');
const { evidenceAsOf } = require('./evidence-as-of');

const AT = 1_793_487_992_000; // a proposal at 2026-10-31 23:06:32 UTC, in ms

const ev = (i, tsMs, over = {}) => Object.freeze({
  txHash: '0x' + String(i).padStart(2, '0').repeat(32),
  payer: ethers.Wallet.createRandom().address,
  amount: String(1000n * BigInt(i + 1)),
  ts: tsMs,
  success: true,
  ...over,
});

test('keeps only what had settled by the proposal, and names the committed root when it is that', () => {
  const before = [ev(1, AT - 86_400_000), ev(2, AT)];
  const after = [ev(3, AT + 1), ev(4, AT + 3_600_000)];
  const got = evidenceAsOf([...before, ...after], AT, rootFor(before));
  assert.deepEqual(got.events, before);
  assert.equal(got.matchedRoot, true);
});

test('finds the proposal\'s evidence when a payer signed an outcome after it', () => {
  // Settled before the proposal with no outcome; the payer signed one an hour after it.
  const unjudged = ev(1, AT - 60_000, { success: null });
  const signed = Object.freeze({ ...unjudged, success: true, payerOutcome: Object.freeze({ outcome: 1, acceptedAt: AT + 3_600_000 }) });
  const old = ev(2, AT - 86_400_000);
  const got = evidenceAsOf([old, signed], AT, rootFor([old, unjudged]));
  assert.equal(got.matchedRoot, true);
  assert.equal(got.events[1].success, null, 'the outcome is read as unreported, as the proposer saw it');
  assert.equal(got.events[1].payerOutcome, undefined);
  assert.equal(rootFor(got.events), rootFor([old, unjudged]));
});

test('keeps an outcome the payer signed before the proposal', () => {
  const signed = ev(1, AT - 60_000, { payerOutcome: Object.freeze({ outcome: 1, acceptedAt: AT - 1 }) });
  const got = evidenceAsOf([signed], AT, rootFor([signed]));
  assert.equal(got.matchedRoot, true);
  assert.equal(got.events[0], signed);
});

test('when no reading matches the committed root, uses what had settled, outcomes as held', () => {
  const held = [ev(1, AT - 60_000), ev(2, AT - 120_000, { payerOutcome: Object.freeze({ acceptedAt: AT + 5 }) })];
  const elsewhere = rootFor([ev(9, AT - 60_000)]);
  const got = evidenceAsOf([...held, ev(3, AT + 10)], AT, elsewhere);
  assert.equal(got.matchedRoot, false);
  assert.deepEqual(got.events, held);
  // No committed root at all reads the same way.
  assert.deepEqual(evidenceAsOf([...held, ev(3, AT + 10)], AT, null), { events: held, matchedRoot: false });
});

test('matches a proposal with no evidence, and compares roots without case', () => {
  assert.deepEqual(evidenceAsOf([ev(1, AT + 1)], AT, ethers.ZeroHash), { events: [], matchedRoot: true });
  const one = [ev(1, AT - 1)];
  assert.equal(evidenceAsOf(one, AT, rootFor(one).toUpperCase().replace('0X', '0x')).matchedRoot, true);
});

test('refuses a time that is not one', () => {
  assert.throws(() => evidenceAsOf([], undefined, null), /atMs/);
});
