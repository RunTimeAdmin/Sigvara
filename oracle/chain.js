'use strict';

const { ethers } = require('ethers');

const IDENTITY_ABI = [
  'event AgentRegistered(bytes32 indexed didHash, address indexed operator, address indexed agentAddress, bytes32 ed25519PubKey)',
  'function getIdentity(bytes32 didHash) view returns (tuple(address operator, address agentAddress, bytes32 ed25519PubKey, uint8 status, uint256 registeredAt))',
  'function stakeView() view returns (address)',
  'function computeDidHash(address agentAddress) view returns (bytes32)',
];

const STAKE_VIEW_ABI = ['function hasMinimumStake(bytes32 didHash) view returns (bool)'];

const OPERATOR_SET_ABI = ['function isActiveOperator(address) view returns (bool)'];

const REPUTATION_ABI = [
  'function operatorBond() view returns (address)',
  'function getTotalScore(bytes32 didHash) view returns (uint8)',
  'function proposeReputation(bytes32 didHash, tuple(uint8 feeScore, uint8 successScore, uint8 ageScore, uint8 externalScore, uint8 communityScore, uint8 propagationScore, uint256 lastUpdated) data, bytes32 evidenceRoot)',
  'function finalizeReputation(bytes32 didHash)',
  'function getPendingScore(bytes32 didHash) view returns (tuple(tuple(uint8 feeScore, uint8 successScore, uint8 ageScore, uint8 externalScore, uint8 communityScore, uint8 propagationScore, uint256 lastUpdated) data, uint256 proposedAt, bool exists))',
  'function challengeWindow() view returns (uint256)',
];
// Note: lastUpdated in the tuple above is required by the contract's function selector
// (ABI shape), but the contract always overwrites it with block.timestamp on finalize —
// see finalizeReputation() in SigvaraReputation.sol. The client-side value is discarded.

const FEE_ABI = [
  'function epochFee() view returns (uint256)',
  'function isCovered(bytes32 didHash) view returns (bool)',
  'function chargeEpoch(bytes32 didHash) returns (bool)',
];

// AgentStatus enum — must match SigvaraIdentity.sol
const STATUS_SLASHED = 2;

const sleep = ms => new Promise(r => setTimeout(r, ms));

let provider, wallet, identityContract, reputationContract, feeContract, cfg_;
let lastScannedBlock = null;
let knownAgents = new Map(); // didHash => { didHash, agentAddress, blockNumber }

// deps lets tests inject fake provider/wallet/contracts instead of connecting
// to a real RPC. Production usage (index.js) calls init(cfg) with no deps.
function init(cfg, deps = {}) {
  cfg_ = cfg;
  provider = deps.provider ?? new ethers.JsonRpcProvider(cfg.rpcUrl);
  wallet = deps.wallet ?? new ethers.Wallet(cfg.privateKey, provider);
  identityContract = deps.identityContract ?? new ethers.Contract(cfg.identityAddress, IDENTITY_ABI, provider);
  reputationContract = deps.reputationContract ?? new ethers.Contract(cfg.reputationAddress, REPUTATION_ABI, wallet);

  // Epoch-fee gating is opt-in: only wired when FEE_REGISTRY_ADDRESS is set. When
  // absent, the oracle scores every agent as before (testnet default).
  feeContract = deps.feeContract ??
    (cfg.feeRegistryAddress ? new ethers.Contract(cfg.feeRegistryAddress, FEE_ABI, wallet) : null);
}

// Clears in-memory scan state — used between tests, not called in production.
function resetStakeViewCache() { stakeViewContract = undefined; }

function reset() {
  lastScannedBlock = null;
  knownAgents = new Map();
  // Cleared too: a test that swaps in a different registry must not inherit the
  // previous one's verdict on whether local derivation is safe.
  localDidHash = null;
}

// Returns ALL agents registered so far. Only scans new blocks since the last call
// (chunking getLogs into windows of chunkSize to stay within free-tier RPC limits,
// e.g. Alchemy: 10) and accumulates them into knownAgents, so repeated epochs don't
// rescan chain history but every previously-seen agent is still rescored each epoch.
/**
 * queryFilter with backoff on a rate-limited node.
 *
 * A public RPC will refuse a burst, and an epoch that gives up on the first refusal
 * loses the whole scan and retries the same burst an hour later. Backing off and
 * retrying the one chunk costs seconds and keeps the epoch.
 */
async function queryWithBackoff(filter, start, end, attempts = 4) {
  let delay = 1000;
  for (let i = 0; ; i++) {
    try {
      return await identityContract.queryFilter(filter, start, end);
    } catch (err) {
      const msg = String(err && err.message || err);
      const rateLimited = /rate limit|429|too many requests/i.test(msg);
      if (!rateLimited || i >= attempts - 1) throw err;
      console.log(`[oracle] rate limited scanning ${start}-${end}, retrying in ${delay}ms`);
      await sleep(delay);
      delay *= 2;
    }
  }
}

/// Scan progress, for the caller to persist. Without this a restart rescans the whole
/// chain from FROM_BLOCK, which grows without bound and is what tripped the public
/// RPC's rate limit after a day of blocks had accumulated.
function getScanState() {
  return { lastScannedBlock, agents: Array.from(knownAgents.values()) };
}

function restoreScanState(state) {
  if (!state || typeof state.lastScannedBlock !== 'number') return false;
  lastScannedBlock = state.lastScannedBlock;
  knownAgents = new Map((state.agents || []).map(a => [a.didHash, a]));
  return true;
}

async function getRegisteredAgents() {
  const chunkSize = cfg_.logChunkSize;
  const filter = identityContract.filters.AgentRegistered();
  const latest = await provider.getBlockNumber();
  const fromBlock = lastScannedBlock !== null ? lastScannedBlock + 1 : cfg_.fromBlock;

  if (fromBlock <= latest) {
    for (let start = fromBlock; start <= latest; start += chunkSize) {
      const end = Math.min(start + chunkSize - 1, latest);
      const chunk = await queryWithBackoff(filter, start, end);
      for (const e of chunk) {
        knownAgents.set(e.args.didHash, {
          didHash: e.args.didHash,
          agentAddress: e.args.agentAddress,
          blockNumber: e.blockNumber,
        });
      }
      // Checkpoint every chunk, not once at the end. A rate-limited node can stop a
      // long backfill part way through, and recording progress only on completion
      // threw away everything already scanned: the next attempt restarted from
      // FROM_BLOCK, hit the same limit at the same place, and never finished. Chunks
      // are processed in order, so the last completed one is a sound resume point.
      lastScannedBlock = end;
      if (end < latest) await sleep(400);
    }
  }

  return Array.from(knownAgents.values());
}

// Removes a slashed agent from the known set. Safe because Slashed is terminal in
// SigvaraIdentity and didHash is deterministic — the same address can never
// re-register, so there's no risk of losing track of an agent that could return.
function pruneAgent(didHash) {
  knownAgents.delete(didHash);
}

async function getAgentInfo(didHash) {
  const id = await identityContract.getIdentity(didHash);
  return {
    operator: id.operator,
    // The address payments must be made to for an attestation to count. It is
    // part of the DID, so it cannot be repointed after registration.
    agentAddress: id.agentAddress,
    registeredAt: Number(id.registeredAt),
    status: Number(id.status),
  };
}

/**
 * Whether this oracle may still propose scores.
 *
 * SigvaraReputation can require the proposer to be an admitted, bonded operator. When
 * it does and this wallet is not one, every propose reverts. Checking at startup turns
 * a silent hourly failure into one line at boot.
 *
 * Returns {enforced, allowed, operatorBond}. Unknown on an RPC failure is reported as
 * allowed, because refusing to start over a flaky node would be worse than trying.
 */
async function operatorStanding() {
  try {
    const addr = await reputationContract.operatorBond();
    if (!addr || addr === ethers.ZeroAddress) {
      return { enforced: false, allowed: true, operatorBond: null };
    }
    const set = new ethers.Contract(addr, OPERATOR_SET_ABI, provider);
    return {
      enforced: true,
      allowed: await set.isActiveOperator(wallet.address),
      operatorBond: addr,
    };
  } catch {
    return { enforced: false, allowed: true, operatorBond: null };
  }
}

/**
 * The Sigvara score of the agent at `address`, or 0 if there is no agent there.
 *
 * A counterparty's own standing is what makes the web of trust weigh anything: a
 * payment from a reputable agent is better evidence than one from a wallet nobody
 * knows. Deliberately reads the MATURED score, the one getTotalScore serves, because
 * it lags what has just been earned and so damps the reflexivity of A's score lifting
 * B's while B's lifts A's.
 *
 * Failures read as 0. An unknown counterparty and an unreachable node both mean "no
 * evidence of standing", and the safe direction is to grant no bonus.
 */
/**
 * The DID hash, derived rather than fetched.
 *
 * keccak256(abi.encodePacked("did:sigvara:", chainid, ":", agentAddress)) — the same
 * expression SigvaraIdentity evaluates, and the reason it is computed on chain at
 * registration is precisely so anyone can reproduce it without asking.
 */
function didHashOf(address, chainId) {
  return ethers.keccak256(ethers.solidityPacked(
    ['string', 'uint256', 'string', 'address'],
    ['did:sigvara:', BigInt(chainId), ':', ethers.getAddress(address)]
  ));
}

// Whether the local derivation has been checked against the deployed registry. Null
// until checked, so an unchecked process falls back to the chain rather than guessing.
let localDidHash = null;

/**
 * Check the local derivation once, against the registry, and use it only if it agrees.
 *
 * A locally derived hash that drifted from the contract would not be slow, it would be
 * wrong: every counterparty would resolve to an unregistered DID and score 0, quietly
 * flattening the web of trust. One round trip per process is a cheap way never to have
 * that argument. Failure leaves it off, which is the old behaviour.
 */
async function verifyDidHashDerivation() {
  const probe = '0x0000000000000000000000000000000000000001';
  try {
    const chainId = (await provider.getNetwork()).chainId;
    const onchain = await identityContract.computeDidHash(probe);
    localDidHash = onchain === didHashOf(probe, chainId) ? { chainId } : null;
    if (!localDidHash) {
      console.warn('[oracle] local didHash derivation disagrees with the registry; using the chain');
    }
    return localDidHash !== null;
  } catch {
    localDidHash = null;
    return false;
  }
}

async function getAgentScore(address) {
  try {
    // Was three serial round trips per counterparty. The first is now arithmetic when
    // the derivation has been verified, so it is two, and those two are genuinely
    // dependent. At ~124 ms a call on Arc that is a third off every payer lookup, and
    // payer lookups are the bulk of what an epoch spends its time on.
    const didHash = localDidHash
      ? didHashOf(address, localDidHash.chainId)
      : await identityContract.computeDidHash(address);

    const id = await identityContract.getIdentity(didHash);
    if (Number(id.registeredAt) === 0) return 0;
    if (Number(id.status) === STATUS_SLASHED) return 0;
    return Number(await reputationContract.getTotalScore(didHash));
  } catch {
    return 0;
  }
}

/// Read-only provider, for modules that verify transactions the oracle did not send.
function getProvider() {
  return provider;
}

// Resolved once: the identity registry's stake view never changes after wiring.
let stakeViewContract;

/**
 * Whether the agent holds the minimum bond.
 *
 * SigvaraReputation refuses to score an unbonded agent, so this is an optimisation:
 * skipping them here avoids spending gas on a proposal that would revert. It fails
 * OPEN on purpose. If the stake view cannot be read, the oracle proceeds and lets the
 * contract decide, because the contract is the authority and an oracle that silently
 * stopped scoring everyone on an RPC hiccup would be worse than a wasted transaction.
 */
async function isBonded(didHash) {
  try {
    if (stakeViewContract === undefined) {
      const addr = await identityContract.stakeView();
      stakeViewContract = addr && addr !== ethers.ZeroAddress
        ? new ethers.Contract(addr, STAKE_VIEW_ABI, provider)
        : null;
    }
    if (!stakeViewContract) return true;
    return await stakeViewContract.hasMinimumStake(didHash);
  } catch {
    return true;
  }
}

async function proposeScore(didHash, scores, evidenceRoot = ethers.ZeroHash) {
  const tx = await reputationContract.proposeReputation(didHash, {
    feeScore:         scores.feeScore,
    successScore:     scores.successScore,
    ageScore:         scores.ageScore,
    externalScore:    scores.externalScore,
    communityScore:   scores.communityScore,
    propagationScore: scores.propagationScore,
    lastUpdated:      BigInt(Math.floor(Date.now() / 1000)),
  }, evidenceRoot);
  await tx.wait(1);
  return tx.hash;
}

async function finalizeScore(didHash) {
  const tx = await reputationContract.finalizeReputation(didHash);
  await tx.wait(1);
  return tx.hash;
}

// Returns { exists, proposedAt } — proposedAt is 0 when no proposal is pending.
async function getPendingScore(didHash) {
  const pending = await reputationContract.getPendingScore(didHash);
  return { exists: pending.exists, proposedAt: Number(pending.proposedAt) };
}

async function getChallengeWindow() {
  const seconds = await reputationContract.challengeWindow();
  return Number(seconds);
}

// The contract compares against block.timestamp, so epoch decisions should use
// the chain's clock rather than the oracle host's (local skew ahead of the chain
// would trigger premature finalize attempts that just revert and waste gas).
async function getLatestBlockTimestamp() {
  const block = await provider.getBlock('latest');
  return Number(block.timestamp);
}

// ---- Epoch-fee gating (opt-in) --------------------------------------------

// True when a fee registry is configured. When false, all fee helpers below are
// no-ops that report "covered" so the epoch loop scores everyone.
function feeGatingConfigured() {
  return !!feeContract;
}

// Current per-epoch fee in wei. 0 means gating is effectively disabled on-chain.
async function getEpochFee() {
  if (!feeContract) return 0n;
  return feeContract.epochFee();
}

async function isCovered(didHash) {
  if (!feeContract) return true;
  return feeContract.isCovered(didHash);
}

// Charges one epoch fee for the agent. The registry reverts when the agent is not
// covered, so a silent no-op is not possible: a failure here surfaces as a thrown
// error and the caller skips the agent rather than scoring it for free.
async function chargeEpoch(didHash) {
  if (!feeContract) return;
  const tx = await feeContract.chargeEpoch(didHash);
  await tx.wait(1);
  return tx.hash;
}

module.exports = {
  init,
  reset,
  verifyDidHashDerivation,
  didHashOf,
  resetStakeViewCache,
  getRegisteredAgents,
  getAgentInfo,
  getProvider,
  isBonded,
  getAgentScore,
  getScanState,
  restoreScanState,
  operatorStanding,
  proposeScore,
  finalizeScore,
  getPendingScore,
  getChallengeWindow,
  getLatestBlockTimestamp,
  pruneAgent,
  feeGatingConfigured,
  getEpochFee,
  isCovered,
  chargeEpoch,
  STATUS_SLASHED,
};
