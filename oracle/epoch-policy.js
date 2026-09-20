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

  const ready = nowSeconds >= pending.proposedAt + challengeWindowSeconds;
  return ready ? 'finalize-then-propose' : 'skip';
}

// Node stores a timer delay in a signed 32-bit int. Anything outside that range, and
// anything that is not a positive number at all, is coerced to 1ms rather than
// rejected — so setInterval(fn, 30 days) and setInterval(fn, NaN) both run the epoch
// a thousand times a second against the RPC, with no error to say why.
//
// NaN is the likeliest way to arrive here: EPOCH_HOURS is read with Number(), so a
// value like "1h" or an empty override parses to NaN and takes this path silently.
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
//   nothing pending               -> 'propose'   the primary is silent; cover for it
//   pending, diverged             -> 'diverged'  alert, and touch nothing
//   pending, agrees, window open  -> 'skip'
//   pending, agrees, window past  -> 'finalize'  permissionless, and we agree with it
//
// Finalising a score it disagrees with is the one thing a checker must never do: that
// would launder the number it was run to question into the live value. Overwriting one
// is the second, because that restarts the window and buys the bad proposal another six
// hours out of the committee's reach.
function decideCheckerAction(pending, own, challengeWindowSeconds, nowSeconds, tolerance = DEFAULT_DIVERGENCE_TOLERANCE) {
  if (!pending || !pending.exists) return 'propose';

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

  return nowSeconds >= pending.proposedAt + challengeWindowSeconds ? 'finalize' : 'skip';
}

module.exports = {
  decideAction, decideCheckerAction, scoreDivergence,
  epochIntervalError, divergenceToleranceError, MAX_TIMER_MS, MIN_EPOCH_MS,
  SCORE_FACTORS, DEFAULT_DIVERGENCE_TOLERANCE, MAX_DIVERGENCE_TOLERANCE,
};
