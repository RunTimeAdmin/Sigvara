'use strict';

/**
 * ERC-8183 (Agentic Commerce) as an evidence source.
 *
 * A job under ERC-8183 is escrow with a verdict: a client funds it, a provider submits
 * work, and a named evaluator calls complete() or reject(). Everything Sigvara scores
 * on is therefore already on chain, and the one thing the oracle has never been able to
 * check for itself comes with it.
 *
 * Today the success bit arrives in an attestation, asserted by whoever submits it. The
 * oracle proves a payment settled and takes "it went well" on trust. Under ERC-8183 the
 * verdict is a log entry written by an address that is neither the agent nor, usually,
 * the party paying for the work. Nobody has to be instrumented, nothing is
 * self-reported, and an agent cannot route around it by shelling out, because the money
 * and the verdict are the same transaction.
 *
 * ## Deliberately read-only
 *
 * This module observes. It does not feed scores, and the flag that enables it is off by
 * default, for two reasons that both resolve with time rather than work:
 *
 *   - ERC-8183 is a Draft ERC (created 2026-02-25). Event signatures in a draft can
 *     change, and an indexer pinned to signatures that moved does not fail loudly, it
 *     silently sees no jobs and reports an agent as having done nothing.
 *   - There is no canonical deployment on Arc. The contracts found there so far are
 *     individual demos, quiet for thousands of blocks.
 *
 * Reading first and scoring later is the same discipline the roadmap already applies to
 * gating: measure against real traffic, then decide the thresholds. Turning this into a
 * scoring input before either of the above settles would mean calibrating against a
 * standard that is still moving.
 *
 * ## What it refuses, and why
 *
 * A job is only evidence when the verdict was not written by the party it flatters:
 *
 *   client === provider     an agent paying itself. Same rule as payments.isSelfPayment.
 *   evaluator === provider  an agent grading its own work. The spec does not forbid it,
 *                           and it is the obvious way to farm a perfect record.
 *
 * `evaluator === client` is allowed but recorded, because a buyer accepting their own
 * delivery is ordinary commerce and weaker evidence than a third party. The caller
 * decides what to do with that; this module will not quietly treat them as equal.
 *
 * Expired and refunded jobs produce no evidence at all. Expiry means nobody evaluated in
 * time, which can as easily be the client failing to act as the provider failing to
 * deliver. Counting it against the provider would hand any client a way to damage an
 * agent by doing nothing, which is the same hole that keeps negative attestation closed
 * elsewhere in this system.
 */

const { ethers } = require('ethers');

/**
 * Event signatures, in one place, spelled out.
 *
 * Every topic below is derived from these strings at load. When the draft changes a
 * signature, this is the only edit, and `EVENT_SIGNATURES` can be diffed against the
 * spec by eye. Hard-coding the resulting topic hashes would make that comparison
 * impossible without a keccak tool.
 */
const EVENT_SIGNATURES = {
  JobCreated: 'JobCreated(uint256,address,address,address,uint256,address)',
  JobFunded: 'JobFunded(uint256,address,uint256)',
  JobSubmitted: 'JobSubmitted(uint256,address,bytes32)',
  JobCompleted: 'JobCompleted(uint256,address,bytes32)',
  JobRejected: 'JobRejected(uint256,address,bytes32)',
  PaymentReleased: 'PaymentReleased(uint256,address,uint256)',
  Refunded: 'Refunded(uint256,address,uint256)',
  JobExpired: 'JobExpired(uint256)',
};

const TOPICS = Object.fromEntries(
  Object.entries(EVENT_SIGNATURES).map(([name, sig]) => [name, ethers.id(sig)]),
);

/** topic0 -> event name, for decoding a mixed log stream. */
const BY_TOPIC = new Map(Object.entries(TOPICS).map(([name, topic]) => [topic, name]));

const IFACE = new ethers.Interface(
  Object.values(EVENT_SIGNATURES).map((sig) => {
    const [name, args] = [sig.slice(0, sig.indexOf('(')), sig.slice(sig.indexOf('(') + 1, -1)];
    // Indexed-ness matters for decoding and is not in the bare signature, so it is
    // restated here, matching the EIP.
    const INDEXED = {
      JobCreated: [true, true, true, false, false, false],
      JobFunded: [true, true, false],
      JobSubmitted: [true, true, false],
      JobCompleted: [true, true, false],
      JobRejected: [true, true, false],
      PaymentReleased: [true, true, false],
      Refunded: [true, true, false],
      JobExpired: [true],
    }[name];
    const NAMES = {
      JobCreated: ['jobId', 'client', 'provider', 'evaluator', 'expiredAt', 'hook'],
      JobFunded: ['jobId', 'client', 'amount'],
      JobSubmitted: ['jobId', 'provider', 'deliverable'],
      JobCompleted: ['jobId', 'evaluator', 'reason'],
      JobRejected: ['jobId', 'rejector', 'reason'],
      PaymentReleased: ['jobId', 'provider', 'amount'],
      Refunded: ['jobId', 'client', 'amount'],
      JobExpired: ['jobId'],
    }[name];
    const params = args
      .split(',')
      .map((t, i) => `${t}${INDEXED[i] ? ' indexed' : ''} ${NAMES[i]}`)
      .join(', ');
    return `event ${name}(${params})`;
  }),
);

class JobsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function readConfig(env = process.env) {
  const registry = (env.JOBS_REGISTRY_ADDRESS || '').trim();
  if (registry && !ethers.isAddress(registry)) {
    throw new JobsError('bad_registry', 'JOBS_REGISTRY_ADDRESS must be an address');
  }
  return {
    // Off unless an address is given. No default address on purpose: there is no
    // canonical ERC-8183 deployment to point at, and guessing one would read an
    // unrelated contract's logs as though they were jobs.
    registry: registry ? ethers.getAddress(registry) : '',
    // Its own RPC, defaulting to the oracle's. The registry may live on a different
    // chain than the protocol, exactly as the ERC-8004 feed may.
    rpcUrl: (env.JOBS_RPC || env.RPC_URL || '').trim(),
    fromBlock: Number(env.JOBS_FROM_BLOCK || 0),
    chunkSize: Math.max(1, Number(env.JOBS_LOG_CHUNK || env.LOG_CHUNK_SIZE || 2000)),
  };
}

function enabled(cfg) {
  return Boolean(cfg && cfg.registry && cfg.rpcUrl);
}

// ---------------------------------------------------------------------------
// Decoding and assembly. Pure: no provider, no clock.
// ---------------------------------------------------------------------------

/**
 * Decode one log into `{ name, jobId, args, txHash, blockNumber }`, or null when the
 * topic is not one of ours.
 *
 * A registry that emits events this module does not know is normal, not an error: the
 * draft may add some, and a shared contract may carry unrelated ones. Skipping quietly
 * is right. Failing to decode one we *do* claim to know is not, and throws.
 */
function decodeLog(log) {
  if (!log || !Array.isArray(log.topics) || !log.topics.length) return null;
  const name = BY_TOPIC.get(log.topics[0]);
  if (!name) return null;

  const parsed = IFACE.parseLog({ topics: log.topics, data: log.data });
  if (!parsed) throw new JobsError('undecodable', `${name} log did not decode`);

  return {
    name,
    jobId: parsed.args.jobId.toString(),
    args: parsed.args,
    txHash: log.transactionHash ?? null,
    blockNumber: log.blockNumber ?? null,
  };
}

/**
 * Fold a stream of decoded logs into one record per job.
 *
 * Order matters only in that later events overwrite earlier ones for the same field,
 * which is the behaviour the lifecycle wants: a job reaches exactly one terminal state,
 * and a re-emitted funding would be the later truth.
 *
 * @param {Array} decoded from decodeLog
 * @param {Map<number, number>} [blockTimes] block number -> unix seconds
 */
function assembleJobs(decoded, blockTimes = new Map()) {
  const jobs = new Map();
  const get = (id) => {
    if (!jobs.has(id)) {
      jobs.set(id, {
        jobId: id,
        client: null,
        provider: null,
        evaluator: null,
        funded: null,
        released: null,
        state: 'open',
        verdictBy: null,
        verdictTxHash: null,
        verdictBlock: null,
        settledAt: null,
      });
    }
    return jobs.get(id);
  };

  for (const d of decoded) {
    if (!d) continue;
    const j = get(d.jobId);
    const a = d.args;

    switch (d.name) {
      case 'JobCreated':
        j.client = a.client;
        j.provider = a.provider;
        j.evaluator = a.evaluator;
        break;
      case 'JobFunded':
        j.client = a.client; // the address the money actually came from
        j.funded = a.amount.toString();
        break;
      case 'PaymentReleased':
        j.provider = a.provider;
        j.released = a.amount.toString();
        break;
      case 'JobCompleted':
        j.state = 'completed';
        j.verdictBy = a.evaluator;
        j.verdictTxHash = d.txHash;
        j.verdictBlock = d.blockNumber;
        break;
      case 'JobRejected':
        j.state = 'rejected';
        j.verdictBy = a.rejector;
        j.verdictTxHash = d.txHash;
        j.verdictBlock = d.blockNumber;
        break;
      case 'JobExpired':
        // Only if nothing already decided it. An expiry log arriving after a verdict is
        // bookkeeping, not a reversal.
        if (j.state === 'open') j.state = 'expired';
        break;
      case 'Refunded':
        if (j.state === 'open') j.state = 'refunded';
        break;
      default:
        break; // JobSubmitted carries no field this record keeps
    }
  }

  for (const j of jobs.values()) {
    if (j.verdictBlock !== null && blockTimes.has(j.verdictBlock)) {
      j.settledAt = blockTimes.get(j.verdictBlock) * 1000;
    }
  }
  return [...jobs.values()];
}

const same = (a, b) => Boolean(a && b && String(a).toLowerCase() === String(b).toLowerCase());

/**
 * Why a job is not usable as evidence, or null when it is.
 *
 * Returned as a reason rather than a boolean so the caller can report what it dropped.
 * A silent filter here would look identical to an agent that simply had no jobs.
 */
function rejectionReason(job) {
  if (!job) return 'missing';
  if (job.state !== 'completed' && job.state !== 'rejected') return `not_terminal:${job.state}`;
  if (!job.provider) return 'no_provider';
  if (!job.client) return 'no_client';
  if (same(job.client, job.provider)) return 'self_paid';
  // The verdict is the whole value of this source. An agent that signed its own is
  // supplying nothing the old attestation path did not already supply on trust.
  if (same(job.verdictBy, job.provider)) return 'self_evaluated';
  if (job.settledAt === null) return 'no_settled_at';
  return null;
}

/**
 * Turn jobs into the evidence shape the rest of the oracle already speaks:
 * `{ txHash, payer, amount, settledAt, success }`.
 *
 * Those are exactly the five fields the merkle leaf commits to, which is why this needs
 * no change to the leaf format and no new evidence version. A job simply arrives as one
 * more settled payment with a verdict attached.
 *
 * A rejected job carries amount 0. The provider was not paid, so it contributes nothing
 * to fee volume, while still counting against the success rate. Recording the escrowed
 * figure instead would pay an agent, in score, for work that was refused.
 */
function toEvidence(jobs, providerAddress) {
  const kept = [];
  const dropped = [];

  for (const job of jobs) {
    if (!same(job.provider, providerAddress)) continue;

    const why = rejectionReason(job);
    if (why) {
      dropped.push({ jobId: job.jobId, reason: why });
      continue;
    }

    const success = job.state === 'completed';
    kept.push({
      txHash: job.verdictTxHash,
      payer: job.client,
      amount: success ? String(job.released ?? job.funded ?? '0') : '0',
      settledAt: job.settledAt,
      success,
      // Not part of the leaf. Corroboration the caller may weigh: a verdict written by
      // the paying client is ordinary commerce, but it is not a third party.
      independentEvaluator: !same(job.verdictBy, job.client),
      jobId: job.jobId,
    });
  }

  return { evidence: kept, dropped };
}

// ---------------------------------------------------------------------------
// Chain-connected side
// ---------------------------------------------------------------------------

/**
 * Fetch job logs in chunks.
 *
 * Chunked for the same reason the identity scan is: a public RPC refuses a wide
 * getLogs range, and one refusal must not lose the whole scan.
 */
async function scanLogs({ provider, cfg }, fromBlock, toBlock) {
  if (!enabled(cfg)) throw new JobsError('disabled', 'ERC-8183 reader is not configured');

  const out = [];
  for (let start = fromBlock; start <= toBlock; start += cfg.chunkSize) {
    const end = Math.min(start + cfg.chunkSize - 1, toBlock);
    const logs = await provider.getLogs({
      address: cfg.registry,
      fromBlock: start,
      toBlock: end,
      topics: [Object.values(TOPICS)], // any of ours
    });
    out.push(...logs);
  }
  return out;
}

/**
 * The registry's provider.
 *
 * Built here rather than by the caller so index.js does not need ethers of its own, and
 * so the RPC that reads jobs stays the one this module's config names.
 */
function makeProvider(cfg) {
  if (!enabled(cfg)) return null;
  return new ethers.JsonRpcProvider(cfg.rpcUrl);
}

/** Block timestamps for the blocks a set of decoded logs actually lands in. */
async function blockTimesFor(provider, decoded) {
  const needed = [...new Set(decoded.filter((d) => d && d.blockNumber !== null).map((d) => d.blockNumber))];
  const times = new Map();
  for (const n of needed) {
    const block = await provider.getBlock(n);
    if (block) times.set(n, Number(block.timestamp));
  }
  return times;
}

/** Read and assemble every job the registry has emitted in a block range. */
async function readJobs({ provider, cfg }, fromBlock, toBlock) {
  const logs = await scanLogs({ provider, cfg }, fromBlock, toBlock);
  const decoded = logs.map(decodeLog).filter(Boolean);
  const times = await blockTimesFor(provider, decoded);
  return assembleJobs(decoded, times);
}

module.exports = {
  EVENT_SIGNATURES,
  TOPICS,
  JobsError,
  readConfig,
  enabled,
  decodeLog,
  assembleJobs,
  rejectionReason,
  toEvidence,
  scanLogs,
  readJobs,
  makeProvider,
};
