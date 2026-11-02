'use strict';

// The explorer pages (site/assets/explorer.js) rebuild evidence roots in the visitor's browser,
// so that "recompute it yourself" needs nothing from this oracle but the payment list. That only
// means something while the browser's rebuild and this oracle's agree, so these tests hold the two
// to the same answers: leaves, roots, proofs, and which payments a committed root is over.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const merkle = require('./merkle');
const { evidenceAsOf } = require('./evidence-as-of');
const explorer = require('../site/assets/explorer.js');

const T0 = 1_700_000_000;

// A payment as the store holds it, and the same payment as /evidence serves it.
const stored = (i, over = {}) => Object.freeze({
  txHash: ethers.hexlify(ethers.randomBytes(32)),
  payer: ethers.Wallet.createRandom().address,
  amount: String(10n ** 18n * BigInt(i + 1)),
  ts: (T0 + i * 60) * 1000,
  success: [true, false, null][i % 3],
  ...over,
});
const served = (e) => ({
  txHash: e.txHash,
  payer: e.payer,
  amount: e.amount,
  settledAt: merkle.settledSeconds(e),
  success: e.success,
  outcomeSource: e.payerOutcome ? 'payer_signed' : typeof e.success === 'boolean' ? 'credentialed' : null,
});

test('the browser leaf is the oracle leaf, for every outcome', () => {
  for (let i = 0; i < 30; i++) {
    const e = stored(i);
    assert.equal(explorer.leafOf(served(e)), merkle.leafFor(e), `payment ${i}`);
  }
});

test('the browser root and proofs are the oracle root and proofs, for odd and even trees', () => {
  for (const n of [0, 1, 2, 3, 5, 8, 9, 17]) {
    const events = Object.freeze(Array.from({ length: n }, (_, i) => stored(i)));
    const tree = merkle.buildTree(events);
    const leaves = events.map((e) => explorer.leafOf(served(e)));
    assert.equal(explorer.rootOf(leaves), merkle.rootFor(events), `root of ${n}`);
    const layers = explorer.layersOf(leaves);
    for (let i = 0; i < n; i++) {
      assert.deepEqual(explorer.proofOf(layers, i), merkle.proofFor(tree, i), `proof ${i} of ${n}`);
    }
  }
});

test('a changed field changes the leaf, so a served list cannot be edited unseen', () => {
  const e = served(stored(1));
  const base = explorer.leafOf(e);
  assert.notEqual(explorer.leafOf({ ...e, amount: String(BigInt(e.amount) + 1n) }), base);
  assert.notEqual(explorer.leafOf({ ...e, settledAt: e.settledAt + 1 }), base);
  assert.notEqual(explorer.leafOf({ ...e, payer: ethers.Wallet.createRandom().address }), base);
  assert.notEqual(explorer.leafOf(e, null), explorer.leafOf(e, false), 'unreported is not failed');
});

test('a payment the oracle could not commit to is refused, not hashed', () => {
  const e = served(stored(2));
  assert.throws(() => explorer.leafOf({ ...e, txHash: null }));
  assert.throws(() => explorer.leafOf({ ...e, payer: 'nobody' }));
  assert.throws(() => explorer.leafOf({ ...e, amount: '-1' }));
});

test('matchRoot finds the set a proposal committed to, as the checker does', () => {
  const events = Object.freeze(Array.from({ length: 7 }, (_, i) => stored(i)));
  // A proposal made after the fourth payment settled.
  const atMs = events[3].ts + 30_000;
  const asOf = evidenceAsOf(events, atMs, null);
  const committed = merkle.rootFor(asOf.events);

  const list = events.map(served);
  const withTime = explorer.matchRoot(list, committed, { at: Math.floor(atMs / 1000) });
  assert.ok(withTime, 'found with the proposal time');
  assert.equal(withTime.events.length, 4);

  const without = explorer.matchRoot(list, committed);
  assert.ok(without, 'found by trying each settlement time');
  assert.equal(without.events.length, 4);
  assert.equal(without.unset, false);

  // Every payment, when the root covers them all.
  assert.equal(explorer.matchRoot(list, merkle.rootFor(events)).events.length, 7);
});

test('matchRoot reads a payer-signed outcome taken after the proposal as unreported', () => {
  const at = (T0 + 10 * 60) * 1000;
  const late = { acceptedAt: at + 3_600_000 };
  const events = Object.freeze([
    stored(0),
    stored(1, { success: true, payerOutcome: late }),
    stored(2),
  ]);
  // What the proposer had: the signed outcome did not exist yet.
  const asOf = evidenceAsOf(events, at, merkle.rootFor(events.map((e) => (e.payerOutcome ? Object.freeze({ ...e, success: null, payerOutcome: undefined }) : e))));
  assert.equal(asOf.matchedRoot, true);
  const committed = merkle.rootFor(asOf.events);

  const found = explorer.matchRoot(events.map(served), committed);
  assert.ok(found);
  assert.equal(found.unset, true);
  assert.equal(found.events.length, 3);
});

test('matchRoot says so when no reading reproduces the root', () => {
  const list = Array.from({ length: 4 }, (_, i) => served(stored(i)));
  assert.equal(explorer.matchRoot(list, ethers.hexlify(ethers.randomBytes(32))), null);
  assert.equal(explorer.matchRoot(list, 'not a root'), null);
});

test('verifyEvidence calldata is what the contract ABI encodes', () => {
  const iface = new ethers.Interface(['function verifyEvidence(bytes32 didHash, bytes32 leaf, bytes32[] proof)']);
  const did = ethers.hexlify(ethers.randomBytes(32));
  const leaf = ethers.hexlify(ethers.randomBytes(32));
  for (const n of [0, 1, 3]) {
    const proof = Array.from({ length: n }, () => ethers.hexlify(ethers.randomBytes(32)));
    assert.equal(explorer.verifyEvidenceCall(did, leaf, proof), iface.encodeFunctionData('verifyEvidence', [did, leaf, proof]));
  }
});
