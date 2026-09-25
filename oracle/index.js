'use strict';

require('dotenv').config();

const http = require('http');
const chain = require('./chain');
const external = require('./external');
const { computeScore } = require('./scoring');
const {
  decideAction, decideCheckerAction, scoreDivergence,
  epochIntervalError, divergenceToleranceError, DEFAULT_DIVERGENCE_TOLERANCE,
  mapChunked,
} = require('./epoch-policy');
const { json, readBody, readCredentials, identifyCaller, mayAttestUnauthenticated, parseScorePath, rateLimited, clientKey, adminTokenPolicyError, runningCommit } = require('./http-helpers');
const payments = require('./payments');
const merkle = require('./merkle');
const { createResponseCache } = require('./response-cache');
const badge = require('./badge');
const jobs = require('./jobs');
const paymentScan = require('./payment-scan');
const metrics = require('./metrics');

// Verified-payment settings. Read once at startup so a malformed value fails the
// process rather than silently disabling verification on the first request.
const paymentCfg = payments.readConfig();

// ERC-8183 job registry, read-only and off unless JOBS_REGISTRY_ADDRESS is set. Parsed
// at startup so a malformed address stops the process rather than failing on the first
// request, the same way the payment config does.
const paymentScanCfg = paymentScan.readConfig();
const jobsCfg = jobs.readConfig();
let jobsProvider = null;
let jobsChainId = null;


// ---- Config ----------------------------------------------------------------

const trimTrailingSlash = (u) => String(u).endsWith('/') ? String(u).replace(/\/+$/, '') : String(u);

const cfg = {
  rpcUrl:            process.env.RPC_URL            || '',
  privateKey:        process.env.ORACLE_PRIVATE_KEY || '',
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
  // A checker that proposes as failover would otherwise run the primary's fee path and
  // debit the agent a second time for one scoring epoch: chargeEpoch has no per-epoch
  // idempotency, so two operators charging is two charges. A checker does not bill.
  if (cfg.feeRegistryAddress) {
    console.error(
      '[oracle] ORACLE_MODE=checker with FEE_REGISTRY_ADDRESS set. A checker must not ' +
      'charge epoch fees — chargeEpoch is not idempotent, so the agent would pay twice ' +
      'for one epoch. Unset FEE_REGISTRY_ADDRESS on the checker.',
    );
    process.exit(1);
  }
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
  getScanState: loadScanState,
  setScanState,
  getPaymentScanState,
  setPaymentScanState,
  isCredited,
  getPaymentEvents,
  allPaymentEvents,
  prunePaymentEvents,
  pruneExpiredCooldowns,
  isStatePathWritable,
  getStatePath,
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
  // getAgentScore swallows its own failures and returns 0, so this cannot reject: an
  // unreachable counterparty reads as "no standing", which is what it already meant.
  const misses = [...unique].filter(([key]) => !payerScoreCache.has(key));
  if (misses.length > 0) {
    const scores = await Promise.all(misses.map(([, addr]) => chain.getAgentScore(addr)));
    misses.forEach(([key], i) => payerScoreCache.set(key, scores[i]));
  }

  const out = {};
  for (const [key] of unique) out[key] = payerScoreCache.get(key);
  return out;
}

// ---- Epoch -----------------------------------------------------------------

// Guards against overlapping epochs from the setInterval tick and the manual
// /epoch endpoint firing at the same time, which would submit tx's with colliding
// nonces from the shared oracle wallet.
let epochRunning = false;

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
    // The stored event keeps no block number, so the receipt supplies it. One extra
    // call, on a path that only runs when a scan found nothing.
    const receipt = await chain.readWithBackoff(
      'canary receipt', () => provider.getTransactionReceipt(canary.txHash),
    );
    if (!receipt || receipt.blockNumber === undefined || receipt.blockNumber === null) {
      return 'unavailable'; // cannot locate the settlement, so this proves nothing
    }
    const logs = await chain.readWithBackoff(
      'canary getLogs',
      () => provider.getLogs(
        paymentScan.canaryFilter(paymentCfg.asset, canary.recipient, receipt.blockNumber),
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
    { readLogs, asset: paymentCfg.asset },
    [...byAddress.values()].map((a) => a.agentAddress),
    from, to, paymentScanCfg.chunkSize,
  );

  const { credits, skipped } = paymentScan.planCredits(logs.map(paymentScan.decodeTransfer), {
    didHashOf: (address) => byAddress.get(address.toLowerCase())?.didHash ?? null,
    operatorOf: (didHash) => byDid.get(didHash)?.operator ?? null,
    // Ask the store, so the scan's pre-check and creditPayment cannot drift apart.
    isUsed: (txHash, didHash) => isCredited(txHash, didHash),
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
    if (creditPayment(c.didHash, c.txHash, c.amount, c.payer, null, ts)) {
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
  if (refused) metrics.add('paymentScanRefused', refused);

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
        'same filter the scan uses. Treat this range as unverified, not as quiet.',
      );
    }
  }

  // Never past a block still unresolved. The scan only moves forward, so advancing over
  // one would lose that payment for good.
  const nextCheckpoint = paymentScan.checkpointAfter(unresolved, from, to);
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
  /** Widest block range one /jobs request may scan. */
const JOBS_MAX_SPAN = Number(process.env.JOBS_MAX_SPAN || 50_000);

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
        const measured  = measuredFactorsFor(didHash, scoringNowMs, await payerScoresFor(didHash));
        const scores    = computeScore({
          registeredAt,
          attestations: measured.measuredAttestations ?? att,
          flags: flagWeight,
          externalScore,
          measuredFeeScore: measured.measuredFeeScore,
          activity: measured.activity,
          propagation: measured.propagation,
          now: scoringNowMs,
        });

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
          const freshPending = await chain.getPendingScore(didHash);

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
            const m = measuredFactorsFor(didHash, atProposalMs, await payerScoresFor(didHash));
            auditScores = computeScore({
              registeredAt,
              attestations: m.measuredAttestations ?? att,
              flags: flagWeight,
              externalScore,
              measuredFeeScore: m.measuredFeeScore,
              activity: m.activity,
              propagation: m.propagation,
              now: atProposalMs,
            });
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

        // Charge before proposing, not after. The coverage read above and the
        // charge are separated by at least the propose transaction, and an
        // operator can withdraw in that gap: they would be scored for free, and
        // because the charge used to be fire-and-forget the failure was silent.
        // Taking the fee first means a withdrawal after the charge costs them
        // nothing to us. The trade-off is that an agent charged for an epoch whose
        // proposal then fails has paid for a run it did not get; that is logged
        // and counted, and is the lesser of the two errors.
        // Never in checker mode. chargeEpoch has no per-epoch idempotency, so a second
        // operator running this path would debit the agent a second time for one scoring
        // epoch. Startup already refuses checker + FEE_REGISTRY_ADDRESS; this is the
        // second lock on a path that moves real value.
        if (gatingActive && !cfg.checkerMode) {
          try {
            await chain.chargeEpoch(didHash);
            metrics.inc('feeCharges');
          } catch (chargeErr) {
            console.error(`[oracle]   ${didHash.slice(0, 10)}… epoch-fee charge failed, not scoring: ${chargeErr.message}`);
            metrics.inc('feeChargeErrors');
            continue;
          }
        }

        metrics.inc('proposeAttempts');
        // Commit to the evidence alongside the score. Without it the only record of
        // which payments produced this number is the oracle's own state file, and a
        // third party checking the arithmetic would have to take that on trust.
        const evidenceRoot = payments.required(paymentCfg)
          ? merkle.rootFor(getPaymentEvents(didHash))
          : undefined;
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${cfg.port}`);
  const { pathname } = url;
  metrics.inc('httpRequests');

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

    const healthy = storeWritable && (!lastEpoch || timeSinceLastEpoch < cfg.epochMs * 2);

    return json(res, healthy ? 200 : 503, {
      ok: healthy,
      epochMs: cfg.epochMs,
      uptimeSeconds: metrics.uptimeSeconds(),
      lastSuccessfulEpochMs: lastEpoch,
      timeSinceLastEpochMs: timeSinceLastEpoch,
      storeWritable,
      statePath: getStatePath(),
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
    // Gated: a manual epoch submits on-chain tx's paid from the oracle wallet, so
    // it must not be triggerable by anyone who can reach the port.
    const caller = identifyCaller(req.headers, cfg.credentials);
    if (!caller) return json(res, 401, { error: 'Unauthorized' });
    if (rateLimited(clientKey(req))) {
      metrics.inc('rateLimitHits');
      return json(res, 429, { error: 'Rate limited' });
    }
    if (epochRunning) return json(res, 409, { error: 'Epoch already running' });
    runEpoch().catch(err => console.error('[oracle] manual epoch error:', err.message));
    return json(res, 202, { message: 'Epoch started' });
  }

  // POST /attest  — body: { didHash, success, attester }
  // attester: unique ID for the party submitting the attestation (e.g. client address, API key hash).
  // Used for dedupe/cooldown: the same attester cannot attest the same agent within ATTEST_COOLDOWN_MS.
  if (req.method === 'POST' && pathname === '/attest') {
    if (rateLimited(clientKey(req))) {
      metrics.inc('rateLimitHits');
      return json(res, 429, { error: 'Rate limited' });
    }
    try {
      const body = await readBody(req);
      const { didHash, success, packetId } = body;

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
      if (!mayAttestUnauthenticated(success, payments.required(paymentCfg)) && !caller) {
        return json(res, 401, {
          error: 'Unauthorized',
          detail: 'a positive, payment-verified attestation needs no token; anything else does',
        });
      }

      let attester = body.attester;
      if (!didHash) {
        metrics.inc('attestRejectedOther');
        return json(res, 400, { error: 'didHash required' });
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
      if (payments.required(paymentCfg)) {
        const txHash = body.payment && body.payment.txHash;
        let info;
        try {
          info = await chain.getAgentInfo(didHash);
        } catch (err) {
          metrics.inc('attestRejectedOther');
          return json(res, 502, { error: `could not read agent: ${err.message}` });
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
          return json(res, rpc ? 502 : 402, { error: err.message, code: err.code || 'payment_invalid' });
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

      const att = attestations.get(didHash) ?? { successful: 0, total: 0 };
      att.total++;
      if (success) att.successful++;
      attestations.set(didHash, att);
      recordAttestation(attester, didHash);
      if (credited) {
        // Credit after the cooldown check so a rejected attestation does not burn
        // the receipt; the payer can retry once the cooldown clears.
        // packetId is optional corroboration: an identifier for a tamper-evident,
        // independently timestamped record of the same work, so a verifier can check
        // the payment on chain AND that such a record existed. Validated for shape
        // only — this oracle does not call CounterAudit to confirm it, because an
        // evidence path that depends on someone's SaaS is not evidence.
        const packet = /^[0-9a-fA-F-]{36}$/.test(String(packetId || '')) ? String(packetId) : null;
        if (!creditPayment(
          didHash, credited.txHash, credited.amount, credited.payer, success, credited.settledAt, packet
        )) {
          metrics.inc('attestRejectedPayment');
          return json(res, 409, { error: 'this settlement has already been credited', code: 'replayed' });
        }
        metrics.inc('paymentsVerified');
      }
      persistState();
      metrics.inc('attestAccepted');
      return json(res, 200, {
        didHash,
        attester,
        ...att,
        ...(credited ? { payment: { txHash: credited.txHash, amount: credited.amount.toString() } } : {}),
      });
    } catch (err) {
      metrics.inc('attestRejectedOther');
      return json(res, 400, { error: err.message });
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
    if (rateLimited(clientKey(req))) {
      metrics.inc('rateLimitHits');
      return json(res, 429, { error: 'Rate limited' });
    }
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
    const didHash = pathname.slice('/divergence/'.length);
    if (!/^0x[0-9a-fA-F]{64}$/.test(didHash)) {
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
    if (rateLimited(clientKey(req))) {
      metrics.inc('rateLimitHits');
      return json(res, 429, { error: 'Rate limited' });
    }
    const didHash = pathname.slice('/evidence/'.length);
    if (!/^0x[0-9a-fA-F]{64}$/.test(didHash)) {
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
    const caller = identifyCaller(req.headers, cfg.credentials);
    if (!caller) return json(res, 401, { error: 'Unauthorized' });
    if (rateLimited(clientKey(req))) {
      metrics.inc('rateLimitHits');
      return json(res, 429, { error: 'Rate limited' });
    }
    try {
      const { didHash } = await readBody(req);
      if (!didHash) return json(res, 400, { error: 'didHash required' });
      const raised = addFlag(didHash);
      persistState();
      metrics.inc('flagsReceived');
      // Attributed. "Someone with the token flagged this agent" stops being an answer
      // once several services hold tokens, and a flag costs an agent real points.
      console.log(`[oracle] flag raised on ${didHash} by ${caller} (now ${raised})`);
      return json(res, 200, { didHash, flags: raised });
    } catch (err) {
      return json(res, 400, { error: err.message });
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
    const caller = identifyCaller(req.headers, cfg.credentials);
    if (!caller) return json(res, 401, { error: 'Unauthorized' });
    if (rateLimited(clientKey(req))) {
      metrics.inc('rateLimitHits');
      return json(res, 429, { error: 'Rate limited' });
    }
    try {
      const { didHash, count } = await readBody(req);
      if (!didHash) return json(res, 400, { error: 'didHash required' });

      const result = resolveFlags(didHash, count ?? 1);
      // Persist only on a real change, so a no-op call does not rewrite the state file.
      if (result.resolved > 0) {
        persistState();
        metrics.inc('flagsResolved', result.resolved);
        console.log(`[oracle] ${result.resolved} flag(s) cleared on ${didHash} by ${caller}`);
      }
      return json(res, 200, { didHash, ...result });
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  // POST /link  — body: { didHash, agentId } — link a Sigvara agent to its
  // ERC-8004 identity so its 8004 feedback drives externalScore. Accepted only
  // if the 8004 agent NFT is owned by the same wallet as the Sigvara operator.
  if (req.method === 'POST' && pathname === '/link') {
    const caller = identifyCaller(req.headers, cfg.credentials);
    if (!caller) return json(res, 401, { error: 'Unauthorized' });
    if (rateLimited(clientKey(req))) {
      metrics.inc('rateLimitHits');
      return json(res, 429, { error: 'Rate limited' });
    }
    try {
      const { didHash, agentId } = await readBody(req);
      if (!didHash || agentId === undefined || agentId === null) {
        return json(res, 400, { error: 'didHash and agentId required' });
      }
      if (!external.configured()) return json(res, 400, { error: 'external (ERC-8004) registry not configured' });
      const { operator } = await chain.getAgentInfo(didHash);
      const owns = await external.verifyOwnership(String(agentId), operator);
      if (!owns) {
        return json(res, 403, { error: 'ERC-8004 agent is not owned by this agent\'s Sigvara operator; refusing to link' });
      }
      links.set(didHash, String(agentId));
      persistState();
      metrics.inc('linksCreated');
      return json(res, 200, { didHash, agentId: String(agentId), operator, linked: true });
    } catch (err) {
      return json(res, 400, { error: err.message });
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
    if (rateLimited(clientKey(req))) {
      metrics.inc('rateLimitHits');
      return json(res, 429, { error: 'Rate limited' });
    }
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
    } else if (rateLimited(clientKey(req))) {
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
    if (rateLimited(clientKey(req))) {
      metrics.inc('rateLimitHits');
      return json(res, 429, { error: 'Rate limited' });
    }
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
      const measured  = measuredFactorsFor(didHash, scoringNowMs, await payerScoresFor(didHash));
      const scores    = computeScore({
        registeredAt,
        attestations: measured.measuredAttestations ?? att,
        flags: flagWeight,
        externalScore,
        measuredFeeScore: measured.measuredFeeScore,
        activity: measured.activity,
        propagation: measured.propagation,
        now: scoringNowMs,
      });
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
  console.log(`[oracle] state path: ${getStatePath()}`);
  loadState();

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
        `[oracle] WARNING: this wallet is not an admitted operator in ${operatorBond}. ` +
        'Every proposeReputation will revert until it has bonded and been admitted.'
      );
    }
  }).catch(() => {});
  runEpoch().catch(err => console.error('[oracle] startup epoch error:', err.message));
  setInterval(() => runEpoch().catch(err => console.error('[oracle] scheduled epoch error:', err.message)), cfg.epochMs);
});
