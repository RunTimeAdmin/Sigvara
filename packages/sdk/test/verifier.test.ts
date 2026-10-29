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
const AUD = 'https://verifier.example';

describe('verifySignature pre-chain guards', () => {
  it('rejects a malformed challenge payload', async () => {
    expect(await verifier.verifySignature(DID_A, 'not-a-challenge', SIG, 300, AUD)).toBe(false);
  });

  it('rejects a challenge whose prover DID does not match', async () => {
    const c = generateChallenge(DID_A, AUD);
    expect(await verifier.verifySignature(DID_B, c.payload, SIG, 300, AUD)).toBe(false);
  });

  it('rejects an expired challenge (replay past its TTL)', async () => {
    // A v2 payload for this DID and this audience, so that only its age can refuse it.
    const staleTs = Math.floor(Date.now() / 1000) - 3600;
    const payload = ['SIGVARA-VERIFY-V2', `did: ${DID_A}`, `aud: ${AUD}`, 'nonce: deadbeef', `ts: ${staleTs}`].join('\n');
    expect(await verifier.verifySignature(DID_A, payload, SIG, 300, AUD)).toBe(false);
  });
});

describe('verifySignature requires the audience', () => {
  const payload = () => generateChallenge(DID_A, AUD).payload;
  const REQUIRED = /expectedAudience is required/;

  // Leaving the audience out used to skip the check of who the agent signed for, so a signature given to
  // one verifier was accepted at another. The first line of defence is that such a call does not compile.
  // The casts below stand in for JavaScript callers and for code that went through `any`: they get this error
  // instead, thrown before the payload is read and before any chain call, so no call shape is accepted by
  // leaving the audience out.
  it('throws when the audience is left out', async () => {
    // @ts-expect-error the audience is a required argument
    await expect(verifier.verifySignature(DID_A, payload(), SIG)).rejects.toThrow(REQUIRED);
  });

  it('throws for the old four-argument call that passed only a lifetime', async () => {
    // @ts-expect-error the audience is a required argument
    await expect(verifier.verifySignature(DID_A, payload(), SIG, 300)).rejects.toThrow(REQUIRED);
  });

  it('throws for an empty audience', async () => {
    await expect(verifier.verifySignature(DID_A, payload(), SIG, 300, '')).rejects.toThrow(REQUIRED);
  });

  it('throws for an audience that is not a string', async () => {
    await expect(verifier.verifySignature(DID_A, payload(), SIG, 300, 7 as unknown as string)).rejects.toThrow(REQUIRED);
  });

  it('takes undefined in place of the lifetime and keeps the default of 300 seconds', async () => {
    // A payload 200 seconds old is inside the default, so it gets past the age check and on to the
    // chain read, which cannot be dialed here: rejected, not a quiet false.
    const ts = Math.floor(Date.now() / 1000) - 200;
    const p = ['SIGVARA-VERIFY-V2', `did: ${DID_A}`, `aud: ${AUD}`, 'nonce: deadbeef', `ts: ${ts}`].join('\n');
    await expect(verifier.verifySignature(DID_A, p, SIG, undefined, AUD)).rejects.toThrow();
  });

  it('refuses a payload addressed to another verifier, without reading the chain', async () => {
    // The relay this closes: a signature the agent gave to somebody else, presented here.
    const forElsewhere = generateChallenge(DID_A, 'https://elsewhere.example').payload;
    expect(await verifier.verifySignature(DID_A, forElsewhere, SIG, 300, AUD)).toBe(false);
  });

  it('refuses a v1 payload, which names no audience to check', async () => {
    const v1 = `SIGVARA-VERIFY:${DID_A}:deadbeef:${Math.floor(Date.now() / 1000)}`;
    expect(await verifier.verifySignature(DID_A, v1, SIG, 300, AUD)).toBe(false);
  });
});

describe('verifySignature signature-width guard', () => {
  // The dummy RPC points at 127.0.0.1:0, which cannot be dialed, and the identity read
  // is not inside verifySignature's try/catch. So "resolved false" proves the guard
  // short-circuited before the chain, and "rejected" proves it did not. That asymmetry
  // is what makes these boundary assertions mean something.
  const fresh = () => generateChallenge(DID_A, AUD).payload;

  it('rejects a signature too short to be 64 bytes, without reading the chain', async () => {
    expect(await verifier.verifySignature(DID_A, fresh(), '1'.repeat(63), 300, AUD)).toBe(false);
  });

  it('rejects an over-long signature, without reading the chain', async () => {
    // The case that motivated the guard: alphabet-valid, arbitrarily long, and it used
    // to buy an identity RPC and an unbounded BigInt decode before failing.
    expect(await verifier.verifySignature(DID_A, fresh(), 'z'.repeat(89), 300, AUD)).toBe(false);
    expect(await verifier.verifySignature(DID_A, fresh(), 'z'.repeat(5000), 300, AUD)).toBe(false);
  });

  it('lets both ends of the legal width through to the chain', async () => {
    // 64 is the all-zero degenerate, 88 the general case. Measured across the all-zero
    // and all-0xff vectors, every leading-zero prefix, and 20,000 random 64-byte values.
    // These must NOT be refused by width, so they reach the unreachable RPC and throw.
    await expect(verifier.verifySignature(DID_A, fresh(), '1'.repeat(64), 300, AUD)).rejects.toThrow();
    await expect(verifier.verifySignature(DID_A, fresh(), 'z'.repeat(88), 300, AUD)).rejects.toThrow();
  });
});
