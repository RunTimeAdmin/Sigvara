'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { leafFor, buildTree, rootFor, proofFor, verifyProof, hashPair } = require('./merkle');

const ev = (i, over = {}) => ({
  txHash: '0x' + String(i).padStart(2, '0').repeat(32),
  payer: ethers.Wallet.createRandom().address,
  amount: String(1000n * BigInt(i + 1)),
  settledAt: 1_700_000_000 + i,
  success: i % 3 !== 0,
  ...over,
});

test('rootFor: no evidence is the zero root, not a hash of nothing', () => {
  assert.equal(rootFor([]), ethers.ZeroHash);
});

test('every leaf proves against the root, for odd and even trees alike', () => {
  for (const n of [1, 2, 3, 4, 5, 7, 8, 9, 16, 17]) {
    const events = Array.from({ length: n }, (_, i) => ev(i));
    const tree = buildTree(events);
    for (let i = 0; i < n; i++) {
      assert.ok(
        verifyProof(tree.leaves[i], proofFor(tree, i), tree.root),
        `leaf ${i} of ${n} failed`
      );
    }
  }
});

test('a leaf that was not in the set does not verify', () => {
  const tree = buildTree(Array.from({ length: 5 }, (_, i) => ev(i)));
  const outsider = leafFor(ev(99));
  assert.equal(verifyProof(outsider, proofFor(tree, 0), tree.root), false);
});

test('the root changes if any field of any payment changes', () => {
  const base = Array.from({ length: 3 }, (_, i) => ev(i));
  const root = rootFor(base);
  const mutate = (i, over) => rootFor(base.map((e, j) => (j === i ? { ...e, ...over } : e)));

  assert.notEqual(mutate(1, { amount: '999' }), root, 'amount');
  assert.notEqual(mutate(1, { success: !base[1].success }), root, 'outcome');
  assert.notEqual(mutate(1, { settledAt: base[1].settledAt + 1 }), root, 'settlement time');
  assert.notEqual(mutate(1, { payer: ethers.Wallet.createRandom().address }), root, 'payer');
  assert.notEqual(mutate(1, { txHash: '0x' + 'ff'.repeat(32) }), root, 'transaction');
});

test('dropping a payment changes the root, which is what makes omission detectable', () => {
  // The failure this exists to catch: an oracle quietly leaving out evidence that
  // would have lowered a score.
  const base = Array.from({ length: 4 }, (_, i) => ev(i));
  assert.notEqual(rootFor(base.slice(0, 3)), rootFor(base));
});

test('sorted-pair hashing commits to the set, not to the ordering within a pair', () => {
  // Worth stating rather than assuming. Pairs are hashed in sorted order, which is what
  // OpenZeppelin's MerkleProof expects, and it means swapping two siblings leaves the
  // root unchanged. The commitment is over which payments are in the set, not the order
  // the oracle happened to list them in, and membership is all a verifier needs.
  const base = Array.from({ length: 4 }, (_, i) => ev(i));
  const siblingsSwapped = [base[1], base[0], base[2], base[3]];
  assert.equal(rootFor(siblingsSwapped), rootFor(base));

  // Moving a leaf into a different pair does change it, so this is not a free-for-all.
  const regrouped = [base[0], base[2], base[1], base[3]];
  assert.notEqual(rootFor(regrouped), rootFor(base));
});

test('an odd node is promoted, not duplicated', () => {
  // Duplicating it is the classic malleability bug: the tree could then be extended
  // with the repeated leaf and still produce the same root.
  const three = Array.from({ length: 3 }, (_, i) => ev(i));
  const tree = buildTree(three);
  const [a, b, c] = tree.leaves;
  assert.equal(tree.root, hashPair(hashPair(a, b), c));
  assert.notEqual(tree.root, hashPair(hashPair(a, b), hashPair(c, c)));
});

test('leaves are double-hashed, guarding against a leaf posing as an internal node', () => {
  const e = ev(0);
  const inner = ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'address', 'uint256', 'uint256', 'bool'],
    [e.txHash, e.payer, BigInt(e.amount), BigInt(e.settledAt), e.success]
  );
  assert.equal(leafFor(e), ethers.keccak256(ethers.keccak256(inner)));
  assert.notEqual(leafFor(e), ethers.keccak256(inner));
});

test('leaf encoding is case-insensitive on addresses and hashes', () => {
  const e = ev(0);
  const upper = { ...e, txHash: e.txHash.toUpperCase().replace('0X', '0x'), payer: e.payer.toLowerCase() };
  assert.equal(leafFor(upper), leafFor(e));
});

test('hashPair sorts, matching OpenZeppelin MerkleProof', () => {
  const a = ethers.keccak256('0x01');
  const b = ethers.keccak256('0x02');
  assert.equal(hashPair(a, b), hashPair(b, a));
});

// Regression: the tree must build from what the store actually writes.
//
// Every test above builds its own fixture with a `settledAt` field. The store writes
// `ts`. Nothing exercised the pair, so both suites passed while rootFor threw on any
// real event, and it only surfaced when the oracle ran against a live state file.
const PAYER = ethers.Wallet.createRandom().address;

test('buildTree: accepts events exactly as creditPayment wrote them', () => {
  const store = require('./store');
  const did = '0x' + '11'.repeat(32);
  const txHash = '0x' + 'ab'.repeat(32);

  assert.equal(store.creditPayment(did, txHash, 5n * 10n ** 18n, PAYER, true, 1_700_000_000_000), true);
  const stored = store.getPaymentEvents(did);
  assert.equal(stored.length, 1);
  assert.ok(stored[0].ts !== undefined, 'store writes ts');
  assert.equal(stored[0].settledAt, undefined, 'store does not write settledAt');

  const root = rootFor(stored);
  assert.notEqual(root, ethers.ZeroHash);

  // And the leaf must match the one a verifier rebuilds from the /evidence shape,
  // which renames ts to settledAt on the way out.
  const asServed = { ...stored[0], settledAt: stored[0].ts };
  delete asServed.ts;
  assert.equal(leafFor(asServed), leafFor(stored[0]), 'ts and settledAt must agree');
});

test('leafFor: refuses an event with no settlement hash', () => {
  assert.throws(
    () => leafFor({ payer: PAYER, amount: 1n, settledAt: 1, success: true }),
    /settlement hash/
  );
});
