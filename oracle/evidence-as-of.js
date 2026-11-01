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
 * @param {object[]} events   one agent's payment events, as the store holds them
 * @param {number} atMs       the proposal's time, in ms
 * @param {string|null} committedRoot the proposal's evidenceRoot, or null when it has none
 * @returns {{ events: object[], matchedRoot: boolean }}
 */
function evidenceAsOf(events, atMs, committedRoot) {
  if (!Number.isFinite(atMs)) throw new TypeError('evidenceAsOf: atMs (ms) is required');
  const settled = events.filter((e) => Number(e.ts) <= atMs);
  const committed = typeof committedRoot === 'string' ? committedRoot.toLowerCase() : null;
  if (committed) {
    if (merkle.rootFor(settled).toLowerCase() === committed) return { events: settled, matchedRoot: true };
    const unset = settled.map((e) => (signedAfter(e, atMs) ? withoutPayerOutcome(e) : e));
    if (unset.some((e, i) => e !== settled[i]) && merkle.rootFor(unset).toLowerCase() === committed) {
      return { events: unset, matchedRoot: true };
    }
  }
  return { events: settled, matchedRoot: false };
}

function signedAfter(event, atMs) {
  return Boolean(event.payerOutcome) && Number(event.payerOutcome.acceptedAt) > atMs;
}

function withoutPayerOutcome(event) {
  const { payerOutcome: _takenLater, ...rest } = event;
  return Object.freeze({ ...rest, success: null });
}

module.exports = { evidenceAsOf };
