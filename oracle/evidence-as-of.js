'use strict';

const merkle = require('./merkle');

/**
 * The payment evidence as it stood when a proposal was made, for a checker auditing it.
 *
 * A checker re-scores a pending proposal at the proposal's own time (index.js), and used to do
 * so over all the evidence it holds now. A payment that settled, or an outcome a payer signed,
 * after the proposal is evidence its proposer could not have had. Counting it made an honest
 * proposal look wrong and sent the committee an alert to reject it: on 2026-11-01 a proposal
 * made at 23:06 was disputed over two payments that settled at 23:15 and 00:02.
 *
 * Two readings of the evidence at `atMs` are tried against the root the proposal committed to:
 *   1. every payment that had settled by then, with the outcomes this operator holds now;
 *   2. the same, with each outcome a payer signed and this operator took after then set back to
 *      unreported, since an outcome can be signed long after its payment settled.
 * The leaf commits to the outcome, so a reading whose root is the committed one IS the
 * proposal's evidence, and the audit is left checking the arithmetic. When neither matches, the
 * evidence differs and reading 1 is used: it holds nothing the proposer could not have had, so
 * a disagreement that remains is a real one.
 *
 * acceptedAt is this operator's own time of taking an outcome, which for one imported from the
 * proposer is later than when the proposer took it, so reading 2 can unset an outcome the
 * proposer had. That is why it only counts when its root matches, and what it can hide is
 * bounded: a proposer that left out an outcome it had passes only for an outcome this operator
 * took after the proposal, and only for that one proposal, because by the next this operator
 * has taken it before the proposal's time and reading 2 no longer unsets it. A credentialed
 * outcome a payer later replaced is not recoverable from the event, so it reads as unreported in
 * reading 2; the root check catches that case the same way.
 *
 * With payment chains configured (ADR 0009), an operator chooses its evidence at a whole-minute
 * cut-off before its clock, and its proposal is dated by its transaction's block a little later.
 * `cuts` lists those cut-offs, newest first (payment-chains.auditCuts); both readings are tried at
 * each after the proposal's time, and the first whose root matches is used. When none does, reading 1
 * is taken at the newest cut-off, since a proposer can have counted nothing later. `eligibleAt` says
 * when a payment started to count: its settlement, or on a payment chain its settlement plus the
 * chain's delay. Without `cuts` only the proposal's time is tried, as before.
 *
 * Only the fixed order is read (payment-chains.eventsAt): it is the order every proposal commits to.
 *
 * @param {object[]} events   one agent's payment events, in the fixed order
 * @param {number} atMs       the proposal's time, in ms
 * @param {string|null} committedRoot the proposal's evidenceRoot, or null when it has none
 * @param {{ eligibleAt?: (e: object) => number, cuts?: number[] }} [options]
 * @returns {{ events: object[], matchedRoot: boolean }}
 */
function evidenceAsOf(events, atMs, committedRoot, { eligibleAt = (e) => Number(e.ts), cuts = [] } = {}) {
  if (!Number.isFinite(atMs)) throw new TypeError('evidenceAsOf: atMs (ms) is required');
  const countedBy = (list, cut) => list.filter((e) => eligibleAt(e) <= cut);
  const committed = typeof committedRoot === 'string' ? committedRoot.toLowerCase() : null;
  if (committed) {
    for (const cut of [atMs, ...cuts.filter((c) => c < atMs)]) {
      const set = countedBy(events, cut);
      if (merkle.rootFor(set).toLowerCase() === committed) return { events: set, matchedRoot: true };
      const unset = set.map((e) => (signedAfter(e, atMs) ? withoutPayerOutcome(e) : e));
      if (unset.some((e, i) => e !== set[i]) && merkle.rootFor(unset).toLowerCase() === committed) {
        return { events: unset, matchedRoot: true };
      }
    }
  }
  return { events: countedBy(events, cuts.length ? Math.min(atMs, cuts[0]) : atMs), matchedRoot: false };
}

function signedAfter(event, atMs) {
  return Boolean(event.payerOutcome) && Number(event.payerOutcome.acceptedAt) > atMs;
}

function withoutPayerOutcome(event) {
  const { payerOutcome: _takenLater, ...rest } = event;
  return Object.freeze({ ...rest, success: null });
}

module.exports = { evidenceAsOf };
