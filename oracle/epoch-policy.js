'use strict';

// Decides what an epoch should do for a single agent's reputation score, given
// whether a proposal is currently pending and how old it is.
//
// proposeReputation() on-chain always overwrites any pending proposal and
// restarts its challenge window. That means re-proposing every epoch while a
// score is still pending would perpetually reset the clock — it would never
// actually finalize. So the rule is:
//   - nothing pending            -> 'propose' a fresh score
//   - pending, window elapsed    -> 'finalize-then-propose' (finalize the old
//                                    one, then propose fresh once it's clear)
//   - pending, window still open -> 'skip' this agent this epoch
//
// Pure function — no I/O, no ethers, easy to unit test in isolation.
function decideAction(pending, challengeWindowSeconds, nowSeconds) {
  if (!pending || !pending.exists) return 'propose';

  const ready = nowSeconds >= finalizableAtOf(pending, challengeWindowSeconds);
  return ready ? 'finalize-then-propose' : 'skip';
}

/**
 * When a pending proposal can first be finalized, and the last moment it can still be rejected.
 *
 * The contract fixes this when the proposal is made, as the time plus the window in force then, and keeps
 * it in `finalizableAt`. Changing the window afterwards moves no proposal already pending. Working it out
 * as proposedAt plus the window in force now delayed every finalize by the difference when the window was
 * lengthened, and sent finalize transactions the contract refused (ChallengeWindowActive) epoch after
 * epoch when it was shortened.
 *
 * A proposal that was already pending when the field was added reads zero, and the contract judges it
 * against the live window; so does this. A missing or unreadable value takes the same fallback.
 */
function finalizableAtOf(pending, challengeWindowSeconds) {
  const stored = Number(pending.finalizableAt);
  return stored > 0 ? stored : pending.proposedAt + challengeWindowSeconds;
}

// Node stores a timer delay in a signed 32-bit int. Anything outside that range, and
// anything that is not a positive number at all, is coerced to 1ms rather than
// rejected — so setInterval(fn, 30 days) and setInterval(fn, NaN) both run the epoch
// a thousand times a second against the RPC, with no error to say why.
//
// NaN is the likeliest way to arrive here: EPOCH_HOURS is read with Number(), so a
// value like "1h" or an empty override parses to NaN and takes this path silently.
const { MAX_BATCH_CALLS } = require('./read-retry');
const MAX_TIMER_MS = 2_147_483_647;
const MIN_EPOCH_MS = 60_000;

/**
 * Why `epochMs` cannot be used as a timer delay, or null when it can.
 *
 * Returns a reason rather than throwing, matching adminTokenPolicyError, so the caller
 * decides whether a bad value is fatal.
 */
function epochIntervalError(epochMs) {
  const hours = epochMs / 3_600_000;
  if (!Number.isFinite(epochMs)) {
    return `EPOCH_HOURS did not parse to a number (got ${epochMs}). Node would treat the interval as 1ms and run epochs continuously.`;
  }
  if (epochMs < MIN_EPOCH_MS) {
    return `EPOCH_HOURS is ${hours}, an interval of ${epochMs}ms. Below ${MIN_EPOCH_MS}ms the oracle would spend its time starting epochs; raise it to at least ${MIN_EPOCH_MS / 60_000} minute.`;
  }
  if (epochMs > MAX_TIMER_MS) {
    return `EPOCH_HOURS is ${hours}, an interval of ${epochMs}ms, past Node's ${MAX_TIMER_MS}ms timer limit. It would silently become 1ms and run epochs continuously; the maximum is ${Math.floor(MAX_TIMER_MS / 3_600_000)} hours.`;
  }
  return null;
}

// The six factors the contract stores, in the order SigvaraReputation declares them.
const SCORE_FACTORS = [
  'feeScore', 'successScore', 'ageScore',
  'externalScore', 'communityScore', 'propagationScore',
];

// Benign skew between two honest oracles, in total score points. Two operators scan the
// chain at different moments, so a payment landing between their scans, or an age
// bucket ticking over, moves the total by a point or two without either being wrong.
// Above this, the disagreement is worth a human looking at it.
const DEFAULT_DIVERGENCE_TOLERANCE = 3;

/**
 * How far this oracle's arithmetic is from a pending proposal's.
 *
 * Returns {total, factors} where total is the absolute difference in summed score and
 * factors lists only the factors that actually differ. Reporting the whole vector would
 * bury the disagreement in five zeroes; reporting only the total would hide which
 * factor moved, which is the part that says whether the cause is a late payment or a
 * different view of an agent's history.
 */
function scoreDivergence(pendingData, own) {
  const factors = {};
  let pendingTotal = 0;
  let ownTotal = 0;
  // Whether every factor on both sides was a real number. A missing or unparseable
  // factor is not a zero: `?? 0` would quietly invent agreement out of a decode that
  // returned nothing, and NaN would be worse, because NaN > tolerance is false and the
  // caller would read "no disagreement" from a comparison that never happened.
  let comparable = true;
  for (const f of SCORE_FACTORS) {
    const p = Number(pendingData?.[f]);
    const o = Number(own?.[f]);
    if (!Number.isFinite(p) || !Number.isFinite(o)) { comparable = false; continue; }
    pendingTotal += p;
    ownTotal += o;
    if (p !== o) factors[f] = { pending: p, own: o, delta: o - p };
  }
  const maxFactor = Object.values(factors).reduce((m, f) => Math.max(m, Math.abs(f.delta)), 0);
  return { total: Math.abs(ownTotal - pendingTotal), maxFactor, pendingTotal, ownTotal, factors, comparable };
}

// The widest tolerance that still means anything. communityScore and propagationScore
// cap at 5, so a tolerance at or above that switches per-factor detection off for them
// entirely; 10 is already half the total range of a realistic score.
const MAX_DIVERGENCE_TOLERANCE = 10;

/**
 * Why `tolerance` cannot be used to compare scores, or null when it can.
 *
 * Mirrors epochIntervalError, and exists for the same reason. Number('3 points') is NaN,
 * and every comparison against NaN is false, so an unvalidated tolerance does not make
 * the checker noisy — it makes it agree with everything, silently, across every agent.
 * A large finite value does the same thing and looks more plausible in a config file.
 */
function divergenceToleranceError(tolerance) {
  if (!Number.isFinite(tolerance)) {
    return `DIVERGENCE_TOLERANCE did not parse to a number (got ${tolerance}). Every comparison against it would be false, so the checker would agree with every proposal on chain.`;
  }
  if (tolerance < 0) {
    return `DIVERGENCE_TOLERANCE is ${tolerance}. A negative tolerance makes every score a divergence, including its own.`;
  }
  if (tolerance > MAX_DIVERGENCE_TOLERANCE) {
    return `DIVERGENCE_TOLERANCE is ${tolerance}, past the maximum of ${MAX_DIVERGENCE_TOLERANCE}. Tolerating that much disagreement is indistinguishable from not checking.`;
  }
  return null;
}

// What a checking operator should do this epoch for one agent.
//
// A second bonded operator is only worth running if it disagrees out loud. The contract
// has no notion of two oracles agreeing: pendingScores holds one slot per agent, a
// second proposeReputation overwrites the first and restarts its challenge window, and
// finalizeReputation asks only that the window elapsed unchallenged. SLASHING_COMMITTEE_ROLE
// can reject a bad proposal inside that window, but nothing currently tells the committee
// when to look. That signal is the whole point of this mode.
//
// So a checker never writes over a live proposal:
//   nothing pending, for the grace or more   -> 'propose'         the primary is silent; cover for it
//   nothing pending, for less than the grace -> 'defer-propose'   leave the slot to the primary
//   pending, diverged                        -> 'diverged'        alert, and touch nothing
//   pending, agrees, window open             -> 'skip'
//   pending, agrees, window past the grace   -> 'finalize'        permissionless, and we agree with it
//   pending, agrees, window past, in grace   -> 'defer-finalize'  leave it to the primary
//
// Finalising a score it disagrees with is the one thing a checker must never do: that
// would launder the number it was run to question into the live value. Overwriting one
// is the second, because that restarts the window and buys the bad proposal another six
// hours out of the committee's reach.
//
// The grace is how long the checker leaves the primary to act before acting itself. Without
// it the checker finalized whatever it reached first, which left the slot empty, and then
// often proposed into that slot before the primary did: 35 of the first 262 proposals on Arc
// testnet were the checker's, and nothing recomputes a checker's proposal, since a primary
// never compares (docs/divergence-log.md, 2026-11-03). The primary finalizes, and proposes
// again in the same epoch when the score has changed, so a slot is empty for long only while
// nothing is due (writeDueAt). A slot empty for the whole grace once something is due, or a
// proposal unfinalized that long past its window, means the primary is late, and covering for
// it is what a second operator is for.
//
//   nothing pending, the score on chain unchanged and written recently -> 'not-due'
//
// `emptySince` is when the slot became empty, in seconds: the last finalized score, or the
// agent's registration if it was never scored. 0 means at once, which is how a slot held by a
// proposer that lost its authority is treated: its primary was removed, not delayed.
// `notDueUntil` is writeDueAt for this checker's own score: until then the primary skips the
// slot on purpose, and an empty slot is nothing to cover.
function decideCheckerAction(
  pending, own, challengeWindowSeconds, nowSeconds, tolerance = DEFAULT_DIVERGENCE_TOLERANCE,
  { graceSeconds = 0, emptySince = 0, notDueUntil = 0 } = {},
) {
  if (!pending || !pending.exists) {
    if (nowSeconds < notDueUntil) return 'not-due';
    return nowSeconds >= emptySince + graceSeconds ? 'propose' : 'defer-propose';
  }

  // Both halves matter. The total is what consumers of the score actually read, but two
  // factors disagreeing in opposite directions cancel in the sum while still meaning the
  // two oracles do not agree about the agent, so a large single-factor gap counts even
  // when the totals happen to match.
  const divergence = scoreDivergence(pending.data, own);

  // Fail closed. Every comparison below is `>`, and `>` against NaN is false, so a
  // single unparseable number anywhere would fall through to the branch that finalizes
  // — the checker would be most willing to make a score live exactly when it understood
  // it least. Treat "cannot compare" as "do not agree".
  if (!divergence.comparable || !Number.isFinite(tolerance)) return 'diverged';

  if (divergence.total > tolerance || divergence.maxFactor > tolerance) return 'diverged';

  const finalizableAt = finalizableAtOf(pending, challengeWindowSeconds);
  if (nowSeconds < finalizableAt) return 'skip';
  return nowSeconds >= finalizableAt + graceSeconds ? 'finalize' : 'defer-finalize';
}

/**
 * How long a checker leaves the primary to act, in milliseconds, or an error to stop on.
 *
 * Unset, twice this checker's own epoch. It is the primary's epoch it has to outlast, which a
 * checker cannot see: on Arc testnet both run hourly, so the default fits; where the primary runs
 * daily and the checker hourly, set it above a day. Shorter than the checker's own epoch would
 * bring the race back, since the checker would act at the first epoch it found the slot empty.
 */
function checkerGraceMs(raw, epochMs) {
  if (raw === undefined || String(raw).trim() === '') return { ms: 2 * epochMs };
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) {
    return { error: `CHECKER_GRACE_MINUTES is ${raw}; it must be a number of minutes, at least 0.` };
  }
  if (minutes * 60_000 < epochMs) {
    return {
      error: `CHECKER_GRACE_MINUTES is ${raw}, shorter than this checker's epoch of ${epochMs / 60_000} minutes. ` +
        'The checker would act at the first epoch it found a slot empty or a proposal ready, ahead of the primary, ' +
        'and propose scores nothing recomputes. Set it above the primary\'s epoch.',
    };
  }
  return { ms: minutes * 60_000 };
}

// How old an unchanged score's last write may get before it is written again, unset: half of the one-day limit that
// docs/integration.md recommends for isTrustedFresh and the SDK gate's maxScoreAgeSeconds on Arc testnet.
const DEFAULT_SCORE_REFRESH_HOURS = 12;

/**
 * How long an unchanged score may go unwritten, in seconds, or an error to stop on (SCORE_REFRESH_HOURS).
 *
 * A score due again is proposed at the next epoch and finalized a challenge window and up to an epoch later, so the most
 * a stable score ages is this plus two epochs plus the window: 20 hours on Arc testnet's hourly epochs and six-hour
 * window. Refused where, with a six-hour window, that could pass a day, which takes an epoch shorter than this and
 * longer than three hours. An epoch at least this long never holds a write back: the score it finalizes is already an
 * epoch old. 0 writes every epoch, as before.
 */
function scoreRefreshSeconds(raw, epochMs) {
  if (raw === undefined || String(raw).trim() === '') return scoreRefreshSeconds(String(DEFAULT_SCORE_REFRESH_HOURS), epochMs);
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours < 0 || hours > DEFAULT_SCORE_REFRESH_HOURS) {
    return { error: `SCORE_REFRESH_HOURS is ${raw}; it must be a number of hours from 0 to ${DEFAULT_SCORE_REFRESH_HOURS}, half the one-day limit a gate on a score's age is advised to use.` };
  }
  const epochHours = epochMs / 3_600_000;
  if (hours > epochHours && hours + 2 * epochHours + 6 > 24) {
    return {
      error: `SCORE_REFRESH_HOURS is ${hours} with EPOCH_HOURS of ${epochHours}: an unchanged score could be a day old before ` +
        `its next write is finalized. Set it to ${Math.max(18 - 2 * epochHours, epochHours)} or less.`,
    };
  }
  return { seconds: hours * 3600 };
}

/**
 * When a score is next due to be written, in chain seconds: at once (0) unless it is the score already on chain, and
 * then once that score's last write is `refreshSeconds` old.
 *
 * `onChain` is what getReputation holds, whose lastUpdated is the time of the proposal it finalized; null, unread or
 * never scored, is due at once. A factor that cannot be compared counts as a change, so a read that went wrong writes
 * rather than lets a score age. The evidence root does not count: a payment that moves no factor is committed to at the
 * next write, at the latest this long after the last one. Both operators judge by this, the primary to skip a proposal
 * and a checker to tell a slot with nothing due from a primary that is late (decideCheckerAction).
 */
function writeDueAt(onChain, own, refreshSeconds) {
  const last = Number(onChain?.lastUpdated);
  if (!(last > 0)) return 0;
  const d = scoreDivergence(onChain, own);
  if (!d.comparable || Object.keys(d.factors).length) return 0;
  return last + refreshSeconds;
}

// The most proposals one epoch sends, unset (MAX_WRITES_PER_EPOCH). Arc testnet has some 260 agents registered, fewer
// bonded, and a stable one is proposed about twice a day; past this, something is asking for writes it should not.
const DEFAULT_MAX_WRITES_PER_EPOCH = 1000;
const STATUS_PENDING_BOND = 3;

/**
 * The order an epoch works through its agents, and so spends its write budget: agents with a score on chain first,
 * the oldest first, then agents never scored, then agents still waiting for a bond, each group in registration order.
 * Registering costs nothing, so a flood of registrations, or of bonded agents never scored, cannot take the writes an
 * agent whose score is ageing needs. `reputation` is phase 1's read of getReputation; null when it failed, read as the
 * oldest, since a score nobody could read is the one most likely to need writing.
 */
function writeOrder(infos) {
  const group = (a) => (a.status === STATUS_PENDING_BOND ? 2 : a.reputation && !(Number(a.reputation.lastUpdated) > 0) ? 1 : 0);
  const age = (a) => Number(a.reputation?.lastUpdated) || 0;
  return [...infos].sort((a, b) => group(a) - group(b) || (group(a) === 0 ? age(a) - age(b) : 0));
}

/**
 * Map over `items` with at most `size` calls in flight, preserving input order.
 *
 * How fast the epoch is allowed to ask is an epoch pacing decision, which is why this
 * lives beside decideAction rather than in the entrypoint: it is the one part of the
 * read path worth testing on its own.
 *
 * Chunked rather than a sliding pool. A chunk waits for its slowest member before the
 * next starts, so one slow call delays the finished ones beside it, and a pool would
 * not. The tradeoff buys an implementation short enough to read in one go and matching
 * the guard loop the epoch already uses, and with comparable per-call latency the
 * difference is noise. If the epoch ever spans providers with very different latency,
 * this is the thing to revisit.
 *
 * `paceMs` is a wait between one chunk and the next, not before the first or after the last.
 */
async function mapChunked(items, size, mapper, paceMs = 0) {
  if (!Number.isInteger(size) || size < 1) {
    throw new TypeError(`mapChunked: size must be a positive integer, got ${size}`);
  }
  const out = [];
  for (let i = 0; i < items.length; i += size) {
    if (i > 0 && paceMs > 0) await new Promise((r) => setTimeout(r, paceMs));
    // mapper is called with the item alone. Passing it through Array.map directly would
    // hand it a chunk-local index, which reads like a position in `items` and is not.
    const done = await Promise.all(items.slice(i, i + size).map(item => mapper(item)));
    for (const d of done) out.push(d);
  }
  return out;
}

/**
 * Why the chain's clock and this host's cannot both be believed, or null when they agree
 * to within `maxSkewMs`.
 *
 * Scores are computed against the chain's timestamp, so whoever supplies it chooses how old
 * every payment looks. A node serving a stale head, or a false one, deflates or inflates
 * every score in the same direction; a host with a wrong clock stamps proposals wrongly.
 * Neither is visible in the numbers. The two clocks have no reason to differ by more than a
 * few seconds, so a large gap means one of them is wrong, and the epoch is not run.
 *
 * Returns a reason rather than throwing, like the other checks in this file.
 */
function clockSkewError(chainNowSec, hostNowMs, maxSkewMs) {
  const chainMs = Number(chainNowSec) * 1000;
  if (!Number.isFinite(chainMs)) return `the chain timestamp (${chainNowSec}) is not a number`;
  const skew = Math.abs(chainMs - hostNowMs);
  if (skew <= maxSkewMs) return null;
  const direction = chainMs > hostNowMs ? 'ahead of' : 'behind';
  return `the chain's clock is ${Math.round(skew / 1000)}s ${direction} this host's, past the limit of ` +
    `${Math.round(maxSkewMs / 1000)}s (MAX_CLOCK_SKEW_SECONDS). One of them is wrong, and every score depends ` +
    'on which; no epoch will run until they agree.';
}

/**
 * Whether the scoring loop has been quiet for too long to call the oracle healthy.
 *
 * Quiet means two epoch intervals with no successful epoch. After a success it is counted from that
 * success. Before the first one it is counted from process start: the first epoch runs at start, so a
 * process still failing it two intervals later is not starting up, it is broken. The check used to be
 * `!lastEpoch || since < 2 * interval`, which kept a primary that had never succeeded green for as long
 * as it ran, against what oracle/README.md says /health returns. watcher-policy.silenceMs applies the
 * same reading to the checker.
 *
 * @param {{ lastEpochMs: number, nowMs: number, uptimeMs: number, epochMs: number }} t
 */
function scoringIsStale({ lastEpochMs, nowMs, uptimeMs, epochMs }) {
  const quietForMs = lastEpochMs ? nowMs - lastEpochMs : uptimeMs;
  return quietForMs >= epochMs * 2;
}

/**
 * How many items fit in one JSON-RPC batch when each takes `readsPerItem` calls. Counted in calls
 * because that is what a node counts: a chunk of 32 agents at 3 reads each is a batch of 96.
 */
function chunkForReads(readsPerItem) {
  return Math.max(1, Math.floor(MAX_BATCH_CALLS / readsPerItem));
}

// How long the epoch waits between chunks of reads. Staying within the batch limit is not enough: the
// RPC also has a budget that runs out. Measured on Arc's public RPC on 5 November 2026 with the real
// chain.js, 264 agents at two reads each: chunks of 32 and no wait, 339 of 528 reads failed after
// all their retries; chunks of 10 and no wait, 28 failed; chunks of 10 and this wait, no read was
// refused at all. It took 42 seconds rather than 41, because retrying is slower than waiting.
const READ_PACE_MS = 1_500;

module.exports = {
  decideAction, decideCheckerAction, checkerGraceMs, finalizableAtOf, scoreDivergence, mapChunked, chunkForReads, READ_PACE_MS, scoringIsStale,
  scoreRefreshSeconds, writeDueAt, writeOrder, DEFAULT_SCORE_REFRESH_HOURS, DEFAULT_MAX_WRITES_PER_EPOCH,
  epochIntervalError, divergenceToleranceError, clockSkewError, MAX_TIMER_MS, MIN_EPOCH_MS,
  SCORE_FACTORS, DEFAULT_DIVERGENCE_TOLERANCE, MAX_DIVERGENCE_TOLERANCE,
};
