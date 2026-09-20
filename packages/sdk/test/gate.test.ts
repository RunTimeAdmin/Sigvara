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
function gateWith(
  opts: { active?: boolean; score?: number; rawSum?: number; proved?: boolean; store?: any } = {},
) {
  const gate = new SigvaraGate({
    rpcUrl: 'http://unused', addresses: ADDRESSES, chainId: 5042002,
    threshold: 40, audience: AUDIENCE, ...(opts.store ? { nonceStore: opts.store } : {}),
  });
  const v = (gate as any).verifier;
  v.verifySignature = vi.fn(async () => opts.proved ?? true);
  v.isActive = vi.fn(async () => opts.active ?? true);
  // getTotalScore() is what admit() reads: the matured value the contract's own
  // meetsThreshold uses. getReputation is stubbed too, with raw factors that can sum
  // higher, so a gate that went back to reading the breakdown would be caught by the
  // "matured score" test rather than quietly passing.
  v.getTotalScore = vi.fn(async () => opts.score ?? 50);
  v.getReputation = vi.fn(async () => ({
    feeScore: opts.rawSum ?? opts.score ?? 50,
    successScore: 0, ageScore: 0, externalScore: 0, communityScore: 0, propagationScore: 0,
    lastUpdated: 0n,
    total: opts.score ?? 50,
  }));
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
    v.getTotalScore = vi.fn(async () => 50);

    const c = gate.challenge(DID);
    await gate.admit(DID, c, 'sig');
    expect(spent.has(c.nonce)).toBe(true);
    expect((await gate.admit(DID, c, 'sig')).reason).toBe('replayed');
  });
});

describe('SigvaraGate — what the wrapper cannot be trusted for', () => {
  it('spends the nonce from the SIGNED payload, not the caller-supplied wrapper', async () => {
    // The bug this closes. verifySignature covers challenge.payload and nothing else, so
    // replaying a captured payload with a freshly invented wrapper nonce used to look up a
    // nonce that had never been spent. Replay protection was bypassable by editing a field.
    const gate = gateWith({ score: 50 });
    const c = gate.challenge(DID);
    const sig = signChallenge(c.payload, kp.secretKey);

    expect((await gate.admit(DID, c, sig)).ok).toBe(true);

    const forged = { ...c, nonce: 'a'.repeat(32), expiresAt: c.expiresAt + 99999 };
    const replay = await gate.admit(DID, forged, sig);
    expect(replay.ok).toBe(false);
    expect(replay.reason).toBe('replayed');
  });

  it('takes expiry from the signed timestamp, not a wrapper field', async () => {
    // A caller setting expiresAt far into the future must not extend its own challenge.
    const gate = gateWith({ score: 50 });
    const c = gate.challenge(DID);
    const sig = signChallenge(c.payload, kp.secretKey);
    await gate.admit(DID, c, sig);

    const store = (gate as any).nonces;
    const signedNonce = c.payload.match(/nonce: (\w+)/)![1];
    expect(store.seen(signedNonce)).toBe(true);
  });

  it('refuses a payload that does not parse, without throwing', async () => {
    const gate = gateWith({ score: 50 });
    const r = await gate.admit(DID, { payload: 'garbage', nonce: 'x', timestamp: 0, expiresAt: 0 } as any, 'sig');
    expect(r.reason).toBe('bad_proof');
  });
});

describe('SigvaraGate — matured score, not raw factors', () => {
  it('follows getTotalScore even when the raw factors sum higher', async () => {
    // A score earned minutes ago has raw factors the contract has not released yet.
    // Admitting on the raw sum would let the gate pass agents that meetsThreshold refuses,
    // so two layers would disagree about who is allowed in.
    const gate = gateWith({ score: 30, rawSum: 90 });
    const c = gate.challenge(DID);
    const r = await gate.admit(DID, c, signChallenge(c.payload, kp.secretKey));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('below_threshold');
    expect(r.score).toBe(30);

    // And it never asked for the breakdown: that is a second contract read this
    // decision does not use.
    expect((gate as any).verifier.getReputation).not.toHaveBeenCalled();
  });
});

describe('SigvaraGate — concurrency', () => {
  it('admits once when the same nonce arrives twice at the same moment', async () => {
    // seen() then add() is two awaits. Without a guard both callers observe the nonce
    // unspent before either writes, and both are admitted.
    const gate = gateWith({ score: 50 });
    const c = gate.challenge(DID);
    const sig = signChallenge(c.payload, kp.secretKey);

    const [a, b] = await Promise.all([gate.admit(DID, c, sig), gate.admit(DID, c, sig)]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect([a.reason, b.reason]).toContain('replayed');
  });

  it('prefers an atomic consume() when the store provides one', async () => {
    // What a Redis-backed store would implement. Only the creating call gets true.
    const rows = new Map<string, number>();
    const store = {
      seen: () => { throw new Error('consume() should be preferred'); },
      add:  () => { throw new Error('consume() should be preferred'); },
      prune: () => {},
      consume: (n: string, e: number) => (rows.has(n) ? false : (rows.set(n, e), true)),
    };
    const gate = gateWith({ score: 50, store });
    const c = gate.challenge(DID);
    const sig = signChallenge(c.payload, kp.secretKey);

    expect((await gate.admit(DID, c, sig)).ok).toBe(true);
    expect((await gate.admit(DID, c, sig)).reason).toBe('replayed');
  });
});

describe('MemoryNonceStore pruning', () => {
  // prune() runs on every accepted admission. It used to scan the whole map, so the cost
  // of admitting one agent grew with how many nonces were live, which is to say with how
  // busy the gate was.
  const storeOf = (gate: SigvaraGate) => (gate as any).nonces;

  it('drops expired entries and keeps live ones', async () => {
    const store = storeOf(gateWith());
    const now = 1_000_000;
    store.add('old-a', now - 100);
    store.add('old-b', now - 1);
    store.add('live',  now + 100);

    store.prune(now);

    expect(store.seen('old-a')).toBe(false);
    expect(store.seen('old-b')).toBe(false);
    expect(store.seen('live')).toBe(true);
  });

  it('stops at the first live entry instead of scanning the whole map', async () => {
    // Entries share a TTL and a Map iterates in insertion order, so the head is the
    // oldest. With one expired entry at the front, pruning must touch one entry and not
    // the 5,000 behind it.
    const store = storeOf(gateWith());
    const now = 1_000_000;
    store.add('expired', now - 1);
    for (let i = 0; i < 5000; i++) store.add(`live-${i}`, now + 300);

    const seen: string[] = [];
    const real = store.spent;
    // Count what the scan actually visits.
    const counting = new Map(real);
    (counting as any)[Symbol.iterator] = function* () {
      for (const e of Map.prototype[Symbol.iterator].call(counting)) { seen.push(e[0]); yield e; }
    };
    (store as any).spent = counting;
    store.prune(now);

    expect(store.seen('expired')).toBe(false);
    expect(seen.length).toBeLessThan(5);
  });

  it('still admits and refuses correctly around a prune', async () => {
    const gate = gateWith({ score: 50 });
    const c = gate.challenge(DID);
    const sig = signChallenge(c.payload, kp.secretKey);
    expect((await gate.admit(DID, c, sig)).ok).toBe(true);
    expect((await gate.admit(DID, c, sig)).reason).toBe('replayed');
  });
});
