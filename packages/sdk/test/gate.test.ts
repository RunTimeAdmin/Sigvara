import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SigvaraGate } from '../src/gate';
import { signChallenge } from '../src/challenge';
import { seedToKeyPair } from '../src/keys';

const ADDRESSES = {
  identity: '0x7e3aFC532eE5d922ab3cc3FFb510c7C8151477Dd',
  reputation: '0x6603C96275e85F724Cdf74666b399365e4cA29ed',
  staking: '0xA69d62B2a6774D21A2c15d5d83b27277eD31d35B',
};
const DID = 'did:sigvara:5042002:0x0000000000000000000000000000000000000001';
const AUDIENCE = 'https://tools.example';

/**
 * The chain is stubbed on the verifier, not mocked at the RPC layer. The gate's logic is
 * the order it asks questions in and the reason it gives when it refuses; the contract
 * reads are SigvaraVerifier's job and are tested there.
 */
function gateWith(opts: { active?: boolean; score?: number; proved?: boolean } = {}) {
  const gate = new SigvaraGate({
    rpcUrl: 'http://unused', addresses: ADDRESSES, chainId: 5042002,
    threshold: 40, audience: AUDIENCE,
  });
  const v = (gate as any).verifier;
  v.verifySignature = vi.fn(async () => opts.proved ?? true);
  v.isActive = vi.fn(async () => opts.active ?? true);
  v.getReputation = vi.fn(async () => {
    const s = opts.score ?? 50;
    return {
      feeScore: s, successScore: 0, ageScore: 0,
      externalScore: 0, communityScore: 0, propagationScore: 0, lastUpdated: 0n,
    };
  });
  return gate;
}

const kp = seedToKeyPair(new Uint8Array(32).fill(3));

describe('SigvaraGate', () => {
  it('admits an active agent over the threshold', async () => {
    const gate = gateWith({ score: 50 });
    const c = gate.challenge(DID);
    const r = await gate.admit(DID, c, signChallenge(c.payload, kp.secretKey));
    expect(r).toEqual({ ok: true, score: 50, threshold: 40, did: DID });
  });

  it('refuses below the threshold, and says the score', async () => {
    // The only refusal that is actually about reputation. The caller can act on it.
    const gate = gateWith({ score: 38 });
    const c = gate.challenge(DID);
    const r = await gate.admit(DID, c, signChallenge(c.payload, kp.secretKey));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('below_threshold');
    expect(r.score).toBe(38);
  });

  it('refuses an inactive agent on standing, not on score', async () => {
    // A slashed or unbonded agent reported as below_threshold would send the caller off
    // to earn points, which is not the fix.
    const gate = gateWith({ active: false, score: 90 });
    const c = gate.challenge(DID);
    const r = await gate.admit(DID, c, signChallenge(c.payload, kp.secretKey));
    expect(r.reason).toBe('not_active');
  });

  it('refuses a bad proof without touching the chain', async () => {
    // An unauthenticated caller must not be able to make the gate do RPC work.
    const gate = gateWith({ proved: false });
    const v = (gate as any).verifier;
    const c = gate.challenge(DID);
    const r = await gate.admit(DID, c, 'nonsense');
    expect(r.reason).toBe('bad_proof');
    expect(v.isActive).not.toHaveBeenCalled();
    expect(v.getReputation).not.toHaveBeenCalled();
  });

  it('refuses a replayed nonce', async () => {
    // The gap the README used to hand to the integrator. verifySignature has no memory,
    // so without this a captured response works until the challenge expires.
    const gate = gateWith({ score: 50 });
    const c = gate.challenge(DID);
    const sig = signChallenge(c.payload, kp.secretKey);

    expect((await gate.admit(DID, c, sig)).ok).toBe(true);
    const second = await gate.admit(DID, c, sig);
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('replayed');
  });

  it('does not burn a nonce on a failed proof', async () => {
    // Otherwise anyone who observes a challenge can lock out its legitimate holder by
    // spending the nonce with garbage.
    const gate = gateWith({ proved: false });
    const c = gate.challenge(DID);
    await gate.admit(DID, c, 'nonsense');

    (gate as any).verifier.verifySignature = vi.fn(async () => true);
    const r = await gate.admit(DID, c, signChallenge(c.payload, kp.secretKey));
    expect(r.ok).toBe(true);
  });

  it('issues a fresh nonce per challenge and binds its own audience', async () => {
    const gate = gateWith();
    const a = gate.challenge(DID);
    const b = gate.challenge(DID);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.audience).toBe(AUDIENCE);
  });

  it('requires an audience at construction', () => {
    expect(() => new SigvaraGate({
      rpcUrl: 'http://unused', addresses: ADDRESSES, threshold: 40, audience: '',
    })).toThrow(/audience is required/);
  });

  it('passes its own audience to verifySignature, so a relayed proof fails', async () => {
    const gate = gateWith({ score: 50 });
    const v = (gate as any).verifier;
    const c = gate.challenge(DID);
    await gate.admit(DID, c, signChallenge(c.payload, kp.secretKey));
    expect(v.verifySignature).toHaveBeenCalledWith(
      DID, c.payload, expect.any(String), 300, AUDIENCE,
    );
  });

  it('accepts a custom nonce store, for gates behind a load balancer', async () => {
    // The in-memory default is per-process: two instances do not share a set, so a
    // response accepted by one replays at the other.
    const spent = new Set<string>();
    const gate = new SigvaraGate({
      rpcUrl: 'http://unused', addresses: ADDRESSES, threshold: 40, audience: AUDIENCE,
      nonceStore: {
        seen: (n) => spent.has(n),
        add: (n) => { spent.add(n); },
        prune: () => {},
      },
    });
    const v = (gate as any).verifier;
    v.verifySignature = vi.fn(async () => true);
    v.isActive = vi.fn(async () => true);
    v.getReputation = vi.fn(async () => ({
      feeScore: 50, successScore: 0, ageScore: 0,
      externalScore: 0, communityScore: 0, propagationScore: 0, lastUpdated: 0n,
    }));

    const c = gate.challenge(DID);
    await gate.admit(DID, c, 'sig');
    expect(spent.has(c.nonce)).toBe(true);
    expect((await gate.admit(DID, c, 'sig')).reason).toBe('replayed');
  });
});
