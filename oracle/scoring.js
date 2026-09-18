'use strict';

// Ported from bagsReputation.js — adapted for the Sigvara EVM protocol.
// All six factors are self-contained pure functions so they can be unit-tested in isolation.
//
// externalScore (ERC-8004 cross-protocol feedback) is 0 unless the EXTERNAL_* env is
// configured. propagationScore is inherited trust: see payments.propagationScore.

function feeScore(attestationTotal) {
  // Proxy for fee activity: 1 point per 10 attestations received, capped at 30.
  //
  // Only used when payment verification is off. It counts HTTP requests, not fees,
  // so with an unauthenticated /attest the largest factor in the score was whatever
  // the loudest caller chose to send. When PAYMENT_VERIFICATION=required the oracle
  // passes measured volume instead and this is not consulted. See payments.js.
  return Math.min(30, Math.floor(attestationTotal / 10));
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
  return Math.floor((successful / (total + prior)) * 25);
}

// Logarithmic curve, reaching the cap of 20 around day 31: log2(32) * 4 = 20.
function ageCurve(days) {
  if (!(days > 0)) return 0;
  return Math.min(20, Math.floor(Math.log2(days + 1) * 4));
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
  return Math.max(0, 5 - unresolvedFlags * 2);
}

/**
 * @param {{ registeredAt: number, attestations: { successful: number, total: number }, flags: number, externalScore?: number, measuredFeeScore?: number }} opts
 * @returns {{ feeScore, successScore, ageScore, externalScore, communityScore, propagationScore, total }}
 */
function computeScore({
  registeredAt, attestations, flags, externalScore = 0, measuredFeeScore = null,
  successPrior = SUCCESS_PRIOR, activity = null, propagation = 0,
}) {
  const { successful = 0, total = 0 } = attestations;

  // measuredFeeScore is supplied when payments are verified: real volume beats the
  // attestation-count proxy. null means payment verification is off.
  const fs = measuredFeeScore === null ? feeScore(total) : Math.max(0, Math.min(30, measuredFeeScore));
  const ss = successScore(successful, total, successPrior);
  const as = ageScore(registeredAt, activity);
  // externalScore comes from ERC-8004 cross-protocol feedback (see external.js),
  // 0 when unlinked or unconfigured. Clamp to the contract's cap so a bad input
  // can never make proposeReputation revert.
  const es = Math.max(0, Math.min(15, Math.trunc(externalScore) || 0));
  const cs = communityScore(flags ?? 0);
  // Inherited trust from counterparties that are themselves scored agents. 0 when
  // payment verification is off, since there are no identified counterparties to
  // inherit from. Clamped so a bad input cannot make proposeReputation revert.
  const ps = Math.max(0, Math.min(5, Math.trunc(propagation) || 0));

  // Sum all six factors so total stays correct once es/ps become nonzero in Phase 2.
  return { feeScore: fs, successScore: ss, ageScore: as, externalScore: es, communityScore: cs, propagationScore: ps, total: fs + ss + as + es + cs + ps };
}

module.exports = { computeScore, feeScore, successScore, ageScore, ageCurve, communityScore, SUCCESS_PRIOR };
