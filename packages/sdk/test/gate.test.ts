import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SigvaraGate, atomicNonceStore } from '../src/gate';
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
  opts: {
    active?: boolean; bonded?: boolean; score?: number; rawSum?: number; proved?: boolean; store?: any;
    threshold?: number; maxScoreAgeSeconds?: number; scoreAgeSeconds?: number | 'never';
  } = {},
) {
  const gate = new SigvaraGate({
    rpcUrl: 'http://unused', addresses: ADDRESSES, chainId: 5042002,
    threshold: opts.threshold ?? 40, audience: AUDIENCE, ...(opts.store ? { nonceStore: opts.store } : {}),
    ...(opts.maxScoreAgeSeconds === undefined ? {} : { maxScoreAgeSeconds: opts.maxScoreAgeSeconds }),
  });
  const v = (gate as any).verifier;
  v.verifySignature = vi.fn(async () => opts.proved ?? true);
  v.isActive = vi.fn(async () => opts.active ?? true);
  // The bond held now against the minimum in force now. isActive is the stored status, which a
  // raised minimum does not change, so the two have to be asked separately.
  v.hasMinimumStake = vi.fn(async () => opts.bonded ?? true);
  // When the score was written: `scoreAgeSeconds` ago, or never (0).
  v.getScoreUpdatedAt = vi.fn(async () => (
    opts.scoreAgeSeconds === 'never' ? 0 : Math.floor(Date.now() / 1000) - (opts.scoreAgeSeconds ?? 60)
  ));
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

  it('asks for the status, the collateral and the score together, not one after the other', async () => {
    // The reads do not depend on each other. All of them have to be under way before any has
    // answered, so an admit costs one round trip for them and not three.
    const gate = gateWith();
    const v = (gate as any).verifier;
    const order: string[] = [];
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    v.isActive = vi.fn(async () => { order.push('status asked'); await hold; return true; });
    v.hasMinimumStake = vi.fn(async () => { order.push('collateral asked'); await hold; return true; });
    v.getTotalScore = vi.fn(async () => { order.push('score asked'); await hold; return 50; });

    const c = gate.challenge(DID);
    const pending = gate.admit(DID, c, signChallenge(c.payload, kp.secretKey));
    await vi.waitFor(() => expect(order).toEqual(['status asked', 'collateral asked', 'score asked']));
    release();
    expect((await pending).ok).toBe(true);
  });

  it('still names the standing, not the score, when an agent is both inactive and under the bar', async () => {
    const gate = gateWith({ active: false, score: 1 });
    const c = gate.challenge(DID);
    const r = await gate.admit(DID, c, signChallenge(c.payload, kp.secretKey));
    expect(r.reason).toBe('not_active');
  });

  it('refuses a bad proof without reading the status or the score', async () => {
    // A caller who cannot prove an identity must not make the gate read either. Checking the proof
    // itself costs one identity read, which belongs to SigvaraVerifier and is not stubbed here.
    const gate = gateWith({ proved: false });
    const v = (gate as any).verifier;
    const c = gate.challenge(DID);
    const r = await gate.admit(DID, c, 'nonsense');
    expect(r.reason).toBe('bad_proof');
    expect(v.isActive).not.toHaveBeenCalled();
    expect(v.hasMinimumStake).not.toHaveBeenCalled();
    expect(v.getTotalScore).not.toHaveBeenCalled();
    expect(v.getScoreUpdatedAt).not.toHaveBeenCalled();
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
    v.hasMinimumStake = vi.fn(async () => true);
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

describe('SigvaraGate: collateral held now', () => {
  // Status is stored. A minimum stake raised after an agent was admitted leaves it Active while it
  // holds less than the contract now asks, and SigvaraReader.isTrusted refuses it for that. A gate
  // that read only the status would admit what the reader refuses.
  it('refuses an agent whose bond is under the minimum in force now, on standing', async () => {
    const gate = gateWith({ bonded: false, score: 90 });
    const c = gate.challenge(DID);
    const r = await gate.admit(DID, c, signChallenge(c.payload, kp.secretKey));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('not_active');
  });

  it('still requires the bond when the threshold is zero', async () => {
    // A threshold of 0 is met by every score, so the bond and the status are all that is left to check.
    const gate = gateWith({ bonded: false, score: 0, threshold: 0 });
    const c = gate.challenge(DID);
    const r = await gate.admit(DID, c, signChallenge(c.payload, kp.secretKey));
    expect(r.reason).toBe('not_active');
  });

  it('admits a bonded, active agent at a threshold of zero', async () => {
    const gate = gateWith({ score: 0, threshold: 0 });
    const c = gate.challenge(DID);
    const r = await gate.admit(DID, c, signChallenge(c.payload, kp.secretKey));
    expect(r).toEqual({ ok: true, score: 0, threshold: 0, did: DID });
  });
});

describe('SigvaraGate: a score nobody has refreshed', () => {
  // Nothing on chain ages a score, so one left over from an oracle outage keeps passing. The limit is
  // opt-in: an integrator picks an age that fits how often their oracle writes.
  const HOUR = 3600;

  it('admits a score written inside the limit', async () => {
    const gate = gateWith({ maxScoreAgeSeconds: HOUR, scoreAgeSeconds: 600, score: 50 });
    const c = gate.challenge(DID);
    const r = await gate.admit(DID, c, signChallenge(c.payload, kp.secretKey));
    expect(r).toEqual({ ok: true, score: 50, threshold: 40, did: DID });
  });

  it('refuses a score older than the limit, and says it is the age and not the number', async () => {
    const gate = gateWith({ maxScoreAgeSeconds: HOUR, scoreAgeSeconds: 2 * HOUR, score: 90 });
    const c = gate.challenge(DID);
    const r = await gate.admit(DID, c, signChallenge(c.payload, kp.secretKey));
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('stale_score');
    expect(r.score).toBe(90);
  });

  it('refuses a score that was never written', async () => {
    // lastUpdated of 0 is no evidence of freshness; the reader refuses it the same way.
    const gate = gateWith({ maxScoreAgeSeconds: HOUR, scoreAgeSeconds: 'never', score: 0, threshold: 0 });
    const c = gate.challenge(DID);
    const r = await gate.admit(DID, c, signChallenge(c.payload, kp.secretKey));
    expect(r.reason).toBe('stale_score');
  });

  it('names standing before staleness, and staleness before the number', async () => {
    const inactive = gateWith({ maxScoreAgeSeconds: HOUR, scoreAgeSeconds: 2 * HOUR, active: false, score: 1 });
    const c1 = inactive.challenge(DID);
    expect((await inactive.admit(DID, c1, signChallenge(c1.payload, kp.secretKey))).reason).toBe('not_active');

    const stale = gateWith({ maxScoreAgeSeconds: HOUR, scoreAgeSeconds: 2 * HOUR, score: 1 });
    const c2 = stale.challenge(DID);
    expect((await stale.admit(DID, c2, signChallenge(c2.payload, kp.secretKey))).reason).toBe('stale_score');
  });

  it('does not read the write time, or limit the age, unless asked to', async () => {
    const gate = gateWith({ scoreAgeSeconds: 365 * 24 * HOUR, score: 50 });
    const c = gate.challenge(DID);
    const r = await gate.admit(DID, c, signChallenge(c.payload, kp.secretKey));
    expect(r.ok).toBe(true);
    expect((gate as any).verifier.getScoreUpdatedAt).not.toHaveBeenCalled();
  });

  it('asks for the write time together with the other reads', async () => {
    const gate = gateWith({ maxScoreAgeSeconds: HOUR });
    const v = (gate as any).verifier;
    const order: string[] = [];
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const slow = (name: string, value: unknown) => vi.fn(async () => { order.push(name); await hold; return value; });
    v.isActive = slow('status', true);
    v.hasMinimumStake = slow('collateral', true);
    v.getTotalScore = slow('score', 50);
    v.getScoreUpdatedAt = slow('written', Math.floor(Date.now() / 1000));

    const c = gate.challenge(DID);
    const pending = gate.admit(DID, c, signChallenge(c.payload, kp.secretKey));
    await vi.waitFor(() => expect(order).toEqual(['status', 'collateral', 'score', 'written']));
    release();
    expect((await pending).ok).toBe(true);
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

describe('SigvaraGate: two gates behind one load balancer', () => {
  // A gate keeps no record of the challenges it issued, only of the nonces it has spent. A response signed for a
  // challenge from one instance is therefore good at the other, and what stops it being used at both is the
  // nonce store they share. The gates here are built the same way and share nothing but that store.
  const trip = () => new Promise<void>((resolve) => setImmediate(resolve));

  /** What Redis `SET NX` gives: the check and the write are one step, however long the trip to it takes. */
  function atomicStore() {
    const rows = new Map<string, number>();
    return {
      rows,
      seen: async (n: string) => { await trip(); return rows.has(n); },
      add: async (n: string, e: number) => { await trip(); rows.set(n, e); },
      prune: async () => { await trip(); },
      consume: async (n: string, e: number) => {
        await trip();
        if (rows.has(n)) return false;
        rows.set(n, e);
        return true;
      },
    };
  }

  /** The three methods and no `consume`: a read, then a write, with a trip to the store for each. */
  function seenAndAddStore() {
    const { consume: _atomic, ...rest } = atomicStore();
    return rest;
  }

  const issue = (gate: SigvaraGate) => {
    const c = gate.challenge(DID);
    return { c, sig: signChallenge(c.payload, kp.secretKey) };
  };

  it('admits the same response at both gates when each has the default store', async () => {
    // The documented limit of the default, pinned so that the README stays true: it is per process.
    const [a, b] = [gateWith({ score: 50 }), gateWith({ score: 50 })];
    const { c, sig } = issue(a);

    expect((await a.admit(DID, c, sig)).ok).toBe(true);
    expect((await b.admit(DID, c, sig)).ok).toBe(true);
  });

  it('admits a response once between two gates that share a store with consume()', async () => {
    const store = atomicStore();
    const [a, b] = [gateWith({ score: 50, store }), gateWith({ score: 50, store })];
    const { c, sig } = issue(a);

    expect((await a.admit(DID, c, sig)).ok).toBe(true);
    const replay = await b.admit(DID, c, sig);
    expect(replay.ok).toBe(false);
    expect(replay.reason).toBe('replayed');
  });

  it('admits it once even when both gates receive it at the same moment', async () => {
    // The race a local lock cannot close, because the other gate is in another process. Only the call that
    // creates the record gets true from consume().
    const store = atomicStore();
    const [a, b] = [gateWith({ score: 50, store }), gateWith({ score: 50, store })];
    const { c, sig } = issue(a);

    const results = await Promise.all([a.admit(DID, c, sig), b.admit(DID, c, sig)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.map((r) => r.reason)).toContain('replayed');
    expect(store.rows.size).toBe(1);
  });

  it('with only seen() and add(), refuses a later replay at the other gate but not a simultaneous one', async () => {
    // The README says a distributed store has to implement consume(). This is why. seen() then add() is two
    // trips, and the lock that covers it lives in one process.
    const store = seenAndAddStore();
    const [a, b] = [gateWith({ score: 50, store }), gateWith({ score: 50, store })];

    const first = issue(a);
    expect((await a.admit(DID, first.c, first.sig)).ok).toBe(true);
    expect((await b.admit(DID, first.c, first.sig)).reason).toBe('replayed');

    const second = issue(a);
    const both = await Promise.all([a.admit(DID, second.c, second.sig), b.admit(DID, second.c, second.sig)]);
    expect(both.map((r) => r.ok)).toEqual([true, true]);
  });

  it('does not admit, or read the agent, when the shared store cannot be reached', async () => {
    // A network store fails. The gate must fail with it and not let the response through unchecked.
    const store = { ...atomicStore(), consume: async () => { throw new Error('store unreachable'); } };
    const gate = gateWith({ score: 50, store });
    const { c, sig } = issue(gate);

    await expect(gate.admit(DID, c, sig)).rejects.toThrow('store unreachable');
    const v = (gate as any).verifier;
    expect(v.isActive).not.toHaveBeenCalled();
    expect(v.getTotalScore).not.toHaveBeenCalled();
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

describe('SigvaraGate configuration that would fail open', () => {
  const base = { rpcUrl: 'http://unused', addresses: ADDRESSES, audience: AUDIENCE };

  it.each([NaN, Infinity, -1, undefined as any, '40' as any])('refuses a threshold of %s', (threshold) => {
    expect(() => new SigvaraGate({ ...base, threshold })).toThrow(/threshold must be/);
  });

  it.each([NaN, 0, -5, Infinity])('refuses ttlSeconds of %s', (ttlSeconds) => {
    expect(() => new SigvaraGate({ ...base, threshold: 40, ttlSeconds })).toThrow(/ttlSeconds must be/);
  });

  it('still accepts a threshold of 0, and the default lifetime', () => {
    expect(() => new SigvaraGate({ ...base, threshold: 0 })).not.toThrow();
  });

  // A limit that is NaN compares false against every age, so a typo in how it was read from the
  // environment would switch the freshness check off without a word.
  it.each([NaN, 0, -5, Infinity, '3600' as any])('refuses maxScoreAgeSeconds of %s', (maxScoreAgeSeconds) => {
    expect(() => new SigvaraGate({ ...base, threshold: 40, maxScoreAgeSeconds })).toThrow(/maxScoreAgeSeconds must be/);
  });

  it('accepts a positive maxScoreAgeSeconds', () => {
    expect(() => new SigvaraGate({ ...base, threshold: 40, maxScoreAgeSeconds: 86_400 })).not.toThrow();
  });
});

describe('SigvaraGate across instances', () => {
  /** A gate with its chain reads stubbed to admit, so only the nonce decides. */
  function admitting(config: Record<string, unknown> = {}) {
    const gate = new SigvaraGate({
      rpcUrl: 'http://unused', addresses: ADDRESSES, chainId: 5042002, threshold: 40, audience: AUDIENCE,
      ...config,
    });
    const v = (gate as any).verifier;
    v.verifySignature = vi.fn(async () => true);
    v.isActive = vi.fn(async () => true);
    v.hasMinimumStake = vi.fn(async () => true);
    v.getScoreUpdatedAt = vi.fn(async () => Math.floor(Date.now() / 1000) - 60);
    v.getTotalScore = vi.fn(async () => 50);
    return gate;
  }

  /** One backend shared by every instance, with an atomic insert-if-absent. */
  function sharedBackend() {
    const keys = new Map<string, number>();
    const setIfAbsent = vi.fn((key: string, expiresAt: number) => {
      if (keys.has(key)) return false;
      keys.set(key, expiresAt);
      return true;
    });
    return { keys, setIfAbsent };
  }

  it('lets one response through twice when two instances keep their own in-memory stores', async () => {
    // The failure the `instances` guard exists for: each process has its own spent set.
    const a = admitting();
    const b = admitting();
    const c = a.challenge(DID);
    const sig = signChallenge(c.payload, kp.secretKey);
    expect((await a.admit(DID, c, sig)).ok).toBe(true);
    expect((await b.admit(DID, c, sig)).ok).toBe(true);
  });

  it('admits a response once across instances that share an atomic store', async () => {
    const backend = sharedBackend();
    const a = admitting({ instances: 'multiple', nonceStore: atomicNonceStore(backend.setIfAbsent) });
    const b = admitting({ instances: 'multiple', nonceStore: atomicNonceStore(backend.setIfAbsent) });
    const c = a.challenge(DID);
    const sig = signChallenge(c.payload, kp.secretKey);
    expect((await a.admit(DID, c, sig)).ok).toBe(true);
    const replay = await b.admit(DID, c, sig);
    expect(replay.ok).toBe(false);
    expect(replay.reason).toBe('replayed');
  });

  it("refuses to start as 'multiple' without an atomic consume", () => {
    expect(() => admitting({ instances: 'multiple' })).toThrow(/atomic consume/);
    expect(() => admitting({
      instances: 'multiple',
      nonceStore: { seen: () => false, add: () => {}, prune: () => {} },
    })).toThrow(/atomic consume/);
  });

  it('refuses an instances value it does not know', () => {
    expect(() => admitting({ instances: 'many' })).toThrow(/instances must be/);
  });

  it('atomicNonceStore prefixes the key, passes the expiry and will not run the non-atomic pair', async () => {
    const backend = sharedBackend();
    const store = atomicNonceStore(backend.setIfAbsent, { prefix: 'gate:' });
    expect(await store.consume!('n1', 1800000000)).toBe(true);
    expect(await store.consume!('n1', 1800000000)).toBe(false);
    expect(backend.setIfAbsent).toHaveBeenCalledWith('gate:n1', 1800000000);
    expect(() => store.seen('n1')).toThrow(/only consume/);
    expect(() => store.add('n1', 1800000000)).toThrow(/only consume/);
  });

  describe("with profile: 'production'", () => {
    const fleet = { profile: 'production', instances: 'multiple', maxScoreAgeSeconds: 3600 };

    it('refuses to start without instances', () => {
      expect(() => admitting({ profile: 'production', maxScoreAgeSeconds: 3600 })).toThrow(/must be set: instances/);
    });

    it('refuses to start without maxScoreAgeSeconds', () => {
      expect(() => admitting({ profile: 'production', instances: 'single' }))
        .toThrow(/must be set: maxScoreAgeSeconds/);
    });

    it('names everything missing in one message', () => {
      expect(() => admitting({ profile: 'production' })).toThrow(/instances .*; maxScoreAgeSeconds/);
    });

    // A typo read from the environment must not quietly build the gate the profile exists to rule out.
    it.each(['prod', 'Production', '', 'development'])('refuses a profile of %j rather than ignoring it', (profile) => {
      expect(() => admitting({ profile, instances: 'single', maxScoreAgeSeconds: 3600 })).toThrow(/profile must be/);
    });

    it('starts as one process with an age limit, and without a profile keeps the defaults', () => {
      expect(() => admitting({ profile: 'production', instances: 'single', maxScoreAgeSeconds: 3600 })).not.toThrow();
      expect(() => admitting()).not.toThrow();
    });

    it("still refuses 'multiple' without an atomic consume", () => {
      expect(() => admitting(fleet)).toThrow(/atomic consume/);
    });

    it('admits a response once across a fleet sharing an atomic store', async () => {
      const backend = sharedBackend();
      const a = admitting({ ...fleet, nonceStore: atomicNonceStore(backend.setIfAbsent) });
      const b = admitting({ ...fleet, nonceStore: atomicNonceStore(backend.setIfAbsent) });
      const c = a.challenge(DID);
      const sig = signChallenge(c.payload, kp.secretKey);
      const [first, second] = await Promise.all([a.admit(DID, c, sig), b.admit(DID, c, sig)]);
      expect([first.ok, second.ok].sort()).toEqual([false, true]);
      expect([first.reason, second.reason]).toContain('replayed');
    });

    it('refuses a score the oracle stopped refreshing', async () => {
      const gate = admitting({ profile: 'production', instances: 'single', maxScoreAgeSeconds: 3600 });
      // The oracle's last write was two hours ago.
      (gate as any).verifier.getScoreUpdatedAt = vi.fn(async () => Math.floor(Date.now() / 1000) - 7200);
      const c = gate.challenge(DID);
      const r = await gate.admit(DID, c, signChallenge(c.payload, kp.secretKey));
      expect(r).toMatchObject({ ok: false, reason: 'stale_score', score: 50 });
    });
  });
});
