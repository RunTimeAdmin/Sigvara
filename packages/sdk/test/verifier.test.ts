import { describe, it, expect } from 'vitest';
import { SigvaraVerifier } from '../src/verifier';
import { generateChallenge } from '../src/challenge';

// These cases all short-circuit inside verifySignature BEFORE any on-chain call,
// so they run without a live RPC. The dummy config is never actually dialed.
const verifier = new SigvaraVerifier({
  rpcUrl: 'http://127.0.0.1:0',
  addresses: {
    identity: '0x0000000000000000000000000000000000000001',
    reputation: '0x0000000000000000000000000000000000000002',
    staking: '0x0000000000000000000000000000000000000003',
  },
  chainId: 5042002,
});

const DID_A = 'did:sigvara:5042002:0x00000000000000000000000000000000000000aa';
const DID_B = 'did:sigvara:5042002:0x00000000000000000000000000000000000000bb';
const SIG = '1'.repeat(64); // shape doesn't matter — rejected before verification

describe('verifySignature pre-chain guards', () => {
  it('rejects a malformed challenge payload', async () => {
    expect(await verifier.verifySignature(DID_A, 'not-a-challenge', SIG)).toBe(false);
  });

  it('rejects a challenge whose prover DID does not match', async () => {
    const c = generateChallenge(DID_A, 'https://verifier.example');
    expect(await verifier.verifySignature(DID_B, c.payload, SIG)).toBe(false);
  });

  it('rejects an expired challenge (replay past its TTL)', async () => {
    const staleTs = Math.floor(Date.now() / 1000) - 3600;
    const payload = `SIGVARA-VERIFY:${DID_A}:deadbeef:${staleTs}`;
    expect(await verifier.verifySignature(DID_A, payload, SIG, 300)).toBe(false);
  });
});

describe('verifySignature signature-width guard', () => {
  // The dummy RPC points at 127.0.0.1:0, which cannot be dialed, and the identity read
  // is not inside verifySignature's try/catch. So "resolved false" proves the guard
  // short-circuited before the chain, and "rejected" proves it did not. That asymmetry
  // is what makes these boundary assertions mean something.
  const fresh = () => generateChallenge(DID_A, 'https://verifier.example').payload;

  it('rejects a signature too short to be 64 bytes, without reading the chain', async () => {
    expect(await verifier.verifySignature(DID_A, fresh(), '1'.repeat(63))).toBe(false);
  });

  it('rejects an over-long signature, without reading the chain', async () => {
    // The case that motivated the guard: alphabet-valid, arbitrarily long, and it used
    // to buy an identity RPC and an unbounded BigInt decode before failing.
    expect(await verifier.verifySignature(DID_A, fresh(), 'z'.repeat(89))).toBe(false);
    expect(await verifier.verifySignature(DID_A, fresh(), 'z'.repeat(5000))).toBe(false);
  });

  it('lets both ends of the legal width through to the chain', async () => {
    // 64 is the all-zero degenerate, 88 the general case. Measured across the all-zero
    // and all-0xff vectors, every leading-zero prefix, and 20,000 random 64-byte values.
    // These must NOT be refused by width, so they reach the unreachable RPC and throw.
    await expect(verifier.verifySignature(DID_A, fresh(), '1'.repeat(64))).rejects.toThrow();
    await expect(verifier.verifySignature(DID_A, fresh(), 'z'.repeat(88))).rejects.toThrow();
  });
});
