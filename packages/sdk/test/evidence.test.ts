import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ethers } from 'ethers';
import {
  evidenceLeaf, evidenceLayers, evidenceProof, evidenceRoot, hashPair, matchEvidenceRoot, outcomeCode, ZERO_ROOT,
} from '../src/evidence';
import type { EvidenceRecord } from '../src/evidence';

/**
 * The fixture in test/SigvaraReputation.t.sol is what the contract's own MerkleProof check is tested against, and
 * scripts/check-evidence-fixture.mjs holds it to oracle/merkle.js in CI. Matching it here puts the SDK, the oracle
 * and the contract on one leaf encoding, pair order and odd-node rule. These are the payments the script builds it
 * from, as /evidence serves them: settledAt in seconds.
 */
const FIXTURE: EvidenceRecord[] = [
  { txHash: `0x${'11'.repeat(32)}`, payer: `0x${'a1'.repeat(20)}`, amount: '1000000', settledAt: 1_700_000_000, success: true },
  { txHash: `0x${'22'.repeat(32)}`, payer: `0x${'b2'.repeat(20)}`, amount: '2500000', settledAt: 1_700_086_400, success: true },
  { txHash: `0x${'33'.repeat(32)}`, payer: `0x${'c3'.repeat(20)}`, amount: '750000', settledAt: 1_700_172_800, success: false },
];

function solidityFixture() {
  const sol = readFileSync(join(__dirname, '..', '..', '..', 'test', 'SigvaraReputation.t.sol'), 'utf8');
  const constant = (name: string) => sol.match(new RegExp(`${name}\\s*=\\s*(0x[0-9a-fA-F]{64})`))![1].toLowerCase();
  return {
    root: constant('EV_ROOT'),
    leaves: [constant('EV_LEAF0'), constant('EV_LEAF1'), constant('EV_LEAF2')],
    node01: sol.match(/p\[0\] = (0x[0-9a-fA-F]{64});/)![1].toLowerCase(),
  };
}

describe('evidence roots', () => {
  it('rebuild the contract test\'s fixture: leaves, root and the promoted odd node', () => {
    const want = solidityFixture();
    const leaves = FIXTURE.map((r) => evidenceLeaf(r));
    expect(leaves).toEqual(want.leaves);
    expect(evidenceRoot(leaves)).toBe(want.root);
    const layers = evidenceLayers(leaves);
    expect(hashPair(leaves[0], leaves[1])).toBe(want.node01);
    // The third leaf has no sibling at the bottom, so it is promoted, and its proof is the first pair's parent.
    expect(evidenceProof(layers, 2)).toEqual([want.node01]);
    for (let i = 0; i < leaves.length; i++) {
      const folded = evidenceProof(layers, i).reduce((acc, sibling) => hashPair(acc, sibling), leaves[i]);
      expect(folded).toBe(want.root);
    }
  });

  it('encode three outcomes, so a payment nobody judged is not a failed one', () => {
    expect([outcomeCode(true), outcomeCode(false), outcomeCode(null)]).toEqual([1, 0, 2]);
    expect(evidenceLeaf({ ...FIXTURE[0], success: null })).not.toBe(evidenceLeaf({ ...FIXTURE[0], success: false }));
  });

  it('give the zero root for no payments, which the contract reads as none', () => {
    expect(evidenceRoot([])).toBe(ZERO_ROOT);
    expect(evidenceLayers([])).toEqual([]);
  });

  it('refuse a payment no oracle could have committed to', () => {
    expect(() => evidenceLeaf({ ...FIXTURE[0], txHash: '0x12' })).toThrow(/transaction hash/);
    expect(() => evidenceLeaf({ ...FIXTURE[0], payer: 'nobody' })).toThrow(/payer/);
    expect(() => evidenceLeaf({ ...FIXTURE[0], amount: '-1' })).toThrow(/out of range/);
    expect(() => evidenceLeaf({ ...FIXTURE[0], settledAt: 1.5 })).toThrow(/whole number/);
    expect(() => evidenceLeaf({ ...FIXTURE[0], amount: (1n << 256n).toString() })).toThrow(/out of range/);
  });

  it('accept the payer in any case, since the leaf commits to the address and not its spelling', () => {
    const upper = { ...FIXTURE[0], payer: ethers.getAddress(FIXTURE[0].payer) };
    expect(evidenceLeaf(upper)).toBe(evidenceLeaf(FIXTURE[0]));
  });
});

describe('matchEvidenceRoot', () => {
  const root = (records: EvidenceRecord[]) => evidenceRoot(records.map((r) => evidenceLeaf(r)));

  it('finds every payment listed', () => {
    const m = matchEvidenceRoot(FIXTURE, root(FIXTURE))!;
    expect(m).toMatchObject({ indexes: [0, 1, 2], cut: Infinity, unset: false });
  });

  it('finds the payments settled by the time of a proposal, when more came after', () => {
    const m = matchEvidenceRoot(FIXTURE, root(FIXTURE.slice(0, 2)))!;
    expect(m.indexes).toEqual([0, 1]);
    expect(m.cut).toBe(1_700_086_400);
    // With the proposal's time, only that cut-off is tried.
    expect(matchEvidenceRoot(FIXTURE, root(FIXTURE.slice(0, 2)), { at: 1_700_100_000 })!.indexes).toEqual([0, 1]);
    expect(matchEvidenceRoot(FIXTURE, root(FIXTURE.slice(0, 2)), { at: 1_700_000_000 })).toBeNull();
  });

  it('reads an outcome the payer signed after the proposal as not yet reported', () => {
    const later = FIXTURE.map((r, i) => (i === 2 ? { ...r, outcomeSource: 'payer_signed' } : r));
    const committed = root(later.map((r, i) => (i === 2 ? { ...r, success: null } : r)));
    const m = matchEvidenceRoot(later, committed)!;
    expect(m).toMatchObject({ indexes: [0, 1, 2], unset: true });
    // An outcome a credential holder gave is never read back: it was there when the proposal was made.
    expect(matchEvidenceRoot(FIXTURE, committed)).toBeNull();
  });

  it('finds nothing for a root no reading reproduces', () => {
    expect(matchEvidenceRoot(FIXTURE, `0x${'99'.repeat(32)}`)).toBeNull();
    expect(matchEvidenceRoot(FIXTURE, 'not a hash')).toBeNull();
  });
});

describe('a payment that settled on a payment chain', () => {
  // The vector oracle/payment-chains.test.js pins to oracle/merkle.js, as /evidence would serve it.
  const VECTOR: EvidenceRecord = {
    chainId: 84532, txHash: `0x${'ab'.repeat(32)}`, payer: `0x${'11'.repeat(20)}`, amount: '1000000', settledAt: 1_700_000_000, success: null,
  };
  const root = (records: EvidenceRecord[]) => evidenceRoot(records.map((r) => evidenceLeaf(r)));
  const arc = (settledAt: number): EvidenceRecord => ({ ...FIXTURE[0], settledAt });
  const base = (settledAt: number, tx: string): EvidenceRecord => ({ ...VECTOR, txHash: `0x${tx.repeat(32)}`, settledAt });

  it('has the leaf the oracle pins, with its chain first, and the scored chain\'s leaf stays as it was', () => {
    expect(evidenceLeaf(VECTOR)).toBe('0x103dc346c3ba80385b6ece79600032b4a0af08aabdc9df0a63903f7e39ff4036');
    const { chainId, ...onScoredChain } = VECTOR;
    expect(evidenceLeaf(onScoredChain)).toBe('0xe5b9c0e3fd34ce7bf8d3c33f2ca52a295e71bd23366ddbf6d79f369e79c1adfb');
    expect(evidenceLeaf({ ...onScoredChain, chainId: null })).toBe(evidenceLeaf(onScoredChain));
    const inner = ethers.AbiCoder.defaultAbiCoder().encode(
      ['uint256', 'bytes32', 'address', 'uint256', 'uint256', 'uint8'],
      [chainId, VECTOR.txHash, ethers.getAddress(VECTOR.payer), 1_000_000n, 1_700_000_000n, 2],
    );
    expect(evidenceLeaf(VECTOR)).toBe(ethers.keccak256(ethers.keccak256(inner)));
  });

  it('refuses a chain id that is not one', () => {
    for (const chainId of [-1, 0, 1.5, '84532' as unknown as number]) {
      expect(() => evidenceLeaf({ ...VECTOR, chainId }), String(chainId)).toThrow(/chain id/);
    }
  });

  it('counts for a cut-off only once its delay has passed', () => {
    const t = 1_700_000_000;
    const list = [arc(t), base(t - 7200, 'cc'), base(t - 1800, 'dd')];
    // A proposal at t held the Arc payment and the Base payment old enough by then, and not the younger one.
    const committed = root(list.slice(0, 2));
    const delays = { 84532: 3600 };
    expect(matchEvidenceRoot(list, committed, { at: t, delays })!.indexes).toEqual([0, 1]);
    expect(matchEvidenceRoot(list, committed, { delays })!.indexes).toEqual([0, 1]);
    // Without the delay, the younger payment reads as settled by then, and no reading finds this root.
    expect(matchEvidenceRoot(list, committed, { at: t })).toBeNull();
  });

  it('tries the whole-minute cut-offs before a proposal, with evidenceCut, and at most maxCuts of them', () => {
    const minute = 1_700_000_040; // a whole minute
    const at = minute + 30;
    // The evidence was cut 4 minutes before the proposal, and a payment came just after the cut.
    const list = [arc(minute - 400), arc(minute - 200)];
    const committed = root(list.slice(0, 1));
    const evidenceCut = { quantumSeconds: 60, windowSeconds: 1800 };
    expect(matchEvidenceRoot(list, committed, { at })).toBeNull();
    expect(matchEvidenceRoot(list, committed, { at, evidenceCut })!.cut).toBe(minute - 240);
    expect(matchEvidenceRoot(list, committed, { at, evidenceCut, maxCuts: 2 })).toBeNull();
    // A window as wide as an answer likes costs no more than maxCuts rebuilds.
    expect(matchEvidenceRoot(list, `0x${'99'.repeat(32)}`, { at, evidenceCut: { quantumSeconds: 1e-6, windowSeconds: 1e12 } })).toBeNull();
  });
});

describe('the leaf written out by hand', () => {
  it('is the ABI coder\'s encoding, for any payment', () => {
    for (let i = 0; i < 200; i++) {
      const r: EvidenceRecord = {
        txHash: ethers.hexlify(ethers.randomBytes(32)),
        payer: ethers.Wallet.createRandom().address,
        amount: i % 7 === 0 ? ((1n << 256n) - 1n).toString() : BigInt(ethers.hexlify(ethers.randomBytes(1 + (i % 32)))).toString(),
        settledAt: i % 5 === 0 ? 0 : 1_700_000_000 + i,
        success: [true, false, null][i % 3] as boolean | null,
      };
      const inner = ethers.AbiCoder.defaultAbiCoder().encode(
        ['bytes32', 'address', 'uint256', 'uint256', 'uint8'],
        [r.txHash, r.payer, BigInt(r.amount), BigInt(r.settledAt), outcomeCode(r.success)],
      );
      expect(evidenceLeaf(r), `case ${i}`).toBe(ethers.keccak256(ethers.keccak256(inner)));
    }
  });
});
