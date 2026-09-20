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

// Logarithmic curve over the span of paid activity, reaching the cap of 20 around day
// 1023: log2(1024) * 2 = 20.
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
  return Math.min(20, Math.floor(Math.log2(days + 1) * 2));
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

// Full marks for bond coverage need roughly 2.3 units of bond per unit of volume:
// log2(1 + 4*2.27) * 6 = 20. The curve is steep at the bottom, so the first multiples of
// the minimum bond are worth the most, and flat at the top, so an agent that over-bonds
// ten times over gains nothing extra for it.
const MAX_BOND_SCORE = 20;

// Volume, in feeUnits, at which coverage is believed in full. Below this the factor is
// scaled down. See the confidence paragraph in bondScore.
const BOND_CONFIDENCE_UNITS = 10;

/**
 * Bond coverage: how much of the agent's own money stands behind the volume it claims.
 *
 * Every other factor measures activity, and activity is what a wash ring manufactures.
 * In a ring the payments return to the attacker, so volume costs gas and float rather
 * than money. A bond does not come back if the agent is slashed, which makes it the one
 * input that is expensive whether or not the behaviour behind it is genuine.
 *
 * Both sides are expressed in protocol units so that no price oracle is needed. The bond
 * is denominated in SVR and the volume in USDC, and any literal ratio between them would
 * need a live exchange rate, which is a dependency and an attack surface. Instead:
 *
 *     stakeUnits  = stake  / minimumStake      "how many minimum bonds"
 *     volumeUnits = volume / feeUnit           "how many fee points of trade"
 *     coverage    = stakeUnits / volumeUnits
 *
 * Both are dimensionless, so the result is scale invariant: an agent with 20x the bond
 * and 10k of volume scores the same as one with 200x and 100k. That is the intended
 * reading. The question is not how large an agent is, it is whether its exposure is
 * backed.
 *
 * The confidence term is what stops this being the cheapest factor in the score instead
 * of the most expensive one. Coverage is a ratio, so it runs to infinity as volume runs
 * to zero: post the minimum bond, do no work at all, and a bare curve would hand over
 * the whole 20 points. An agent with no exposure has nothing to back, so the honest
 * answer there is not full marks, it is no evidence. Confidence rises linearly to 1 at
 * BOND_CONFIDENCE_UNITS of volume, so the factor has to be earned by trading AND by
 * bonding, and neither alone will do.
 *
 * @param {number} stakeUnits   stake divided by minimumStake
 * @param {number} volumeUnits  decayed diversified volume divided by feeUnit
 */
function bondScore(stakeUnits, volumeUnits, max = MAX_BOND_SCORE) {
  if (!(stakeUnits > 0) || !(volumeUnits > 0)) return 0;
  const coverage = stakeUnits / volumeUnits;
  const curve = Math.log2(1 + 4 * coverage) * (max * 0.3);
  const confidence = Math.min(1, volumeUnits / BOND_CONFIDENCE_UNITS);
  return Math.max(0, Math.min(max, Math.floor(curve * confidence)));
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

module.exports = {
  computeScore, feeScore, successScore, ageScore, ageCurve, communityScore, bondScore,
  SUCCESS_PRIOR, MAX_BOND_SCORE, BOND_CONFIDENCE_UNITS,
};
