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
