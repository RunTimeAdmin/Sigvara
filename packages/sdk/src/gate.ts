import { SigvaraVerifier } from './verifier';
import { generateChallenge } from './challenge';
import type { Challenge, ContractAddresses } from './types';

/**
 * A gate: something that refuses work to agents without standing.
 *
 * `meetsThreshold` has existed since the first release and challenge-response since not
 * long after, and neither had a consumer. A score nothing refuses work over is a number
 * in a database, and an authentication protocol nothing authenticates is a test fixture.
 * This is the piece that turns both into a decision, and it is deliberately small: issue
 * a challenge, admit or refuse, say why.
 *
 * ## It owns the nonce
 *
 * `verifySignature` has no memory, so a captured response replays against the same
 * verifier until the challenge expires. The README says tracking nonces is the
 * integrator's job, which is true and is also how it gets skipped. A gate is the natural
 * owner: it issued the challenge, so it is the only party that knows which nonces are
 * outstanding. Seen nonces are dropped once past their expiry, so the set stays bounded
 * by issue rate rather than growing forever.
 *
 * The default store is in memory, which is correct for a single process and wrong for a
 * fleet behind a load balancer: two instances do not share a set, so a response accepted
 * by one can be replayed at the other. Pass a `NonceStore` backed by Redis or the like
 * when that applies. The interface is three methods for that reason.
 *
 * ## What a refusal means
 *
 * Four different things, and they need different responses from the caller:
 *
 *   `bad_proof`       the signature does not verify, or names a different agent,
 *                     audience or challenge. Nothing was proven.
 *   `replayed`        a valid signature, already used. Someone is replaying, or the
 *                     caller retried without asking for a fresh challenge.
 *   `not_active`      real agent, proved itself, but it is not bonded, is suspended, or
 *                     has been slashed. Standing is not a score question here.
 *   `below_threshold` real, active, proved itself, and the number is not high enough.
 *
 * Only the last is about reputation. Collapsing them into `false` is what makes a gate
 * impossible to debug from the caller's side.
 */

export type AdmitReason = 'bad_proof' | 'replayed' | 'not_active' | 'below_threshold';

export interface AdmitResult {
  ok: boolean;
  reason?: AdmitReason;
  /** The agent's on-chain score when it could be read. Undefined if the proof failed. */
  score?: number;
  threshold: number;
  did: string;
}

export interface NonceStore {
  /** True if this nonce has already been spent. */
  seen(nonce: string): Promise<boolean> | boolean;
  /** Mark spent. `expiresAt` is unix seconds, for pruning. */
  add(nonce: string, expiresAt: number): Promise<void> | void;
  /** Drop everything already expired. Called opportunistically, not on a timer. */
  prune(nowSeconds: number): Promise<void> | void;
}

/** Bounded by issue rate, not by uptime. Single process only. */
class MemoryNonceStore implements NonceStore {
  private readonly spent = new Map<string, number>();
  seen(nonce: string): boolean { return this.spent.has(nonce); }
  add(nonce: string, expiresAt: number): void { this.spent.set(nonce, expiresAt); }
  prune(nowSeconds: number): void {
    for (const [nonce, exp] of this.spent) if (exp < nowSeconds) this.spent.delete(nonce);
  }
}

export interface GateConfig {
  rpcUrl: string;
  addresses: ContractAddresses;
  chainId?: number;
  /** Minimum on-chain score. See the caveat in the docs about what numbers mean today. */
  threshold: number;
  /**
   * Who this gate is. Signed into every challenge so a response given to you cannot be
   * relayed to somebody else. Use a stable identifier you control, normally your origin.
   */
  audience: string;
  /** How long an issued challenge stays valid. Default 300s. */
  ttlSeconds?: number;
  nonceStore?: NonceStore;
}

export class SigvaraGate {
  private readonly verifier: SigvaraVerifier;
  private readonly nonces: NonceStore;
  private readonly ttl: number;
  readonly threshold: number;
  readonly audience: string;

  constructor(config: GateConfig) {
    if (!config.audience) {
      throw new Error(
        'SigvaraGate: audience is required. It is signed into every challenge, so a ' +
        'response given to this gate cannot be relayed to another one.',
      );
    }
    this.verifier = new SigvaraVerifier({
      rpcUrl: config.rpcUrl, addresses: config.addresses, chainId: config.chainId,
    });
    this.threshold = config.threshold;
    this.audience = config.audience;
    this.ttl = config.ttlSeconds ?? 300;
    this.nonces = config.nonceStore ?? new MemoryNonceStore();
  }

  /** Issue a challenge for an agent to sign. Hand the whole object back to `admit`. */
  challenge(did: string): Challenge {
    return generateChallenge(did, this.audience, this.ttl);
  }

  /**
   * Admit or refuse.
   *
   * Order matters: the proof is checked before anything is read from the chain, so an
   * unauthenticated caller cannot make this gate do RPC work on its behalf.
   */
  async admit(did: string, challenge: Challenge, signatureBase58: string): Promise<AdmitResult> {
    const base = { threshold: this.threshold, did };
    const nowSeconds = Math.floor(Date.now() / 1000);

    const proved = await this.verifier.verifySignature(
      did, challenge.payload, signatureBase58, this.ttl, this.audience,
    );
    if (!proved) return { ...base, ok: false, reason: 'bad_proof' };

    // After the signature, not before: an invalid proof should not be able to burn a
    // nonce and lock out the legitimate holder of that challenge.
    if (await this.nonces.seen(challenge.nonce)) {
      return { ...base, ok: false, reason: 'replayed' };
    }
    await this.nonces.add(challenge.nonce, challenge.expiresAt);
    await this.nonces.prune(nowSeconds);

    // Status before score. An agent that is slashed or unbonded is refused on standing,
    // and reporting "below_threshold" for it would be a misleading reason: topping up its
    // score is not the fix.
    if (!(await this.verifier.isActive(did))) {
      return { ...base, ok: false, reason: 'not_active' };
    }

    const rep = await this.verifier.getReputation(did);
    const score = Number(rep.feeScore) + Number(rep.successScore) + Number(rep.ageScore)
      + Number(rep.externalScore) + Number(rep.communityScore) + Number(rep.propagationScore);

    if (score < this.threshold) {
      return { ...base, ok: false, reason: 'below_threshold', score };
    }
    return { ...base, ok: true, score };
  }
}
