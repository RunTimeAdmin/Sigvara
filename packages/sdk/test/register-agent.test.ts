import { describe, it, expect, vi, beforeEach } from 'vitest';

// ethers.Contract is replaced so registerAgent can be driven without a chain. Everything
// else in ethers is the real thing, including the Interface that decodes the event.
const calls: Array<[string, unknown[]]> = [];
let logs: Array<{ topics: string[]; data: string }> = [];
const DIGEST = '0x' + '11'.repeat(32);

vi.mock('ethers', async (importOriginal) => {
  const actual: any = await importOriginal();
  class FakeContract {
    constructor(public address: string, _abi: unknown, _signer: unknown) {}
    async registrationDigest(...args: unknown[]) { calls.push(['registrationDigest', args]); return DIGEST; }
    async registerAgent(...args: unknown[]) {
      calls.push(['registerAgent', args]);
      return { wait: async () => ({ hash: '0xreceipt', logs }) };
    }
  }
  return { ...actual, ethers: { ...actual.ethers, Contract: FakeContract } };
});

import { ethers } from 'ethers';
import { registerAgent } from '../src/verifier';
import { IDENTITY_ABI } from '../src/abis';

const OPERATOR = '0x00000000000000000000000000000000000000cc';
const AGENT = '0x00000000000000000000000000000000000000aa';
const KEY = '0x' + '22'.repeat(32);
const DID_HASH = '0x' + '33'.repeat(32);
const operatorSigner = { getAddress: async () => OPERATOR } as any;

const iface = new ethers.Interface(IDENTITY_ABI);
const registeredLog = () => {
  const ev = iface.getEvent('AgentRegistered')!;
  return iface.encodeEventLog(ev, [DID_HASH, OPERATOR, AGENT, KEY]);
};

describe('registerAgent', () => {
  beforeEach(() => { calls.length = 0; logs = []; });

  it('with an agent signer, signs the contract digest as raw bytes and registers', async () => {
    const signMessage = vi.fn(async () => '0xsig');
    logs = [registeredLog()];
    const res = await registerAgent(operatorSigner, AGENT, KEY, '0xidentity', { agentSigner: { signMessage } as any });

    expect(calls[0]).toEqual(['registrationDigest', [AGENT, OPERATOR, KEY]]);
    expect(signMessage).toHaveBeenCalledTimes(1);
    const arg = (signMessage.mock.calls[0] as unknown[])[0];
    expect(arg).toBeInstanceOf(Uint8Array);
    expect(ethers.hexlify(arg as Uint8Array)).toBe(DIGEST);
    expect(calls[1]).toEqual(['registerAgent', [AGENT, KEY, '0xsig']]);
    expect(res).toEqual({ didHash: DID_HASH, txHash: '0xreceipt' });
  });

  it('with a ready signature, skips the digest and passes it straight through', async () => {
    logs = [registeredLog()];
    const res = await registerAgent(operatorSigner, AGENT, KEY, '0xidentity', { signature: '0xprovided' });
    expect(calls.map((c) => c[0])).toEqual(['registerAgent']);
    expect(calls[0][1]).toEqual([AGENT, KEY, '0xprovided']);
    expect(res.didHash).toBe(DID_HASH);
  });

  it('skips logs it cannot decode and finds the registration among them', async () => {
    logs = [
      { topics: [ethers.id('Unrelated(uint256)')], data: '0x' },
      registeredLog(),
    ];
    const res = await registerAgent(operatorSigner, AGENT, KEY, '0xidentity', { signature: '0x' });
    expect(res.didHash).toBe(DID_HASH);
  });

  it('returns an empty didHash when the receipt carries no registration event', async () => {
    logs = [{ topics: [ethers.id('Unrelated(uint256)')], data: '0x' }];
    const res = await registerAgent(operatorSigner, AGENT, KEY, '0xidentity', { signature: '0x' });
    expect(res).toEqual({ didHash: '', txHash: '0xreceipt' });
  });
});
