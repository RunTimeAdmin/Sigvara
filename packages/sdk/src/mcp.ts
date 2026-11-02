/**
 * An MCP server that answers one question for an agent about to pay or rely on another: what does
 * Sigvara's chain say about it?
 *
 * Every tool reads; none signs or sends a transaction, and the server holds no key. It speaks
 * JSON-RPC 2.0 over stdio, one message per line, which is what an MCP host expects of a local server,
 * and it does so without the MCP SDK: four methods is all a tools-only server answers, and the SDK
 * stays at two runtime dependencies.
 *
 *   npx -p @sigvara/protocol-sdk sigvara-mcp
 *
 * `sigvara_check_agent` with a threshold gives the answer SigvaraGate gives, minus the proof:
 * Active and holding the minimum stake now, a score fresh enough if a limit is set, and a matured
 * score at or above the threshold, refused in that order. `sigvara_challenge` and
 * `sigvara_verify_proof` add the proof, for when the caller needs to know the party it is talking to
 * holds the agent's key and is not quoting a stranger's good name.
 */

import { randomUUID } from 'crypto';
import readline from 'readline';
import type { Readable, Writable } from 'stream';
import { ethers } from 'ethers';
import { SigvaraVerifier } from './verifier';
import { computeDidHash, formatDid, parseDid } from './did';
import { generateChallenge } from './challenge';
import { bytes32ToPubKey, pubKeyToMultibase } from './keys';
import { AgentStatus, SlashState } from './types';
import type { ContractAddresses } from './types';

// Read at runtime so serverInfo always names the release that is running. '../package.json' resolves to
// the package root from src/ in tests and from dist/ once built.
const VERSION: string = require('../package.json').version;

/** The Arc testnet deployment, as deployments/5042002.json records it. A test holds the two equal. */
export const ARC_TESTNET = {
  chainId: 5042002,
  rpcUrl: 'https://rpc.testnet.arc.io',
  addresses: {
    identity: '0x7e3aFC532eE5d922ab3cc3FFb510c7C8151477Dd',
    reputation: '0x6603C96275e85F724Cdf74666b399365e4cA29ed',
    staking: '0xA69d62B2a6774D21A2c15d5d83b27277eD31d35B',
  },
} as const;

/**
 * Protocol versions this server can speak. It echoes the client's when it is one of these and offers
 * the newest otherwise. A tools-only server answers the same way in all of them.
 */
export const MCP_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

/** Challenges kept for sigvara_verify_proof. Past this many unexpired ones, the oldest is dropped. */
const MAX_OUTSTANDING = 1000;

export interface TrustServerOptions {
  chainId: number;
  addresses: ContractAddresses;
  /** Used to build a verifier when none is given. */
  rpcUrl?: string;
  /** Per-read timeout for the verifier built here, in milliseconds. */
  timeoutMs?: number;
  /** Injected in tests. Built from rpcUrl, addresses and chainId otherwise. */
  verifier?: SigvaraVerifier;
  /**
   * Asks the RPC which chain it serves. Checked once, before the first read, so a server pointed at
   * the wrong endpoint refuses rather than reading another chain's contracts at these addresses.
   */
  readChainId?: () => Promise<number>;
  /**
   * Who signs for this server: written into every challenge it issues, so a proof given here cannot be
   * replayed to another verifier. Defaults to a name unique to this process.
   */
  audience?: string;
  /** How long a challenge stays valid, in seconds. Default 300. */
  challengeTtlSeconds?: number;
  /** Unix seconds now. Injected in tests. */
  now?: () => number;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

interface Tool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties: false };
  annotations: { readOnlyHint: true; openWorldHint: boolean };
}

/** A tool call the caller can fix: reported as a tool result with isError, which the model sees. */
class ToolError extends Error {}

const AGENT_PROP = {
  type: 'string',
  description: 'The agent, as did:sigvara:<chainId>:<address> or as its 0x address on the chain this server reads.',
};
const THRESHOLD_PROP = {
  type: 'integer', minimum: 0, maximum: 100,
  description: 'Optional. The lowest matured score you accept, 0 to 100. With it, the result carries a decision.',
};
const MAX_AGE_PROP = {
  type: 'integer', minimum: 1,
  description: 'Optional. Refuse a score last written longer ago than this many seconds, or never written.',
};

export const TRUST_TOOLS: Tool[] = [
  {
    name: 'sigvara_check_agent',
    description:
      'Check an agent before paying or relying on it. Reports whether it is registered, Active and holding the '
      + 'minimum stake now; its matured score and when the score was last written; the stake a slash could take; '
      + 'and anything pending (a slash, a queued withdrawal, a new score). With a threshold it also gives the yes or '
      + 'no SigvaraGate gives, without the proof of identity: use sigvara_challenge for that.',
    inputSchema: {
      type: 'object',
      properties: { agent: AGENT_PROP, threshold: THRESHOLD_PROP, maxScoreAgeSeconds: MAX_AGE_PROP },
      required: ['agent'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'sigvara_score',
    description:
      'The six factors of an agent\'s score, the earned total, the matured total a threshold is checked against, '
      + 'when it was written, and any proposal waiting out its challenge window.',
    inputSchema: { type: 'object', properties: { agent: AGENT_PROP }, required: ['agent'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'sigvara_stake',
    description:
      'An agent\'s stake: what it holds, what is queued for withdrawal and when it can leave, the minimum, its most '
      + 'recent slash proposal, and the share of a slash that goes to the victim the committee names.',
    inputSchema: { type: 'object', properties: { agent: AGENT_PROP }, required: ['agent'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'sigvara_identity',
    description:
      'Who operates an agent, its status, when it registered, the Ed25519 key it signs with, and its DID document.',
    inputSchema: { type: 'object', properties: { agent: AGENT_PROP }, required: ['agent'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'sigvara_challenge',
    description:
      'Step 1 of proving that the party you are dealing with controls an agent. Returns a challenge to send it. It '
      + 'signs the payload with the agent\'s registered Ed25519 key (SigvaraAgent.signChallengeFor with this '
      + 'audience) and sends back the base58 signature, which you pass to sigvara_verify_proof. Single use.',
    inputSchema: { type: 'object', properties: { agent: AGENT_PROP }, required: ['agent'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'sigvara_verify_proof',
    description:
      'Step 2. Checks the signature over a challenge this server issued against the key registered on chain for the '
      + 'agent, then reports its standing as sigvara_check_agent does. A challenge is spent by its first valid proof.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: AGENT_PROP,
        challenge: { type: 'string', description: 'The payload sigvara_challenge returned.' },
        signature: { type: 'string', description: 'The base58 Ed25519 signature the agent returned.' },
        threshold: THRESHOLD_PROP,
        maxScoreAgeSeconds: MAX_AGE_PROP,
      },
      required: ['agent', 'challenge', 'signature'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
];

const STATUS_NAMES: Record<number, string> = {
  [AgentStatus.Active]: 'Active',
  [AgentStatus.Suspended]: 'Suspended',
  [AgentStatus.Slashed]: 'Slashed',
  [AgentStatus.PendingBond]: 'PendingBond',
};
const SLASH_NAMES: Record<number, string> = {
  [SlashState.None]: 'None',
  [SlashState.Pending]: 'Pending',
  [SlashState.Executed]: 'Executed',
  [SlashState.Cancelled]: 'Cancelled',
  [SlashState.Disputed]: 'Disputed',
};

export type StandingReason = 'not_active' | 'stale_score' | 'below_threshold';

/**
 * SigvaraGate's rule without the proof, in the gate's order: standing, then freshness, then the number.
 * Kept beside the gate's own code by a test that runs both over the same chain states.
 */
export function standingDecision(
  s: { active: boolean; bonded: boolean; score: number; scoreUpdatedAt: number },
  threshold: number,
  maxScoreAgeSeconds: number | undefined,
  nowSeconds: number,
): { ok: boolean; reason?: StandingReason } {
  if (!s.active || !s.bonded) return { ok: false, reason: 'not_active' };
  if (maxScoreAgeSeconds !== undefined
      && (s.scoreUpdatedAt === 0 || nowSeconds - s.scoreUpdatedAt > maxScoreAgeSeconds)) {
    return { ok: false, reason: 'stale_score' };
  }
  if (s.score < threshold) return { ok: false, reason: 'below_threshold' };
  return { ok: true };
}

const REASON_DETAIL: Record<StandingReason, string> = {
  not_active: 'The agent is not Active with at least the minimum stake now: it is unbonded, suspended, slashed, '
    + 'or holds less than a raised minimum. A higher score would not change that.',
  stale_score: 'The score was last written longer ago than the limit you set, or never. The oracle may have stopped '
    + 'refreshing it, so the number cannot be relied on either way.',
  below_threshold: 'The agent is Active and bonded, but its matured score is below your threshold.',
};

function iso(seconds: bigint | number): string | null {
  const n = Number(seconds);
  return n === 0 ? null : new Date(n * 1000).toISOString();
}

type Factors = { feeScore: number; successScore: number; ageScore: number; externalScore: number; communityScore: number; propagationScore: number };

function factorsOf(f: Factors): Factors {
  return {
    feeScore: f.feeScore, successScore: f.successScore, ageScore: f.ageScore,
    externalScore: f.externalScore, communityScore: f.communityScore, propagationScore: f.propagationScore,
  };
}

function sumFactors(f: Factors): number {
  return f.feeScore + f.successScore + f.ageScore + f.externalScore + f.communityScore + f.propagationScore;
}

export interface TrustServer {
  /** One JSON-RPC message in, its response out, or null for a notification. */
  handle(message: unknown): Promise<unknown | null>;
  readonly audience: string;
}

export function createTrustServer(options: TrustServerOptions): TrustServer {
  const { chainId, addresses } = options;
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error(`createTrustServer: chainId must be a positive integer, got ${chainId}`);
  for (const k of ['identity', 'reputation', 'staking'] as const) {
    if (!ethers.isAddress(addresses?.[k])) throw new Error(`createTrustServer: addresses.${k} is not an address`);
  }
  const verifier = options.verifier ?? new SigvaraVerifier({
    rpcUrl: options.rpcUrl ?? (() => { throw new Error('createTrustServer: rpcUrl or verifier is required'); })(),
    addresses, chainId, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const audience = options.audience ?? `sigvara-mcp:${randomUUID()}`;
  const ttl = options.challengeTtlSeconds ?? 300;
  if (!(ttl > 0) || !Number.isFinite(ttl)) throw new Error(`createTrustServer: challengeTtlSeconds must be positive, got ${ttl}`);
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const outstanding = new Map<string, { did: string; expiresAt: number }>();

  let chainChecked: Promise<void> | undefined;
  function ensureChain(): Promise<void> {
    if (!options.readChainId) return Promise.resolve();
    return (chainChecked ??= options.readChainId().then((served) => {
      if (served !== chainId) {
        throw new ToolError(`The RPC serves chain ${served}, but this server is configured for chain ${chainId}. `
          + 'Fix SIGVARA_RPC_URL or SIGVARA_CHAIN_ID; nothing was read.');
      }
    }).catch((err) => {
      // A mismatch stays a refusal; an unreachable RPC is asked again next time.
      if (!(err instanceof ToolError)) chainChecked = undefined;
      throw err;
    }));
  }

  function agentArg(value: unknown): { did: string; didHash: string } {
    if (typeof value !== 'string' || value.trim() === '') throw new ToolError('agent is required: a did:sigvara DID or a 0x address.');
    const v = value.trim();
    let did: string;
    if (/^0x[0-9a-fA-F]{40}$/.test(v)) {
      did = formatDid(v, chainId);
    } else {
      let parsed;
      try { parsed = parseDid(v); } catch { throw new ToolError(`Not a did:sigvara DID or a 0x address: ${JSON.stringify(v.slice(0, 120))}`); }
      if (parsed.chainId !== chainId) {
        throw new ToolError(`That DID is on chain ${parsed.chainId}; this server reads chain ${chainId}.`);
      }
      did = formatDid(parsed.agentAddress, chainId);
    }
    const { agentAddress } = parseDid(did);
    return { did, didHash: computeDidHash(agentAddress, chainId) };
  }

  function optionalThreshold(value: unknown): number | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100) {
      throw new ToolError('threshold must be a whole number from 0 to 100.');
    }
    return value;
  }

  function optionalMaxAge(value: unknown): number | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      throw new ToolError('maxScoreAgeSeconds must be a whole number of seconds, 1 or more.');
    }
    return value;
  }

  function source() {
    return { chainId, contracts: { ...addresses }, readAt: new Date(now() * 1000).toISOString() };
  }

  async function amounts() {
    const decimals = await verifier.getStakeTokenDecimals();
    return (x: bigint) => ethers.formatUnits(x, decimals);
  }

  /**
   * Everything sigvara_check_agent reports. Reads go out in two waves of at most six: the public Arc RPC
   * refuses a JSON-RPC batch of more than about ten calls, and ethers batches calls made together.
   */
  async function standing(did: string, didHash: string, threshold: number | undefined, maxAge: number | undefined) {
    await ensureChain();
    const agent = { did, didHash, chainId };
    const identity = await verifier.getIdentity(did);
    if (identity.registeredAt === 0n) {
      return {
        agent, registered: false, status: 'NotRegistered',
        signals: [{ code: 'not_registered', detail: 'No agent is registered under this DID on this chain.' }],
        ...(threshold === undefined ? {} : {
          decision: { threshold, maxScoreAgeSeconds: maxAge ?? null, ok: false, reason: 'not_active', detail: REASON_DETAIL.not_active },
        }),
        source: source(),
      };
    }
    const [active, bonded, score, earned, scoreUpdatedAt, stake] = await Promise.all([
      verifier.isActive(did),
      verifier.hasMinimumStake(did),
      verifier.getTotalScore(did),
      verifier.getEarnedScore(did),
      verifier.getScoreUpdatedAt(did),
      verifier.getStake(did),
    ]);
    const [withdrawal, minimum, slash, pending, fmt] = await Promise.all([
      verifier.getPendingWithdrawal(did),
      verifier.getMinimumStake(),
      verifier.getSlashProposal(did),
      verifier.getPendingScore(did),
      amounts(),
    ]);
    const t = now();
    const status = STATUS_NAMES[identity.status] ?? `Unknown(${identity.status})`;
    const slashable = stake + withdrawal.amount;

    const signals: { code: string; detail: string }[] = [];
    if (identity.status === AgentStatus.PendingBond) {
      signals.push({ code: 'never_bonded', detail: 'Registered but never bonded: nothing is at stake, so it is neither scored nor slashable.' });
    } else if (identity.status === AgentStatus.Slashed) {
      signals.push({ code: 'slashed', detail: 'This agent has been slashed. Its stake was taken and its score zeroed.' });
    } else if (identity.status === AgentStatus.Suspended) {
      signals.push({ code: 'suspended', detail: 'Suspended, so not Active. A slash filed against it suspends it until resolved.' });
    } else if (!bonded) {
      signals.push({ code: 'below_minimum_stake', detail: `Active, but holds ${fmt(stake)} against a minimum of ${fmt(minimum)}, which may have been raised since it bonded.` });
    }
    if (slash.state === SlashState.Pending) {
      signals.push({ code: 'slash_pending', detail: `A slash was filed ${iso(slash.initiatedAt)}. Unless it is disputed, cancelled or vetoed, anyone can execute it after ${iso(slash.challengeDeadline)}.` });
    } else if (slash.state === SlashState.Disputed) {
      signals.push({ code: 'slash_disputed', detail: `A slash filed ${iso(slash.initiatedAt)} was disputed ${iso(slash.disputedAt)}. The admin rules on it; the stake stays frozen until then.` });
    }
    if (withdrawal.amount > 0n) {
      signals.push({ code: 'withdrawal_queued', detail: `${fmt(withdrawal.amount)} is queued to leave, claimable from ${iso(withdrawal.claimableAt)}. It stays slashable until claimed.` });
    }
    if (scoreUpdatedAt === 0) {
      signals.push({ code: 'never_scored', detail: 'No score has been written for this agent yet.' });
    } else if (maxAge !== undefined && t - scoreUpdatedAt > maxAge) {
      signals.push({ code: 'score_stale', detail: `The score was last written ${t - scoreUpdatedAt} seconds ago, past your limit of ${maxAge}.` });
    }
    if (earned > score) {
      signals.push({ code: 'score_maturing', detail: `${earned} earned, ${score} matured so far. A threshold is checked against the matured score.` });
    }
    if (pending.exists) {
      signals.push({ code: 'score_pending', detail: `An oracle has proposed a new score (earned ${sumFactors(pending.data)}), which can be finalized from ${iso(pending.finalizableAt) ?? 'the end of its challenge window'}.` });
    }

    const result: Record<string, unknown> = {
      agent, registered: true, status, bonded,
      score: {
        matured: score, earned,
        updatedAt: iso(scoreUpdatedAt),
        ageSeconds: scoreUpdatedAt === 0 ? null : t - scoreUpdatedAt,
      },
      stake: {
        held: fmt(stake),
        queuedForWithdrawal: fmt(withdrawal.amount),
        minimum: fmt(minimum),
        // executeSlash takes the stake held and the queue together, and credits the victim a quarter
        // (src/SigvaraStaking.sol, executeSlash).
        slashable: fmt(slashable),
        victimShareIfSlashed: fmt(slashable / 4n),
      },
      signals,
    };
    if (threshold !== undefined) {
      const d = standingDecision({ active, bonded, score, scoreUpdatedAt }, threshold, maxAge, t);
      result.decision = {
        threshold, maxScoreAgeSeconds: maxAge ?? null, ok: d.ok,
        ...(d.reason ? { reason: d.reason, detail: REASON_DETAIL[d.reason] } : {}),
      };
    }
    result.source = source();
    return result;
  }

  const tools: Record<string, (args: Record<string, unknown>) => Promise<unknown>> = {
    async sigvara_check_agent(args) {
      const { did, didHash } = agentArg(args.agent);
      return standing(did, didHash, optionalThreshold(args.threshold), optionalMaxAge(args.maxScoreAgeSeconds));
    },

    async sigvara_score(args) {
      const { did, didHash } = agentArg(args.agent);
      await ensureChain();
      const [rep, earned, pending] = await Promise.all([
        verifier.getReputation(did), verifier.getEarnedScore(did), verifier.getPendingScore(did),
      ]);
      return {
        agent: { did, didHash, chainId },
        factors: factorsOf(rep),
        earned,
        matured: rep.total,
        updatedAt: iso(rep.lastUpdated),
        pending: pending.exists ? {
          factors: factorsOf(pending.data),
          earned: sumFactors(pending.data),
          proposedAt: iso(pending.proposedAt),
          finalizableAt: iso(pending.finalizableAt),
          proposer: pending.proposer,
          evidenceRoot: pending.evidenceRoot,
        } : null,
        source: source(),
      };
    },

    async sigvara_stake(args) {
      const { did, didHash } = agentArg(args.agent);
      await ensureChain();
      const [stake, bonded, minimum, withdrawal, slash, fmt] = await Promise.all([
        verifier.getStake(did), verifier.hasMinimumStake(did), verifier.getMinimumStake(),
        verifier.getPendingWithdrawal(did), verifier.getSlashProposal(did), amounts(),
      ]);
      const slashable = stake + withdrawal.amount;
      return {
        agent: { did, didHash, chainId },
        held: fmt(stake),
        minimum: fmt(minimum),
        holdsMinimum: bonded,
        withdrawal: withdrawal.amount === 0n ? null : { amount: fmt(withdrawal.amount), claimableAt: iso(withdrawal.claimableAt) },
        slashable: fmt(slashable),
        victimShareIfSlashed: fmt(slashable / 4n),
        lastSlash: slash.state === SlashState.None ? null : {
          state: SLASH_NAMES[slash.state] ?? `Unknown(${slash.state})`,
          reporter: slash.reporter,
          victim: slash.victim,
          initiatedAt: iso(slash.initiatedAt),
          challengeDeadline: iso(slash.challengeDeadline),
          disputedAt: iso(slash.disputedAt),
          evidenceHash: slash.evidenceHash,
        },
        source: source(),
      };
    },

    async sigvara_identity(args) {
      const { did, didHash } = agentArg(args.agent);
      await ensureChain();
      const id = await verifier.getIdentity(did);
      if (id.registeredAt === 0n) return { agent: { did, didHash, chainId }, registered: false, source: source() };
      return {
        agent: { did, didHash, chainId },
        registered: true,
        status: STATUS_NAMES[id.status] ?? `Unknown(${id.status})`,
        operator: id.operator,
        agentAddress: id.agentAddress,
        ed25519PublicKey: pubKeyToMultibase(bytes32ToPubKey(id.ed25519PubKey)),
        registeredAt: iso(id.registeredAt),
        didDocument: await verifier.buildDidDocument(did),
        source: source(),
      };
    },

    async sigvara_challenge(args) {
      const { did } = agentArg(args.agent);
      const t = now();
      for (const [payload, c] of outstanding) if (c.expiresAt <= t) outstanding.delete(payload);
      while (outstanding.size >= MAX_OUTSTANDING) outstanding.delete(outstanding.keys().next().value as string);
      const c = generateChallenge(did, audience, ttl);
      outstanding.set(c.payload, { did, expiresAt: c.timestamp + ttl });
      return {
        agent: did,
        challenge: c.payload,
        audience,
        expiresAt: iso(c.timestamp + ttl),
        ask: `Ask the agent to sign the challenge with its registered Ed25519 key for audience ${JSON.stringify(audience)} `
          + '(SigvaraAgent.signChallengeFor) and to send back the base58 signature, then call sigvara_verify_proof.',
      };
    },

    async sigvara_verify_proof(args) {
      const { did, didHash } = agentArg(args.agent);
      const threshold = optionalThreshold(args.threshold);
      const maxAge = optionalMaxAge(args.maxScoreAgeSeconds);
      if (typeof args.challenge !== 'string' || typeof args.signature !== 'string') {
        throw new ToolError('challenge and signature are both required strings.');
      }
      // Only a challenge this server issued, for this agent, and not yet spent or expired. A verifier that
      // checks whatever payload arrives is checking the caller's homework.
      const issued = outstanding.get(args.challenge);
      if (!issued || issued.did !== did || issued.expiresAt <= now()) {
        return { agent: did, proved: false, reason: 'unknown_challenge',
          detail: 'No unexpired, unspent challenge from this server matches, for this agent. Call sigvara_challenge again.' };
      }
      await ensureChain();
      const proved = await verifier.verifySignature(did, args.challenge, args.signature, ttl, audience);
      if (!proved) {
        // Not spent: a bad signature must not let anyone burn the challenge the real agent is answering.
        return { agent: did, proved: false, reason: 'bad_proof',
          detail: 'The signature does not verify against the Ed25519 key registered on chain for this agent, for this challenge and audience.' };
      }
      outstanding.delete(args.challenge);
      return { proved: true, ...(await standing(did, didHash, threshold, maxAge)) };
    },
  };

  async function callTool(params: unknown) {
    const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
    const name = typeof p.name === 'string' ? p.name : '';
    const fn = Object.prototype.hasOwnProperty.call(tools, name) ? tools[name] : undefined;
    if (!fn) return { error: { code: -32602, message: `Unknown tool: ${name || '(none)'}` } };
    const args = (p.arguments && typeof p.arguments === 'object' && !Array.isArray(p.arguments) ? p.arguments : {}) as Record<string, unknown>;
    try {
      const value = await fn(args);
      return { result: { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value as Json, isError: false } };
    } catch (err) {
      const text = err instanceof ToolError
        ? err.message
        : `Could not read the chain: ${(err as Error)?.message ?? String(err)}`.slice(0, 500);
      return { result: { content: [{ type: 'text', text }], isError: true } };
    }
  }

  async function handle(message: unknown): Promise<unknown | null> {
    const m = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    const isRequest = m !== null && typeof m === 'object' && 'id' in m;
    const id = isRequest ? (m.id as Json) : null;
    if (m === null || typeof m !== 'object' || m.jsonrpc !== '2.0' || typeof m.method !== 'string') {
      return isRequest ? { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } } : null;
    }
    // A notification gets no answer, whatever its method.
    if (!isRequest) return null;
    const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result });

    switch (m.method) {
      case 'initialize': {
        const asked = (m.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
        const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly unknown[]).includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0];
        return ok({
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'sigvara-trust', version: VERSION },
          instructions:
            `Read-only lookups of agent standing in Sigvara on chain ${chainId}. Before paying or relying on an agent, `
            + 'call sigvara_check_agent; pass a threshold to get a yes or no. To confirm that the party you are dealing '
            + 'with controls the agent\'s key, send it the payload from sigvara_challenge and check the signature it '
            + 'returns with sigvara_verify_proof. Nothing here signs or sends a transaction.',
        });
      }
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: TRUST_TOOLS });
      case 'tools/call': {
        const r = await callTool(m.params);
        return 'error' in r ? { jsonrpc: '2.0', id, error: r.error } : ok(r.result);
      }
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${m.method}` } };
    }
  }

  return { handle, audience };
}

/**
 * Serve over newline-delimited JSON on the given streams, stdio by default. Messages are handled one at a
 * time, in order: an MCP host rarely sends two at once, and running them together would put their reads
 * in one JSON-RPC batch, which the public Arc RPC refuses past about ten calls.
 */
export function serveStdio(
  server: TrustServer,
  io: { input?: Readable; output?: Writable } = {},
): Promise<void> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let queue: Promise<void> = Promise.resolve();
  const write = (value: unknown) => { output.write(JSON.stringify(value) + '\n'); };

  async function line(text: string) {
    if (!text.trim()) return;
    let msg: unknown;
    try {
      msg = JSON.parse(text);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    try {
      if (Array.isArray(msg)) {
        const out = [];
        for (const one of msg) {
          const r = await server.handle(one);
          if (r !== null) out.push(r);
        }
        if (out.length) write(out);
      } else {
        const r = await server.handle(msg);
        if (r !== null) write(r);
      }
    } catch (err) {
      const id = msg && typeof msg === 'object' && 'id' in msg ? (msg as { id: unknown }).id : null;
      write({ jsonrpc: '2.0', id, error: { code: -32603, message: (err as Error)?.message ?? 'Internal error' } });
    }
  }

  rl.on('line', (text) => { queue = queue.then(() => line(text)); });
  return new Promise((resolve) => rl.on('close', () => { queue.then(resolve); }));
}
