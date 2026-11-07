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
 * `sigvara_verify_proof` add a proof that the agent's key signed a challenge naming this server. That
 * shows the party being dealt with is the agent only when the agent checks the audience before it
 * signs, which is why the proof tools need an audience the agent can check: the host agent's own DID,
 * or the origin it is reached at. Without one they are not offered.
 */

import readline from 'readline';
import type { Readable, Writable } from 'stream';
import { ethers, FetchRequest } from 'ethers';
import { SigvaraVerifier } from './verifier';
import { REASON_DETAIL, standingDecision } from './standing';
import type { StandingReason } from './standing';
import { computeDidHash, formatDid, parseDid } from './did';
import { generateChallenge } from './challenge';
import { bytes32ToPubKey, pubKeyToMultibase } from './keys';
import { evidenceLayers, evidenceLeaf, evidenceProof, evidenceRoot, matchEvidenceRoot, ZERO_ROOT } from './evidence';
import type { EvidenceRecord } from './evidence';
import { AgentStatus, SlashState } from './types';
import type { ContractAddresses } from './types';

// Read at runtime so serverInfo always names the release that is running. '../package.json' resolves to
// the package root from src/ in tests and from dist/ once built.
const VERSION: string = require('../package.json').version;

/** The Arc testnet deployment, as deployments/5042002.json records it. A test holds the two equal. */
export const ARC_TESTNET = {
  chainId: 5042002,
  rpcUrl: 'https://rpc.testnet.arc.io',
  /** The primary operator, whose /evidence lists the payments behind each score. */
  evidenceUrl: 'https://oracle.sigvara.xyz',
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
   * Defaults to an eth_chainId call on rpcUrl when the verifier is built here. With an injected
   * verifier and no readChainId, the chain is not checked.
   */
  readChainId?: () => Promise<number>;
  /**
   * Who the agents being checked are signing for, written into every challenge this server issues.
   * It must be a name the agent can check against whoever it is talking to, such as the host agent's
   * own did:sigvara DID or the origin it is reached at: an agent that signs for an audience it cannot
   * check can be relayed. Without it, sigvara_challenge and sigvara_verify_proof are not offered.
   * Use a value no SigvaraGate of yours also uses, or a proof given here would pass that gate too.
   */
  audience?: string;
  /** How long a challenge stays valid, in seconds. Default 300. */
  challengeTtlSeconds?: number;
  /** Unix seconds now. Injected in tests. */
  now?: () => number;
  /** Told about every failed read, for logs. The caller sees a short message with URLs removed. */
  onError?: (err: unknown) => void;
  /**
   * An oracle serving GET /evidence/:didHash, for sigvara_verify_evidence. Without it (or fetchEvidence) that
   * tool is not offered. What it serves is checked, never trusted: every leaf is rebuilt here.
   */
  evidenceUrl?: string;
  /** Fetches an agent's evidence list. Injected in tests; a bounded GET on evidenceUrl otherwise. */
  fetchEvidence?: (didHash: string) => Promise<unknown>;
}

/** Largest /evidence body read, and most payments taken from it. */
const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024;
const MAX_EVIDENCE_RECORDS = 2_000;
/**
 * Leaves hashed into trees while matching a root, at most. Each cut-off tried rebuilds a tree over the list, so an
 * oracle serving a long list that matches nothing could otherwise hold the server's only thread for close to a
 * minute. A long list gets fewer cut-offs, the newest first, where a finalized root usually sits.
 */
const MATCH_BUDGET = 20_000;
/** Payments confirmed one by one with verifyEvidence, the last listed. The root match covers the rest. */
const MAX_CONFIRMED = 100;
/** Payments shown in the result, the last listed. Counts cover them all. */
const MAX_LISTED = 50;
/** The latest settlement time accepted, the end of the year 9999, so a date can always be written. */
const MAX_SETTLED_AT = 253_402_300_799;

/** How many cut-offs to try for a list of `n`, within MATCH_BUDGET. */
function cutsFor(n: number): number {
  return Math.max(1, Math.min(64, Math.floor(MATCH_BUDGET / (2 * Math.max(1, n)))));
}

/** GET a JSON body, giving up after `timeoutMs` and refusing one larger than `maxBytes`. */
export async function fetchJsonBounded(url: string, timeoutMs: number, maxBytes: number): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // No redirects: the oracle answers at the URL it was given, or not at all. Following one would let whoever
    // controls it point this host at an address of their choosing, internal ones included.
    const res = await fetch(url, { signal: controller.signal, redirect: 'error', headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`the oracle answered HTTP ${res.status}`);
    const reader = res.body?.getReader();
    if (!reader) throw new Error('the oracle sent no body');
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        controller.abort();
        throw new Error(`the oracle's answer is larger than ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
    const text = new TextDecoder().decode(Buffer.concat(chunks));
    try { return JSON.parse(text); } catch { throw new Error('the oracle did not answer with JSON'); }
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw new Error(`the oracle did not answer within ${timeoutMs} ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Asks an RPC endpoint which chain it serves, with one eth_chainId call. */
export async function rpcChainId(rpcUrl: string, timeoutMs = 30_000): Promise<number> {
  const req = new FetchRequest(rpcUrl);
  req.timeout = timeoutMs;
  req.body = { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] };
  const res = await req.send();
  res.assertOk();
  const body = res.bodyJson as { result?: unknown };
  if (typeof body?.result !== 'string') throw new Error('eth_chainId returned no result');
  return Number(BigInt(body.result));
}

/**
 * What a failed read tells the model: ethers' short message, never the long one. The long message
 * carries the request URL, and an RPC key lives in the URL with most providers, along with the RPC's
 * response body, which is text from outside going straight into the model's context.
 */
export function describeError(err: unknown, secrets: string[] = []): string {
  const e = err as { shortMessage?: unknown; message?: unknown };
  let text = typeof e?.shortMessage === 'string' ? e.shortMessage
    : typeof e?.message === 'string' ? e.message.split('\n')[0]
    : String(err);
  for (const s of secrets) if (s) text = text.split(s).join('<rpc>');
  text = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi, '<url>');
  return text.slice(0, 200);
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
    name: 'sigvara_verify_evidence',
    description:
      'Check the payments behind an agent\'s score against what the chain committed to. Fetches the payments the '
      + 'oracle lists, rebuilds their Merkle root here (never trusting the oracle\'s own leaves), finds which of them '
      + 'the finalized root on chain covers, and asks the reputation contract to confirm them with verifyEvidence. Also '
      + 'says whether a pending proposal\'s root is reproduced. It shows the oracle scored on the set it published; it '
      + 'does not check each transaction itself.',
    inputSchema: { type: 'object', properties: { agent: AGENT_PROP }, required: ['agent'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'sigvara_challenge',
    description:
      'Step 1 of checking that the party you are dealing with is an agent. Returns a challenge to send it, naming you '
      + 'as audience. The agent signs it with its registered Ed25519 key (SigvaraAgent.signChallengeFor, which refuses '
      + 'a challenge whose audience is not who it believes it is talking to) and returns the base58 signature for '
      + 'sigvara_verify_proof. Single use.',
    inputSchema: { type: 'object', properties: { agent: AGENT_PROP }, required: ['agent'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: 'sigvara_verify_proof',
    description:
      'Step 2. Checks the signature over a challenge this server issued against the key registered on chain for the '
      + 'agent, then reports its standing as sigvara_check_agent does. proved: true means the agent\'s key signed this '
      + 'challenge, naming you, within its lifetime. It shows you are dealing with the agent only if the agent checked '
      + 'that audience before signing; otherwise a party could pass your challenge to the agent and relay the answer. '
      + 'Pay only the agent\'s on-chain address or operator, never an address the counterparty supplies. A challenge '
      + 'is spent by its first valid proof.',
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

export { standingDecision };
export type { StandingReason };

function iso(seconds: bigint | number): string | null {
  const n = Number(seconds);
  if (n === 0) return null;
  const d = new Date(n * 1000);
  // A time no calendar can write (a contract value past the year 275760) is reported as unknown, not thrown.
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

type Factors = { feeScore: number; successScore: number; ageScore: number; externalScore: number; communityScore: number; propagationScore: number };

function factorsOf(f: Factors): Factors {
  return {
    feeScore: f.feeScore, successScore: f.successScore, ageScore: f.ageScore,
    externalScore: f.externalScore, communityScore: f.communityScore, propagationScore: f.propagationScore,
  };
}

const FOURTEEN_DAYS = 14n * 24n * 3600n;

const OUTCOME_SOURCES = new Set(['payer_signed', 'credentialed']);

/**
 * The payments in an oracle's /evidence answer, keeping only the fields a leaf commits to, each checked. The
 * answer is text from outside, so nothing else in it reaches the result. A payment that cannot be a leaf is
 * reported by position, in this code's own words.
 */
function readEvidence(body: unknown, didHash: string) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ToolError('The oracle\'s answer is not an evidence list.');
  }
  const b = body as { didHash?: unknown; evidence?: unknown; evidenceRoot?: unknown; paymentChains?: unknown; evidenceCut?: unknown };
  if (typeof b.didHash !== 'string' || b.didHash.toLowerCase() !== didHash.toLowerCase()) {
    throw new ToolError('The oracle\'s answer does not name this agent, so it is not checked.');
  }
  if (!Array.isArray(b.evidence)) throw new ToolError('The oracle\'s answer has no list of payments.');
  if (b.evidence.length > MAX_EVIDENCE_RECORDS) {
    throw new ToolError(`The oracle lists more than ${MAX_EVIDENCE_RECORDS} payments, more than this tool checks.`);
  }
  const isHash = (v: unknown): v is string => typeof v === 'string' && /^0x[0-9a-fA-F]{64}$/.test(v);
  const records: EvidenceRecord[] = [];
  const leaves: string[] = [];
  const servedLeaves: (string | null)[] = [];
  const problems: string[] = [];
  b.evidence.forEach((item: unknown, i: number) => {
    const e = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    // Only plain 0x addresses, as the explorer takes them: ethers also accepts ICAP spellings, which
    // getAddress then refuses in lower case, and that error would read as a failed chain read.
    const payer = typeof e.payer === 'string' && /^0x[0-9a-fA-F]{40}$/.test(e.payer) ? e.payer.toLowerCase() : '';
    const record: EvidenceRecord = {
      txHash: isHash(e.txHash) ? e.txHash.toLowerCase() : '',
      payer,
      amount: typeof e.amount === 'string' && /^\d{1,78}$/.test(e.amount) ? e.amount : '',
      settledAt: typeof e.settledAt === 'number' && Number.isSafeInteger(e.settledAt)
        && e.settledAt >= 0 && e.settledAt <= MAX_SETTLED_AT ? e.settledAt : -1,
      success: e.success === true ? true : e.success === false ? false : null,
      outcomeSource: typeof e.outcomeSource === 'string' && OUTCOME_SOURCES.has(e.outcomeSource) ? e.outcomeSource : null,
    };
    if (e.chainId !== undefined && e.chainId !== null) {
      record.chainId = typeof e.chainId === 'number' && Number.isSafeInteger(e.chainId) && e.chainId > 0 ? e.chainId : -1;
    }
    try {
      if (record.amount === '') throw new Error('a payment amount that is not a whole number');
      if (record.settledAt === -1) throw new Error('a payment time that is not a whole number of seconds before the year 10000');
      if (payer) record.payer = ethers.getAddress(payer);
      leaves.push(evidenceLeaf(record));
    } catch (err) {
      problems.push(`payment ${i + 1}: ${(err as Error).message}`);
      leaves.push(ZERO_ROOT);
    }
    records.push(record);
    servedLeaves.push(isHash(e.leaf) ? e.leaf.toLowerCase() : null);
  });
  // These only choose which readings of the list are tried, so a wrong one cannot make a root reproduce.
  const delays: Record<number, number> = {};
  for (const c of Array.isArray(b.paymentChains) ? b.paymentChains : []) {
    if (Number.isSafeInteger(c?.chainId) && Number.isSafeInteger(c?.delaySeconds) && c.delaySeconds >= 0) delays[c.chainId] = c.delaySeconds;
  }
  const cut = (b.evidenceCut && typeof b.evidenceCut === 'object' ? b.evidenceCut : {}) as Record<string, unknown>;
  const evidenceCut = typeof cut.quantumSeconds === 'number' && typeof cut.windowSeconds === 'number'
    ? { quantumSeconds: cut.quantumSeconds, windowSeconds: cut.windowSeconds }
    : null;
  return { records, leaves, servedLeaves, problems, delays, evidenceCut, servedRoot: isHash(b.evidenceRoot) ? b.evidenceRoot.toLowerCase() : null };
}

function sumFactors(f: Factors): number {
  return f.feeScore + f.successScore + f.ageScore + f.externalScore + f.communityScore + f.propagationScore;
}

export interface TrustServer {
  /** One JSON-RPC message in, its response out, or null for a notification. */
  handle(message: unknown): Promise<unknown | null>;
  /** Who agents sign for in this server's challenges, or null when the proof tools are off. */
  readonly audience: string | null;
}

const PROOF_TOOLS = new Set(['sigvara_challenge', 'sigvara_verify_proof']);

export function createTrustServer(options: TrustServerOptions): TrustServer {
  const { chainId, addresses } = options;
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error(`createTrustServer: chainId must be a positive integer, got ${chainId}`);
  for (const k of ['identity', 'reputation', 'staking'] as const) {
    if (!ethers.isAddress(addresses?.[k])) throw new Error(`createTrustServer: addresses.${k} is not an address`);
  }
  if (!options.verifier && !options.rpcUrl) throw new Error('createTrustServer: rpcUrl or verifier is required');
  const verifier = options.verifier ?? new SigvaraVerifier({
    rpcUrl: options.rpcUrl as string,
    addresses, chainId, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const readChainId = options.readChainId
    ?? (options.verifier ? undefined : () => rpcChainId(options.rpcUrl as string, options.timeoutMs));
  const audience = options.audience ?? null;
  if (audience !== null) {
    // Whatever the challenge format refuses, refuse now rather than on every sigvara_challenge.
    try {
      generateChallenge(`did:sigvara:${chainId}:0x${'0'.repeat(40)}`, audience);
    } catch (err) {
      throw new Error(`createTrustServer: audience cannot go in a challenge: ${(err as Error).message}`);
    }
  }
  const ttl = options.challengeTtlSeconds ?? 300;
  if (!(ttl > 0) || !Number.isFinite(ttl)) throw new Error(`createTrustServer: challengeTtlSeconds must be positive, got ${ttl}`);
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const outstanding = new Map<string, { did: string; expiresAt: number }>();
  const secrets = [options.rpcUrl, options.evidenceUrl].filter((s): s is string => !!s);
  const fail = (err: unknown) => { options.onError?.(err); return describeError(err, secrets); };
  const evidenceBase = options.evidenceUrl?.replace(/\/+$/, '');
  if (evidenceBase !== undefined && !/^https?:\/\/[^\s]+$/i.test(evidenceBase)) {
    throw new Error('createTrustServer: evidenceUrl must be an http(s) URL');
  }
  const fetchEvidence = options.fetchEvidence ?? (evidenceBase
    ? (didHash: string) => fetchJsonBounded(`${evidenceBase}/evidence/${didHash}`, options.timeoutMs ?? 30_000, MAX_EVIDENCE_BYTES)
    : undefined);
  const offered = (name: string) => !(audience === null && PROOF_TOOLS.has(name))
    && !(fetchEvidence === undefined && name === 'sigvara_verify_evidence');
  const listed = TRUST_TOOLS.filter((t) => offered(t.name));

  let chainChecked: Promise<void> | undefined;
  function ensureChain(): Promise<void> {
    if (!readChainId) return Promise.resolve();
    return (chainChecked ??= readChainId().then((served) => {
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
        agent, registered: false, status: 'NotRegistered', onChain: null,
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
      signals.push({ code: 'never_bonded', detail: 'Registered, but has never reached the minimum stake, so it is not Active and is not scored. A part-deposit it holds can still be slashed.' });
    } else if (identity.status === AgentStatus.Slashed) {
      signals.push({ code: 'slashed', detail: 'This agent has been slashed. Its stake was taken and its score zeroed.' });
    } else if (identity.status === AgentStatus.Suspended) {
      signals.push({ code: 'suspended', detail: 'Suspended, so not Active. A slash filed against it suspends it until resolved.' });
    } else if (!bonded) {
      signals.push({ code: 'below_minimum_stake', detail: `Active, but holds ${fmt(stake)} against a minimum of ${fmt(minimum)}, which may have been raised since it bonded.` });
    }
    if (slash.state === SlashState.Pending) {
      // EXECUTION_PERIOD and DISPUTE_RESOLUTION_PERIOD are both 14 days, constants in SigvaraStaking.
      signals.push({ code: 'slash_pending', detail: `A slash was filed ${iso(slash.initiatedAt)}. Unless it is disputed, cancelled or vetoed, anyone can execute it after ${iso(slash.challengeDeadline)} while the member who filed it is still on the committee. If nobody does, it lapses after ${iso(slash.challengeDeadline + FOURTEEN_DAYS)}.` });
    } else if (slash.state === SlashState.Disputed) {
      signals.push({ code: 'slash_disputed', detail: `A slash filed ${iso(slash.initiatedAt)} was disputed ${iso(slash.disputedAt)}. The admin rules on it, and the stake stays frozen until then. Without a ruling, anyone can expire the dispute after ${iso(slash.disputedAt + FOURTEEN_DAYS)} and the agent keeps its stake.` });
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
      // Where the record says the agent and its operator are. Pay one of these, never an address the
      // counterparty supplies.
      onChain: { agentAddress: identity.agentAddress, operator: identity.operator },
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

    async sigvara_verify_evidence(args) {
      const { did, didHash } = agentArg(args.agent);
      await ensureChain();
      const [finalRoot, pending, fetched] = await Promise.all([
        verifier.getEvidenceRoot(did),
        verifier.getPendingScore(did),
        (fetchEvidence as (h: string) => Promise<unknown>)(didHash).then(
          (body) => ({ body, err: undefined as unknown }),
          (err) => ({ body: undefined as unknown, err }),
        ),
      ]);
      if (fetched.err !== undefined) throw new ToolError(`Could not fetch the oracle's evidence: ${fail(fetched.err)}`);
      const { records, leaves, servedRoot, servedLeaves, problems, delays, evidenceCut } = readEvidence(fetched.body, didHash);

      const rebuiltRoot = problems.length ? null : evidenceRoot(leaves);
      const servedLeavesDiffering = problems.length ? null
        : servedLeaves.filter((l, i) => l !== null && l !== leaves[i].toLowerCase()).length;

      let finalized: Record<string, unknown>;
      const covered = new Set<number>();
      const confirmed = new Map<number, boolean>();
      // Payments whose outcome the root covers as not reported, though the oracle now lists one the payer signed.
      const readAsUnreported = new Set<number>();
      const maxCuts = cutsFor(records.length);
      if (problems.length) {
        finalized = { root: finalRoot === ZERO_ROOT ? null : finalRoot, reproduced: null,
          detail: 'Not checked: some payments listed cannot be part of any root.' };
      } else if (finalRoot === ZERO_ROOT) {
        finalized = { root: null, reproduced: null, detail: 'No score with an evidence root has been finalized for this agent.' };
      } else {
        const m = matchEvidenceRoot(records, finalRoot, { leaves, maxCuts, delays });
        if (!m) {
          finalized = { root: finalRoot, reproduced: false,
            detail: 'No reading of the payments listed reproduces the finalized root. The oracle no longer lists the set '
              + 'this score was made on, or lists it differently.'
              + (maxCuts < 64 ? ` With ${records.length} payments listed, only the ${maxCuts} latest settlement cut-offs were tried.` : '') };
        } else {
          m.indexes.forEach((i) => covered.add(i));
          if (m.unset) m.indexes.forEach((i) => { if (records[i].outcomeSource === 'payer_signed') readAsUnreported.add(i); });
          const layers = evidenceLayers(m.leaves);
          // The last listed, in waves of eight: the public Arc RPC refuses a batch of more than about ten.
          const positions = m.indexes.map((_, p) => p).slice(-MAX_CONFIRMED);
          for (let w = 0; w < positions.length; w += 8) {
            const wave = positions.slice(w, w + 8);
            const answers = await Promise.all(wave.map((p) => verifier.verifyEvidence(did, m.leaves[p], evidenceProof(layers, p))));
            wave.forEach((p, k) => confirmed.set(m.indexes[p], answers[k]));
          }
          const yes = [...confirmed.values()].filter(Boolean).length;
          // A payment in the committed set twice was counted twice. Legs of one transaction share a txHash with
          // different payers, so it is identical leaves that are flagged, not shared hashes.
          const duplicated = m.leaves.length - new Set(m.leaves.map((l) => l.toLowerCase())).size;
          // A payment chain's payment counts its delay after it settled, so with one in the set the cut-off is
          // not a settlement time.
          const delayed = m.indexes.some((i) => records[i].chainId != null);
          finalized = {
            root: finalRoot,
            reproduced: true,
            covers: m.indexes.length,
            settledBy: m.cut === Infinity || delayed ? null : iso(m.cut),
            countedBy: m.cut === Infinity ? null : iso(m.cut),
            outcomesReadAsUnreported: readAsUnreported.size,
            duplicatedPayments: duplicated,
            checkedWithContract: confirmed.size,
            confirmedByContract: yes,
            detail: `Reproduced from ${m.indexes.length === records.length ? `all ${records.length}` : `${m.indexes.length} of the ${records.length}`} `
              + 'payments listed'
              + (m.cut === Infinity || m.indexes.length === records.length ? '' : `, those ${delayed ? 'counted' : 'settled'} by ${iso(m.cut)}`)
              + (readAsUnreported.size ? `, reading ${readAsUnreported.size} outcome(s) the payer signed afterwards as not yet reported, as the root does` : '')
              + `. verifyEvidence confirmed ${yes} of the ${confirmed.size} checked`
              + (confirmed.size < m.indexes.length ? ', the last listed; the root match covers the rest' : '') + '.'
              + (duplicated ? ` ${duplicated} payment(s) appear more than once in the committed set, so the score counted them more than once.` : '')
              // The proofs come from a tree whose root was just read, so the two disagree only if the root
              // changed between the reads: a finalize or a zeroing landed in between.
              + (yes < confirmed.size ? ' The contract refused some: its root may have changed since it was read, so run this again.' : ''),
          };
        }
      }

      let pendingResult: Record<string, unknown> | null = null;
      if (pending.exists && pending.evidenceRoot === ZERO_ROOT) {
        pendingResult = { root: null, proposedAt: iso(pending.proposedAt), reproduced: null,
          detail: 'Proposed with no evidence root, so it commits to no payments.' };
      } else if (pending.exists) {
        const m = problems.length ? null
          : matchEvidenceRoot(records, pending.evidenceRoot, { at: Number(pending.proposedAt), leaves, maxCuts, delays, evidenceCut });
        pendingResult = { root: pending.evidenceRoot, proposedAt: iso(pending.proposedAt), reproduced: problems.length ? null : !!m };
      }
      const notYetFinalized = problems.length ? null
        : finalRoot === ZERO_ROOT ? records.length
        : covered.size ? records.length - covered.size : null;

      const first = Math.max(0, records.length - MAX_LISTED);
      return {
        agent: { did, didHash, chainId },
        listed: records.length,
        cannotRebuild: problems.slice(0, 5),
        rebuiltRoot,
        servedRootMatches: servedRoot === null || rebuiltRoot === null ? null : servedRoot === rebuiltRoot.toLowerCase(),
        servedLeavesDiffering,
        finalized,
        notYetFinalized,
        pending: pendingResult,
        payments: records.slice(first).map((r, k) => {
          const i = first + k;
          const label = (s: boolean | null) => (s === true ? 'delivered' : s === false ? 'failed' : 'not reported');
          return {
            txHash: r.txHash, payer: r.payer, amount: String(r.amount),
            settledAt: iso(BigInt(r.settledAt)),
            chainId: r.chainId ?? null,
            // What the oracle lists now. A payer-signed outcome added after the root is the oracle's word here.
            outcome: label(r.success),
            outcomeSource: r.outcomeSource ?? null,
            inFinalizedRoot: covered.has(i),
            // What the finalized root, and so the contract's confirmation, covers.
            committedOutcome: covered.has(i) ? label(readAsUnreported.has(i) ? null : r.success) : null,
            confirmedByContract: confirmed.has(i) ? confirmed.get(i) : null,
          };
        }),
        paymentsShown: `${records.length - first} of ${records.length}, the last listed`,
        meaning: 'A reproduced finalized root shows the oracle scored on exactly the payments it lists, with the outcomes in '
          + 'committedOutcome; verifyEvidence is the contract agreeing, payment by payment. An outcome that differs from '
          + 'committedOutcome was added afterwards and is the oracle\'s word. Neither shows a transaction happened as '
          + 'listed: read a payment\'s txHash on chain for that, on the chain its chainId names when it has one.',
        source: source(),
      };
    },

    async sigvara_challenge(args) {
      const { did } = agentArg(args.agent);
      const t = now();
      for (const [payload, c] of outstanding) if (c.expiresAt <= t) outstanding.delete(payload);
      // A shared server can be made to drop a challenge an agent is still answering by issuing a thousand
      // more. Stdio serves one host; an embedding that serves several should give each its own server.
      while (outstanding.size >= MAX_OUTSTANDING) outstanding.delete(outstanding.keys().next().value as string);
      const c = generateChallenge(did, audience as string, ttl);
      outstanding.set(c.payload, { did, expiresAt: c.timestamp + ttl });
      return {
        agent: did,
        challenge: c.payload,
        audience,
        expiresAt: iso(c.timestamp + ttl),
        ask: `Send the challenge to the agent. It should sign only if ${JSON.stringify(audience)} is who it believes it is `
          + 'talking to (SigvaraAgent.signChallengeFor checks this), and return the base58 signature for sigvara_verify_proof.',
      };
    },

    async sigvara_verify_proof(args) {
      const { did, didHash } = agentArg(args.agent);
      const threshold = optionalThreshold(args.threshold);
      const maxAge = optionalMaxAge(args.maxScoreAgeSeconds);
      if (typeof args.challenge !== 'string' || typeof args.signature !== 'string') {
        throw new ToolError('challenge and signature are both required strings.');
      }
      const unknown = { agent: did, proved: false, reason: 'unknown_challenge',
        detail: 'No unexpired, unspent challenge from this server matches, for this agent. Call sigvara_challenge again.' };
      // Only a challenge this server issued, for this agent, and not yet spent or expired. A verifier that
      // checks whatever payload arrives is checking the caller's homework.
      const issued = outstanding.get(args.challenge);
      if (!issued || issued.did !== did || issued.expiresAt <= now()) return unknown;
      await ensureChain();
      const proved = await verifier.verifySignature(did, args.challenge, args.signature, ttl, audience as string);
      if (!proved) {
        // Not spent: a bad signature must not let anyone burn the challenge the real agent is answering.
        return { agent: did, proved: false, reason: 'bad_proof',
          detail: 'The signature does not verify against the Ed25519 key registered on chain for this agent, for this challenge and audience.' };
      }
      // Spent by the first valid proof to get here. Another call with the same proof may have finished while
      // this one waited on the chain; only the one that still finds the challenge outstanding is let through.
      if (outstanding.get(args.challenge) !== issued) return unknown;
      outstanding.delete(args.challenge);
      const meaning = `The agent's key signed this challenge for ${JSON.stringify(audience)} within its lifetime. That `
        + 'shows you are dealing with the agent only if it checked the audience before signing. Pay only the '
        + 'onChain addresses below, never one the counterparty supplies.';
      try {
        return { proved: true, meaning, ...(await standing(did, didHash, threshold, maxAge)) };
      } catch (err) {
        // The proof is spent either way, so say it held even when the standing read failed.
        if (err instanceof ToolError) throw err;
        return { proved: true, meaning, agent: { did, didHash, chainId }, standingError: `Could not read the chain: ${fail(err)}` };
      }
    },
  };

  async function callTool(params: unknown) {
    const p = (params ?? {}) as { name?: unknown; arguments?: unknown };
    const name = typeof p.name === 'string' ? p.name : '';
    const fn = Object.prototype.hasOwnProperty.call(tools, name) ? tools[name] : undefined;
    if (!fn) return { error: { code: -32602, message: `Unknown tool: ${name || '(none)'}` } };
    const args = (p.arguments && typeof p.arguments === 'object' && !Array.isArray(p.arguments) ? p.arguments : {}) as Record<string, unknown>;
    if (name === 'sigvara_verify_evidence' && !offered(name)) {
      return { result: { content: [{ type: 'text', text:
        'sigvara_verify_evidence needs an oracle that serves /evidence. Set SIGVARA_EVIDENCE_URL (or the evidenceUrl '
        + 'option) and restart.' }], isError: true } };
    }
    if (audience === null && PROOF_TOOLS.has(name)) {
      return { result: { content: [{ type: 'text', text:
        `${name} needs an audience: a name the agents you check can verify is you, such as your own did:sigvara DID or `
        + 'the origin they reach you at. Set SIGVARA_AUDIENCE (or the audience option) and restart.' }], isError: true } };
    }
    try {
      const value = await fn(args);
      return { result: { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value as Json, isError: false } };
    } catch (err) {
      const text = err instanceof ToolError ? err.message : `Could not read the chain: ${fail(err)}`;
      return { result: { content: [{ type: 'text', text }], isError: true } };
    }
  }

  async function handle(message: unknown): Promise<unknown | null> {
    const invalid = (id: Json) => ({ jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } });
    if (message === null || typeof message !== 'object' || Array.isArray(message)) return invalid(null);
    const m = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    // A response to a request of ours. This server sends none, and a response is never answered.
    if (!('method' in m) && ('result' in m || 'error' in m)) return null;
    const isRequest = 'id' in m;
    const id = isRequest ? (m.id as Json) : null;
    if (m.jsonrpc !== '2.0' || typeof m.method !== 'string') return invalid(id);
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
            + 'call sigvara_check_agent; pass a threshold to get a yes or no, and pay only the onChain addresses it '
            + 'reports, never one the counterparty supplies.'
            + (audience === null ? '' : ' To check that the party you are dealing with holds the agent\'s key, send it '
              + 'the payload from sigvara_challenge and check its signature with sigvara_verify_proof.')
            + ' Nothing here signs or sends a transaction.',
        });
      }
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: listed });
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
  if (output === process.stdout) {
    // stdout now carries the protocol and nothing else. ethers writes to console.log when an RPC fails its
    // network detection, once a second until it answers, and any such line breaks the host's parser.
    const toStderr = (...a: unknown[]) => console.error(...a);
    console.log = toStderr;
    console.info = toStderr;
    console.debug = toStderr;
  }
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
      if (Array.isArray(msg) && msg.length === 0) {
        write({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
      } else if (Array.isArray(msg)) {
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
    } catch {
      // handle() turns every failure it expects into a reply, so this is a bug, and its text could carry
      // anything. Say only that it happened.
      const id = msg && typeof msg === 'object' && 'id' in msg ? (msg as { id: unknown }).id : null;
      write({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error' } });
    }
  }

  rl.on('line', (text) => { queue = queue.then(() => line(text)); });
  return new Promise((resolve) => rl.on('close', () => { queue.then(resolve); }));
}
