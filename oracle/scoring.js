'use strict';

// Ported from bagsReputation.js — adapted for the Sigvara EVM protocol.
// All six factors are self-contained pure functions so they can be unit-tested in isolation.
//
// Phase 1 stubs: externalScore (SAID integration) and propagationScore (trust graph)
// are always 0 until Phase 2 oracle network is live.

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

function ageScore(registeredAtSeconds) {
  // Logarithmic formula matches the Solidity on-chain reference value.
  // Reaches max (20) around day 31: log2(32) * 4 = 20.
  const days = (Date.now() / 1000 - registeredAtSeconds) / 86400;
  return Math.min(20, Math.floor(Math.log2(days + 1) * 4));
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
  successPrior = SUCCESS_PRIOR,
}) {
  const { successful = 0, total = 0 } = attestations;

  // measuredFeeScore is supplied when payments are verified: real volume beats the
  // attestation-count proxy. null means payment verification is off.
  const fs = measuredFeeScore === null ? feeScore(total) : Math.max(0, Math.min(30, measuredFeeScore));
  const ss = successScore(successful, total, successPrior);
  const as = ageScore(registeredAt);
  // externalScore comes from ERC-8004 cross-protocol feedback (see external.js),
  // 0 when unlinked or unconfigured. Clamp to the contract's cap so a bad input
  // can never make proposeReputation revert.
  const es = Math.max(0, Math.min(15, Math.trunc(externalScore) || 0));
  const cs = communityScore(flags ?? 0);
  const ps = 0;  // Trust propagation graph — Phase 2

  // Sum all six factors so total stays correct once es/ps become nonzero in Phase 2.
  return { feeScore: fs, successScore: ss, ageScore: as, externalScore: es, communityScore: cs, propagationScore: ps, total: fs + ss + as + es + cs + ps };
}

module.exports = { computeScore, feeScore, successScore, ageScore, communityScore, SUCCESS_PRIOR };
