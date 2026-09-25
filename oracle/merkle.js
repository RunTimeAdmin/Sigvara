'use strict';

// Evidence commitments.
//
// A score is computed off-chain from payments the oracle verified, and the only record
// of which payments those were lived in the oracle's own state file. Anyone wanting to
// check the arithmetic had to trust that file: the payments are on chain and checkable,
// but the *set* the oracle claims to have used was not.
//
// Each proposal now carries a Merkle root over its evidence. A third party asks the
// oracle for the leaves, re-verifies every payment against the chain itself, rebuilds
// the root, and compares it with the one committed on chain. If the oracle quietly drops
// an inconvenient payment or invents one, the root will not match what it published.
//
// This makes the inputs auditable. It does not make them correct: a root commits to
// what the oracle says it counted, and the check is that the claim matches the chain.

const { ethers } = require('ethers');

/**
 * The settlement time a leaf commits to: SECONDS, matching the block timestamp.
 *
 * The store keeps `ts` in milliseconds because the decay maths works in ms, and the
 * leaf used to encode that value directly. It was self-consistent and unverifiable:
 * a verifier following the documented procedure reads the block timestamp off the
 * chain, gets seconds, rebuilds the leaf, and computes a different root. The one
 * mechanism that exists to prove the oracle honest would have made it look dishonest.
 *
 * So the conversion lives here, in one place, and both the leaf and the /evidence
 * response go through it. `ts` is the store's field and the only accepted input: the
 * endpoint publishes `settledAt` already in seconds, and refusing that name back here
 * means a served record can never be fed in and silently re-divided.
 */
function settledSeconds(event) {
  const ms = event.ts;
  if (ms === undefined) {
    throw new Error('payment event has no settlement time (ts, in milliseconds)');
  }
  return Math.floor(Number(ms) / 1000);
}

/**
 * The leaf for one verified payment.
 *
 * Double-hashed, which is the standard guard against second preimage attacks: an
 * internal node is a hash of two 32-byte values, and a leaf hashed once could be made
 * to collide with one. Anyone can rebuild this from the transaction alone: the hash
 * identifies it, and the payer, amount and settlement time all come off the receipt
 * and its block.
 */
/**
 * How the leaf encodes the reported outcome: 0 failed, 1 succeeded, 2 not reported.
 *
 * `Boolean(success)` was wrong here in a way that was invisible from this file. ADR 0003
 * introduced payments found by scanning the chain, and those carry no outcome at all,
 * because whether the work was any good is not on chain. The store records that as null
 * rather than false, deliberately: `!!success` would damage an agent nobody complained
 * about, and scoring keeps a null out of both sides of the success ratio.
 *
 * The leaf collapsed it back to false anyway, so a payment nobody judged committed to
 * the same hash as a payment somebody failed. Two consequences, both bad. The root no
 * longer commits to the arithmetic that produced the score, since the two cases are
 * scored differently. And with two bonded operators, one holding null and one holding
 * false publish identical roots, so comparing roots cannot see that they disagree.
 *
 * uint8 rather than a second field, because ABI-encodes bool as a 32-byte 0 or 1, which
 * is byte-for-byte what uint8 0 or 1 encodes. Every leaf ever committed carried a
 * boolean, so all of them reproduce exactly and no published root moves. Only the third
 * state is new, and nothing has written one yet: the pull scanner is disabled on both
 * operators, which is the window in which this is free to fix.
 */
function outcomeCode(success) {
  if (success === true) return 1;
  if (success === false) return 0;
  return 2;
}

function leafFor(event) {
  const { txHash, payer, amount, success } = event;

  // A leaf with no settlement hash cannot be rebuilt from the chain, so committing
  // to it would put something in the root that no verifier could ever check. That is
  // worse than refusing: the root would look like evidence while proving nothing.
  if (!txHash) {
    throw new Error(
      'payment event has no settlement hash, so it cannot be verified against the chain'
    );
  }

  const inner = ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'address', 'uint256', 'uint256', 'uint8'],
    [
      String(txHash).toLowerCase(),
      ethers.getAddress(payer),
      BigInt(amount),
      BigInt(settledSeconds(event)),
      outcomeCode(success),
    ]
  );
  return ethers.keccak256(ethers.keccak256(inner));
}

/// Sorted-pair hashing, matching OpenZeppelin's MerkleProof.
function hashPair(a, b) {
  return a.toLowerCase() <= b.toLowerCase()
    ? ethers.keccak256(ethers.concat([a, b]))
    : ethers.keccak256(ethers.concat([b, a]));
}

/**
 * Builds the tree over `events` and returns { root, leaves, layers }.
 *
 * An odd node is promoted rather than duplicated. Duplicating it is the classic
 * malleability bug: a tree can then be extended with the repeated leaf and still
 * produce the same root.
 */
function buildTree(events) {
  const leaves = events.map(leafFor);
  if (leaves.length === 0) return { root: ethers.ZeroHash, leaves: [], layers: [] };

  const layers = [leaves.slice()];
  let level = leaves.slice();
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? hashPair(level[i], level[i + 1]) : level[i]);
    }
    layers.push(next);
    level = next;
  }
  return { root: level[0], leaves, layers };
}

function rootFor(events) {
  return buildTree(events).root;
}

/// The sibling path for the leaf at `index`, in the order MerkleProof.verify expects.
function proofFor(tree, index) {
  const proof = [];
  let idx = index;
  for (let l = 0; l < tree.layers.length - 1; l++) {
    const layer = tree.layers[l];
    const pairIdx = idx % 2 === 0 ? idx + 1 : idx - 1;
    if (pairIdx < layer.length) proof.push(layer[pairIdx]);
    idx = Math.floor(idx / 2);
  }
  return proof;
}

/// Local check of a proof, so the oracle can refuse to serve one that does not verify.
function verifyProof(leaf, proof, root) {
  let computed = leaf;
  for (const sibling of proof) computed = hashPair(computed, sibling);
  return computed.toLowerCase() === String(root).toLowerCase();
}

module.exports = {
  leafFor, buildTree, rootFor, proofFor, verifyProof, hashPair, settledSeconds, outcomeCode,
};
