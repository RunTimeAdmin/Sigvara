import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ethers } from 'ethers';
import {
  signPaymentOutcome,
  verifyPaymentOutcome,
  paymentOutcomeDomain,
  PAYMENT_OUTCOME_TYPES,
  OUTCOME_DELIVERED,
  type SignedPaymentOutcome,
} from '../src/outcome';

// The cases the oracle and test/PaymentOutcome.t.sol are held to as well.
const vectors = JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'test', 'vectors', 'payment-outcome.json'), 'utf8'));
const deployment = { chainId: vectors.domain.chainId, reputationAddress: vectors.domain.verifyingContract };
const keyOf = (name: string) => ethers.keccak256(ethers.toUtf8Bytes(`sigvara/payment-outcome/vector/${name}`));
const wallet = (name: string) => new ethers.Wallet(keyOf(name));
const ERC1271 = new ethers.Interface(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)']);

type Account = { kind: string; owner: string } | null;

/**
 * A node holding the vectors' smart account, answering as the Solidity test's accounts do. Every read
 * must be at `block`, and a call must go to the account.
 */
function vectorNode(account: Account, block: ethers.BlockTag | undefined) {
  return {
    getCode: async (address: string, blockTag: ethers.BlockTag) => {
      expect(blockTag).toBe(block);
      return account && address.toLowerCase() === vectors.addresses.account.toLowerCase() ? '0x6080' : '0x';
    },
    call: async ({ to, data, blockTag }: { to?: string | null; data?: string | null; blockTag?: ethers.BlockTag }) => {
      expect(blockTag).toBe(block);
      expect(String(to).toLowerCase()).toBe(vectors.addresses.account.toLowerCase());
      const [hash, signature] = ERC1271.decodeFunctionData('isValidSignature', data!);
      let yes = false;
      try {
        yes = ethers.recoverAddress(hash, signature) === account!.owner;
      } catch { /* not a signature */ }
      const word = `${yes ? '0x1626ba7e' : '0xffffffff'}${'0'.repeat(56)}`;
      if (account!.kind === 'longer') return `${word}${'0'.repeat(63)}1`;
      if (account!.kind === 'short') return word.slice(0, 10);
      return word;
    },
  } as unknown as Pick<ethers.Provider, 'getCode' | 'call'>;
}

const outcomeOf = (c: { message: Record<string, unknown>; signature: string }): SignedPaymentOutcome => ({
  payer: c.message.payer as string,
  outcome: c.message.outcome as 1 | 2,
  evidence: c.message.evidence as string,
  signedAt: c.message.signedAt as number,
  deadline: c.message.deadline as number,
  signature: c.signature,
});

describe('the payment outcome type and domain', () => {
  it('are the ones ADR 0006 defines', () => {
    expect(ethers.TypedDataEncoder.from(PAYMENT_OUTCOME_TYPES).encodeType('PaymentOutcome')).toBe(vectors.typeString);
    expect(ethers.TypedDataEncoder.hashDomain(paymentOutcomeDomain(deployment))).toBe(vectors.domainSeparator);
  });
});

describe('signPaymentOutcome', () => {
  it('signs every vector the way its key does', async () => {
    let signed = 0;
    for (const c of vectors.cases) {
      if (!c.signedBy) continue;
      const out = await signPaymentOutcome(wallet(c.signedBy), {
        chainId: c.signedUnder.chainId,
        reputationAddress: c.signedUnder.verifyingContract,
        didHash: c.message.didHash,
        txHash: c.message.txHash,
        outcome: c.message.outcome,
        evidence: c.message.evidence,
        payer: c.message.payer,
        signedAt: c.message.signedAt,
        deadline: c.message.deadline,
      });
      expect(out, c.name).toEqual(outcomeOf(c));
      signed += 1;
    }
    expect(signed).toBe(vectors.cases.length - 1);
  });

  it('defaults to the signer as payer, now, a day\'s deadline and no evidence', async () => {
    const payer = ethers.Wallet.createRandom();
    const before = Math.floor(Date.now() / 1000);
    const out = await signPaymentOutcome(payer, {
      ...deployment, didHash: ethers.id('agent'), txHash: ethers.id('tx'), outcome: OUTCOME_DELIVERED,
    });
    expect(out.payer).toBe(payer.address);
    expect(out.signedAt).toBeGreaterThanOrEqual(before);
    expect(out.deadline - out.signedAt).toBe(86_400);
    expect(out.evidence).toBe(ethers.ZeroHash);
    expect(await verifyPaymentOutcome({
      ...deployment, didHash: ethers.id('agent'), txHash: ethers.id('tx'), payerOutcome: out, provider: vectorNode(null, undefined),
    })).toEqual({ valid: true, signer: 'eoa' });
  });

  it('rewrites a v of 0 or 1 to what OpenZeppelin takes, and refuses a signature that is not the payer\'s', async () => {
    const payer = ethers.Wallet.createRandom();
    const opts = { ...deployment, didHash: ethers.id('agent'), txHash: ethers.id('tx'), outcome: OUTCOME_DELIVERED as 1 };
    // A wallet that answers with v 0 or 1, as some hardware wallets do.
    const low = {
      getAddress: async () => payer.address,
      signTypedData: async (...a: Parameters<ethers.Wallet['signTypedData']>) => {
        const bytes = ethers.getBytes(await payer.signTypedData(...a));
        bytes[64] -= 27;
        return ethers.hexlify(bytes);
      },
    };
    const out = await signPaymentOutcome(low, opts);
    expect([27, 28]).toContain(ethers.getBytes(out.signature)[64]);
    expect(await verifyPaymentOutcome({ ...opts, payerOutcome: out, provider: vectorNode(null, undefined) }))
      .toEqual({ valid: true, signer: 'eoa' });
    const wrongKey = { getAddress: async () => payer.address, signTypedData: (...a: Parameters<ethers.Wallet['signTypedData']>) => ethers.Wallet.createRandom().signTypedData(...a) };
    await expect(signPaymentOutcome(wrongKey, opts)).rejects.toThrow(/does not recover to the payer/);
  });

  it('signs with types nobody can change', () => {
    expect(Object.isFrozen(PAYMENT_OUTCOME_TYPES)).toBe(true);
    expect(Object.isFrozen(PAYMENT_OUTCOME_TYPES.PaymentOutcome)).toBe(true);
    expect(Object.isFrozen(PAYMENT_OUTCOME_TYPES.PaymentOutcome[3])).toBe(true);
  });

  it('refuses what no oracle would take', async () => {
    const payer = ethers.Wallet.createRandom();
    const ok = { ...deployment, didHash: ethers.id('agent'), txHash: ethers.id('tx'), outcome: OUTCOME_DELIVERED as 1, signedAt: 1_000 };
    await expect(signPaymentOutcome(payer, { ...ok, outcome: 3 as 1 })).rejects.toThrow(/outcome must be/);
    await expect(signPaymentOutcome(payer, { ...ok, didHash: '0x12' })).rejects.toThrow(/didHash/);
    await expect(signPaymentOutcome(payer, { ...ok, evidence: 'x' })).rejects.toThrow(/evidence/);
    await expect(signPaymentOutcome(payer, { ...ok, deadline: 1_000 })).rejects.toThrow(/deadline/);
    await expect(signPaymentOutcome(payer, { ...ok, deadline: 1_000 + 30 * 86_400 + 1 })).rejects.toThrow(/30 days/);
    await expect(signPaymentOutcome(payer, { ...ok, signedAt: 1.5 })).rejects.toThrow(/signedAt/);
  });
});

describe('verifyPaymentOutcome', () => {
  it('gives every vector OpenZeppelin\'s verdict', async () => {
    const offChain = vectors.cases.filter((c: { onChainOnly?: boolean }) => !c.onChainOnly);
    expect(offChain.length).toBeGreaterThanOrEqual(11);
    for (const c of offChain) {
      const verdict = await verifyPaymentOutcome({
        ...deployment,
        didHash: c.message.didHash,
        txHash: c.message.txHash,
        payerOutcome: outcomeOf(c),
        provider: vectorNode(c.account, 1),
        blockTag: 1,
      });
      expect(verdict, c.name).toEqual({ valid: c.valid, signer: c.account ? 'contract' : 'eoa' });
    }
  });

  it('needs a provider: whether the payer has code decides how it is checked', async () => {
    const eoa = vectors.cases.find((c: { name: string }) => c.name === 'eoa_delivered');
    await expect(verifyPaymentOutcome({
      ...deployment, didHash: eoa.message.didHash, txHash: eoa.message.txHash, payerOutcome: outcomeOf(eoa),
    } as Parameters<typeof verifyPaymentOutcome>[0])).rejects.toThrow(/provider is required/);
  });

  it('reads a missing evidence as zero, as the oracle does', async () => {
    const eoa = vectors.cases.find((c: { name: string }) => c.name === 'eoa_delivered');
    const { evidence: _zero, ...rest } = outcomeOf(eoa);
    expect(await verifyPaymentOutcome({
      ...deployment, didHash: eoa.message.didHash, txHash: eoa.message.txHash,
      payerOutcome: rest as SignedPaymentOutcome, provider: vectorNode(null, undefined),
    })).toEqual({ valid: true, signer: 'eoa' });
  });

  it('reads a revert as the account\'s no, and a node that cannot answer as an error', async () => {
    const c = vectors.cases.find((x: { name: string }) => x.name === 'contract_owner');
    const node = (fail: () => never) => ({ getCode: async () => '0x6080', call: async () => fail() }) as unknown as Pick<ethers.Provider, 'getCode' | 'call'>;
    const run = (fail: () => never) => verifyPaymentOutcome({
      ...deployment, didHash: c.message.didHash, txHash: c.message.txHash, payerOutcome: outcomeOf(c), provider: node(fail),
    });
    const callError = (message: string) => () => {
      throw Object.assign(new Error('call failed'), { code: 'CALL_EXCEPTION', info: { error: { message } } });
    };
    expect(await run(callError('execution reverted'))).toEqual({ valid: false, signer: 'contract' });
    await expect(run(callError('header not found'))).rejects.toThrow(/could not ask/);
    await expect(run(() => { throw new Error('socket hang up'); })).rejects.toThrow(/could not ask/);
  });

  it('refuses an outcome that is not shaped as one', async () => {
    const c = vectors.cases[0];
    const run = (payerOutcome: unknown) => verifyPaymentOutcome({
      ...deployment, didHash: c.message.didHash, txHash: c.message.txHash, payerOutcome: payerOutcome as SignedPaymentOutcome,
      provider: vectorNode(null, undefined),
    });
    await expect(run({ ...outcomeOf(c), payer: 'nobody' })).rejects.toThrow(TypeError);
    await expect(run({ ...outcomeOf(c), signature: 'ab' })).rejects.toThrow(/signature/);
    await expect(run({ ...outcomeOf(c), signature: '0x' })).rejects.toThrow(/signature/);
    // The oracle refuses a signature over 4096 bytes before asking anything, so this does too.
    await expect(run({ ...outcomeOf(c), signature: `0x${'ab'.repeat(4097)}` })).rejects.toThrow(/at most 4096/);
    await expect(run(undefined)).rejects.toThrow(TypeError);
  });
});
