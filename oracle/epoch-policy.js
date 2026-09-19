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

module.exports = { decideAction, epochIntervalError, MAX_TIMER_MS, MIN_EPOCH_MS };
