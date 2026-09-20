'use strict';

require('dotenv').config();

const http = require('http');
const chain = require('./chain');
const external = require('./external');
const { computeScore } = require('./scoring');
const {
  decideAction, decideCheckerAction, scoreDivergence,
  epochIntervalError, divergenceToleranceError, DEFAULT_DIVERGENCE_TOLERANCE,
} = require('./epoch-policy');
const { json, readBody, readCredentials, identifyCaller, mayAttestUnauthenticated, parseScorePath, rateLimited, clientKey, adminTokenPolicyError } = require('./http-helpers');
const payments = require('./payments');
const merkle = require('./merkle');
const metrics = require('./metrics');

// Verified-payment settings. Read once at startup so a malformed value fails the
// process rather than silently disabling verification on the first request.
const paymentCfg = payments.readConfig();


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
  getPaymentEvents,
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

  // Phase 1: reads are stateless — fire them concurrently instead of one at a time.
  const agentInfos = await Promise.all(
    agents.map(async ({ didHash }) => {
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
    })
  );

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
    });
  }

  // GET /metrics — Prometheus text format
  if (readMethod === 'GET' && pathname === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
    return res.end(metrics.toPrometheusText());
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
    // Unauthenticated does not mean unmetered. Every call rebuilds a Merkle tree over
    // the agent's payment history, so this is the most expensive thing a stranger can
    // ask for once the read paths are proxied to the public internet.
    if (rateLimited(clientKey(req))) {
      metrics.inc('rateLimitHits');
      return json(res, 429, { error: 'Rate limited' });
    }
    const didHash = pathname.slice('/evidence/'.length);
    if (!/^0x[0-9a-fA-F]{64}$/.test(didHash)) {
      return json(res, 400, { error: 'didHash must be a 32-byte hex string' });
    }
    const events = getPaymentEvents(didHash);
    const tree = merkle.buildTree(events);
    return json(res, 200, {
      didHash,
      evidenceRoot: tree.root,
      count: events.length,
      // Exactly what the root commits to, in leaf order, so nobody has to read this
      // service's source to know which fields are covered. counterauditPacketId is
      // deliberately absent: it identifies an independently timestamped record of the
      // same work, which a verifier fetches and checks for themselves, and committing
      // to it would have changed the leaf format and made roots already published on
      // chain unreproducible.
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
        // Corroboration, NOT part of the leaf. See committedFields below.
        ...(e.packetId ? { counterauditPacketId: e.packetId } : {}),
      })),
    });
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
