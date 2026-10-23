'use strict';

const { ethers } = require('ethers');

const IDENTITY_ABI = [
  'event AgentRegistered(bytes32 indexed didHash, address indexed operator, address indexed agentAddress, bytes32 ed25519PubKey)',
  'function getIdentity(bytes32 didHash) view returns (tuple(address operator, address agentAddress, bytes32 ed25519PubKey, uint8 status, uint256 registeredAt))',
  'function stakeView() view returns (address)',
  'function computeDidHash(address agentAddress) view returns (bytes32)',
];

const STAKE_VIEW_ABI = ['function hasMinimumStake(bytes32 didHash) view returns (bool)'];

const { SCORE_FACTORS } = require('./epoch-policy');

const OPERATOR_SET_ABI = ['function isActiveOperator(address) view returns (bool)'];

const REPUTATION_ABI = [
  'function operatorBond() view returns (address)',
  'function getTotalScore(bytes32 didHash) view returns (uint8)',
  'function getReputation(bytes32 didHash) view returns (tuple(uint8 feeScore, uint8 successScore, uint8 ageScore, uint8 externalScore, uint8 communityScore, uint8 propagationScore, uint256 lastUpdated))',
  'function proposeReputation(bytes32 didHash, tuple(uint8 feeScore, uint8 successScore, uint8 ageScore, uint8 externalScore, uint8 communityScore, uint8 propagationScore, uint256 lastUpdated) data, bytes32 evidenceRoot)',
  'function proposeIfEmpty(bytes32 didHash, tuple(uint8 feeScore, uint8 successScore, uint8 ageScore, uint8 externalScore, uint8 communityScore, uint8 propagationScore, uint256 lastUpdated) data, bytes32 evidenceRoot)',
  // Declared so ethers decodes the revert into a named error instead of raw bytes. A
  // checker that loses the race needs to tell that apart from a real failure.
  'error ScoreAlreadyPending(bytes32 didHash, uint256 proposedAt)',
  // Same reason. A pending proposal whose proposer has lost its authority (the operator was
  // removed, its signer cleared, or its role revoked) can never be finalized, and the epoch has
  // to tell that from a real failure.
  'error ProposerNotAuthorized(bytes32 didHash, address proposer)',
  // What a dry run says when the wallet is neither an active operator nor the signer of one: a
  // signer that was cleared, or an operator that was removed. Named so the log says so.
  'error OracleNotBonded(address oracle)',
  'function finalizeReputation(bytes32 didHash)',
  // evidenceRoot is decoded now, not dropped. A divergence without it says two operators
  // disagree; with it, a stranger can see they were scoring different evidence and go and
  // diff the two evidence sets themselves.
  'function getPendingScore(bytes32 didHash) view returns (tuple(tuple(uint8 feeScore, uint8 successScore, uint8 ageScore, uint8 externalScore, uint8 communityScore, uint8 propagationScore, uint256 lastUpdated) data, uint256 proposedAt, bool exists, bytes32 evidenceRoot))',
  'function challengeWindow() view returns (uint256)',
];
// Note: lastUpdated in the tuple above is required by the contract's function selector
// (ABI shape), but the contract always overwrites it with block.timestamp on finalize —
// see finalizeReputation() in SigvaraReputation.sol. The client-side value is discarded.

const FEE_ABI = [
  'function epochFee() view returns (uint256)',
  'function isCovered(bytes32 didHash) view returns (bool)',
  'function chargeEpoch(bytes32 didHash) returns (bool)',
  // An agent is charged once per epoch. Declared so that being told it was already charged
  // is not mistaken for a failure to pay.
  'error AlreadyCharged(bytes32 didHash, uint256 epoch)',
];

// Every custom error declared above, to name a revert from its data. See namedError.
const REVERT_NAMES = new ethers.Interface(
  [...REPUTATION_ABI, ...FEE_ABI].filter((fragment) => fragment.startsWith('error ')),
);

// AgentStatus enum — must match SigvaraIdentity.sol
const STATUS_SLASHED = 2;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- Safety around the RPC -------------------------------------------------
//
// The oracle trusts its RPC endpoint for three things it can check cheaply: which chain it
// is on, what a transaction costs, and whether a transaction landed. Each of them used to be
// taken on trust.

/** The RPC reports a different chain from the one this oracle was configured for. */
class ChainMismatchError extends Error {
  constructor(expected, actual, what = 'EXPECTED_CHAIN_ID') {
    super(
      what === 'state'
        ? `the state file belongs to chain ${expected} but the RPC reports chain ${actual}. Using it would ` +
          'mix one chain\'s records into another\'s. Point RPC_URL at the right chain, or move the state file aside.'
        : `${what} is ${expected} but the RPC reports chain ${actual}. Nothing will be signed until they agree.`,
    );
    this.code = 'CHAIN_MISMATCH';
    this.expected = expected;
    this.actual = actual;
  }
}

/** A transaction was refused before signing because its fee or total cost is above the cap. */
class FeeCapError extends Error {
  constructor(message) {
    super(message);
    this.code = 'FEE_CAP';
  }
}

/** A transaction was sent and has not been seen mined within the wait. It may still land. */
class TxUnconfirmedError extends Error {
  constructor(txHash, waitedMs, replacementHash = null) {
    super(
      `transaction ${txHash} was not mined within ${Math.round(waitedMs / 1000)}s` +
      (replacementHash ? ` (nor was its fee-bumped replacement ${replacementHash})` : '') +
      '; it may still land, and the next epoch will read the chain as it is',
    );
    this.code = 'TX_UNCONFIRMED';
    this.txHash = txHash;
    this.replacementHash = replacementHash;
  }
}

const DEFAULT_MAX_FEE_GWEI = 1000;
const DEFAULT_MAX_TX_COST = '1'; // native token units, which is USDC on Arc
const DEFAULT_TX_WAIT_MS = 60_000;
const DEFAULT_TX_POLL_MS = 1_500;

/**
 * A wallet that will not sign a transaction whose fee or worst-case cost is above a cap.
 *
 * The fee comes from the RPC. With no limit, an endpoint that reports a priority fee of a
 * few million gwei made one finalize spend nearly the whole float, and an endpoint that
 * is merely wrong does the same without meaning to. The check runs after ethers has filled
 * in the transaction and before anything is signed, so a refused transaction costs nothing.
 *
 * Two bounds, because they fail differently: a ceiling on the price of gas, and a ceiling
 * on price times the gas limit, which also catches an inflated gas estimate.
 */
class CappedWallet extends ethers.Wallet {
  constructor(privateKey, provider, caps) {
    super(privateKey, provider);
    this.caps = caps;
  }

  async populateTransaction(tx) {
    const populated = await super.populateTransaction(tx);
    assertWithinCaps(populated, this.caps);
    return populated;
  }
}

const gwei = (wei) => `${Number(ethers.formatUnits(wei, 'gwei')).toLocaleString('en-US', { maximumFractionDigits: 3 })} gwei`;

function assertWithinCaps(tx, { maxFeePerGas, maxTxCost }) {
  const perGas = tx.maxFeePerGas ?? tx.gasPrice;
  if (perGas == null) return;
  const price = BigInt(perGas);
  if (maxFeePerGas != null && price > maxFeePerGas) {
    throw new FeeCapError(
      `refusing to sign: the RPC set a fee of ${gwei(price)} per gas, above MAX_FEE_GWEI (${gwei(maxFeePerGas)})`,
    );
  }
  if (maxTxCost != null && tx.gasLimit != null) {
    const worst = price * BigInt(tx.gasLimit);
    if (worst > maxTxCost) {
      throw new FeeCapError(
        `refusing to sign: this transaction could cost ${ethers.formatEther(worst)} (gas limit ${tx.gasLimit} at ` +
        `${gwei(price)}), above MAX_TX_COST (${ethers.formatEther(maxTxCost)})`,
      );
    }
  }
}

function capsFromConfig(cfg) {
  return {
    maxFeePerGas: ethers.parseUnits(String(cfg.maxFeeGwei ?? DEFAULT_MAX_FEE_GWEI), 'gwei'),
    maxTxCost: ethers.parseEther(String(cfg.maxTxCost ?? DEFAULT_MAX_TX_COST)),
  };
}

let provider, wallet, identityContract, reputationContract, feeContract, cfg_;
let txWaitMs = DEFAULT_TX_WAIT_MS;
let txPollMs = DEFAULT_TX_POLL_MS;
let lastScannedBlock = null;
let knownAgents = new Map(); // didHash => { didHash, agentAddress, blockNumber }

// deps lets tests inject fake provider/wallet/contracts instead of connecting
// to a real RPC. Production usage (index.js) calls init(cfg) with no deps.
function init(cfg, deps = {}) {
  cfg_ = cfg;
  txWaitMs = cfg.txWaitMs ?? DEFAULT_TX_WAIT_MS;
  txPollMs = cfg.txPollMs ?? DEFAULT_TX_POLL_MS;
  provider = deps.provider ?? new ethers.JsonRpcProvider(cfg.rpcUrl);
  wallet = deps.wallet ?? new CappedWallet(cfg.privateKey, provider, capsFromConfig(cfg));
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

/**
 * A contract read, retried on the failures that are the node's fault rather than the
 * contract's.
 *
 * queryWithBackoff above does this for the log scan and nothing did it for the reads,
 * and the gap cost a real epoch. A scan burst exhausted a free-tier RPC's request
 * budget, the per-agent reads that followed inherited the throttling with no retry, and
 * every agent failed with CALL_EXCEPTION. The epoch then reported "0 proposed, 0
 * finalized, 0 diverged" and exited cleanly, which reads exactly like agreement. A
 * checker that silently audits nothing is worse than one that is visibly down.
 *
 * Retrying CALL_EXCEPTION needs justifying, because that is normally how a revert
 * arrives. The distinction is `err.data`: a genuine revert carries its payload there and
 * is rethrown on the first attempt. `data: null` means the node declined to execute at
 * all. Every call wrapped here is a view over plain storage that cannot revert for a
 * well-formed didHash, so no-data is a transport failure wearing a contract error's
 * clothes.
 *
 * Deliberately not applied to writes. proposeScore and finalizeScore race other parties
 * for one slot, and retrying a submission that may already be in the mempool is how you
 * pay twice for one epoch.
 */
/**
 * Whether a read failed because of the node and not because of what was asked of it: a throttle, a
 * timeout, a dropped connection, a call that came back empty with no revert data. readWithBackoff
 * retries these. A caller that is about to read a failed answer as "none" has to refuse to for these,
 * because the failure says nothing about the thing it was asking about.
 */
function isTransientReadError(err) {
  const msg = String((err && err.message) || err);
  const code = err && err.code;
  return /rate limit|429|too many requests|timeout|etimedout|econnreset|socket hang up/i.test(msg) ||
    code === 'SERVER_ERROR' || code === 'NETWORK_ERROR' || code === 'TIMEOUT' ||
    (code === 'CALL_EXCEPTION' && (err.data === null || err.data === undefined));
}

async function readWithBackoff(label, fn, attempts = 4) {
  let delay = 500;
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const code = err && err.code;
      if (!isTransientReadError(err) || i >= attempts - 1) throw err;
      console.log(`[oracle] ${label} failed (${code || 'error'}), retrying in ${delay}ms`);
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
          // Already in the event, so keeping it costs nothing and saves a read per
          // agent. The payment scanner needs it to refuse an operator paying its own
          // agent, which is the attested path's rule and must not become cheaper to
          // dodge just because the evidence now arrives by a different door.
          operator: e.args.operator,
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
  const id = await readWithBackoff('getIdentity', () => identityContract.getIdentity(didHash));
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

/**
 * didHash for an address, derived locally once that derivation has been checked against
 * the registry and asked of the chain until then.
 *
 * Same rule `getAgentScore` applies inline, exported because the badge endpoint needs it
 * too and a second copy of "derive it locally if that is safe" is a second place for the
 * two to drift apart.
 */
async function didHashFor(address) {
  return localDidHash
    ? didHashOf(address, localDidHash.chainId)
    : identityContract.computeDidHash(address);
}

/**
 * The finalized reputation tuple.
 *
 * `lastUpdated` is the reason this exists: it is 0 until a score is finalized, and it is
 * the only thing separating an agent scored zero from one nobody has scored yet.
 * `getTotalScore` returns 0 for both.
 */
async function getReputationData(didHash) {
  const rep = await readWithBackoff('getReputation', () => reputationContract.getReputation(didHash));
  return {
    feeScore: Number(rep.feeScore),
    successScore: Number(rep.successScore),
    ageScore: Number(rep.ageScore),
    externalScore: Number(rep.externalScore),
    communityScore: Number(rep.communityScore),
    propagationScore: Number(rep.propagationScore),
    lastUpdated: Number(rep.lastUpdated),
  };
}

async function getAgentScore(address) {
  try {
    return await readWithBackoff('payer standing', () => readStanding(address));
  } catch (err) {
    // A failure of the node says nothing about the counterparty. Read as "no standing" it lowers the
    // score this oracle proposes, and the checker, whose own reads succeeded, then records a divergence
    // against an honest primary. It was retried above; if it still fails, the caller skips the agent
    // for this epoch and tries again at the next, instead of scoring on a number it knows is wrong.
    if (isTransientReadError(err)) throw err;
    // Anything else is about the counterparty or the question, and has always meant no standing.
    return 0;
  }
}

async function readStanding(address) {
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

  // The HARD part of a counterparty's standing, not its total.
  //
  // Weighting by the total let a farmed score launder into someone else's. A sybil
  // that wash-traded its way to 100 raised its target's per-payer cap (trustMultiplier
  // doubles it) and counted as a fully trusted voucher (propagationScore). Measured:
  // scored sybils maxed the 30-point fee factor with four payers instead of six.
  //
  // externalScore is the one factor a single party cannot manufacture, because it is
  // ERC-8004 standing in a registry this protocol does not control. Capping it by the
  // matured total keeps the existing lag: an identity cannot link an 8004 history and
  // propagate it the same epoch, and a handover restarts maturity, so bought standing
  // is not instantly spendable through counterparties either.
  const [rep, matured] = await Promise.all([
    reputationContract.getReputation(didHash),
    reputationContract.getTotalScore(didHash),
  ]);
  return Math.min(Number(rep.externalScore), Number(matured));
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

// ---- Waiting for a transaction ----------------------------------------------

/** The node's own trouble, as opposed to an answer about the transaction. */
function isTransientRpc(err) {
  if (!err) return false;
  if (isRateLimited(err)) return true;
  const code = err.code;
  return code === 'SERVER_ERROR' || code === 'NETWORK_ERROR' || code === 'TIMEOUT'
    || /timeout|etimedout|econnreset|socket hang up|fetch failed/i.test(String(err.shortMessage || err.message || ''));
}

/**
 * The receipt of the first of `hashes` to be mined, or null once `deadline` passes.
 *
 * The node is polled here instead of leaning on tx.wait(). ethers polls inside the
 * provider, so a rate-limit error on one of those reads rejects the wait although the
 * transaction was mined: an epoch fee that had landed was reported as failed and charged
 * again next epoch. A read that fails for the node's own reasons is tried again here.
 */
async function pollReceipt(hashes, deadline) {
  for (;;) {
    for (const h of hashes) {
      try {
        const receipt = await provider.getTransactionReceipt(h);
        if (receipt) return { receipt, hash: h };
      } catch (err) {
        if (!isTransientRpc(err)) throw err;
      }
    }
    if (Date.now() >= deadline) return null;
    await sleep(Math.min(txPollMs, Math.max(0, deadline - Date.now())));
  }
}

function revertedError(tx, receipt) {
  const err = new Error('transaction execution reverted');
  err.code = 'CALL_EXCEPTION';
  err.receipt = receipt;
  err.transaction = { hash: tx.hash };
  return err;
}

/**
 * The same call at twice the fee, with the same nonce, or null when that cannot be done.
 *
 * Same nonce is what makes this safe where a blind resend is not. The original and the
 * replacement compete for one slot in the account's sequence, so at most one of them can
 * ever be mined and the epoch cannot be paid twice. A transaction that never reaches the
 * mempool is dropped for a fee below the base fee on Arc, silently, and the higher fee is
 * what lets it through. The wallet's caps apply as they do to any send.
 */
async function tryReplace(tx) {
  if (!tx || tx.nonce == null || !tx.to || tx.maxFeePerGas == null || tx.maxPriorityFeePerGas == null
      || tx.gasLimit == null || typeof wallet?.sendTransaction !== 'function') {
    return null;
  }
  try {
    return await wallet.sendTransaction({
      to: tx.to,
      data: tx.data,
      value: tx.value ?? 0n,
      nonce: tx.nonce,
      gasLimit: tx.gasLimit,
      type: 2,
      chainId: tx.chainId,
      maxFeePerGas: BigInt(tx.maxFeePerGas) * 2n,
      maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas) * 2n,
    });
  } catch (err) {
    // The caps refused it, or the node says the nonce is used because the original landed.
    console.warn(`[oracle] could not replace ${tx.hash}: ${err.shortMessage || err.message}`);
    return null;
  }
}

function settled(tx, { receipt, hash }) {
  if (receipt.status === 0) throw revertedError(tx, receipt);
  return { receipt, hash };
}

/**
 * Wait for a sent transaction to be mined, for a bounded time.
 *
 * tx.wait(1) had no timeout, and ethers sets none. A transaction the node dropped, or one
 * it never broadcast, left the wait pending for ever: the epoch never finished, its guard
 * stayed set, every later tick was skipped and /epoch answered 409, until someone
 * restarted the process.
 *
 * After TX_WAIT_SECONDS the transaction is replaced once, at a higher fee and the same
 * nonce (see tryReplace), and the replacement is given the same wait. If neither lands this
 * throws TxUnconfirmedError and the epoch moves on. Nothing is resent beyond that, which
 * keeps the rule the write paths have always had: never pay twice for one epoch.
 *
 * Resolves to { receipt, hash }, where hash is the transaction that was mined. Throws the
 * revert as ethers would for a transaction that was mined and failed.
 */
async function settle(tx) {
  const first = await pollReceipt([tx.hash], Date.now() + txWaitMs);
  if (first) return settled(tx, first);

  console.warn(
    `[oracle] ${tx.hash} was not mined within ${Math.round(txWaitMs / 1000)}s; ` +
    'sending it again at a higher fee with the same nonce',
  );
  const replacement = await tryReplace(tx);
  // With a replacement in flight it gets a full wait. Without one there is nothing new to
  // wait for, and a last look is all that is left.
  const second = await pollReceipt(
    replacement ? [tx.hash, replacement.hash] : [tx.hash],
    Date.now() + (replacement ? txWaitMs : 0),
  );
  if (second) return settled(tx, second);
  throw new TxUnconfirmedError(tx.hash, txWaitMs * (replacement ? 2 : 1), replacement?.hash ?? null);
}

function isTxUnconfirmed(err) { return !!err && err.code === 'TX_UNCONFIRMED'; }
function isFeeCap(err) { return !!err && err.code === 'FEE_CAP'; }

// ---- Which chain, and is anything stuck ----------------------------------------

/** The chain id as the node reports it now. Asked afresh: ethers caches the first answer. */
async function getChainId() {
  return Number(BigInt(await provider.send('eth_chainId', [])));
}

/**
 * The chain id, after checking it against the one this oracle was configured for.
 *
 * Nothing used to say which chain the RPC was on. A testnet URL beside mainnet addresses
 * fails loudly on the first call, but an endpoint that serves the wrong chain, or a failover
 * that lands on one, would have been signed against. Throws ChainMismatchError when
 * `expected` is given and the node disagrees.
 */
async function assertChainId(expected = null) {
  const actual = await readWithBackoff('chain id', getChainId);
  if (expected != null && actual !== Number(expected)) throw new ChainMismatchError(Number(expected), actual);
  return actual;
}

/**
 * How many of this wallet's transactions are pending: ones the node has accepted that no
 * block holds yet. Epochs run one at a time, so at the start of one the answer should be 0.
 * More means a transaction is stuck, and every transaction sent behind it waits for it.
 */
async function getNonceGap() {
  const [latest, pending] = await Promise.all([
    readWithBackoff('nonce', () => provider.getTransactionCount(wallet.address, 'latest')),
    readWithBackoff('pending nonce', () => provider.getTransactionCount(wallet.address, 'pending')),
  ]);
  return Math.max(0, Number(pending) - Number(latest));
}

/**
 * Propose a score.
 *
 * `ifEmpty` picks the compare-and-swap entry point, which reverts rather than replacing
 * a proposal that landed between the caller's check and this transaction. Checker mode
 * passes it; the primary does not, because replacing its own stale proposal with a
 * fresher one is the intended behaviour.
 *
 * Returns null when the slot was taken. That is a normal outcome for a checker covering
 * a gap, not a failure: it means the primary came back. Distinguishing it from a real
 * error is why ScoreAlreadyPending is in the ABI above.
 */
async function proposeScore(didHash, scores, evidenceRoot = ethers.ZeroHash, ifEmpty = false) {
  const method = ifEmpty ? 'proposeIfEmpty' : 'proposeReputation';
  const tx = await reputationContract[method](didHash, {
    feeScore:         scores.feeScore,
    successScore:     scores.successScore,
    ageScore:         scores.ageScore,
    externalScore:    scores.externalScore,
    communityScore:   scores.communityScore,
    propagationScore: scores.propagationScore,
    lastUpdated:      BigInt(Math.floor(Date.now() / 1000)),
  }, evidenceRoot);
  return (await settle(tx)).hash;
}

/**
 * Whether a proposal would be accepted right now, asked of the node without sending
 * anything. Returns { ok: true } or { ok: false, reason } when the contract itself says no
 * (the operator is not bonded, the agent is not scorable, the slot is taken).
 *
 * Exists so the epoch fee is not taken for a proposal that cannot land. The fee used to be
 * charged first and the proposal sent second, and when the oracle's bond lapsed every
 * charge succeeded while every proposal reverted: ten epochs, a hundred tokens charged,
 * no proposals, and /health still green. Anything that is not the contract refusing, such
 * as the node being down, is thrown rather than answered, so an unreachable node does not
 * read as "cannot propose" and does not read as "can" either.
 */
async function canPropose(didHash, scores, evidenceRoot = ethers.ZeroHash, ifEmpty = false) {
  const method = ifEmpty ? 'proposeIfEmpty' : 'proposeReputation';
  try {
    await readWithBackoff('simulate propose', () => reputationContract[method].staticCall(didHash, {
      feeScore:         scores.feeScore,
      successScore:     scores.successScore,
      ageScore:         scores.ageScore,
      externalScore:    scores.externalScore,
      communityScore:   scores.communityScore,
      propagationScore: scores.propagationScore,
      lastUpdated:      BigInt(Math.floor(Date.now() / 1000)),
    }, evidenceRoot));
    return { ok: true };
  } catch (err) {
    // A real revert carries its data. Without any, the node declined to execute at all, and
    // that is not the contract's answer.
    if (err && err.code === 'CALL_EXCEPTION' && err.data) {
      return { ok: false, reason: err.revert?.name || err.reason || err.shortMessage || 'reverted' };
    }
    throw err;
  }
}

/// A revert the contract named, matched on the decoded name first, then on the revert data, and
/// on the text last.
///
/// The data is read because ethers decodes a custom error only on a path that holds the
/// contract's interface, which is a call. A send that fails while its gas is estimated reaches
/// this code from the provider: `data` is set, `revert` is null, and the message says "unknown
/// custom error". That is how a real node answered the first time AlreadyCharged was seen live,
/// and a match on the name alone read it as an ordinary failure.
function namedError(err, name) {
  if (!err) return false;
  if (err.errorName === name) return true;
  if (err.revert && err.revert.name === name) return true;
  if (typeof err.data === 'string' && err.data.length >= 10) {
    let parsed = null;
    try { parsed = REVERT_NAMES.parseError(err.data); } catch { /* not an error this oracle knows */ }
    if (parsed && parsed.name === name) return true;
  }
  return new RegExp(name).test(String(err.shortMessage || err.message || ''));
}

/// True when finalizing was refused because whoever made the pending proposal can no longer
/// make it. Not a failure of this epoch: nothing can finalize that proposal, and the proposal
/// this oracle is about to make replaces it.
function isProposerNotAuthorized(err) { return namedError(err, 'ProposerNotAuthorized'); }

/// True when the agent was already charged in this epoch, by an earlier run of this oracle or
/// by someone else. The agent is covered for it, so it counts as paid.
function isAlreadyCharged(err) { return namedError(err, 'AlreadyCharged'); }

/// True when this error is the pending slot having been taken by someone else, rather
/// than anything being wrong. Matched as namedError does: decoded name, revert data, text.
function isSlotTaken(err) { return namedError(err, 'ScoreAlreadyPending'); }

/**
 * True when the node refused the request because we are being throttled, rather than
 * because anything is wrong with the transaction.
 *
 * Reads already treat throttling as transient and retry, in readWithBackoff. Writes
 * deliberately do not, and that is unchanged here: proposeScore and finalizeScore race
 * other parties for one slot, and resending something that may already be in the mempool
 * is how you pay twice for one epoch. This only names the cause.
 *
 * Naming it matters because the alternative was counting it as a propose failure.
 * `proposeErrors` should mean this operator could not do its job; on the live checker it
 * also meant the provider said slow down, which is a different problem with a different
 * fix, and the log line was a wall of JSON-RPC payload rather than a sentence.
 *
 * -32005 is the JSON-RPC code providers use for this. ethers wraps it in "could not
 * coalesce error" with the original nested inside, so the string match is doing real work
 * and is not just belt and braces.
 */
function isRateLimited(err) {
  if (!err) return false;
  const nested = err.error || err.info?.error || {};
  if (nested.code === -32005 || err.code === -32005) return true;
  return /rate limit|429|too many requests/i.test(
    String(err.shortMessage || err.message || '')
  );
}

async function finalizeScore(didHash) {
  const tx = await reputationContract.finalizeReputation(didHash);
  return (await settle(tx)).hash;
}

// Returns { exists, proposedAt } — proposedAt is 0 when no proposal is pending.
async function getPendingScore(didHash) {
  const pending = await readWithBackoff('getPendingScore', () => reputationContract.getPendingScore(didHash));
  // The factors come back too, for checker mode to compare against its own arithmetic.
  // The primary path reads only exists/proposedAt and is unaffected. Decoding is
  // positional over a fixed-size struct, so the fields land even though the ABI above
  // does not carry the trailing evidenceRoot.
  //
  // A field that does not decode to a finite number throws rather than returning a
  // half-populated object. SigvaraReputation is UUPS-upgradeable and inserting a field
  // into ReputationData would shift everything after it, so this is the difference
  // between a checker that stops and says why, and one that silently starts agreeing
  // with scores it can no longer read.
  const data = {};
  for (const f of SCORE_FACTORS) {
    const v = Number(pending.data?.[f]);
    // Only meaningful when something is pending. An empty slot decodes to a zeroed
    // struct that nothing compares against: decideCheckerAction returns 'propose' on
    // !exists without reading a single factor.
    if (!Number.isFinite(v)) {
      if (!pending.exists) continue;
      throw new Error(`getPendingScore: ${f} did not decode to a number (got ${pending.data?.[f]}); the ReputationData ABI may no longer match the contract`);
    }
    data[f] = v;
  }
  return {
    exists: pending.exists,
    proposedAt: Number(pending.proposedAt),
    data,
    evidenceRoot: pending.evidenceRoot ?? null,
  };
}

// The live, finalized score. Used by checker mode to tell a proposal that was finalized
// by someone else from one the slashing committee rejected: both leave pendingScores
// empty, and only one of them means the number went live.
async function getTotalScore(didHash) {
  return Number(await readWithBackoff('getTotalScore', () => reputationContract.getTotalScore(didHash)));
}

async function getChallengeWindow() {
  const seconds = await readWithBackoff('challengeWindow', () => reputationContract.challengeWindow());
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
  return (await settle(tx)).hash;
}

module.exports = {
  readWithBackoff,
  isSlotTaken,
  isProposerNotAuthorized,
  isAlreadyCharged,
  isRateLimited,
  init,
  reset,
  verifyDidHashDerivation,
  didHashOf,
  didHashFor,
  getReputationData,
  resetStakeViewCache,
  getRegisteredAgents,
  getAgentInfo,
  getProvider,
  isBonded,
  getAgentScore,
  isTransientReadError,
  getScanState,
  restoreScanState,
  operatorStanding,
  proposeScore,
  finalizeScore,
  getPendingScore,
  getTotalScore,
  getChallengeWindow,
  getLatestBlockTimestamp,
  pruneAgent,
  feeGatingConfigured,
  getEpochFee,
  isCovered,
  chargeEpoch,
  canPropose,
  settle,
  isTxUnconfirmed,
  isFeeCap,
  getChainId,
  assertChainId,
  getNonceGap,
  assertWithinCaps,
  CappedWallet,
  ChainMismatchError,
  FeeCapError,
  TxUnconfirmedError,
  STATUS_SLASHED,
};
