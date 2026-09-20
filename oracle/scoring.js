'use strict';

// Ported from bagsReputation.js — adapted for the Sigvara EVM protocol.
// All six factors are self-contained pure functions so they can be unit-tested in isolation.
//
// externalScore (ERC-8004 cross-protocol feedback) is 0 unless the EXTERNAL_* env is
// configured. propagationScore is inherited trust: see payments.propagationScore.

function feeScore(attestationTotal) {
  // Proxy for fee activity: 1 point per 10 attestations received, capped at 20.
  //
  // Only used when payment verification is off. It counts HTTP requests, not fees,
  // so with an unauthenticated /attest the largest factor in the score was whatever
  // the loudest caller chose to send. When PAYMENT_VERIFICATION=required the oracle
  // passes measured volume instead and this is not consulted. See payments.js.
  return Math.min(20, Math.floor(attestationTotal / 10));
}

// Pseudo-observations added to the denominator of the success rate.
//
// A bare ratio has two failures. One good job scores the same as ninety-nine out
// of a hundred, because 1/1 and 99/99 are both 1.0. And a ratio is scale
// invariant, so decaying both halves at the same rate leaves it untouched: an
// agent with ten successes that then went silent for a year still reads 10/10
// once decayed to 0.44/0.44, and holds full marks forever.
//
// Dividing by (total + prior) fixes both. A single observation is worth little,
// evidence has to accumulate to approach the cap, and as decayed weight tends to
// zero so does the score. That last part is what stops a farmed score sitting
// indefinitely.
const SUCCESS_PRIOR = 5;

function successScore(successful, total, prior = SUCCESS_PRIOR) {
  if (total <= 0) return 0;
  return Math.floor((successful / (total + prior)) * 15);
}

// Logarithmic curve over the span of paid activity, reaching the cap of 30 around day
// 1023: log2(1024) * 3 = 30.
//
// The multiplier was 4, which capped at day 31. That contradicted the paragraph below,
// which says two years of sustained paid operation is the part an attacker cannot
// shortcut: six weeks of wash payments collected the whole factor. Measured in
// adversarial.test.js, a six-wallet ring reached 76/100, and 20 of those points were
// this one.
//
// Fixing WHAT is measured (activity, not registration) was necessary and not
// sufficient. An attacker who has to pay for a month instead of wait for a month is
// paying gas and floating capital, which is a real cost, but it is weeks of cost for a
// factor that claims to represent years. The multiplier now matches the claim.
//
// The trade is a slower ramp for honest agents: six months of trading is 14 of 20
// rather than the full 20. That is the intended shape. A factor that everyone maxes in
// a month distinguishes nobody.
function ageCurve(days) {
  if (!(days > 0)) return 0;
  return Math.min(30, Math.floor(Math.log2(days + 1) * 3));
}

/**
 * Tenure, not calendar age.
 *
 * Measuring time since registration made this the cheapest factor in the score.
 * Waiting costs nothing, so an attacker could register identities in bulk, leave
 * them a month, and collect the full 20 points having done no work at all. The
 * model doc claimed the logarithm stopped idle old agents dominating; it did not,
 * it only capped them.
 *
 * With `activity` supplied the span runs from the agent's FIRST verified payment
 * to its most recent one, and the result is weighted by how recent that last one
 * is. The span deliberately starts at first activity rather than registration:
 * otherwise waiting a month and then making one payment would unlock the full 20,
 * which is the same free-lunch problem in a different shape.
 *
 * So an agent that never worked scores 0 however long ago it signed up. One that
 * has just started scores 0 because it has no span yet, which is correct, it is
 * new. One that traded for two years and stopped a year ago keeps almost nothing.
 * One that has been trading for two years and is working today gets the full 20,
 * because two years of sustained, paid, bonded operation is the part an attacker
 * cannot shortcut.
 *
 * `activity` is null when payment verification is off, which keeps the old
 * calendar behaviour so existing deployments are unaffected.
 *
 * @param {number} registeredAtSeconds
 * @param {{ firstActivitySec: number, lastActivitySec: number, recency: number }|null} activity
 */
function ageScore(registeredAtSeconds, activity = null, nowMs = Date.now()) {
  if (!activity) return ageCurve((nowMs / 1000 - registeredAtSeconds) / 86400);
  const { firstActivitySec, lastActivitySec } = activity;
  if (!firstActivitySec || !lastActivitySec) return 0;

  const spanDays = (lastActivitySec - firstActivitySec) / 86400;
  const recency = Math.max(0, Math.min(1, activity.recency ?? 0));
  return Math.floor(ageCurve(spanDays) * recency);
}

function communityScore(unresolvedFlags) {
  // 0 flags → 5 pts, 1 flag → 3 pts, 2 flags → 1 pt, 3+ flags → 0
  // Formula: max(0, 5 - flags*2)
  //
  // Floored because the count is age-weighted and therefore fractional: a flag one
  // half-life old counts 0.5 and costs one point rather than two. Without the floor the
  // total is fractional and proposeReputation takes uint8s. Flooring rather than
  // rounding matches every other factor here, and keeps the penalty until the flag has
  // genuinely decayed instead of writing it off early.
  return Math.max(0, Math.floor(5 - unresolvedFlags * 2));
}

/**
 * @param {{ registeredAt: number, attestations: { successful: number, total: number }, flags: number, externalScore?: number, measuredFeeScore?: number }} opts
 * @returns {{ feeScore, successScore, ageScore, externalScore, communityScore, propagationScore, total }}
 */
/**
 * `now` is the clock every time-dependent factor is measured against, in milliseconds.
 *
 * It exists because two operators scoring the same agent from the same evidence must
 * produce the same number, and `Date.now()` does not let them. Host clocks drift, so
 * tenure and decay come out fractionally different on each machine. Measured across the
 * primary and the checker on the day the second operator went live, that showed up as a
 * recency of 0.982146 against 0.982148: too small to move an integer factor, and large
 * enough to mean the two were never actually computing the same function.
 *
 * Callers on the epoch path pass the chain's own clock, so agreement between operators
 * stops depending on their hosts being in sync with each other. It defaults to
 * `Date.now()` for callers with no chain to read, such as the unit tests.
 */
function computeScore({
  registeredAt, attestations, flags, externalScore = 0, measuredFeeScore = null,
  successPrior = SUCCESS_PRIOR, activity = null, propagation = 0, now = Date.now(),
}) {
  const { successful = 0, total = 0 } = attestations;

  // measuredFeeScore is supplied when payments are verified: real volume beats the
  // attestation-count proxy. null means payment verification is off.
  const fs = measuredFeeScore === null ? feeScore(total) : Math.max(0, Math.min(20, measuredFeeScore));
  const ss = successScore(successful, total, successPrior);
  const as = ageScore(registeredAt, activity, now);
  // externalScore comes from ERC-8004 cross-protocol feedback (see external.js),
  // 0 when unlinked or unconfigured. Clamp to the contract's cap so a bad input
  // can never make proposeReputation revert. The cap is 25: it was 15, and it took
  // 10 of the 20 points released by cutting fee and success, because standing in a
  // registry this protocol does not control is not something an attacker can mint.
  const es = Math.max(0, Math.min(25, Math.trunc(externalScore) || 0));
  const cs = communityScore(flags ?? 0);
  // Inherited trust from counterparties that are themselves scored agents. 0 when
  // payment verification is off, since there are no identified counterparties to
  // inherit from. Clamped so a bad input cannot make proposeReputation revert.
  const ps = Math.max(0, Math.min(5, Math.trunc(propagation) || 0));

  // Sum all six factors so total stays correct once es/ps become nonzero in Phase 2.
  return { feeScore: fs, successScore: ss, ageScore: as, externalScore: es, communityScore: cs, propagationScore: ps, total: fs + ss + as + es + cs + ps };
}

module.exports = { computeScore, feeScore, successScore, ageScore, ageCurve, communityScore, SUCCESS_PRIOR };
