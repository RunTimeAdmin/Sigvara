'use strict';

require('dotenv').config();

// Before any module reads its own settings. A typo in a numeric one used to turn a control
// off without a word: PAYMENT_MAX_PER_PAYER=four removed the per-payer cap. See config.js.
require('./config').requireValidNumericConfig('oracle');
// Likewise the mode: a typo here does not turn a control off, it picks the wrong role.
{
  const modeErr = require('./config').oracleModeError(process.env.ORACLE_MODE);
  if (modeErr) {
    console.error(`[oracle] ${modeErr}`);
    process.exit(1);
  }
}

const http = require('http');
const chain = require('./chain');
const external = require('./external');
const { computeScore } = require('./scoring');
const {
  decideAction, decideCheckerAction, scoreDivergence,
  epochIntervalError, divergenceToleranceError, DEFAULT_DIVERGENCE_TOLERANCE,
  mapChunked, clockSkewError, scoringIsStale,
} = require('./epoch-policy');
const {
  json, readBody, bodyErrorStatus, readCredentials, identifyCaller, mayAttestUnauthenticated, parseScorePath, parseDidHash,
  rateLimited, clientKey, adminTokenPolicyError, runningCommit,
  parseTrustedProxies, parseRequestTarget, readScopes, mayUse, weakCredentials, MIN_TOKEN_LENGTH,
} = require('./http-helpers');
const payments = require('./payments');
const merkle = require('./merkle');
const { createResponseCache } = require('./response-cache');
const badge = require('./badge');
const jobs = require('./jobs');
const paymentScan = require('./payment-scan');
const metrics = require('./metrics');
const { readPrivateKey } = require('./secrets');

// Verified-payment settings. Read once at startup so a malformed value fails the
// process rather than silently disabling verification on the first request.
const paymentCfg = payments.readConfig();

// A minimum of zero with verification on means a transfer of one unit counts as a payment,
// so a counterparty that is not real costs only the gas to send it. The setting is easy to
// leave at its default, so the process refuses to start rather than run that way. (A
// zero-value transfer never counts, whatever this is; see payments.countsAsPayment.)
if (payments.required(paymentCfg) && paymentCfg.minAmount <= 0n) {
  console.error(
    '[oracle] PAYMENT_VERIFICATION=required needs PAYMENT_MIN_AMOUNT above 0, in the asset\'s base ' +
    'units (10000 is one cent of 6-decimal USDC). At 0, a transfer of a single unit counts as a payment.',
  );
  process.exit(1);
}

// ERC-8183 job registry, read-only and off unless JOBS_REGISTRY_ADDRESS is set. Parsed
// at startup so a malformed address stops the process rather than failing on the first
// request, the same way the payment config does.
const paymentScanCfg = paymentScan.readConfig();
const jobsCfg = jobs.readConfig();
/**
 * Widest block range one /jobs request may scan. Module scope because the /jobs handler
 * reads it: declared inside runEpochInner it was out of reach there, and every /jobs
 * request threw a ReferenceError and answered 502.
 */
const JOBS_MAX_SPAN = Number(process.env.JOBS_MAX_SPAN || 50_000);
let jobsProvider = null;
let jobsChainId = null;


// ---- Config ----------------------------------------------------------------

const trimTrailingSlash = (u) => String(u).endsWith('/') ? String(u).replace(/\/+$/, '') : String(u);

// From ORACLE_PRIVATE_KEY_FILE or ORACLE_PRIVATE_KEY. Read inside a try so that a malformed
// key stops the process with a fixed message: ethers puts the whole value in its own error,
// and a restart loop would print it on every restart. See secrets.js.
let privateKey = '';
try {
  privateKey = readPrivateKey();
} catch (err) {
  console.error(`[oracle] ${err.message}`);
  process.exit(1);
}

const cfg = {
  rpcUrl:            process.env.RPC_URL            || '',
  privateKey,
  identityAddress:   process.env.IDENTITY_ADDRESS   || '',
  reputationAddress: process.env.REPUTATION_ADDRESS || '',
  epochMs:           Number(process.env.EPOCH_HOURS || 24) * 3_600_000,
  host:              process.env.HOST || '127.0.0.1',
  port:              Number(process.env.PORT || 3030),
  fromBlock:         Number(process.env.FROM_BLOCK  || 0),
  logChunkSize:      Number(process.env.LOG_CHUNK_SIZE || 2000),
  adminToken:        process.env.ORACLE_ADMIN_TOKEN || '',
  // name -> token, from ORACLE_ADMIN_TOKEN and every ORACLE_TOKEN_<NAME>. Read once so
  // a credential cannot be added or revoked without a restart anyone can see.
  credentials:       readCredentials(),
  // Optional: SigvaraEpochFees address. When set (and its on-chain epochFee > 0),
  // the oracle only scores agents with fee coverage and charges them per epoch.
  feeRegistryAddress: process.env.FEE_REGISTRY_ADDRESS || '',
  // Optional: ERC-8004 registries (typically Base Sepolia) for the externalScore
  // factor. When all three are set, linked agents get an external-trust score from
  // their 8004 feedback; unset leaves externalScore at 0. See external.js.
  externalRpc:        process.env.EXTERNAL_RPC || '',
  externalIdentity:   process.env.EXTERNAL_IDENTITY_ADDRESS || '',
  externalReputation: process.env.EXTERNAL_REPUTATION_ADDRESS || '',
  // Checker mode: a second bonded operator that audits the primary's proposals rather
  // than racing them. It scores every agent independently and compares; it proposes only
  // when nothing is pending, and never finalizes or overwrites a score it disputes.
  // See decideCheckerAction in epoch-policy.js for why those two prohibitions matter.
  checkerMode:        process.env.ORACLE_MODE === 'checker',
  divergenceTolerance: Number(process.env.DIVERGENCE_TOLERANCE || DEFAULT_DIVERGENCE_TOLERANCE),
  // Named in divergence records so a reader is told where the other side's evidence
  // lives, rather than having to already know the deployment's endpoint layout.
  primaryEvidenceUrl: trimTrailingSlash(process.env.PRIMARY_EVIDENCE_URL || 'https://oracle.sigvara.xyz'),
  // The chain this oracle is for. When set, nothing is read for scoring or signed while the
  // RPC reports another, and the saved state must belong to it. Unset keeps the old
  // behaviour of signing for whatever the RPC serves, with a warning at startup.
  expectedChainId: process.env.EXPECTED_CHAIN_ID ? Number(process.env.EXPECTED_CHAIN_ID) : null,
  // How long a transaction is waited for before it is replaced once at a higher fee, and
  // then given up on. See chain.settle.
  txWaitMs: Number(process.env.TX_WAIT_SECONDS || 60) * 1000,
  // Ceilings on what one transaction may cost, enforced before signing. See chain.CappedWallet.
  maxFeeGwei: process.env.MAX_FEE_GWEI ? Number(process.env.MAX_FEE_GWEI) : undefined,
  maxTxCost: process.env.MAX_TX_COST || undefined,
  // How far the chain's clock may be from this host's before the epoch is not run.
  maxClockSkewMs: Number(process.env.MAX_CLOCK_SKEW_SECONDS || 600) * 1000,
};

if (!cfg.rpcUrl || !cfg.privateKey || !cfg.identityAddress || !cfg.reputationAddress) {
  console.error('[oracle] Missing required env vars. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

// Checked before anything starts, because the failure is silent: a bad interval does
// not throw, it just runs the epoch loop flat out against the RPC.
const epochErr = epochIntervalError(cfg.epochMs);
if (epochErr) {
  console.error(`[oracle] ${epochErr}`);
  process.exit(1);
}

// Same reasoning as the interval, and the same failure shape. An unparseable tolerance
// does not make the checker noisy, it makes it agree with everything: every comparison
// against NaN is false. Refuse to start rather than run a check that cannot fail.
if (cfg.checkerMode) {
  const tolErr = divergenceToleranceError(cfg.divergenceTolerance);
  if (tolErr) {
    console.error(`[oracle] ${tolErr}`);
    process.exit(1);
  }
  // A checker that proposes as failover would otherwise run the primary's fee path. A fee
  // registry from before the once-per-epoch charge would debit the agent a second time for
  // one scoring epoch, and a current one would refuse the second charge while the two
  // operators raced for the first. A checker does not bill.
  if (cfg.feeRegistryAddress) {
    console.error(
      '[oracle] ORACLE_MODE=checker with FEE_REGISTRY_ADDRESS set. A checker must not ' +
      'charge epoch fees: the primary bills, and a second operator charging would either ' +
      'debit the agent twice on an older registry or race the primary for the one charge ' +
      'a newer one allows. Unset FEE_REGISTRY_ADDRESS on the checker.',
    );
    process.exit(1);
  }
}

// Which peers may vouch for X-Forwarded-For, besides loopback. Behind a reverse proxy in a
// container the peer is a bridge address, and without this every visitor shares one
// rate-limit bucket. A typo stops the process rather than quietly trusting nothing.
let isTrustedProxy;
try {
  isTrustedProxy = parseTrustedProxies(process.env.TRUSTED_PROXIES);
} catch (err) {
  console.error(`[oracle] ${err.message}`);
  process.exit(1);
}

// What each credential may do. A restriction that names a credential that does not exist, or
// a scope that does not exist, stops the process: either typo would leave a credential with
// more power than the operator meant it to have.
try {
  cfg.scopes = readScopes(process.env, cfg.credentials);
} catch (err) {
  console.error(`[oracle] ${err.message}`);
  process.exit(1);
}

chain.init(cfg);
external.init(cfg);
// Resolve the external chain id once at boot, so /health can answer without a round trip
// and a feed pointed at a dead host is visible from the first request rather than the
// first time somebody thinks to check.
external.refreshChainId().catch(() => {});

// Most recent divergences returned by the collection route. Bounded so an anonymous
// caller cannot make the oracle serialise its whole history on every request.
const DIVERGENCE_PAGE = 100;

// The challenge window as of the last epoch, so /divergence can say whether this
// checker's cadence is short enough to actually see proposals before they expire.
let lastChallengeWindow = null;

// ---- Persistent state ------------------------------------------------------
// attestations/flags drive score factors that accumulate and cannot be
// recomputed from chain, so they are persisted to a mounted volume. See store.js.
const {
  attestations,
  flags,
  addFlag,
  flagCount,
  decayedFlagCount,
  pruneFlags,
  resolveFlags,
  links,
  load: loadState,
  persist: persistState,
  checkAttestCooldown,
  recordAttestation,
  creditPayment,
  setPaymentOutcome,
  getScanState: loadScanState,
  setScanState,
  getPaymentScanState,
  setPaymentScanState,
  isCredited,
  getLastPersist,
  getPaymentEvents,
  allPaymentEvents,
  prunePaymentEvents,
  pruneExpiredCooldowns,
  isStatePathWritable,
  getStatePath,
  getLoadReport,
  getStateChainId,
  setStateChainId,
  recordDivergence,
  getDivergences,
  allDivergences,
  pruneDivergences,
  forgetAgent,
  ATTEST_COOLDOWN_MS,
} = require('./store');

// With verification on, the payment log replaces both the attestation-count proxy
// for feeScore and the raw attestation tally for successScore, and both are weighted
// by age. Nulls keep computeScore on the old path. Used by the epoch and by /score so
// the number served matches the number proposed.
// `now` is required, not defaulted. Both callers pass the chain's clock in
// milliseconds, and a default of Date.now() would let a future third caller silently
// reintroduce host-clock drift into a score — the exact failure this parameter exists to
// remove, and one that shows up as an unexplainable divergence between operators rather
// than as an error.
function measuredFactorsFor(didHash, now, payerScores = null) {
  if (!Number.isFinite(now)) {
    throw new TypeError('measuredFactorsFor: now (ms, from the chain clock) is required');
  }
  if (!payments.required(paymentCfg)) {
    return { measuredFeeScore: null, measuredAttestations: null, activity: null, propagation: 0 };
  }
  const events = getPaymentEvents(didHash);

  // Group once. diversifiedVolume, diversifiedAttestations and distinctPayers each used
  // to call byPayer independently, so one agent's evidence was walked three times an
  // epoch with the BigInt decay arithmetic run on each pass. Same answers, a third of
  // the work — though at ~2 ms per agent this is tidiness, not the bottleneck: the
  // round trips above are worth sixty times more.
  const grouped = payments.byPayer(events, paymentCfg.halfLifeMs, now);

  // Diversified, not just decayed: one counterparty's evidence is capped, so a ring
  // of wallets cannot substitute for a customer base. payerScores raises that cap for
  // counterparties that are themselves scored agents.
  const volume = payments.diversifiedVolume(events, paymentCfg, now, payerScores, grouped);
  return {
    measuredFeeScore: payments.feeScoreFromVolume(volume, paymentCfg.feeUnit),
    measuredAttestations: payments.diversifiedAttestations(events, paymentCfg, now, payerScores, grouped),
    distinctPayers: grouped.size,
    propagation: payments.propagationScore(events, payerScores),
    // Tenure replaces calendar age: time since registration cost nothing, so it
    // was the cheapest twenty points an idle farm could collect.
    activity: payments.activityWindow(events, paymentCfg.halfLifeMs, now),
  };
}

// Counterparty standing, for the web of trust. Resolved once per epoch per address:
// an agent's payers repeat across epochs and within one, and each lookup is three
// chain reads. Cleared at the start of every epoch so standings cannot go stale.
let payerScoreCache = new Map();

async function payerScoresFor(didHash) {
  if (!payments.required(paymentCfg)) return null;

  // Unique payers first: an address recurs across an agent's events, and this way it is
  // neither looked up nor awaited twice.
  const unique = new Map(); // lowercased key => the address as recorded
  for (const e of getPaymentEvents(didHash)) {
    const key = String(e.payer || '').toLowerCase();
    if (!unique.has(key)) unique.set(key, e.payer);
  }

  // Resolve the cache misses together rather than one at a time.
  //
  // These reads are independent, and awaiting them in sequence cost a full round trip
  // each. ethers batches calls issued in the same tick into one JSON-RPC request, which
  // a for-loop with an await inside defeats completely. Measured against Arc testnet:
  // twelve calls take 1,491 ms sequentially and 118 ms concurrently.
  //
  // getAgentScore retries a throttled or dropped read, and still rejects when the node cannot be
  // reached, because a counterparty the node could not answer for is not one with no standing. What was
  // read is kept either way, so the next try asks only for what is missing. The rejection reaches the
  // agent's own handler, which skips the agent for this epoch.
  const misses = [...unique].filter(([key]) => !payerScoreCache.has(key));
  if (misses.length > 0) {
    const settled = await Promise.allSettled(misses.map(([, addr]) => chain.getAgentScore(addr)));
    misses.forEach(([key], i) => { if (settled[i].status === 'fulfilled') payerScoreCache.set(key, settled[i].value); });
    const failed = settled.find((s) => s.status === 'rejected');
    if (failed) throw failed.reason;
  }

  const out = {};
  for (const [key] of unique) out[key] = payerScoreCache.get(key);
  return out;
}

/**
 * One agent's score at `nowMs` (the chain's clock, in milliseconds): the single assembly
 * shared by the epoch, the checker's re-score at a proposal's own time, and GET /score.
 * It was written out three times, and the point of each copy was to match the others,
 * so the number served is the number proposed. Returns the measured factors too, which
 * callers report.
 */
async function scoreAt(didHash, { registeredAt, att, flagWeight, externalScore }, nowMs) {
  const measured = measuredFactorsFor(didHash, nowMs, await payerScoresFor(didHash));
  const scores = computeScore({
    registeredAt,
    attestations: measured.measuredAttestations ?? att,
    flags: flagWeight,
    externalScore,
    measuredFeeScore: measured.measuredFeeScore,
    activity: measured.activity,
    propagation: measured.propagation,
    now: nowMs,
  });
  return { measured, scores };
}

// ---- Epoch -----------------------------------------------------------------

// Guards against overlapping epochs from the setInterval tick and the manual
// /epoch endpoint firing at the same time, which would submit tx's with colliding
// nonces from the shared oracle wallet.
let epochRunning = false;

// The chain the RPC was last seen on, once it has been checked. Reported by /health.
let verifiedChainId = null;
let warnedNoExpectedChain = false;

/**
 * The chain the RPC is on, checked against EXPECTED_CHAIN_ID and against the chain the saved
 * state belongs to. Throws chain.ChainMismatchError when either disagrees.
 *
 * Nothing said which chain an RPC was serving. A testnet URL beside mainnet addresses fails
 * on the first call, but a node that serves the wrong chain, or a failover that lands on
 * one, would have been signed against, and state copied from one chain onto another would
 * have scored mainnet agents with testnet payments. Asked before every epoch and at startup;
 * the answer comes from the node each time, because ethers remembers its first.
 */
async function ensureChain() {
  const actual = await chain.assertChainId(cfg.expectedChainId);
  const stored = getStateChainId();
  if (stored != null && stored !== actual) throw new chain.ChainMismatchError(stored, actual, 'state');
  if (stored == null) {
    // First run on this state file: it now belongs to this chain.
    setStateChainId(actual);
    persistState();
  }
  if (cfg.expectedChainId == null && !warnedNoExpectedChain) {
    warnedNoExpectedChain = true;
    console.warn(
      `[oracle] WARNING: EXPECTED_CHAIN_ID is not set, so this oracle will sign for whatever chain RPC_URL ` +
      `serves (chain ${actual} now). Set EXPECTED_CHAIN_ID=${actual}.`,
    );
  }
  verifiedChainId = actual;
  return actual;
}

async function runEpoch() {
  if (epochRunning) {
    console.log('[oracle] epoch already running, skipping this trigger');
    return;
  }
  epochRunning = true;

  try {
    await runEpochInner();
  } catch (err) {
    // runEpochInner reads chain config (challenge window, chain clock, epoch fee)
    // outside any per-agent guard. A transient RPC failure there used to escape as
    // an unhandled rejection and kill the process; the container then restarted and
    // immediately re-ran the epoch, which is how an agent could be charged twice.
    // An epoch that cannot start is skipped until the next tick instead.
    console.error('[oracle] epoch aborted:', err.message);
    metrics.inc('epochsFailed');
  } finally {
    epochRunning = false;
  }
}

/**
 * Find payments by scanning the chain, rather than waiting to be told about them.
 *
 * ADR 0003. Verification was always chain-based; only the notification was not, and with
 * two operators that difference produced a 29-point divergence where nobody misbehaved:
 * the evidence simply never arrived at one of them, because arrival was per-operator and
 * by HTTP.
 *
 * Credited with no outcome. Money moving is on chain; whether the work was good is not.
 *
 * Returns a summary rather than throwing. A failed payment scan must not lose the epoch:
 * scoring from the payments already known is strictly better than not scoring, and the
 * checkpoint is only advanced on success so the range is simply retried next time.
 */
/**
 * Prove the scan's own query still finds something it is known to find.
 *
 * Re-runs the same filter shape against one settlement already in this operator's
 * state: one recipient, one block, one expected transaction. Passing means an empty
 * scan really was an empty range. Failing means the query is broken, so the range is
 * unverified, which is a different thing and must not be reported as quiet.
 *
 * Returns 'unavailable' when there is no prior payment to point at, rather than
 * 'passed'. A check that reports success when it did not run is the failure it exists
 * to prevent.
 */
async function runScanCanary(byAddress, provider) {
  const byDidAddress = new Map();
  for (const a of byAddress.values()) byDidAddress.set(a.didHash, a.agentAddress);

  const canary = paymentScan.pickCanary(allPaymentEvents(), (did) => byDidAddress.get(did) ?? null);
  if (!canary) return 'unavailable';

  try {
    // The event's own block when it has one, which is every settlement credited since
    // this was stored. Otherwise the receipt, which is how this used to work and still
    // has to, for events written before then.
    //
    // That fallback is the part that fails in practice: both live endpoints prune the
    // transaction index, around 6 days on Circle's and 13 on QuickNode's, so a receipt
    // lookup for anything older returns null and the canary could prove nothing. One
    // extra call, on a path that only runs when a scan found nothing.
    let blockNumber = canary.blockNumber;
    if (!Number.isInteger(blockNumber)) {
      const receipt = await chain.readWithBackoff(
        'canary receipt', () => provider.getTransactionReceipt(canary.txHash),
      );
      if (!receipt || !Number.isInteger(receipt.blockNumber)) {
        return 'unavailable'; // cannot locate the settlement, so this proves nothing
      }
      blockNumber = receipt.blockNumber;
    }
    const logs = await chain.readWithBackoff(
      'canary getLogs',
      () => provider.getLogs(
        paymentScan.canaryFilter(paymentCfg.asset, canary.recipient, blockNumber),
      ),
    );
    return paymentScan.canaryVerdict(logs, canary.txHash);
  } catch (err) {
    // An RPC failure is not evidence that the filter is broken.
    console.warn(`[oracle] payment scan canary could not run: ${err.message}`);
    return 'unavailable';
  }
}

async function runPaymentScan(agents) {
  if (!paymentScanCfg.enabled) return null;
  if (!paymentCfg.asset) {
    console.warn('[oracle] payment scan enabled but PAYMENT_ASSET is unset; skipping');
    return null;
  }

  const provider = chain.getProvider();
  const head = await provider.getBlockNumber();
  const to = paymentScan.safeHead(head, paymentScanCfg.confirmations);
  const checkpoint = getPaymentScanState();
  const from = checkpoint && Number.isInteger(checkpoint.lastBlock)
    ? checkpoint.lastBlock + 1
    : paymentScanCfg.fromBlock;

  if (from > to) return { from, to, credited: 0, skipped: 0, upToDate: true };

  const byAddress = new Map();
  const byDid = new Map();
  for (const a of agents) {
    if (a.agentAddress) byAddress.set(a.agentAddress.toLowerCase(), a);
    byDid.set(a.didHash, a);
  }

  // Backoff belongs to chain.js, which already owns retry policy for this RPC.
  const readLogs = (filter) =>
    chain.readWithBackoff('payment-scan getLogs', () => provider.getLogs(filter));

  const logs = await paymentScan.scanRange(
    // paceMs is how fast this scan may ask, which is a different thing from how it
    // reacts to being refused. Backoff is in readLogs above; this stops provoking the
    // refusal in the first place, and only applies between calls, so a steady one-chunk
    // epoch pays nothing for it.
    { readLogs, asset: paymentCfg.asset, paceMs: paymentScanCfg.paceMs },
    [...byAddress.values()].map((a) => a.agentAddress),
    from, to, paymentScanCfg.chunkSize,
  );

  const { credits, skipped } = paymentScan.planCredits(logs.map((log) => paymentScan.decodeTransfer(log, paymentCfg.asset)), {
    didHashOf: (address) => byAddress.get(address.toLowerCase())?.didHash ?? null,
    operatorOf: (didHash) => byDid.get(didHash)?.operator ?? null,
    // Ask the store, so the scan's pre-check and creditPayment cannot drift apart.
    isUsed: (txHash, didHash, payer) => isCredited(txHash, didHash, payer),
    minAmount: paymentCfg.minAmount,
  });

  // The settlement time is the block's, not now. Crediting a back-scanned payment with
  // the current clock would make an old settlement look fresh and defeat the decay that
  // every volume figure depends on.
  const times = new Map();
  for (const n of new Set(credits.map((c) => c.blockNumber))) {
    const block = await chain.readWithBackoff('payment-scan getBlock', () => provider.getBlock(n));
    if (block) times.set(n, Number(block.timestamp) * 1000);
  }

  let credited = 0;
  let refused = 0;
  const unresolved = [];
  for (const c of credits) {
    const ts = times.get(c.blockNumber);
    if (ts === undefined) {
      // No block timestamp means no decay basis, so it cannot be credited yet. The
      // checkpoint below stops short of it so it is retried rather than skipped.
      unresolved.push(c);
      continue;
    }
    if (creditPayment(c.didHash, c.txHash, c.amount, c.payer, null, ts, null, c.blockNumber)) {
      credited += 1;
    } else {
      // planCredits already asked isCredited about this exact pair, so a refusal here
      // means the scan's pre-check and the store disagree. That should be impossible.
      //
      // Counted and said out loud because the silent version of this hid a real bug: the
      // dedupe key was the transaction hash alone, so a batch payment crediting two
      // agents dropped the second, and this branch discarded the only evidence of it
      // while the checkpoint moved past the block. A refused credit is either that class
      // of disagreement or a legacy bare-hash entry, and both are worth seeing.
      refused += 1;
      console.warn(
        `[oracle] payment scan: ${c.txHash} for ${c.didHash} passed planCredits and was ` +
        'then refused by the store. Pre-check and store disagree, or a pre-migration ' +
        'entry blocks it.',
      );
    }
  }
  if (refused) metrics.inc('paymentScanRefused', refused);

  // An empty scan is only meaningful once the query is known to work. Run when nothing
  // was credited, which is the only time the distinction between "nobody was paid" and
  // "the filter is broken" decides anything.
  let canary = 'not_run';
  if (credited === 0) {
    canary = await runScanCanary(byAddress, provider);
    if (canary === 'failed') {
      metrics.inc('paymentScanCanaryFailures');
      console.error(
        '[oracle] payment scan canary FAILED: a known settlement was not found by the ' +
        'same filter the scan uses. Treat this range as unverified, not as quiet; the checkpoint ' +
        `stays at ${from - 1} and the range is scanned again next epoch.`,
      );
    }
  }

  // Never past a block still unresolved, and not at all after a failed canary. The scan only moves
  // forward, so advancing over either would lose a payment for good.
  const nextCheckpoint = paymentScan.checkpointAfter(unresolved, from, to, canary);
  if (nextCheckpoint !== null) setPaymentScanState({ lastBlock: nextCheckpoint, at: Date.now() });
  metrics.inc('paymentScans');
  if (credited) metrics.inc('paymentsPulled', credited);

  const bySkipReason = {};
  for (const sk of skipped) bySkipReason[sk.reason] = (bySkipReason[sk.reason] || 0) + 1;
  console.log(
    `[oracle] payment scan ${from}-${to}: ${credited} credited, ${skipped.length} skipped` +
    (canary === 'not_run' ? '' : `, canary ${canary}`) +
    (skipped.length ? ` (${JSON.stringify(bySkipReason)})` : ''),
  );

  return { from, to, credited, skipped: skipped.length, unresolved: unresolved.length, checkpoint: nextCheckpoint, canary, reasons: bySkipReason };
}

async function runEpochInner() {
  const start = Date.now();
  payerScoreCache = new Map();
  console.log(`[oracle] epoch start — ${new Date().toISOString()}`);
  metrics.inc('epochsStarted');

  // Before anything is read for scoring or signed. A mismatch throws, and runEpoch logs the
  // epoch as aborted and tries again at the next tick.
  await ensureChain();

  // Epochs run one at a time, so a pending transaction from this wallet at this point is
  // left over from an earlier one, and everything sent now queues behind it. Informational:
  // chain.settle already replaces a transaction that does not land.
  try {
    const stuck = await chain.getNonceGap();
    if (stuck > 0) {
      console.warn(
        `[oracle] WARNING: ${stuck} transaction(s) from this wallet are still pending from before this epoch. ` +
        'Anything sent now queues behind them.',
      );
    }
  } catch { /* a missing warning is not worth an epoch */ }

  // The chain's clock against this host's, before anything is credited or scored from it.
  // Payments are stored with the block time the RPC reports and every score is dated by it,
  // so a node serving a stale or false head would date all of it wrongly, unseen, and the
  // payment record is permanent.
  const skewReason = clockSkewError(await chain.getLatestBlockTimestamp(), Date.now(), cfg.maxClockSkewMs);
  if (skewReason) throw new Error(skewReason);

  let agents;
  try {
    agents = await chain.getRegisteredAgents();
  } catch (err) {
    // Keep whatever the scan managed before it failed. Chunks are checkpointed, so
    // an aborted backfill resumes rather than starting over, and a long catch-up on
    // a rate-limited node finishes across several epochs instead of never.
    setScanState(chain.getScanState());
    persistState();
    console.error('[oracle] could not fetch registered agents:', err.message);
    metrics.inc('epochsFailed');
    return;
  }

  console.log(`[oracle] ${agents.length} agent(s) found`);

  // Before scoring, so this epoch scores what the chain shows rather than what happened
  // to be posted to this operator. Failure is logged and swallowed: scoring from the
  // payments already known beats not scoring at all.
  try {
    await runPaymentScan(agents);
  } catch (err) {
    metrics.inc('paymentScanErrors');
    console.error('[oracle] payment scan failed:', err.message);
  }
  let proposed = 0;
  let finalized = 0;
  let diverged = 0;

  const challengeWindow = await chain.getChallengeWindow();
  lastChallengeWindow = challengeWindow;
  // A proposal is only auditable while it sits in pendingScores. A checker whose epoch
  // is not comfortably shorter than that window simply misses proposals, and an empty
  // /divergence would then read as "checked, found nothing" rather than "did not look".
  if (cfg.checkerMode && cfg.epochMs >= (challengeWindow * 1000) / 2) {
    console.warn(
      `[oracle] WARNING: checker epoch is ${cfg.epochMs / 3_600_000}h against a ` +
      `${challengeWindow / 3600}h challenge window. Proposals will expire unseen. ` +
      'Set EPOCH_HOURS below half the challenge window.',
    );
  }
  // Use the chain's clock for window math, not the local one — the contract
  // compares against block.timestamp. Fetched once per epoch; going slightly
  // stale during a long epoch only errs toward 'skip', never toward a
  // premature finalize that would revert.
  const chainNow = await chain.getLatestBlockTimestamp();

  // Epoch-fee gating (opt-in via FEE_REGISTRY_ADDRESS). Active only when a fee
  // registry is configured AND the on-chain epochFee is non-zero. When inactive,
  // every agent is treated as covered and nothing is charged.
  const gatingActive = chain.feeGatingConfigured() && (await chain.getEpochFee()) > 0n;
  if (gatingActive) console.log('[oracle] epoch-fee gating ACTIVE');

  // Phase 1: reads are stateless — fire them concurrently, but a chunk at a time.
  //
  // "Concurrently" and "all at once" are not the same thing, and this used to be all at
  // once: one Promise.all over every registered agent, which is 2 logical reads each, or
  // 3 with fee gating. The agent set is small today and that was fine. At 10,000 agents
  // it is 30,000 reads released in a single tick.
  //
  // What that actually costs is worth stating precisely, because the logical number
  // overstates it. ethers folds calls issued in the same tick into batched JSON-RPC
  // requests (measured on ethers 6.17: batchMaxCount 100, batchStallTime 10ms), so
  // 30,000 reads arrive as ~300 HTTP requests carrying 100 calls each, not 30,000
  // sockets. That is still the wrong shape in two ways: 300 near-simultaneous requests
  // is a burst most public endpoints will rate-limit, and a 100-call batch is itself
  // over the limit several providers accept. Both failures then land in
  // readWithBackoff, which retries, which makes the burst worse rather than better.
  //
  // 32 to match the phase-two guard loop below: one chunk is 64 to 96 logical reads,
  // which ethers sends as a single batched round trip, so RPC pressure is flat in the
  // agent count instead of linear. See mapChunked for what chunking costs. It preserves
  // input order, so agentInfos stays aligned with agents exactly as the single
  // Promise.all left it and candidate ordering downstream is unchanged.
  const PHASE_ONE_CHUNK = 32;
  const agentInfos = await mapChunked(agents, PHASE_ONE_CHUNK, async ({ didHash }) => {
    try {
      const [info, pending, covered] = await Promise.all([
        chain.getAgentInfo(didHash),
        chain.getPendingScore(didHash),
        gatingActive ? chain.isCovered(didHash) : Promise.resolve(true),
      ]);
      return { didHash, ...info, pending, covered, error: null };
    } catch (err) {
      return { didHash, registeredAt: 0, status: -1, pending: null, covered: false, error: err };
    }
  });

  // Agents worth writing for, filtered from the phase-1 batch before any further reads.
  const candidates = [];
  for (const info of agentInfos) {
    if (info.error) {
      console.error(`[oracle]   ${info.didHash.slice(0, 10)}… error: ${info.error.message}`);
      continue;
    }
    // Slashed agents are terminal — their score was zeroed by SigvaraStaking.
    if (info.status === chain.STATUS_SLASHED) {
      chain.pruneAgent(info.didHash);
      forgetAgent(info.didHash);
      continue;
    }
    // Uncovered agents fall out of the active scoring run (tokenomics §4).
    if (gatingActive && !info.covered) {
      console.log(`[oracle]   ${info.didHash.slice(0, 10)}… uncovered (no epoch fee), skipping`);
      continue;
    }
    candidates.push(info);
  }

  // Phase 2: writes share the oracle wallet's nonce, so they stay sequential. The two
  // guard reads before each write do not, and used to be sequential awaits inside the
  // loop — two full round trips per agent, about 248 ms each on Arc, before any work
  // happened. At a thousand agents that alone is four minutes of an epoch spent waiting.
  //
  // Both guards are gas savers, not safety checks: SigvaraReputation._requireScorable
  // enforces AgentSlashed and AgentNotBonded itself, so acting on a read that went stale
  // costs a reverted proposal and nothing else. Reading a chunk ahead rather than
  // hoisting the lot keeps the guards close to the writes they guard, so the window
  // stays bounded by the chunk instead of by the epoch.
  const GUARD_CHUNK = 32;

  for (let c = 0; c < candidates.length; c += GUARD_CHUNK) {
    const chunk = candidates.slice(c, c + GUARD_CHUNK);
    // One batch for the whole chunk: ethers folds calls issued in the same tick into a
    // single JSON-RPC request, so this is one round trip rather than 2 x chunk.
    const guards = await Promise.all(chunk.map(async a => {
      try {
        const [fresh, bonded] = await Promise.all([
          chain.getAgentInfo(a.didHash),
          chain.isBonded(a.didHash),
        ]);
        return { fresh, bonded, guardError: null };
      } catch (guardError) {
        return { fresh: null, bonded: false, guardError };
      }
    }));

    for (let k = 0; k < chunk.length; k++) {
      const { didHash, operator, registeredAt, pending } = chunk[k];
      const { fresh, bonded, guardError } = guards[k];
      if (guardError) {
        console.error(`[oracle]   ${didHash.slice(0, 10)}… error: ${guardError.message}`);
        continue;
      }
      try {
        if (fresh.status === chain.STATUS_SLASHED) {
          console.log(`[oracle]   ${didHash.slice(0, 10)}… slashed since the batch read, skipping`);
          chain.pruneAgent(didHash);
          continue;
        }

        if (!bonded) {
          console.log(`[oracle]   ${didHash.slice(0, 10)}… below minimum stake, skipping`);
          metrics.inc('skippedUnbonded');
          continue;
        }

        // Checker mode decides after scoring instead, because it needs its own number to
        // compare against the pending one. The primary keeps the cheap skip: there is no
        // point computing a score it has already decided not to propose.
        const action = cfg.checkerMode ? null : decideAction(pending, challengeWindow, chainNow);

        if (action === 'skip') {
          console.log(`[oracle]   ${didHash.slice(0, 10)}… score still pending, waiting out challenge window`);
          continue;
        }

        if (action === 'finalize-then-propose') {
          metrics.inc('finalizeAttempts');
          try {
            const finalizeTx = await chain.finalizeScore(didHash);
            console.log(`[oracle]   ${didHash.slice(0, 10)}… finalized tx=${finalizeTx.slice(0, 10)}…`);
            finalized++;
            metrics.inc('finalizeSuccesses');
          } catch (finalizeErr) {
            if (chain.isProposerNotAuthorized(finalizeErr)) {
              // The proposer of the pending proposal has lost its authority: its operator was
              // removed, its signer cleared, or its role revoked. Nobody can finalize that
              // proposal, so it is not a failure of this epoch, and the proposal made below
              // replaces it.
              console.log(`[oracle]   ${didHash.slice(0, 10)}… the pending proposal's proposer is no longer authorized; replacing it`);
              metrics.inc('proposalsStranded');
            } else {
              // finalizeReputation is permissionless, so another party can front-run
              // us. If the pending proposal is gone, that's exactly what happened —
              // the score is live, carry on and propose fresh. Anything else is a
              // real failure and should skip this agent via the outer catch.
              const still = await chain.getPendingScore(didHash);
              if (still.exists) {
                metrics.inc('finalizeErrors');
                throw finalizeErr;
              }
              console.log(`[oracle]   ${didHash.slice(0, 10)}… already finalized by another party`);
              metrics.inc('finalizeSuccesses');
            }
          }
        }

        const att       = attestations.get(didHash) ?? { successful: 0, total: 0 };
        // Age-weighted, not the raw count: a flag decays out of the penalty rather than
        // costing two points forever. See store.decayedFlagCount.
        const flagWeight = decayedFlagCount(didHash);
        // externalScore: only for agents linked to an ERC-8004 identity they own.
        // Ownership is re-verified inside externalScoreFor; any failure yields 0.
        const linkedId  = links.get(didHash);
        const externalScore = (external.configured() && linkedId !== undefined)
          ? await external.externalScoreFor(linkedId, operator)
          : 0;
        // The chain's clock, not this host's. chainNow is a block timestamp in seconds;
        // every scoring function below measures in milliseconds, and getting that
        // conversion wrong would date every payment to 1970 and decay the lot to zero.
        //
        // Using it is what makes two operators computable against each other. Wall clocks
        // drift, so the same evidence produced fractionally different tenure and decay on
        // each machine: 0.982146 against 0.982148 on the day the checker went live. Small
        // enough to move no integer factor, large enough that the two were not computing
        // the same function. A divergence tolerance hid it rather than fixing it.
        const scoringNowMs = chainNow * 1000;
        const inputs = { registeredAt, att, flagWeight, externalScore };
        const { measured, scores } = await scoreAt(didHash, inputs, scoringNowMs);

        // Checker mode: compare rather than compete. This oracle holds ORACLE_ROLE and a
        // bond like any other, so it *could* overwrite the primary's proposal — and must
        // not. Overwriting restarts the six-hour challenge window, which would hand a bad
        // proposal another window out of the slashing committee's reach. So the only
        // writes a checker makes are proposing into an empty slot and finalizing a score
        // it agrees with.
        if (cfg.checkerMode) {
          // Re-read rather than trusting the batch. `pending` was fetched for every agent
          // before phase 2 began, and phase 2 is sequential with a tx wait per write, so
          // by the time this agent is reached the snapshot can be minutes old. Deciding
          // on it would mean proposing into a slot that is no longer empty — overwriting
          // a live proposal, restarting its challenge window, and recording no divergence,
          // because the overwrite path never reaches recordDivergence. The checker would
          // be destroying exactly the evidence it exists to produce.
          //
          // This narrows the race to one round trip. The rest is closed by the contract:
          // the propose below uses proposeIfEmpty, which reverts rather than replacing a
          // proposal that lands in the remaining gap.
          let freshPending = await chain.getPendingScore(didHash);

          // A proposal whose proposer has lost its authority holds the slot in name only. It
          // can never be finalized, and the contract lets proposeIfEmpty replace it, which is
          // how a checker takes over from a primary that was removed. The contract is asked
          // rather than the answer worked out here: a compare-and-swap that would be accepted
          // over an occupied slot means the occupant is dead. Anything short of a clear yes
          // leaves the proposal alone, which is the safe reading.
          if (freshPending.exists) {
            let probe = { ok: false };
            try {
              probe = await chain.canPropose(didHash, scores, undefined, true);
            } catch { /* cannot ask, so leave it alone */ }
            if (probe.ok) {
              console.log(`[oracle]   ${didHash.slice(0, 10)}… the pending proposal's proposer is no longer authorized; covering for it`);
              metrics.inc('proposalsStranded');
              freshPending = { exists: false, proposedAt: 0, data: {}, evidenceRoot: null };
            }
          }

          // Score the proposal against ITS OWN clock, not this epoch's.
          //
          // `scores` above was computed at chainNow. The proposal being audited was made
          // minutes or hours earlier, and every decay weight and the recency that fades
          // tenure are measured against the time of measurement. Comparing the two means
          // comparing scores computed at different moments, which differ even when both
          // operators are perfectly honest and hold identical evidence. That difference is
          // real: at 20 seconds apart it moves recency by 2e-6, and it grows with the gap.
          //
          // Using the chain's clock does not fix this on its own, because two operators
          // run on independent schedules and therefore read different blocks. The fix is
          // to ask the right question: not "what do I compute now" but "what should the
          // primary have computed when it proposed this". Re-measuring at proposedAt
          // answers that, so a divergence means the evidence disagreed rather than the
          // epochs being minutes apart.
          //
          // Cheap: measuredFactorsFor and computeScore are pure functions over payment
          // events already in memory. No extra chain reads.
          let auditScores = scores;
          if (freshPending.exists && freshPending.proposedAt > 0) {
            const atProposalMs = freshPending.proposedAt * 1000;
            auditScores = (await scoreAt(didHash, inputs, atProposalMs)).scores;
          }

          // auditScores for every comparison; `scores` stays as-is for the propose path
          // below, because covering a silent primary means proposing a CURRENT score, not
          // a reconstruction of some past moment.
          const decision = decideCheckerAction(freshPending, auditScores, challengeWindow, chainNow, cfg.divergenceTolerance);

          if (decision === 'diverged') {
            const d = scoreDivergence(freshPending.data, auditScores);
            // Publish what each side was scoring, not just that the numbers differ.
            // ownEvidenceRoot is over this operator's payment events; proposedEvidenceRoot
            // is the one the primary committed to on chain. Different roots mean different
            // evidence, which is diagnosable; identical roots with different scores would
            // mean an arithmetic disagreement, which is a much more serious finding.
            const ownEvents = getPaymentEvents(didHash);
            recordDivergence(didHash, d, freshPending.proposedAt, Date.now(), {
              ownEvidenceRoot: payments.required(paymentCfg) ? merkle.rootFor(ownEvents) : null,
              proposedEvidenceRoot: freshPending.evidenceRoot ?? null,
              ownPaymentEvents: ownEvents.length,
              ownDistinctPayers: measured.distinctPayers ?? null,
              // Where to go next. Named in the payload so the diagnosis does not depend on
              // knowing the protocol's endpoint layout.
              compareWith: `${cfg.primaryEvidenceUrl}/evidence/${didHash}`,
            });
            const open = chainNow < freshPending.proposedAt + challengeWindow;
            const detail = Object.entries(d.factors)
              .map(([f, v]) => `${f} pending=${v.pending} ours=${v.own}`).join(', ');
            console.error(
              `[oracle]   ${didHash.slice(0, 10)}… DIVERGENCE pending=${d.pendingTotal} ours=${d.ownTotal} ` +
              `(${detail})${open ? ' — challenge window OPEN, committee can still reject' : ' — window closed'}`,
            );
            metrics.inc('checkerDivergences');
            diverged++;
            continue;
          }

          if (decision === 'skip') {
            metrics.inc('checkerAgreed');
            continue;
          }

          if (decision === 'finalize') {
            // Agreed, and the window is up. Finalizing is permissionless and this oracle
            // has checked the number itself, which is the only condition under which a
            // checker should be the one to make it live.
            //
            // The proposal was re-read a few lines above, so this is the one that was
            // checked. A replacement landing in the gap that remains is caught by the
            // contract rather than by this code: any replacement sets proposedAt to its
            // own block, so the window is open again and finalize reverts with
            // ChallengeWindowActive. That backstop depends on challengeWindow being
            // non-trivial — setChallengeWindow has no lower bound — so it is a second
            // line of defence behind the re-read, not the first.
            metrics.inc('finalizeAttempts');
            try {
              const finalizeTx = await chain.finalizeScore(didHash);
              console.log(`[oracle]   ${didHash.slice(0, 10)}… agreed, finalized tx=${finalizeTx.slice(0, 10)}…`);
              finalized++;
              metrics.inc('finalizeSuccesses');
            } catch (finalizeErr) {
              // Same distinction as the propose path, and checked before the pending
              // re-read: a throttled send never reached the chain, so the slot is still
              // occupied and the code below would otherwise read that as a failure to
              // finalize and rethrow, inflating both counters for one throttle.
              if (chain.isRateLimited(finalizeErr)) {
                console.warn(
                  `[oracle]   ${didHash.slice(0, 10)}… RPC throttled the finalize; retrying next epoch`,
                );
                metrics.inc('finalizeThrottled');
                continue;
              }
              // The proposer lost its authority between the probe above and this call. The next
              // epoch's probe sees it and covers for it.
              if (chain.isProposerNotAuthorized(finalizeErr)) {
                console.log(`[oracle]   ${didHash.slice(0, 10)}… the proposer is no longer authorized; covering for it next epoch`);
                metrics.inc('proposalsStranded');
                continue;
              }
              // An empty slot after a failed finalize has two very different causes, and
              // counting both as success hides the one that matters most: the slashing
              // committee rejecting a proposal deletes it too. That is the committee
              // acting on this checker's alert, the entire point of running one, and it
              // must not be indistinguishable from a routine finalize in the metrics.
              const still = await chain.getPendingScore(didHash);
              if (still.exists) { metrics.inc('finalizeErrors'); throw finalizeErr; }
              const live = await chain.getTotalScore(didHash);
              if (live > 0 && live === auditScores.total) {
                console.log(`[oracle]   ${didHash.slice(0, 10)}… already finalized by another party`);
                metrics.inc('finalizeSuccesses');
              } else {
                console.warn(
                  `[oracle]   ${didHash.slice(0, 10)}… pending proposal vanished without becoming live ` +
                  `(live=${live}, ours=${auditScores.total}) — most likely a committee rejection`,
                );
                metrics.inc('proposalsRejected');
              }
            }
            continue;
          }
          // 'propose' falls through: nothing is pending, so the primary is silent and
          // this operator covers for it. That is the failover half of running a second.
        }

        // Commit to the evidence alongside the score. Without it the only record of
        // which payments produced this number is the oracle's own state file, and a
        // third party checking the arithmetic would have to take that on trust.
        // Worked out before the fee, because the fee now waits on a dry run of the proposal.
        const evidenceRoot = payments.required(paymentCfg)
          ? merkle.rootFor(getPaymentEvents(didHash))
          : undefined;

        // Charge before proposing, not after. The coverage read above and the
        // charge are separated by at least the propose transaction, and an
        // operator can withdraw in that gap: they would be scored for free, and
        // because the charge used to be fire-and-forget the failure was silent.
        // Taking the fee first means a withdrawal after the charge costs them
        // nothing to us. The trade-off is that an agent charged for an epoch whose
        // proposal then fails has paid for a run it did not get; that is logged
        // and counted, and is the lesser of the two errors.
        // Never in checker mode. On a registry from before the once-per-epoch charge a second
        // operator running this path would debit the agent a second time for one scoring
        // epoch, and on a current one it would race the primary for the single charge.
        // Startup already refuses checker + FEE_REGISTRY_ADDRESS; this is the second lock on
        // a path that moves real value.
        if (gatingActive && !cfg.checkerMode) {
          // Ask the contract whether this proposal would be accepted before taking the fee
          // for it. Charging first is still right, for the reason above, but it used to be
          // unconditional: when the oracle's bond lapsed, or an agent stopped being
          // scorable, every charge succeeded and every proposal reverted, every epoch, and
          // /health stayed green. A refusal here costs the agent nothing. Not being able to
          // ask is not a yes either: the agent is skipped this epoch, uncharged.
          let verdict;
          try {
            verdict = await chain.canPropose(didHash, scores, evidenceRoot, cfg.checkerMode);
          } catch (simErr) {
            console.error(`[oracle]   ${didHash.slice(0, 10)}… could not check the proposal before charging, skipping: ${simErr.message}`);
            metrics.inc('feeChargesSkipped');
            continue;
          }
          if (!verdict.ok) {
            console.warn(`[oracle]   ${didHash.slice(0, 10)}… the contract would refuse this proposal (${verdict.reason}); no fee taken`);
            metrics.inc('feeChargesSkipped');
            continue;
          }
          try {
            await chain.chargeEpoch(didHash);
            metrics.inc('feeCharges');
          } catch (chargeErr) {
            if (chain.isAlreadyCharged(chargeErr)) {
              // Charged earlier in this epoch, by an earlier run of this oracle or by anyone
              // else. The agent has paid for it, so scoring carries on and nothing more is taken.
              console.log(`[oracle]   ${didHash.slice(0, 10)}… already charged this epoch; scoring without charging again`);
              metrics.inc('feeChargesAlreadyPaid');
            } else {
              // A charge that was sent and not seen mined may still land. Said plainly, because
              // the agent may have paid for an epoch that is not scored.
              if (chain.isTxUnconfirmed(chargeErr)) {
                metrics.inc('txUnconfirmed');
                console.error(`[oracle]   ${didHash.slice(0, 10)}… epoch-fee charge not confirmed, not scoring: ${chargeErr.message}`);
              } else {
                console.error(`[oracle]   ${didHash.slice(0, 10)}… epoch-fee charge failed, not scoring: ${chargeErr.message}`);
              }
              metrics.inc('feeChargeErrors');
              continue;
            }
          }
        }

        metrics.inc('proposeAttempts');
        // Checker mode uses the compare-and-swap entry point. It decided to propose by
        // reading the slot and finding it empty, and the primary can land a proposal in
        // the gap between that read and this transaction. proposeReputation would replace
        // it, restart its six-hour window, and record no divergence, so the checker would
        // be destroying the evidence it exists to produce. proposeIfEmpty makes the
        // contract check and write in the same breath, which is the only place that gap
        // can actually be closed.
        //
        // The primary keeps the replacing entry point: overwriting its own stale proposal
        // with a fresher one is the intended behaviour, not a race.
        const txHash    = await chain.proposeScore(didHash, scores, evidenceRoot, cfg.checkerMode);
        metrics.inc('proposeSuccesses');

        console.log(`[oracle]   ${didHash.slice(0, 10)}… proposed score=${scores.total}/100 tx=${txHash.slice(0, 10)}…`);
        proposed++;
      } catch (err) {
        // Losing the race is the system working, not an error. The checker went to cover
        // a silent primary and the primary came back first, which is the outcome anyone
        // would want. Counting it as a failure would make a healthy handover look like
        // an incident, and would bury real propose errors in the same number.
        if (chain.isSlotTaken(err)) {
          console.log(`[oracle]   ${didHash.slice(0, 10)}… primary proposed first, standing down`);
          metrics.inc('proposeSlotTaken');
          continue;
        }
        // Being throttled is the provider's limit, not this operator failing. Counted
        // apart from proposeErrors so the number that means "something is wrong here"
        // keeps meaning that, and logged as a sentence rather than the JSON-RPC payload
        // ethers wraps it in. The epoch will try again; nothing is resent now, because a
        // write that may already be in the mempool must not be repeated.
        if (chain.isRateLimited(err)) {
          console.warn(
            `[oracle]   ${didHash.slice(0, 10)}… RPC throttled the proposal; retrying next epoch`,
          );
          metrics.inc('proposeThrottled');
          continue;
        }
        // A transaction the oracle would not sign, or one that was sent and never seen mined.
        // Each has its own counter, because neither is the contract refusing and neither is
        // the provider throttling, and a fee cap that trips is a reason to look at the RPC.
        if (chain.isFeeCap(err)) {
          console.error(`[oracle]   ${didHash.slice(0, 10)}… ${err.message}`);
          metrics.inc('txCapped');
          continue;
        }
        if (chain.isTxUnconfirmed(err)) {
          console.error(`[oracle]   ${didHash.slice(0, 10)}… ${err.message}`);
          metrics.inc('txUnconfirmed');
          continue;
        }
        console.error(`[oracle]   ${didHash.slice(0, 10)}… error: ${err.message}`);
        metrics.inc('proposeErrors');
      }
    }
  }

  // Once an event's weight is negligible it cannot move an integer score, so
  // keeping it only grows the state file. Pruning here rather than on the write
  // path keeps /attest fast and bounds the work to once an epoch.
  // Record how far the scan got, so a restart does not replay the chain.
  setScanState(chain.getScanState());

  const pruned = prunePaymentEvents(paymentCfg.halfLifeMs);
  // Same reason, same place: a flag too old to move an integer score is dead weight
  // in the state file.
  pruneFlags();
  // And the same again for divergences, which are capped per agent but not in the number
  // of agents, and are re-serialised on every persist().
  if (cfg.checkerMode) {
    const droppedDivergences = pruneDivergences();
    if (droppedDivergences > 0) console.log(`[oracle] pruned ${droppedDivergences} expired divergence record(s)`);
  }
  if (pruned > 0) console.log(`[oracle] pruned ${pruned} fully decayed payment event(s)`);
  persistState();

  console.log(
    `[oracle] epoch done — ${proposed} proposed, ${finalized} finalized` +
    (cfg.checkerMode ? `, ${diverged} diverged` : '') +
    ` in ${Date.now() - start}ms`,
  );
  metrics.inc('epochsSucceeded');
  metrics.set('lastSuccessfulEpochMs', Date.now());
  metrics.set('activeAgents', proposed);

  pruneExpiredCooldowns();
}

// ---- HTTP API --------------------------------------------------------------

// 32MB of serialized evidence responses. The revision token is the payment-event array
// itself: the store replaces it on every change, so nothing has to remember to
// invalidate this, and a case it somehow missed degrades to a cache miss rather than to
// stale evidence.
const evidenceCache = createResponseCache({ maxBytes: 32 * 1024 * 1024 });

const badgeCache = badge.createBadgeCache({ ttlMs: 60_000, maxEntries: 500 });

/**
 * The job registry's provider, built on first use.
 *
 * Separate from the oracle's own provider because the registry may sit on a different
 * chain, exactly as the ERC-8004 feed may. The chain id is resolved alongside it for the
 * same reason /health reports one for the external feed: a reader pointed at the wrong
 * chain finds no jobs, which is indistinguishable from an agent that has done none.
 */
async function jobsProviderOrNull() {
  if (!jobs.enabled(jobsCfg)) return null;
  if (!jobsProvider) {
    jobsProvider = jobs.makeProvider(jobsCfg);
    try {
      jobsChainId = Number((await jobsProvider.getNetwork()).chainId);
    } catch {
      jobsChainId = null;
    }
  }
  return jobsProvider;
}

/**
 * What an address's badge should say, read from the chain.
 *
 * Reports the FINALIZED score, not this oracle's preview. A badge is shown to strangers
 * as a trust claim, so it carries the number that survived a challenge window rather
 * than the number this operator would like to propose.
 */
async function readBadgeState(address) {
  try {
    const didHash = await chain.didHashFor(address);
    const info = await chain.getAgentInfo(didHash);
    if (!info.registeredAt) return { kind: 'unregistered' };
    if (info.status === chain.STATUS_SLASHED) return { kind: 'slashed' };

    // getTotalScore applies maturity, so it is not the sum of the factors and has to be
    // read rather than derived. lastUpdated comes along to tell a genuine zero apart
    // from an agent nobody has scored yet.
    const [rep, score] = await Promise.all([
      chain.getReputationData(didHash),
      chain.getTotalScore(didHash),
    ]);
    if (!rep.lastUpdated) return { kind: 'unscored' };
    return { kind: 'scored', score };
  } catch (err) {
    metrics.inc('badgeRpcErrors');
    console.warn(`[oracle] /badge chain read failed for ${address}: ${err.message}`);
    return { kind: 'unavailable' };
  }
}

/**
 * The /evidence body for an agent, as a JSON string.
 *
 * Built once per (agent, payment set). Everything here is a pure function of `events`,
 * which is why it caches cleanly: the tree, every proof and the serialization are
 * O(E log E) work that does not change until a payment is credited or pruned.
 */
function buildEvidenceBody(didHash, events) {
  const tree = merkle.buildTree(events);
  return JSON.stringify({
    didHash,
    evidenceRoot: tree.root,
    count: events.length,
    // Exactly what the root commits to, in leaf order, so nobody has to read this
    // service's source to know which fields are covered. counterauditPacketId is
    // deliberately absent: it identifies an independently timestamped record of the
    // same work, which a verifier fetches and checks for themselves, and committing
    // to it would have changed the leaf format and made roots already published on
    // chain unreproducible.
    // `success` is served as true, false or null and enters the leaf as a uint8:
    // 0 failed, 1 succeeded, 2 not reported. The third state is what a payment found
    // by scanning the chain carries, since no outcome for it exists anywhere. Encoding
    // it as a boolean made it collide with a reported failure, which the score counts
    // very differently, so the root stopped covering the arithmetic it commits to.
    committedFields: ['txHash', 'payer', 'amount', 'settledAt', 'success'],
    // The leaf is derivable from the payment, so a verifier rebuilds it rather than
    // trusting the one served here; it is included to make that comparison easy.
    evidence: events.map((e, i) => ({
      txHash: e.txHash ?? null,
      payer: e.payer,
      amount: e.amount,
      settledAt: merkle.settledSeconds(e),
      success: e.success,
      leaf: tree.leaves[i],
      proof: merkle.proofFor(tree, i),
      // Corroboration, NOT part of the leaf. See committedFields above.
      ...(e.packetId ? { counterauditPacketId: e.packetId } : {}),
    })),
  });
}

// The rate-limit bucket for a request: who is asking, and which kind of route. One bucket
// for every route let a client flood a cheap or expensive read and use up the allowance of
// the one that mattered. /divergence is the case: the watcher polls it, and a bucket shared
// with /evidence and /score meant anyone could make the watcher's poll fail with a 429.
const rateKey = (req, cls) => `${cls}|${clientKey(req, isTrustedProxy)}`;

/**
 * Over this caller's limit for `bucket`? When true the 429 has already been sent and the route should
 * return. Nine routes carried this block word for word. The badge route keeps its own check on purpose,
 * because it limits only a cache miss.
 */
const overLimit = (req, res, bucket) => {
  if (!rateLimited(rateKey(req, bucket))) return false;
  metrics.inc('rateLimitHits');
  json(res, 429, { error: 'Rate limited' });
  return true;
};

async function handleRequest(req, res) {
  metrics.inc('httpRequests');
  // Only a path-form target whose path is already canonical is answered. See
  // parseRequestTarget for the three ways a raw request line used to get past a proxy's
  // allowlist or end the process.
  const url = parseRequestTarget(req.url, `http://localhost:${cfg.port}`);
  if (!url) {
    metrics.inc('httpBadTargets');
    return json(res, 400, { error: 'bad request target' });
  }
  const { pathname } = url;

  /* HEAD is routed as GET.
   *
   * Without this every HEAD fell through to the catch-all 404, so an uptime monitor
   * probing /health with the default HEAD read a healthy service as down. HTTP also
   * requires HEAD wherever GET is offered.
   *
   * Node suppresses the response body for HEAD by itself, so routing is the whole fix
   * and the handlers below need no special case. Only the read routes see this: the
   * POST routes keep testing req.method directly, so HEAD cannot reach a write.
   */
  const readMethod = req.method === 'HEAD' ? 'GET' : req.method;

  // GET /health — extended for production alerting
  if (readMethod === 'GET' && pathname === '/health') {
    // Never awaited. /health has to answer while the thing it reports on is broken,
    // which is exactly when an unreachable RPC would make it hang.
    const externalState = external.chainState();
    if (externalState.status === 'unreachable') external.refreshChainId().catch(() => {});
    const lastEpoch = metrics.get('lastSuccessfulEpochMs');
    const timeSinceLastEpoch = lastEpoch ? Date.now() - lastEpoch : null;
    const storeWritable = isStatePathWritable();
    // What the last write actually did, beside whether the path looks writable. The
    // probe writes a handful of bytes and deletes them, so it passes while a real state
    // file fails to land for want of space. Unhealthy on a failed persist because the
    // attest path has already answered 200 to somebody on the strength of it.
    const persisted = getLastPersist();

    const healthy = storeWritable
      && persisted.ok
      && !scoringIsStale({
        lastEpochMs: lastEpoch, nowMs: Date.now(), uptimeMs: metrics.uptimeSeconds() * 1000, epochMs: cfg.epochMs,
      });

    return json(res, healthy ? 200 : 503, {
      ok: healthy,
      epochMs: cfg.epochMs,
      uptimeSeconds: metrics.uptimeSeconds(),
      lastSuccessfulEpochMs: lastEpoch,
      timeSinceLastEpochMs: timeSinceLastEpoch,
      storeWritable,
      statePersisted: persisted.ok,
      lastPersistMs: persisted.at,
      ...(persisted.ok ? {} : { statePersistError: persisted.error }),
      statePath: getStatePath(),
      // 'file', 'fresh', or 'backup' when the state file was unusable and the previous save
      // was used instead, which is a recovery somebody should hear about.
      stateSource: getLoadReport().source,
      // The chain the RPC was last seen on, and the one this oracle was configured for. Null
      // until the first check, and the expected one is null when EXPECTED_CHAIN_ID is unset.
      chainId: verifiedChainId,
      expectedChainId: cfg.expectedChainId,
      attestCooldownMs: ATTEST_COOLDOWN_MS,
      epochRunning,
      commit: runningCommit(),
      // Whether the ERC-8004 feed is wired at all.
      //
      // externalScore renders as 0 in three unrelated situations: the operator never
      // configured EXTERNAL_*, the agent is not linked to an 8004 id, or it is linked
      // and has no feedback this oracle recognizes. Those call for completely
      // different responses and the score cannot tell them apart, so the first one is
      // answered here instead of being guessed at.
      // 'disabled' | 'configured' | 'unreachable'. The last one used to be invisible:
      // the old check could not distinguish a working feed from one pointed at a dead
      // host, and reported success for both.
      externalFeed: externalState.status,
      // Which chain the feed is really reading. The value that would have caught a
      // stale container holding an RPC for a different chain in one request.
      externalChainId: externalState.chainId,
      // 'disabled' | 'configured'. Reported for the same reason as the external feed:
      // a reader nobody enabled and a reader pointed at the wrong chain both produce no
      // jobs, and only one of those is fine.
      // 'enabled' | 'disabled', and how far it has got. Reported for the same reason
      // the external feed's chain id is: a scanner nobody enabled and a scanner stuck
      // 200,000 blocks behind both produce no new evidence, and only one is fine.
      paymentScan: paymentScanCfg.enabled ? 'enabled' : 'disabled',
      paymentScanBlock: (getPaymentScanState() || {}).lastBlock ?? null,
      jobsFeed: jobs.enabled(jobsCfg) ? 'configured' : 'disabled',
      jobsRegistry: jobsCfg.registry || null,
      jobsChainId,
    });
  }

  // GET /metrics — Prometheus text format
  if (readMethod === 'GET' && pathname === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    return res.end(metrics.toPrometheusText({ evidenceCache: evidenceCache.stats() }));
  }

  // POST /epoch  — trigger a manual run (useful for testing)
  if (req.method === 'POST' && pathname === '/epoch') {
    // Metered before it is authorised, so that guessing at a token is throttled as well.
    if (overLimit(req, res, 'write')) return;
    // Gated: a manual epoch submits on-chain tx's paid from the oracle wallet, so
    // it must not be triggerable by anyone who can reach the port.
    const caller = identifyCaller(req.headers, cfg.credentials);
    if (!caller) return json(res, 401, { error: 'Unauthorized' });
    if (!mayUse(cfg.scopes, caller, 'epoch')) return json(res, 403, { error: 'Forbidden' });
    if (epochRunning) return json(res, 409, { error: 'Epoch already running' });
    runEpoch().catch(err => console.error('[oracle] manual epoch error:', err.message));
    return json(res, 202, { message: 'Epoch started' });
  }

  // POST /attest  — body: { didHash, success, attester }
  // attester: unique ID for the party submitting the attestation (e.g. client address, API key hash).
  // Used for dedupe/cooldown: the same attester cannot attest the same agent within ATTEST_COOLDOWN_MS.
  if (req.method === 'POST' && pathname === '/attest') {
    if (overLimit(req, res, 'write')) return;
    try {
      const body = await readBody(req);
      const { success, packetId } = body;

      /* Authorisation depends on what is being claimed, so it is decided after the
       * body is read rather than before.
       *
       * A positive attestation backed by a verified payment carries its own
       * credential and needs no token: that is what lets a counterparty say "this
       * agent did work for me" without asking us for anything. A negative one still
       * needs the token, because it lowers the score directly and the payment proves
       * only that money moved. See mayAttestUnauthenticated.
       *
       * Reading the body before authorising widens the unauthenticated surface to a
       * 1 MB JSON parse, which the rate limit above already bounds.
       */
      const caller = identifyCaller(req.headers, cfg.credentials);
      // A credential restricted to other scopes is refused outright, not treated as a
      // stranger: it presented a token, and what it may do with it is the operator's rule.
      if (caller && !mayUse(cfg.scopes, caller, 'attest')) {
        return json(res, 403, { error: 'Forbidden' });
      }
      if (!mayAttestUnauthenticated(success, payments.required(paymentCfg)) && !caller) {
        return json(res, 401, {
          error: 'Unauthorized',
          detail: 'a positive, payment-verified attestation needs no token; anything else does',
        });
      }

      // true, false, or left out. Anything else is refused rather than guessed at: the tally
      // below used to count the string "false" as a success, because it is truthy.
      if (success !== undefined && success !== null && typeof success !== 'boolean') {
        metrics.inc('attestRejectedOther');
        return json(res, 400, { error: 'success must be true, false or omitted' });
      }

      /* What an outcome is worth depends on who reports it.
       *
       * A credential holder is a party this oracle has agreed to hear from: CounterAudit,
       * which audited the work, or the operator's own tooling. Its outcome is recorded.
       *
       * Anyone else holds only a settlement hash, and a settlement hash is public. It proves
       * that money moved to the agent, not that the person naming it paid, and not that the
       * work went well. Taking their `success` at its word let an agent's operator file
       * "success" against every one of its customers' payments before anyone else could, and
       * the first credit for a settlement is final. So a stranger's attestation still records
       * the payment, as evidence of fee volume and tenure, and records no outcome, which is
       * exactly what a payment found by the scan carries. A credential holder can still give
       * that payment its outcome afterwards.
       *
       * `caller` is truthy for a matched credential and in the open mode a loopback bind may
       * run in, where there are no credentials at all.
       */
      const outcome = caller && typeof success === 'boolean' ? success : null;

      let attester = body.attester;
      if (!body.didHash) {
        metrics.inc('attestRejectedOther');
        return json(res, 400, { error: 'didHash required' });
      }
      const didHash = parseDidHash(body.didHash);
      if (!didHash) {
        metrics.inc('attestRejectedOther');
        return json(res, 400, { error: 'didHash must be a 32-byte hex string' });
      }
      // Only needed when payments are off; otherwise it comes from the transfer.
      if (!attester && !payments.required(paymentCfg)) {
        metrics.inc('attestRejectedOther');
        return json(res, 400, { error: 'attester required (unique ID for the attestation source)' });
      }

      // With verification on, the attester is whoever actually paid, taken from the
      // settlement transfer. The `attester` field in the body is ignored: letting a
      // caller name themselves is what made attestations free to manufacture.
      let credited = null;
      // Declared here, not inside the block, because the per-leg self-payment check further
      // down reads it. It was declared inside, so every attestation with verification on
      // threw a ReferenceError at that line and was answered 400: nothing was credited, and
      // no test covered the route.
      let info = null;
      if (payments.required(paymentCfg)) {
        const txHash = body.payment && body.payment.txHash;
        try {
          info = await chain.getAgentInfo(didHash);
        } catch (err) {
          // The provider's message can carry the RPC URL, key and all, so it is logged
          // here and never sent to a caller who needed no token to get this far.
          metrics.inc('attestRejectedOther');
          console.warn(`[oracle] /attest chain read failed for ${didHash}: ${err.message}`);
          return json(res, 502, { error: 'could not read the chain', code: 'rpc_error' });
        }
        if (!info || Number(info.registeredAt) === 0) {
          metrics.inc('attestRejectedOther');
          return json(res, 400, { error: 'unknown didHash' });
        }
        try {
          credited = await payments.verifyPayment(
            { provider: chain.getProvider(), cfg: paymentCfg },
            txHash,
            info.agentAddress
          );
        } catch (err) {
          // An RPC failure is not the caller's fault and must not be recorded as a
          // rejected attestation, or a flaky node would look like abuse.
          const rpc = err.code === 'rpc_error';
          metrics.inc(rpc ? 'paymentRpcErrors' : 'attestRejectedPayment');
          // Only an rpc_error quotes the provider (payments.js wraps its message), so it
          // is the one kept off the wire. The others are this oracle's own words.
          if (rpc) {
            console.warn(`[oracle] /attest payment check failed for ${didHash}: ${err.message}`);
            return json(res, 502, { error: 'could not read the chain', code: 'rpc_error' });
          }
          return json(res, 402, { error: err.message, code: err.code || 'payment_invalid' });
        }
        if (payments.isSelfPayment(credited.payer, info)) {
          metrics.inc('attestRejectedPayment');
          return json(res, 402, {
            error: 'an agent cannot attest itself: the payer is its own operator or agent address',
            code: 'self_payment',
          });
        }
        attester = credited.payer;
      }

      /* The cooldown throttles strangers. A credential holder reporting on a payment this
       * oracle has just verified is not spamming: the settlement is single-use and cost real
       * money, and the credential is the throttle. Exempting it also stops the cooldown being
       * used as a lock. It is keyed on the payer, anyone can submit a public settlement hash,
       * and an agent's operator could therefore arm it on every customer payment as it
       * happened and keep the auditor's report out indefinitely. With verification off every
       * caller holds a credential, so the cooldown there is untouched.
       */
      const throttled = !(credited && caller);
      if (throttled) {
        const cooldownCheck = checkAttestCooldown(attester, didHash);
        if (!cooldownCheck.allowed) {
          metrics.inc('attestRejectedCooldown');
          const remainingSec = Math.ceil(cooldownCheck.remainingMs / 1000);
          return json(res, 429, {
            error: 'Attestation cooldown active',
            attester,
            didHash,
            remainingSeconds: remainingSec,
            cooldownMs: ATTEST_COOLDOWN_MS,
          });
        }
      }

      // Whether this request put an outcome on a payment. Only meaningful when one was
      // credited; without verification there is no payment to hang an outcome on.
      let outcomeRecorded = false;
      if (credited) {
        // Credit after the cooldown check so a rejected attestation does not burn
        // the receipt; the payer can retry once the cooldown clears.
        // packetId is optional corroboration: an identifier for a tamper-evident,
        // independently timestamped record of the same work, so a verifier can check
        // the payment on chain AND that such a record existed. Validated for shape
        // only — this oracle does not call CounterAudit to confirm it, because an
        // evidence path that depends on someone's SaaS is not evidence.
        const packet = /^[0-9a-fA-F-]{36}$/.test(String(packetId || '')) ? String(packetId) : null;

        // One event per sender. Two payers can credit one agent in a single transaction,
        // and recording that as a single payment from one of them lost who actually paid,
        // which the per-payer cap, the distinct counterparty count and propagation all
        // read. The scan groups by sender for the same reason, so the two paths now agree
        // about a transaction instead of applying different payer rules to it.
        //
        // The outcome goes on the largest leg alone. An attestation reports on one piece
        // of work, so repeating its boolean per sender would count one job several times
        // in the success ratio. The remaining legs are money that demonstrably moved with
        // nobody reporting on it, which is exactly what `success: null` already means, so
        // they count toward fee volume and tenure and stay out of both sides of the
        // ratio. For a single sender, which is nearly every payment, this is one call
        // with the outcome, as before.
        const legs = credited.legs ?? [{ payer: credited.payer, amount: credited.amount }];
        let anyCredited = false;
        let outcomeConflict = false;
        for (const [i, leg] of legs.entries()) {
          // Per leg, matching planCredits, which refuses a self-paying sender group and
          // credits the rest of the transaction. Checking only the largest contributor
          // would let an operator's own leg ride along inside a transaction a real
          // customer also paid into, and would put the two intake paths back into
          // disagreement about the same transaction.
          if (payments.isSelfPayment(leg.payer, info)) continue;
          const legOutcome = i === 0 ? outcome : null;
          if (creditPayment(
            didHash, credited.txHash, leg.amount, leg.payer, legOutcome, credited.settledAt, packet,
            credited.blockNumber,
          )) {
            anyCredited = true;
            if (legOutcome !== null) outcomeRecorded = true;
            continue;
          }
          // Credited before. A report with an outcome is not a replay when the earlier
          // credit carried none (the scan, or a stranger's attestation): it is the first
          // outcome this payment has had. An outcome that is already recorded stays.
          if (legOutcome === null) continue;
          const filed = setPaymentOutcome(didHash, credited.txHash, leg.payer, legOutcome);
          if (filed === 'set') { anyCredited = true; outcomeRecorded = true; }
          else if (filed === 'already_set') outcomeConflict = true;
        }
        if (!anyCredited) {
          metrics.inc('attestRejectedPayment');
          return outcomeConflict
            ? json(res, 409, { error: 'an outcome has already been recorded for this settlement', code: 'outcome_recorded' })
            : json(res, 409, { error: 'this settlement has already been credited', code: 'replayed' });
        }
        metrics.inc('paymentsVerified');
      }

      // Recorded last, once something has been accepted. These used to be written before the
      // credit was decided, so a refused replay (409) of somebody else's public settlement
      // still armed the payer's cooldown and added to the tally: anyone could lock a payer
      // out of an agent, an hour at a time, by replaying that payer's transaction.
      const att = attestations.get(didHash) ?? { successful: 0, total: 0 };
      att.total++;
      if (outcome === true) att.successful++;
      attestations.set(didHash, att);
      if (throttled) recordAttestation(attester, didHash);
      persistState();
      metrics.inc('attestAccepted');
      return json(res, 200, {
        didHash,
        attester,
        ...att,
        ...(credited
          ? { payment: { txHash: credited.txHash, amount: credited.amount.toString() }, outcomeRecorded }
          : {}),
      });
    } catch (err) {
      metrics.inc('attestRejectedOther');
      return json(res, bodyErrorStatus(err), { error: err.message });
    }
  }

  // GET /divergence and /divergence/:didHash — where this oracle disagreed with the
  // score pending on chain.
  //
  // Only a checker ever writes these. Public for the same reason /evidence is: the
  // point of running a second operator is that its disagreements are visible to
  // someone other than its own operator. An alert only its author can read is not a
  // check on anything.
  if (readMethod === 'GET' && (pathname === '/divergence' || pathname.startsWith('/divergence/'))) {
    // Its own class: the watcher polls this, and sharing a bucket with the expensive reads
    // let anyone make that poll fail.
    if (overLimit(req, res, 'divergence')) return;
    if (!cfg.checkerMode) {
      // A primary has nothing to say here, and an empty list would read as "checked,
      // no disagreements" rather than "this oracle does not check".
      return json(res, 404, { error: 'not_a_checker', message: 'This oracle does not run in checker mode.' });
    }
    if (pathname === '/divergence') {
      // Capped. Serialising every agent's full history on an unauthenticated route is
      // CPU and bandwidth an anonymous caller gets to spend 60 times a minute, on the
      // same event loop that serves /attest and runs the epoch timer. Newest first,
      // because a committee acts on what is still inside its challenge window.
      const flat = [];
      for (const [didHash, list] of Object.entries(allDivergences())) {
        for (const e of list) flat.push({ didHash, ...e });
      }
      flat.sort((a, b) => b.at - a.at);
      const recent = flat.slice(0, DIVERGENCE_PAGE);
      return json(res, 200, {
        mode: 'checker',
        tolerance: cfg.divergenceTolerance,
        // So an empty list cannot be read as "checked, found nothing" when the real
        // answer is "this checker's epoch is too long to see proposals before they
        // expire". Silence and not looking are different claims.
        epochHours: cfg.epochMs / 3_600_000,
        challengeWindowHours: lastChallengeWindow === null ? null : lastChallengeWindow / 3600,
        seesProposals: lastChallengeWindow === null ? null : cfg.epochMs < (lastChallengeWindow * 1000) / 2,
        total: flat.length,
        truncated: flat.length > recent.length,
        divergences: recent,
      });
    }
    // Lowercased like every other route: divergences are recorded under the hash as the
    // chain returns it, so a mixed-case query read as "checked, nothing found".
    const didHash = parseDidHash(pathname.slice('/divergence/'.length));
    if (!didHash) {
      return json(res, 400, { error: 'didHash must be a 32-byte hex string' });
    }
    return json(res, 200, {
      mode: 'checker',
      tolerance: cfg.divergenceTolerance,
      didHash,
      divergences: getDivergences(didHash),
    });
  }

  // GET /evidence/:didHash — the payments behind an agent's score, with proofs.
  //
  // Everything here is checkable without trusting this service: each txHash can be
  // read off the chain, and the root can be compared with the one the reputation
  // contract holds. Deliberately unauthenticated, like /score: evidence nobody can
  // fetch is evidence nobody can audit.

  if (readMethod === 'GET' && pathname.startsWith('/evidence/')) {
    // Unauthenticated does not mean unmetered. A cache miss rebuilds a Merkle tree over
    // the agent's payment history, so this is the most expensive thing a stranger can
    // ask for once the read paths are proxied to the public internet. The cache below
    // bounds repeat cost, not first-request cost, and the limiter still matters.
    if (overLimit(req, res, 'evidence')) return;
    // The one stored spelling. The cache is keyed on this, and it used to be keyed on
    // whatever casing the caller sent, so one agent's hash had millions of spellings, each
    // its own cache entry and each a full Merkle rebuild.
    const didHash = parseDidHash(pathname.slice('/evidence/'.length));
    if (!didHash) {
      return json(res, 400, { error: 'didHash must be a 32-byte hex string' });
    }
    const events = getPaymentEvents(didHash);
    const body = evidenceCache.get(didHash, events, () => buildEvidenceBody(didHash, events));

    // Same bytes a miss would have produced, so a hit is indistinguishable to the
    // caller. json() is not used because it would re-serialize what is already a string.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(body);
  }

  // POST /flag  — body: { didHash }
  if (req.method === 'POST' && pathname === '/flag') {
    if (overLimit(req, res, 'write')) return;
    const caller = identifyCaller(req.headers, cfg.credentials);
    if (!caller) return json(res, 401, { error: 'Unauthorized' });
    if (!mayUse(cfg.scopes, caller, 'flag')) return json(res, 403, { error: 'Forbidden' });
    try {
      // Validated and lower-cased like every other route that writes. A flag keyed on any
      // value at all, an object included, broke every later save of the state file until
      // the process was restarted, and a flag filed under a mixed-case spelling was one
      // no score ever read.
      const didHash = parseDidHash((await readBody(req)).didHash);
      if (!didHash) return json(res, 400, { error: 'didHash must be a 32-byte hex string' });
      const raised = addFlag(didHash);
      persistState();
      metrics.inc('flagsReceived');
      // Attributed. "Someone with the token flagged this agent" stops being an answer
      // once several services hold tokens, and a flag costs an agent real points.
      console.log(`[oracle] flag raised on ${didHash} by ${caller} (now ${raised})`);
      return json(res, 200, { didHash, flags: raised });
    } catch (err) {
      return json(res, bodyErrorStatus(err), { error: err.message });
    }
  }

  // POST /flag/resolve — body: { didHash, count? }
  //
  // The counterpart /flag never had. Flagging was one-way, so a flag raised in error
  // cost two Community points until someone edited the state file by hand. That is
  // tolerable while flags arrive from a person and untenable once a threshold in some
  // other service produces them, which is the direction this is heading.
  //
  // Token-gated like /flag, and for a stronger reason: this one raises a score. It
  // stays off the public proxy entirely.
  if (req.method === 'POST' && pathname === '/flag/resolve') {
    if (overLimit(req, res, 'write')) return;
    const caller = identifyCaller(req.headers, cfg.credentials);
    if (!caller) return json(res, 401, { error: 'Unauthorized' });
    if (!mayUse(cfg.scopes, caller, 'flag')) return json(res, 403, { error: 'Forbidden' });
    try {
      const body = await readBody(req);
      const didHash = parseDidHash(body.didHash);
      const { count } = body;
      if (!didHash) return json(res, 400, { error: 'didHash must be a 32-byte hex string' });

      const result = resolveFlags(didHash, count ?? 1);
      // Persist only on a real change, so a no-op call does not rewrite the state file.
      if (result.resolved > 0) {
        persistState();
        metrics.inc('flagsResolved', result.resolved);
        console.log(`[oracle] ${result.resolved} flag(s) cleared on ${didHash} by ${caller}`);
      }
      return json(res, 200, { didHash, ...result });
    } catch (err) {
      return json(res, bodyErrorStatus(err), { error: err.message });
    }
  }

  // POST /link  — body: { didHash, agentId } — link a Sigvara agent to its
  // ERC-8004 identity so its 8004 feedback drives externalScore. Accepted only
  // if the 8004 agent NFT is owned by the same wallet as the Sigvara operator.
  if (req.method === 'POST' && pathname === '/link') {
    if (overLimit(req, res, 'write')) return;
    const caller = identifyCaller(req.headers, cfg.credentials);
    if (!caller) return json(res, 401, { error: 'Unauthorized' });
    if (!mayUse(cfg.scopes, caller, 'link')) return json(res, 403, { error: 'Forbidden' });
    try {
      const body = await readBody(req);
      const didHash = parseDidHash(body.didHash);
      const { agentId } = body;
      if (!didHash) return json(res, 400, { error: 'didHash must be a 32-byte hex string' });
      if (agentId === undefined || agentId === null) {
        return json(res, 400, { error: 'didHash and agentId required' });
      }
      if (!external.configured()) return json(res, 400, { error: 'external (ERC-8004) registry not configured' });
      let operator;
      try {
        ({ operator } = await chain.getAgentInfo(didHash));
      } catch (err) {
        console.warn(`[oracle] /link chain read failed for ${didHash}: ${err.message}`);
        return json(res, 502, { error: 'could not read the chain', code: 'rpc_error' });
      }
      const owns = await external.verifyOwnership(String(agentId), operator);
      if (!owns) {
        return json(res, 403, { error: 'ERC-8004 agent is not owned by this agent\'s Sigvara operator; refusing to link' });
      }
      links.set(didHash, String(agentId));
      persistState();
      metrics.inc('linksCreated');
      return json(res, 200, { didHash, agentId: String(agentId), operator, linked: true });
    } catch (err) {
      return json(res, bodyErrorStatus(err), { error: err.message });
    }
  }

  // GET /jobs/<address> — ERC-8183 jobs for one provider. Observation only.
  //
  // Nothing here feeds a score. ERC-8183 is a Draft ERC and has no canonical deployment
  // on Arc, so this exists to watch real traffic before anything is calibrated against
  // it, which is the same order the gating roadmap uses: observe, then enforce.
  const jobsAddress = /^\/jobs\/(0x[0-9a-fA-F]{40})$/.exec(pathname)?.[1];
  if (readMethod === 'GET' && jobsAddress) {
    if (!jobs.enabled(jobsCfg)) {
      // 501, not an empty list. An empty result would read as "this agent has done no
      // jobs", which is the opposite of "nobody has told this oracle where to look".
      return json(res, 501, {
        error: 'jobs reader not configured',
        code: 'jobs_disabled',
        hint: 'set JOBS_REGISTRY_ADDRESS (and JOBS_RPC if the registry is on another chain)',
      });
    }
    if (overLimit(req, res, 'read')) return;
    try {
      const provider = await jobsProviderOrNull();
      const head = await provider.getBlockNumber();
      const requested = Number(url.searchParams.get('fromBlock') ?? NaN);
      const floor = Math.max(0, head - JOBS_MAX_SPAN);
      // Bounded by default and bounded when asked. An unbounded scan from genesis is the
      // most expensive thing a stranger could ask this process to do.
      const from = Number.isFinite(requested)
        ? Math.max(requested, floor)
        : Math.max(jobsCfg.fromBlock, floor);

      const all = await jobs.readJobs({ provider, cfg: jobsCfg }, from, head);
      const { evidence, dropped } = jobs.toEvidence(all, jobsAddress);
      metrics.inc('jobsReads');

      return json(res, 200, {
        provider: jobsAddress,
        registry: jobsCfg.registry,
        chainId: jobsChainId,
        // The window actually scanned, so a caller can tell a quiet agent from a narrow
        // look. Without it "0 jobs" is unreadable.
        window: { fromBlock: from, toBlock: head, truncated: from > jobsCfg.fromBlock },
        counts: {
          jobsSeen: all.length,
          usable: evidence.length,
          dropped: dropped.length,
          successful: evidence.filter((e) => e.success).length,
          independentlyEvaluated: evidence.filter((e) => e.independentEvaluator).length,
        },
        // Named rather than counted, because a job refused for self-evaluation and one
        // that simply expired mean different things about the agent.
        dropped,
        evidence,
        scored: false,
      });
    } catch (err) {
      metrics.inc('jobsErrors');
      console.warn(`[oracle] /jobs read failed for ${jobsAddress}: ${err.message}`);
      return json(res, 502, { error: 'could not read the job registry', code: 'jobs_rpc_error' });
    }
  }

  // GET /badge/<address>.svg — the embeddable score badge.
  const badgeAddress = badge.parseBadgePath(pathname);
  if (readMethod === 'GET' && badgeAddress) {
    metrics.inc('badgeRequests');
    const key = badgeAddress.toLowerCase();
    let state = badgeCache.get(key);

    if (state) {
      metrics.inc('badgeCacheHits');
    } else if (rateLimited(rateKey(req, 'read'))) {
      // The limiter guards the miss path only. One badge in a popular README is a
      // single address fetched by thousands of readers, which the cache absorbs
      // entirely; somebody walking the address space is thousands of addresses that
      // all miss, and that is the traffic worth refusing.
      metrics.inc('rateLimitHits');
      state = { kind: 'unavailable' };
    } else {
      state = await readBadgeState(badgeAddress);
      // An unreadable chain is this oracle's problem and should clear by itself rather
      // than being pinned into the cache for the full five minutes.
      badgeCache.set(key, state, state.kind === 'unavailable' ? 15_000 : 60_000);
    }

    // 200 for every state that renders, including "not registered". An error status
    // here paints a broken image on somebody else's page, which reads as "this
    // protocol is broken" rather than "this address has no agent".
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': state.kind === 'unavailable'
        ? 'public, max-age=15'
        : 'public, max-age=300, stale-while-revalidate=600',
      // The whole point of the endpoint is being loaded from other origins, and a
      // browser enforcing CORP refuses it without this.
      'Cross-Origin-Resource-Policy': 'cross-origin',
      'Access-Control-Allow-Origin': '*',
    });
    return res.end(badge.renderBadge(state));
  }

  // GET /score/:didHash  — preview computed score without writing to chain
  const didHash = parseScorePath(pathname);
  if (readMethod === 'GET' && didHash) {
    // Each call costs several RPC round trips (agent info, payer standing, and the
    // external score when one is linked), so it is metered like the writes despite
    // needing no token.
    if (overLimit(req, res, 'read')) return;
    try {
      // Upstream failures are reported as 502, the way /attest already reports them.
      // A node having a bad minute is not a bad request, and answering 500 told a
      // caller the oracle was broken when the chain was the thing that was unreachable.
      let info;
      try {
        info = await chain.getAgentInfo(didHash);
      } catch (err) {
        metrics.inc('scoreRpcErrors');
        console.warn(`[oracle] /score chain read failed for ${didHash}: ${err.message}`);
        return json(res, 502, { error: 'could not read the chain', code: 'rpc_error' });
      }
      const { operator, registeredAt, status } = info;
      const att       = attestations.get(didHash) ?? { successful: 0, total: 0 };
      const flagWeight = decayedFlagCount(didHash);
      const linkedId  = links.get(didHash);
      const externalScore = (external.configured() && linkedId !== undefined)
        ? await external.externalScoreFor(linkedId, operator)
        : 0;
      // Same inputs as the epoch, including counterparty standing AND the chain clock,
      // or this endpoint would serve a number the oracle never proposes. Two operators'
      // /score are compared against each other by hand when a divergence is investigated,
      // so serving a wall-clock number here would reintroduce exactly the difference the
      // epoch path removes, in the place people look to explain it.
      //
      // One extra chain read per request, on an endpoint that already makes several.
      const scoringNowMs = (await chain.getLatestBlockTimestamp()) * 1000;
      const { measured, scores } = await scoreAt(didHash, { registeredAt, att, flagWeight, externalScore }, scoringNowMs);
      return json(res, 200, {
        didHash,
        status,
        scores,
        attestations: att,
        // Present only when payment verification is on. Shows what the score was
        // actually computed from, which is age-weighted and so differs from the
        // raw tally above.
        ...(measured.measuredAttestations ? { weighted: {
          attestations: measured.measuredAttestations,
          distinctPayers: measured.distinctPayers,
          activity: measured.activity,
          trustWeight: paymentCfg.trustWeight,
          halfLifeDays: paymentCfg.halfLifeMs / 86400000,
          maxPerPayer: paymentCfg.maxPerPayer,
        } } : {}),
        // Both: the raw count is what an operator raised, the weight is what the
        // score actually charged for it.
        flags: flagCount(didHash),
        flagWeight: Number(flagWeight.toFixed(4)),
        erc8004AgentId: linkedId ?? null,
      });
    } catch (err) {
      // The node could not answer for a payer, after retries. An upstream failure like the one above,
      // not a bug in this oracle.
      if (chain.isTransientReadError(err)) {
        metrics.inc('scoreRpcErrors');
        console.warn(`[oracle] /score chain read failed for ${didHash}: ${err.message}`);
        return json(res, 502, { error: 'could not read the chain', code: 'rpc_error' });
      }
      /* Anything reaching here is a bug or an upstream failure outside the guarded
       * read above, so it is logged in full and reported generically.
       *
       * This endpoint is unauthenticated and public. It used to return err.message
       * verbatim, which hands an anonymous caller whatever an ethers or provider
       * error happens to contain, including upstream URLs. /attest can echo its
       * errors because a bearer token gates it; this cannot.
       */
      metrics.inc('scoreErrors');
      console.error(`[oracle] /score failed for ${didHash}:`, err);
      return json(res, 500, { error: 'could not compute the score' });
    }
  }

  return json(res, 404, { error: 'Not found' });
}

/* A handler that throws must cost one request, not the process.
 *
 * handleRequest is async, and Node ends the process on a rejection nothing handles, so any
 * throw outside a route's own try block was a remote shutdown for anyone who could reach
 * the port; the request-target parser was one, and a single request line was enough. The
 * restart policy brought the container back, and the compose files re-cloned `main` each
 * time (they now fetch a pinned commit). The error is logged with the request line quoted, so a hostile target cannot forge
 * a log line, and the caller is told nothing about it.
 */
const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    metrics.inc('httpHandlerErrors');
    console.error(
      `[oracle] request failed: ${req.method} ${JSON.stringify(String(req.url).slice(0, 200))}: ` +
      `${(err && err.message) || err}`,
    );
    if (res.headersSent) {
      res.destroy();
    } else {
      json(res, 500, { error: 'internal error' });
    }
  });
});

{
  const policyError = adminTokenPolicyError(cfg.host, cfg.credentials);
  if (policyError) {
    console.error(`[oracle] ${policyError}`);
    process.exit(1);
  }
}

server.listen(cfg.port, cfg.host, () => {
  if (!cfg.adminToken) {
    console.warn('[oracle] WARNING: ORACLE_ADMIN_TOKEN is unset — /attest, /flag, and /epoch are UNAUTHENTICATED. Set a token before exposing this service.');
  }
  console.log(`[oracle] HTTP on ${cfg.host}:${cfg.port}  epoch every ${cfg.epochMs / 3_600_000}h  attest cooldown ${ATTEST_COOLDOWN_MS / 1000}s`);
  // Names only, never the tokens. Revoking a credential means deleting its variable and
  // restarting, so the startup line is where you confirm it actually went.
  console.log(`[oracle] write credentials: ${cfg.credentials.size ? [...cfg.credentials.keys()].join(', ') : 'NONE (writes are unauthenticated)'}`);
  if (cfg.scopes.size) {
    console.log(`[oracle] restricted credentials: ${[...cfg.scopes].map(([n, s]) => `${n}=${[...s].join('+')}`).join(', ')}`);
  }
  // Names only. A short token is a warning, not a refusal: a running deployment may hold
  // one, and refusing at startup would turn a restart into an outage. A new token should
  // be generated, not shortened.
  const weak = weakCredentials(cfg.credentials);
  if (weak.length) {
    console.warn(`[oracle] WARNING: credential(s) ${weak.join(', ')} shorter than ${MIN_TOKEN_LENGTH} characters. Generate a token with: openssl rand -hex 32`);
  }
  if (!process.env.TRUSTED_PROXIES && !['127.0.0.1', 'localhost', '::1'].includes(cfg.host)) {
    console.warn(
      '[oracle] WARNING: TRUSTED_PROXIES is unset and the listener is not loopback-only. Behind a reverse ' +
      'proxy in a container every visitor then shares one rate-limit bucket. Set TRUSTED_PROXIES to the ' +
      'proxy network, for example 172.16.0.0/12.',
    );
  }
  console.log(`[oracle] state path: ${getStatePath()}`);
  // A state file that exists and cannot be used stops the process. It used to log "starting
  // fresh" and carry on, and the next save wrote an empty state over the original. See
  // store.load for what is recovered on the way and what is refused.
  try {
    loadState();
  } catch (err) {
    console.error(`[oracle] ${err.message}`);
    process.exit(1);
  }

  // Resume the log scan where it left off. Without this every restart replays the
  // chain from FROM_BLOCK, which lengthens with every block and eventually exceeds
  // what a public RPC will serve in one burst.
  if (chain.restoreScanState(loadScanState())) {
    console.log(`[oracle] resuming log scan from block ${loadScanState().lastScannedBlock + 1}`);
  }

  // Which half of a two-operator setup this process is. Said at boot because the two
  // modes differ in what they will write to the chain, and running the wrong one is
  // otherwise invisible until the epoch after something has already gone out.
  if (cfg.checkerMode) {
    console.log(
      `[oracle] CHECKER mode — audits pending proposals, tolerance ${cfg.divergenceTolerance} points. ` +
      'Proposes only into an empty slot; never overwrites or finalizes a disputed score.',
    );
  }

  // Check once whether didHash can be derived locally instead of fetched. Doing it here
  // rather than lazily means the answer is settled before the first epoch, and the one
  // round trip it costs is paid per process rather than per counterparty.
  chain.verifyDidHashDerivation().then(ok => {
    if (ok) console.log('[oracle] didHash derived locally (verified against the registry)');
  }).catch(() => {});

  // Reported, not enforced. The contract decides; this just means an oracle that
  // cannot propose says so at boot instead of failing quietly once an hour.
  chain.operatorStanding().then(({ enforced, allowed, operatorBond }) => {
    if (!enforced) return;
    if (allowed) {
      console.log(`[oracle] bonded operator check passed (registry ${operatorBond})`);
    } else {
      console.warn(
        `[oracle] WARNING: this wallet is neither an admitted operator in ${operatorBond} nor the signer ` +
        'one has named. Every proposeReputation will revert until its operator has bonded, been admitted ' +
        'and named this wallet with setSigner.'
      );
    }
  }).catch(() => {});
  // Which chain, now and not only at the first epoch, so a wrong one ends the process instead
  // of waiting to be noticed. A node that cannot be reached yet is not a wrong chain: the
  // epochs wait for the answer.
  ensureChain().catch((err) => {
    if (err instanceof chain.ChainMismatchError) {
      console.error(`[oracle] ${err.message}`);
      process.exit(1);
    }
    console.warn(`[oracle] could not check the chain yet (${err.message}); epochs wait until it can be checked`);
  });
  runEpoch().catch(err => console.error('[oracle] startup epoch error:', err.message));
  setInterval(() => runEpoch().catch(err => console.error('[oracle] scheduled epoch error:', err.message)), cfg.epochMs);
});
