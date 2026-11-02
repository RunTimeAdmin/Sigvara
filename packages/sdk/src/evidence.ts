/**
 * Evidence roots, rebuilt the way oracle/merkle.js builds them.
 *
 * Each score an oracle proposes commits to a Merkle root over the payments it counted, and the reputation
 * contract keeps the finalized one (`evidenceRoots`) and checks a payment against it (`verifyEvidence`).
 * These functions rebuild that root from the payments an oracle's `/evidence` endpoint lists, so anyone can
 * check that the set it scored on is the set it published, without trusting the oracle's own leaves.
 *
 * The leaf is keccak256(keccak256(abi.encode(bytes32 txHash, address payer, uint256 amount, uint256 settledAt,
 * uint8 outcome))), with settledAt in seconds and the outcome 0 failed, 1 delivered, 2 not reported. Pairs are
 * hashed sorted, as OpenZeppelin's MerkleProof expects, and an odd node is promoted, not duplicated.
 * test/evidence.test.ts holds this to the fixture in test/SigvaraReputation.t.sol, which CI holds to both
 * oracle/merkle.js and the contract.
 */

import { ethers } from 'ethers';

/** One payment as an oracle's /evidence endpoint serves it. */
export interface EvidenceRecord {
  txHash: string;
  payer: string;
  /** Base units, as a decimal string or a bigint. */
  amount: string | bigint;
  /** Unix seconds, the settlement block's timestamp. */
  settledAt: number | string | bigint;
  /** true delivered, false failed, null not reported. */
  success: boolean | null;
  /** Who the outcome is the word of. `payer_signed` outcomes can arrive after a proposal was made. */
  outcomeSource?: string | null;
}

export const ZERO_ROOT = ethers.ZeroHash;
const UINT256 = 1n << 256n;
const HASH = /^0x[0-9a-fA-F]{64}$/;

/** How a leaf encodes the outcome: 0 failed, 1 delivered, 2 not reported. */
export function outcomeCode(success: boolean | null | undefined): 0 | 1 | 2 {
  if (success === true) return 1;
  if (success === false) return 0;
  return 2;
}

/**
 * The leaf for one payment. Throws on a field an oracle could not have committed to, so a list with one cannot
 * reproduce any root. `success` overrides the record's outcome, to read the payment as it was before a later one.
 */
export function evidenceLeaf(record: EvidenceRecord, success: boolean | null = record.success): string {
  if (typeof record?.txHash !== 'string' || !HASH.test(record.txHash)) throw new Error('a payment without a transaction hash');
  if (typeof record.payer !== 'string' || !ethers.isAddress(record.payer)) throw new Error('a payment without a payer address');
  let amount: bigint;
  let settled: bigint;
  try {
    amount = BigInt(record.amount);
    settled = BigInt(record.settledAt);
  } catch {
    throw new Error('a payment amount or time that is not a whole number');
  }
  if (amount < 0n || amount >= UINT256 || settled < 0n || settled >= UINT256) {
    throw new Error('a payment amount or time out of range');
  }
  const inner = ethers.AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'address', 'uint256', 'uint256', 'uint8'],
    [record.txHash.toLowerCase(), ethers.getAddress(record.payer.toLowerCase()), amount, settled, outcomeCode(success)],
  );
  return ethers.keccak256(ethers.keccak256(inner));
}

/** Sorted-pair hashing, matching OpenZeppelin's MerkleProof. */
export function hashPair(a: string, b: string): string {
  return a.toLowerCase() <= b.toLowerCase()
    ? ethers.keccak256(ethers.concat([a, b]))
    : ethers.keccak256(ethers.concat([b, a]));
}

/** Every layer of the tree, leaves first. Empty for no leaves. */
export function evidenceLayers(leaves: string[]): string[][] {
  if (!leaves.length) return [];
  const layers = [leaves.slice()];
  let level = leaves.slice();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? hashPair(level[i], level[i + 1]) : level[i]);
    layers.push(next);
    level = next;
  }
  return layers;
}

/** The root over these leaves, in order. The zero hash for none, which the contract treats as no root. */
export function evidenceRoot(leaves: string[]): string {
  if (!leaves.length) return ZERO_ROOT;
  const layers = evidenceLayers(leaves);
  return layers[layers.length - 1][0];
}

/** The sibling path for the leaf at `index`, in the order MerkleProof.verify and verifyEvidence expect. */
export function evidenceProof(layers: string[][], index: number): string[] {
  const proof: string[] = [];
  let idx = index;
  for (let l = 0; l < layers.length - 1; l++) {
    const pair = idx % 2 === 0 ? idx + 1 : idx - 1;
    if (pair < layers[l].length) proof.push(layers[l][pair]);
    idx = Math.floor(idx / 2);
  }
  return proof;
}

export interface RootMatch {
  /** Indexes into the records given, of the payments the root is over, in leaf order. */
  indexes: number[];
  leaves: string[];
  /** The settlement cut-off that reproduced it: Infinity for every payment listed. */
  cut: number;
  /** True when it took reading each payer-signed outcome as not yet reported. */
  unset: boolean;
}

/**
 * Which set of the listed payments a committed root is over, if any reading an oracle could have made
 * reproduces it, as the explorer's matchRoot does (site/assets/explorer.js).
 *
 * A proposal commits to the payments settled by the time it was made, and a payer can sign an outcome after
 * that. So the root is tried against every payment, against those settled by each cut-off, and against both
 * with every payer-signed outcome read as not reported. With `at` (a proposal's time, in seconds) only that
 * cut-off is tried. Throws if a record cannot be a leaf at all.
 */
export function matchEvidenceRoot(
  records: EvidenceRecord[],
  committed: string,
  { at, maxCuts = 64 }: { at?: number; maxCuts?: number } = {},
): RootMatch | null {
  if (!HASH.test(committed)) return null;
  const want = committed.toLowerCase();
  const asServed = records.map((r) => evidenceLeaf(r));
  const signed = records.map((r) => r.outcomeSource === 'payer_signed');
  const unsetLeaves = records.map((r, i) => (signed[i] ? evidenceLeaf(r, null) : asServed[i]));
  const cuts = at !== undefined
    ? [Number(at)]
    : [Infinity, ...[...new Set(records.map((r) => Number(r.settledAt)))].sort((a, b) => b - a).slice(0, maxCuts)];
  for (const cut of cuts) {
    const indexes = records.map((r, i) => (Number(r.settledAt) <= cut ? i : -1)).filter((i) => i >= 0);
    const tries: [string[], boolean][] = [[asServed, false]];
    if (indexes.some((i) => signed[i])) tries.push([unsetLeaves, true]);
    for (const [leaves, unset] of tries) {
      const picked = indexes.map((i) => leaves[i]);
      if (evidenceRoot(picked).toLowerCase() === want) return { indexes, leaves: picked, cut, unset };
    }
  }
  return null;
}
