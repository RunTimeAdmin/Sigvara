'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { leafFor, buildTree, rootFor, proofFor, verifyProof, hashPair, settledSeconds } = require('./merkle');

const ev = (i, over = {}) => ({
  txHash: '0x' + String(i).padStart(2, '0').repeat(32),
  payer: ethers.Wallet.createRandom().address,
  amount: String(1000n * BigInt(i + 1)),
  ts: (1_700_000_000 + i) * 1000,   // the store's shape: milliseconds
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
  assert.notEqual(mutate(1, { ts: base[1].ts + 1000 }), root, 'settlement time');
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
    [e.txHash, e.payer, BigInt(e.amount), BigInt(e.ts / 1000), e.success]
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

  // What /evidence publishes is what the leaf commits to, in the same unit.
  assert.equal(settledSeconds(stored[0]), 1_700_000_000, 'served settledAt is seconds');
});

test('leafFor: refuses an event with no settlement hash', () => {
  assert.throws(
    () => leafFor({ payer: PAYER, amount: 1n, settledAt: 1, success: true }),
    /settlement hash/
  );
});

// The property the whole commitment rests on: a verifier who reads the block off the
// chain must arrive at the leaf the oracle published. The chain reports seconds, so the
// leaf commits to seconds. Encoding the store's milliseconds instead was self-consistent
// and unverifiable, which is the worst of both: the root looks like proof and refutes
// itself the moment anyone checks it.
test('the leaf commits to the block timestamp a verifier reads off the chain', () => {
  const blockTimestamp = 1_789_734_970;              // seconds, as eth_getBlockByNumber gives it
  const stored = {
    txHash: '0x' + 'cd'.repeat(32),
    payer: PAYER,
    amount: '20000000000000000000',
    ts: blockTimestamp * 1000,                        // what verifyPayment records
    success: true,
  };

  assert.equal(settledSeconds(stored), blockTimestamp);

  const rebuiltByVerifier = ethers.keccak256(ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'address', 'uint256', 'uint256', 'bool'],
      [stored.txHash, stored.payer, BigInt(stored.amount), BigInt(blockTimestamp), true]
    )
  ));
  assert.equal(leafFor(stored), rebuiltByVerifier);
});

test('settledSeconds refuses a record served by /evidence, which is already seconds', () => {
  // Round-tripping a served record would divide by 1000 twice and silently produce a
  // leaf for some moment in 1970. Better to reject the field name outright.
  assert.throws(() => settledSeconds({ settledAt: 1_789_734_970 }), /milliseconds/);
});

// --- cross-evidence: packetId must not enter the commitment -------------------
// A CounterAudit packet id is corroboration, not evidence: it identifies an
// independently timestamped record of the same work. It is stored on the event and
// served by /evidence, and it must never reach the leaf — the root 0xb07cdfc2… is
// already on Arc and must stay reproducible from the five committed fields alone.

test('leafFor ignores packetId entirely', () => {
  const base = {
    txHash: '0xc94ed4acfd17e4e514caf2deef67e46eda7bdd449a964d6fac813804a4432487',
    payer: '0x016F40f44E74cf1907434b83D50D8d833847896a',
    amount: '20000000000000000000',
    ts: 1789734970000,
    success: true,
  };
  const without = leafFor(base);
  const with_ = leafFor({ ...base, packetId: '56ccbfd3-3868-4b98-8e56-97faa0aec031' });
  assert.equal(with_, without, 'adding a packet id must not change the leaf');
});

test('a tree built with packet ids has the same root as one without', () => {
  // The regression that would break every published root at once.
  const events = [
    { txHash: '0x' + '11'.repeat(32), payer: '0x016F40f44E74cf1907434b83D50D8d833847896a', amount: '1000', ts: 1789734970000, success: true },
    { txHash: '0x' + '22'.repeat(32), payer: '0xaCc2362C6254B67954cB813399173fa631A1fA8e', amount: '2000', ts: 1789734973000, success: false },
  ];
  const plain = buildTree(events).root;
  const tagged = buildTree(events.map((e, i) => ({ ...e, packetId: `packet-${i}` }))).root;
  assert.equal(tagged, plain, 'the root must not depend on corroboration metadata');
});

// A pulled payment carries no outcome: nobody reported whether the work was good.
// The store keeps that as null precisely so it is not mistaken for a failure, and
// scoring keeps it out of both sides of the success ratio. The leaf has to draw the
// same distinction, or the root commits to an outcome the score did not use.
//
// Fixed inputs, because the point of the second assertion is the exact hash.
const fixed = {
  txHash: '0x' + 'ab'.repeat(32),
  payer: '0x' + '11'.repeat(20),
  amount: '1000000',
  ts: 1_700_000_000_000,
};

test('leafFor: an unreported outcome is not a reported failure', () => {
  const unreported = leafFor({ ...fixed, success: null });
  const failed = leafFor({ ...fixed, success: false });
  const succeeded = leafFor({ ...fixed, success: true });

  assert.notEqual(
    unreported, failed,
    'success:null and success:false must not share a leaf: the score treats them differently, ' +
    'so a root that cannot tell them apart does not commit to the arithmetic it claims to'
  );
  assert.notEqual(unreported, succeeded);
  assert.notEqual(failed, succeeded);
});

test('leafFor: roots already published on chain stay reproducible', () => {
  // Captured from the bool encoding that every credited payment has used to date.
  // Outcomes are booleans on that path, and these two hashes are what the live
  // operators have already committed to, so they must not move.
  assert.equal(
    leafFor({ ...fixed, success: false }),
    '0x74e48881685673b00e21f176b7b348c6ddbe466547bc5068cf9183f84ad71f4b'
  );
  assert.equal(
    leafFor({ ...fixed, success: true }),
    '0x93719bf728289b66233e9bb41eeda66eda0fa2cdf553733ef7a659ede8c01d57'
  );
});
