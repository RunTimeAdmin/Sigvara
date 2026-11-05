import { ethers } from 'ethers';
import { formatDid } from './did';
import { SigvaraVerifier } from './verifier';
import type { ContractAddresses } from './types';

/**
 * One rule for whether an agent has standing, used by SigvaraGate, the MCP server, the x402 guard and
 * the framework tools, so that no two of them can come to different answers about the same agent.
 */

export type StandingReason = 'not_active' | 'below_bond' | 'stale_score' | 'below_threshold';

/** What each refusal means, for a person or a model reading it. */
export const REASON_DETAIL: Record<StandingReason, string> = {
  not_active: 'The agent is not Active with at least the minimum stake now: it is unbonded, suspended, slashed, '
    + 'or holds less than a raised minimum. A higher score would not change that.',
  below_bond: 'The agent is Active and holds the protocol minimum, but holds less than the larger bond you asked for.',
  stale_score: 'The score was last written longer ago than the limit you set, or never. The oracle may have stopped '
    + 'refreshing it, so the number cannot be relied on either way.',
  below_threshold: 'The agent is Active and bonded, but its matured score is below your threshold.',
};

/**
 * The rule, in order: standing, the bond asked for, freshness, then the number. Only the last is about
 * reputation, and a gate that gives the fix for the wrong one is impossible to debug from outside.
 */
export function standingDecision(
  s: { active: boolean; bonded: boolean; score: number; scoreUpdatedAt: number; stake?: bigint },
  threshold: number,
  maxScoreAgeSeconds: number | undefined,
  nowSeconds: number,
  minBond?: bigint,
): { ok: boolean; reason?: StandingReason } {
  if (!s.active || !s.bonded) return { ok: false, reason: 'not_active' };
  if (minBond !== undefined && (s.stake ?? 0n) < minBond) return { ok: false, reason: 'below_bond' };
  if (maxScoreAgeSeconds !== undefined
      && (s.scoreUpdatedAt === 0 || nowSeconds - s.scoreUpdatedAt > maxScoreAgeSeconds)) {
    return { ok: false, reason: 'stale_score' };
  }
  if (s.score < threshold) return { ok: false, reason: 'below_threshold' };
  return { ok: true };
}

/**
 * A bond floor in the bond token's base units, or a thrown error. Not a number: a floor of 2,500,000
 * tokens at 18 decimals is past what a double can hold, and would quietly become a different floor.
 */
export function parseMinBond(value: unknown, who: string): bigint | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'bigint') {
    if (value < 0n) throw new Error(`${who}: minBond cannot be negative (got ${value}).`);
    return value;
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  throw new Error(`${who}: minBond must be a bigint or a string of digits, in the bond token's base units (got ${String(value)}).`);
}

export interface TrustCheckConfig {
  rpcUrl: string;
  addresses: ContractAddresses;
  chainId: number;
  /** The matured score an agent must have. */
  minScore: number;
  /** A bond larger than the protocol minimum, in the bond token's base units. Unset, the minimum is enough. */
  minBond?: bigint | string;
  /** Refuse a score written longer ago than this, or never. Unset, a score is trusted however old it is. */
  maxScoreAgeSeconds?: number;
  timeoutMs?: number;
}

export type TrustReason = StandingReason | 'not_an_address';

export interface TrustVerdict {
  ok: boolean;
  /** The address asked about, as given. */
  agent: string;
  reason?: TrustReason;
  /** Says what the reason means, for a person or a model. */
  detail?: string;
  /** The matured score, when the agent is Active and bonded. */
  score?: number;
}

/** What a chain read failed with, safe to show: ethers' full message holds the RPC URL, which can hold a key. */
function readFailure(err: unknown): string {
  const e = err as { error?: { message?: unknown }; info?: { error?: { message?: unknown } }; shortMessage?: unknown };
  // ethers calls a rate limit on a batched read "missing revert data", and keeps the node's words underneath.
  const said = e?.error?.message ?? e?.info?.error?.message ?? e?.shortMessage ?? 'the read failed';
  return String(said).replace(/https?:\/\/\S+/g, '<url>');
}

/**
 * Whether an address, as you would meet it in a payment or a tool call, has standing. There is no proof
 * of identity here, and none is needed for the question "should I pay this address": what matters is
 * who the money goes to. To know that the party you are talking to controls an agent, use SigvaraGate.
 *
 * A read that fails throws. It says nothing about the agent, so it is neither a yes nor a no, and the
 * caller must not treat it as either. Whatever is guarded by this should not go ahead.
 */
export class SigvaraTrustCheck {
  private readonly verifier: SigvaraVerifier;
  private readonly chainId: number;
  private readonly minScore: number;
  private readonly minBond: bigint | undefined;
  private readonly maxScoreAge: number | undefined;

  constructor(config: TrustCheckConfig) {
    if (!Number.isInteger(config.chainId) || config.chainId <= 0) {
      throw new Error(`SigvaraTrustCheck: chainId must be a positive whole number (got ${String(config.chainId)}).`);
    }
    if (typeof config.minScore !== 'number' || !Number.isFinite(config.minScore) || config.minScore < 0) {
      throw new Error(`SigvaraTrustCheck: minScore must be a finite number, 0 or more (got ${String(config.minScore)}).`);
    }
    const maxAge = config.maxScoreAgeSeconds;
    if (maxAge !== undefined && (typeof maxAge !== 'number' || !Number.isFinite(maxAge) || maxAge <= 0)) {
      throw new Error(`SigvaraTrustCheck: maxScoreAgeSeconds must be a positive number (got ${String(maxAge)}).`);
    }
    this.verifier = new SigvaraVerifier({
      rpcUrl: config.rpcUrl, addresses: config.addresses, chainId: config.chainId, timeoutMs: config.timeoutMs,
    });
    this.chainId = config.chainId;
    this.minScore = config.minScore;
    this.minBond = parseMinBond(config.minBond, 'SigvaraTrustCheck');
    this.maxScoreAge = maxAge;
  }

  async check(agent: string): Promise<TrustVerdict> {
    if (!ethers.isAddress(agent)) {
      return { ok: false, agent, reason: 'not_an_address', detail: 'This is not a 0x address, so it cannot be looked up as an agent.' };
    }
    const did = formatDid(agent, this.chainId);
    let read;
    try {
      read = await Promise.all([
        this.verifier.isActive(did),
        this.verifier.hasMinimumStake(did),
        this.verifier.getTotalScore(did),
        // Only asked for when the rule uses them, so a rule without them makes no extra read.
        this.minBond === undefined ? Promise.resolve(0n) : this.verifier.getStake(did),
        this.maxScoreAge === undefined ? Promise.resolve(0) : this.verifier.getScoreUpdatedAt(did),
      ]);
    } catch (err) {
      throw new Error(`SigvaraTrustCheck: could not read the chain (${readFailure(err)})`);
    }
    const [active, bonded, score, stake, scoreUpdatedAt] = read;
    const d = standingDecision(
      { active, bonded, score, scoreUpdatedAt, stake }, this.minScore, this.maxScoreAge, Math.floor(Date.now() / 1000), this.minBond,
    );
    if (d.ok) return { ok: true, agent, score };
    const verdict: TrustVerdict = { ok: false, agent, reason: d.reason, detail: REASON_DETAIL[d.reason as StandingReason] };
    return d.reason === 'not_active' ? verdict : { ...verdict, score };
  }
}
