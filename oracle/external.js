'use strict';

// externalScore — the ERC-8004 cross-protocol trust factor (max 25).
//
// ERC-8004's Reputation Registry stores only raw, signed client feedback
// (int128 value + free-text tag) and leaves scoring off-chain. The spec and its
// best-practices guide suggest tags (starred on 0-100, uptime and successRate as
// percentages, reachable as 0 or 1), but nothing enforces them, and in the wild
// clients also invent their own (quality=85 on 0-100, win-rate=0.5 on 0-1,
// glicko2-mu=1500, e2e-test=4.5 on 0-5), so the registry's own average is
// meaningless. This module reads an agent's 8004 feedback and normalizes the
// dimensions it recognizes into a single 0-25 factor — the opinionated judgment
// the standard deliberately omits.
//
// Trust: an ERC-8004 identity is a transferable ERC-721. Before using an agent's
// feedback we verify the 8004 NFT is owned by the SAME wallet as the Sigvara
// operator, so no one can claim another agent's reputation. Opt-in: when the
// EXTERNAL_* env is unset the module is inert and every externalScore is 0.
//
// The registry accepts feedback from anyone, so which of it counts is decided by
// reviewers.js, not here: this module reads and normalizes, and externalScoreFor
// hands the rows to that judgment. Whoever can post could otherwise set how many reads an agent
// costs, so only addresses that paid the agent are read, up to these limits. Both operators apply
// them the same way, from the same evidence, so they read the same rows.

const { ethers } = require('ethers');
const { CAPS } = require('./score-caps');
const { readWithBackoff, MAX_BATCH_CALLS } = require('./read-retry');
const { accountRefused: registryRefused } = require('./payer-outcome');

const ID_ABI = [
  'function ownerOf(uint256) view returns (address)',
  'function getMetadata(uint256 agentId, string metadataKey) view returns (bytes)',
  'event MetadataSet(uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue)',
];
const REP_ABI = [
  'function getClients(uint256 agentId) view returns (address[])',
  'function getLastIndex(uint256 agentId, address clientAddress) view returns (uint64)',
  'function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex) view returns (int128 value, uint8 valueDecimals, string tag1, string tag2, bool isRevoked)',
];

const MAX_EXTERNAL_SCORE = CAPS.external;
const READ_TIMEOUT_MS = 8000;
// The factor is full at five independent reviewers (reviewers.js), so a hundred leaves room for those
// who do not qualify. The most paid come first, so pushing a reviewer out means out-paying it.
const MAX_CLIENTS_READ = 100;
// One rating per reviewer, however many reviews it posts, so its newest word is enough.
const MAX_ROWS_PER_CLIENT = 10;

// ---- pure normalization (the oracle's judgment; curated deliberately) -------
// Map a recognized feedback tag to a 0..1 rating. Unrecognized tags (bespoke
// rating systems, raw counts) are excluded rather than guessed, so the score
// stays meaningful. Extend this map on purpose, never blindly.
//
// The first four are the tags the ERC-8004 spec and erc-8004/best-practices
// (Reputation.md) give as examples, lowercased as every tag is here. `value` has
// already been divided by 10^valueDecimals, so uptime 9977 with 2 decimals
// arrives as 99.77. The guide's other examples are left out: ownerVerified says
// whether the agent's owner controls an endpoint, not how good the agent is, and
// responseTime, blocktimeFreshness, revenues and tradingYield have no fixed scale.
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const TAG_NORMALIZERS = {
  starred:     (v) => clamp01(v / 100),
  successrate: (v) => clamp01(v / 100),
  uptime:      (v) => clamp01(v / 100),
  reachable:   (v) => clamp01(v),
  quality:     (v) => clamp01(v / 100),
  trustscore:  (v) => clamp01(v / 100),
  reliability: (v) => clamp01(v / 100),
  accuracy:    (v) => clamp01(v / 100),
  credit:      (v) => clamp01(v / 100),
  'win-rate':  (v) => clamp01(v),
  rating:      (v) => clamp01(v / 5),
  'e2e-test':  (v) => clamp01(v / 5),
  stars:       (v) => clamp01(v / 5),
};

// rows: [{ value: Number, tag: String (already lowercased) }]. The mean of the
// recognized ratings, 0..1, or null when no row is in a tag this oracle reads.
function meanRating(rows) {
  const recognized = [];
  for (const r of rows) {
    // Own keys only. `tag` is text chosen by whoever posts the feedback, and a plain object also
    // answers to 'constructor' and '__proto__'. The first returned Object(value) and dragged the mean
    // up to the cap; the second is not a function, so this threw and externalScoreFor read it as 0.
    const norm = Object.hasOwn(TAG_NORMALIZERS, r.tag) ? TAG_NORMALIZERS[r.tag] : undefined;
    if (norm) recognized.push(norm(r.value));
  }
  if (!recognized.length) return null;
  return recognized.reduce((a, b) => a + b, 0) / recognized.length;
}

// The unfiltered mean scaled to the factor: what one reviewer's feedback would be worth
// on its own. The score itself comes from reviewers.js.
function computeExternalScore(rows) {
  const mean = meanRating(rows);
  return mean === null ? 0 : Math.round(mean * MAX_EXTERNAL_SCORE);
}

// ---- chain-connected side (opt-in) -----------------------------------------
let provider, idContract, repContract, enabled = false;

// Which chain the feed is actually reading, resolved from the provider rather than
// parsed out of the URL.
//
// This exists because `configured()` answers a question nobody was asking. It is a
// truthiness check on three environment strings, so it reported "configured" while the
// container held a stale RPC pointing at a different chain entirely, and it would report
// the same for an RPC pointing at nothing at all. A status that cannot fail is not a
// status. The chain id can fail, which is what makes it worth reporting.
//
// The URL is deliberately NOT exposed: an RPC endpoint often carries an API key in its
// path, and /health is public.
let chainId = null;
let chainIdError = null;
let resolving = false;


// deps lets tests inject fake contracts. Production (index.js) calls init(cfg).
function init(cfg, deps = {}) {
  enabled = !!(cfg.externalRpc && cfg.externalIdentity && cfg.externalReputation);
  if (!enabled) return;
  provider = deps.provider ?? new ethers.JsonRpcProvider(cfg.externalRpc, undefined, { batchMaxCount: MAX_BATCH_CALLS });
  idContract = deps.idContract ?? new ethers.Contract(cfg.externalIdentity, ID_ABI, provider);
  repContract = deps.repContract ?? new ethers.Contract(cfg.externalReputation, REP_ABI, provider);
  // A re-init points at a different chain, so anything cached about the old one is a
  // lie until proven otherwise.
  chainId = null;
  chainIdError = null;
}

/**
 * Resolve the feed's chain id and cache it. Safe to call repeatedly.
 *
 * Returns the id, or null when the feed is disabled or the chain could not be read.
 * Never throws: a health endpoint that fails because the thing it reports on is broken
 * tells you less than one that says so.
 */
async function refreshChainId() {
  if (!enabled || resolving) return chainId;
  resolving = true;
  try {
    const net = await withTimeout(provider.getNetwork());
    chainId = Number(net.chainId);
    chainIdError = null;
  } catch (err) {
    chainId = null;
    chainIdError = String((err && err.message) || err).slice(0, 120);
  } finally {
    resolving = false;
  }
  return chainId;
}

/**
 * What to report about the feed. Three outcomes, because "disabled" and "configured but
 * unreachable" are different problems and collapsing them hides the second one, which is
 * the one that happens by accident.
 */
function chainState() {
  if (!enabled) return { status: 'disabled', chainId: null };
  if (chainId !== null) return { status: 'configured', chainId };
  return { status: 'unreachable', chainId: null, error: chainIdError };
}

function configured() { return enabled; }

// The timer is cleared once the read settles. Left running, every read held a pending
// timer for the full timeout after it had already answered.
function withTimeout(promise) {
  let timer;
  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error('external read timeout')), READ_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// One read of a registry. Only a revert is the registry's own answer: no such agent, no such row.
// Anything else is the node, and says nothing about the agent, so it is tried again and then thrown.
// Read as no feedback, it lowers the score this oracle proposes, and a checker whose read succeeded
// records a divergence against an honest primary (chain.getAgentScore has the same rule). Thrown as
// a node's failure to callers that know that one, and with none of its message, which can hold the
// RPC's URL and so its key.
async function read(label, fn) {
  try {
    return await readWithBackoff(label, () => withTimeout(fn()), 4, (err) => !registryRefused(err));
  } catch (err) {
    if (registryRefused(err)) throw err;
    throw Object.assign(new Error(`could not read the ERC-8004 registry (${label})`), { code: 'NETWORK_ERROR' });
  }
}

// getClients -> per-client getLastIndex -> readFeedback. The registry is not
// enumerable and public RPCs cap getLogs ranges, so per-agent reads beat event
// scanning. ethers Result arrays are frozen, hence the Array.from copy.
//
// `blockTag`, when given, reads the registry as of that block (reviewers.js reads
// everything as of its snapshot); left out, at the latest block.
//
// `payers` is who may be a reviewer, most paid first and lowercased (reviewers.payersByAmount). Feedback
// from anyone else could not count, so it is not read at all. Left out, every client is a candidate.
async function readFeedbackRows(agentId, blockTag, payers) {
  if (payers && payers.length === 0) return [];
  const at = blockTag === undefined ? [] : [{ blockTag }];
  const posted = Array.from(await read('feedback clients', () => repContract.getClients(agentId, ...at)));
  const named = new Map(posted.map((c) => [String(c).toLowerCase(), c]));
  const clients = (payers ? payers.filter((p) => named.has(p)).map((p) => named.get(p)) : posted).slice(0, MAX_CLIENTS_READ);
  const rows = [];
  for (const c of clients) {
    let last = 0;
    try {
      last = Number(await read('feedback count', () => repContract.getLastIndex(agentId, c, ...at)));
    } catch (err) {
      if (registryRefused(err)) continue;
      throw err;
    }
    for (let i = Math.max(1, last - MAX_ROWS_PER_CLIENT + 1); i <= last; i++) {
      try {
        const fb = await read('feedback row', () => repContract.readFeedback(agentId, c, i, ...at));
        if (fb.isRevoked) continue;
        rows.push({ client: c, value: Number(fb.value) / 10 ** Number(fb.valueDecimals), tag: (fb.tag1 || '').toLowerCase() });
      } catch (err) {
        if (!registryRefused(err)) throw err; // a revert is an index gap, which is expected
      }
    }
  }
  return rows;
}

// True iff the 8004 agent NFT is owned by expectedOwner (same wallet across
// chains). Case-insensitive. A revert (no such agent) is "no"; a node that cannot answer is thrown.
async function verifyOwnership(agentId, expectedOwner, blockTag) {
  if (!enabled) return false;
  try {
    const owner = await read('8004 owner', () => idContract.ownerOf(agentId, ...(blockTag === undefined ? [] : [{ blockTag }])));
    return owner.toLowerCase() === String(expectedOwner).toLowerCase();
  } catch (err) {
    if (registryRefused(err)) return false;
    throw err;
  }
}

// ---- links made on chain (link-claims.js) -----------------------------------

async function latestBlock() {
  return Number(await withTimeout(provider.getBlockNumber()));
}

// The MetadataSet logs for `key` in blocks [fromBlock, toBlock], oldest first. The key is an
// indexed string, so the node filters on its hash and returns only these.
async function readLinkLogs(key, fromBlock, toBlock) {
  const logs = await withTimeout(idContract.queryFilter(idContract.filters.MetadataSet(null, key), fromBlock, toBlock));
  return logs
    .filter((e) => e.args.metadataKey === key)
    .map((e) => ({ agentId: e.args.agentId, value: e.args.metadataValue, blockNumber: e.blockNumber, logIndex: e.index }));
}

// Whether 8004 agent `agentId` still names `didHash` under `key` and is owned by `operator`, as
// of `blockTag` when given. Errors are the caller's to judge: a node that could not answer is not
// an agent that said no.
async function claimHolds(agentId, key, didHash, operator, blockTag) {
  const at = blockTag === undefined ? [] : [{ blockTag }];
  const [value, owner] = await Promise.all([
    withTimeout(idContract.getMetadata(agentId, key, ...at)),
    withTimeout(idContract.ownerOf(agentId, ...at)),
  ]);
  return String(value).toLowerCase() === String(didHash).toLowerCase()
    && String(owner).toLowerCase() === String(operator).toLowerCase();
}

// The owner of 8004 agent `agentId` as of `blockTag`. Throws when it has none, as the registry
// does for an agent not yet minted.
async function ownerAt(agentId, blockTag) {
  return String(await withTimeout(idContract.ownerOf(agentId, { blockTag })));
}

// externalScore for a linked agent. Re-verifies ownership every call (the NFT is
// transferable), then reads the feedback and returns what `judge` makes of it
// (reviewers.scoreFeedback, through index.js), both as of `blockTag` when given.
// An ownership mismatch or a registry that refuses yields 0. A node that cannot answer
// is thrown, as is an error from `judge`, which means a reviewer the node could not
// answer for. The caller skips the agent this epoch rather than propose a number it
// knows is wrong, as it does for a counterparty it could not read (chain.getAgentScore).
async function externalScoreFor(agentId, expectedOwner, judge, blockTag, payers) {
  if (!enabled) return 0;
  let rows;
  try {
    if (!(await verifyOwnership(agentId, expectedOwner, blockTag))) return 0;
    rows = await readFeedbackRows(agentId, blockTag, payers);
  } catch (err) {
    if (registryRefused(err)) return 0;
    throw err;
  }
  return judge(rows);
}

module.exports = {
  init, configured, meanRating, computeExternalScore, readFeedbackRows,
  verifyOwnership, externalScoreFor, TAG_NORMALIZERS, MAX_EXTERNAL_SCORE, MAX_CLIENTS_READ, MAX_ROWS_PER_CLIENT,
  refreshChainId, chainState, latestBlock, readLinkLogs, claimHolds, ownerAt,
};
