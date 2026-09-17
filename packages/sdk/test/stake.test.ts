import { describe, it, expect, vi, beforeEach } from 'vitest';

// Fake ethers.Contract: records calls and serves canned responses so the
// helper's approve-then-deposit logic can be tested without a chain.
const calls: string[] = [];
let allowance = 0n;

vi.mock('ethers', () => {
  class FakeContract {
    constructor(public address: string, _abi: unknown, _signer: unknown) {}
    async svrToken() { calls.push('svrToken'); return '0xtoken'; }
    async allowance() { calls.push('allowance'); return allowance; }
    async approve(spender: string, amount: bigint) {
      calls.push(`approve:${spender}:${amount}`);
      return { wait: async () => ({ hash: '0xapprove' }) };
    }
    async depositStake(didHash: string, amount: bigint) {
      calls.push(`depositStake:${didHash}:${amount}`);
      return { wait: async () => ({ hash: '0xdeposit' }) };
    }
  }
  return { ethers: { Contract: FakeContract } };
});

import { depositStake } from '../src/stake';

const signer = { getAddress: async () => '0xoperator' } as any;

describe('depositStake', () => {
  beforeEach(() => { calls.length = 0; allowance = 0n; });

  it('approves the staking contract when allowance is short, then deposits', async () => {
    const res = await depositStake(signer, '0xdid', 1000n, '0xstaking');
    expect(calls).toEqual([
      'svrToken',
      'allowance',
      'approve:0xstaking:1000',
      'depositStake:0xdid:1000',
    ]);
    expect(res).toEqual({ txHash: '0xdeposit', approveTxHash: '0xapprove' });
  });

  it('skips approval when the allowance already covers the amount', async () => {
    allowance = 5000n;
    const res = await depositStake(signer, '0xdid', 1000n, '0xstaking');
    expect(calls).toEqual(['svrToken', 'allowance', 'depositStake:0xdid:1000']);
    expect(res).toEqual({ txHash: '0xdeposit', approveTxHash: undefined });
  });

  it('rejects a zero amount before touching the chain', async () => {
    await expect(depositStake(signer, '0xdid', 0n, '0xstaking')).rejects.toThrow('positive');
    expect(calls).toEqual([]);
  });
});
