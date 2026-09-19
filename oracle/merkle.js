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
 * The leaf for one verified payment.
 *
 * Double-hashed, which is the standard guard against second preimage attacks: an
 * internal node is a hash of two 32-byte values, and a leaf hashed once could be made
 * to collide with one. Anyone can rebuild this from the transaction alone.
 */
function leafFor(event) {
  const { txHash, payer, amount, success } = event;

  // `settledAt` here, `ts` in the store. The two names drifted apart and nothing
  // noticed: these tests build their own fixtures and never go through
  // creditPayment, so each side passed its own suite while the pair was broken.
  // Every propose threw "Cannot convert undefined to a BigInt" the first time the
  // oracle ran against real stored events. Accept both rather than rename a field
  // that is already persisted in live state files.
  const settledAt = event.settledAt ?? event.ts;
  if (settledAt === undefined) {
    throw new Error('payment event has no settlement time (settledAt or ts)');
  }

  // A leaf with no settlement hash cannot be rebuilt from the chain, so committing
  // to it would put something in the root that no verifier could ever check. That is
  // worse than refusing: the root would look like evidence while proving nothing.
  if (!txHash) {
    throw new Error(
      'payment event has no settlement hash, so it cannot be verified against the chain'
    );
  }

  const inner = ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'address', 'uint256', 'uint256', 'bool'],
    [
      String(txHash).toLowerCase(),
      ethers.getAddress(payer),
      BigInt(amount),
      BigInt(settledAt),
      Boolean(success),
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

module.exports = { leafFor, buildTree, rootFor, proofFor, verifyProof, hashPair };
