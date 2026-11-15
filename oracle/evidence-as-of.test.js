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

test('keeps only what had settled by the proposal, and names the committed root when it is that', async () => {
  const before = [ev(1, AT - 86_400_000), ev(2, AT)];
  const after = [ev(3, AT + 1), ev(4, AT + 3_600_000)];
  const got = await evidenceAsOf([...before, ...after], AT, rootFor(before));
  assert.deepEqual(got.events, before);
  assert.equal(got.matchedRoot, true);
});

test('finds the proposal\'s evidence when a payer signed an outcome after it', async () => {
  // Settled before the proposal with no outcome; the payer signed one an hour after it.
  const unjudged = ev(1, AT - 60_000, { success: null });
  const signed = Object.freeze({ ...unjudged, success: true, payerOutcome: Object.freeze({ outcome: 1, acceptedAt: AT + 3_600_000 }) });
  const old = ev(2, AT - 86_400_000);
  const got = await evidenceAsOf([old, signed], AT, rootFor([old, unjudged]));
  assert.equal(got.matchedRoot, true);
  assert.equal(got.events[1].success, null, 'the outcome is read as unreported, as the proposer saw it');
  assert.equal(got.events[1].payerOutcome, undefined);
  assert.equal(rootFor(got.events), rootFor([old, unjudged]));
});

test('keeps an outcome the payer signed before the proposal', async () => {
  const signed = ev(1, AT - 60_000, { payerOutcome: Object.freeze({ outcome: 1, acceptedAt: AT - 1 }) });
  const got = await evidenceAsOf([signed], AT, rootFor([signed]));
  assert.equal(got.matchedRoot, true);
  assert.equal(got.events[0], signed);
});

test('when no reading matches the committed root, uses what had settled, outcomes as held', async () => {
  const held = [ev(1, AT - 60_000), ev(2, AT - 120_000, { payerOutcome: Object.freeze({ acceptedAt: AT + 5 }) })];
  const elsewhere = rootFor([ev(9, AT - 60_000)]);
  const got = await evidenceAsOf([...held, ev(3, AT + 10)], AT, elsewhere);
  assert.equal(got.matchedRoot, false);
  assert.deepEqual(got.events, held);
  // No committed root at all reads the same way.
  assert.deepEqual(await evidenceAsOf([...held, ev(3, AT + 10)], AT, null), { events: held, matchedRoot: false });
});

test('matches a proposal with no evidence, and compares roots without case', async () => {
  assert.deepEqual(await evidenceAsOf([ev(1, AT + 1)], AT, ethers.ZeroHash), { events: [], matchedRoot: true });
  const one = [ev(1, AT - 1)];
  assert.equal((await evidenceAsOf(one, AT, rootFor(one).toUpperCase().replace('0X', '0x'))).matchedRoot, true);
});

test('refuses a time that is not one', async () => {
  await assert.rejects(evidenceAsOf([], undefined, null), /atMs/);
});

test('only the fixed order is read: a root over the same payments in another order does not match', async () => {
  const unjudged = ev(1, AT - 60_000, { success: null });
  const signed = Object.freeze({ ...unjudged, success: true, payerOutcome: Object.freeze({ outcome: 1, acceptedAt: AT + 3_600_000 }) });
  const a = ev(2, AT - 86_400_000);
  const b = ev(3, AT - 3_600_000);
  const fixed = [a, b, signed];
  const root = rootFor([unjudged, a, b]);
  assert.notEqual(rootFor([a, b, unjudged]), root, 'the order changes this root');

  const got = await evidenceAsOf(fixed, AT, root);
  assert.equal(got.matchedRoot, false);
  assert.deepEqual(got.events, fixed, 'what had settled by then, in the fixed order');
  assert.equal(got.events[2].success, true);
});

// ---- cost ----------------------------------------------------------------------------------------------------------

const many = (n) => Array.from({ length: n }, (_, i) => Object.freeze({
  txHash: '0x' + (i + 1).toString(16).padStart(64, '0'),
  payer: '0x' + '11'.repeat(20),
  amount: '1000',
  ts: AT - (n - i) * 1000,
  success: true,
}));

/** How many keccak256 hashes `fn` computes. merkle.js reads ethers.keccak256 at each call, so it can be counted. */
async function hashesIn(fn) {
  const real = ethers.keccak256;
  let n = 0;
  Object.defineProperty(ethers, 'keccak256', { value: (...a) => { n += 1; return real(...a); }, configurable: true, writable: true });
  try {
    await fn();
  } finally {
    Object.defineProperty(ethers, 'keccak256', { value: real, configurable: true, writable: true });
  }
  return n;
}

// Every cut-off's tree was built whole: an audit that matched none at the cap of 25,000 payments held the event loop for
// 22 s (performance review, 15 November). Neighbouring cut-offs share every pair left of where they differ.
test('the trees of neighbouring cut-offs share their pairs', async () => {
  const N = 3000;
  const events = many(N);
  rootFor(events); // the leaves, hashed once and kept, so only the pairs are counted below
  const cuts = Array.from({ length: 30 }, (_, k) => AT - (k + 1) * 60_000);
  let got;
  const hashes = await hashesIn(async () => { got = await evidenceAsOf(events, AT, ethers.ZeroHash.replace(/0$/, '1'), { cuts }); });
  assert.equal(got.matchedRoot, false);
  // Built whole, the 31 trees take about 31 times N. Shared, about N and a few dozen for each further cut-off.
  assert.ok(hashes < 2 * N, `${hashes} hashes for ${cuts.length + 1} cut-offs over ${N} payments`);
});

test('an audit lets other work run between the trees it tries', async () => {
  const events = many(50);
  const cuts = Array.from({ length: 5 }, (_, k) => AT - (k + 1) * 5_000);
  let ran = false;
  const audit = evidenceAsOf(events, AT, ethers.ZeroHash.replace(/0$/, '1'), { cuts });
  setImmediate(() => { ran = true; });
  await audit;
  assert.equal(ran, true);
});
