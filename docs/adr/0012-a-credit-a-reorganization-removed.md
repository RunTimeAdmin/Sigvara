# ADR 0012: A credit for a transaction a reorganization removed

**Status:** Accepted · 2026-11-14. Option C (section 3). It answers the open Phase 4 item in the
[launch checklist](../launch-checklist.md): how a credit for a transaction that a reorganization removed would be
taken back, without changing roots already published.

## 1. Context

- **When a payment is credited.** On the scored chain, `POST /attest` credits a payment once it has
  `PAYMENT_MIN_CONFIRMATIONS` confirmations, counted from the head (`oracle/payments.js:192-198`). The default
  is 1 (`oracle/config.js:28`), so the payment's own block is enough. The scan stays at least 6 blocks behind the
  head (`oracle/payment-scan.js:60`, `:101-116`). A payment chain (ADR 0009) is read only up to its `finalized`
  block (`oracle/payment-chains.js:515-524`).
- **A credit is never taken back.** The transaction hash goes into `usedPaymentTxs` (`oracle/store.js:97`) and
  stays there, so the payment cannot be credited twice. The comment at `oracle/payment-scan.js:101-104` says what
  follows: "a reorg leaves a credit for a transaction that no longer exists."
- **Arc's finality was measured.** For 24 hours from 12 November 2026, no block hash read from three endpoints
  ever changed, and `finalized` stayed within one block of `latest`
  ([launch-checklist.md](../launch-checklist.md), the finality item). The three endpoints are not independent
  views of consensus, so this shows that nothing happened, not that nothing can.
- **Evidence can already stop counting from a set time.** A payment-chain payment stops counting once its payer
  is named the agent's operator: the proposer leaves it out (`oracle/payment-chains.js:376-385`) and a checker
  auditing a proposal gives it an end time (`endsAt`, `oracle/index.js:429-432`,
  `oracle/evidence-as-of.js:38-52`). The event itself stays, so a root committed before that time still
  reproduces.
- **A later chain fact is already read back onto a held event.** The refund read for a payer negative reads a
  payment chain at its `finalized` block and the scored chain at the scan's safe head (`oracle/index.js:535-539`),
  and records the result on the event (`refundCheck`, ADR 0011).

## 2. What any answer must keep

1. A root already published, or committed in a pending proposal, still reproduces from the operator's state.
2. Both operators reach the same answer from the chain alone, so the checker can audit it.
3. A transaction is never credited twice, whatever happens to its block.
4. An honest agent loses nothing on a chain that does not reorganize.

## 3. Options considered

**A. Never take a credit back.** Rely on Arc's finality and write down the risk. No code. A credit for a removed
transaction counts for as long as the payment would have, and anyone who could reorganize the chain could
mint credits with payments that never stay.

**B. Credit at `finalized` only, and halt if a credit goes missing.** The scored chain uses its `finalized` block
like a payment chain does. A re-read of recent credits that finds one missing stops proposals and alerts a person.
This makes a removal a consensus failure rather than a routine event, but it still does not say how the credit is
taken back: the person who is alerted needs a way to do it, and a hand edit of both operators' state is the kind
of step that goes wrong under pressure.

**C. Credit at `finalized`, and end a removed credit from the time it was found. Chosen.**
1. The scored chain credits at its `finalized` block, in the attested path and in the scan (which keeps its
   6-block floor as well). On Arc that is within one block of the head, so an agent sees no delay.
2. Each epoch reads again every credit not read again yet whose block is now at or below `finalized`, within a
   budget and the oldest first, as the refund read does. The receipt is read first. Arc's public endpoints serve
   no receipt for a transaction a few weeks old (measured 14 November 2026), so where there is none the block's
   list of transactions is read, and the transfer is looked for in that block's logs.
3. A credit whose receipt now sits in another block or no longer holds the credited transfer, or that has no
   receipt and whose block no longer lists the transaction, gets `removedAt`: the time of the `finalized` block
   the re-read was made against. An answer that could be the node's rather than the chain's (a block without its
   list, or a transaction still in its block whose logs do not show the transfer) removes nothing, and the credit
   is read again next epoch.
4. Evidence leaves an event out from `removedAt` on: the proposer's filter and the checker's `endsAt` both read
   it, as they already do for a payer named operator. The event stays in state, so every root committed before
   `removedAt` reproduces. Its payer outcome, positive or negative, ends with it.
5. The transaction hash stays in `usedPaymentTxs`. A transaction put back in a later block is not credited again.
   The agent loses that one credit, which on a chain that does not reorganize never happens.
6. A removal is logged, counted in a metric, and served in `/evidence` with the event, and the watcher alerts on
   it. Two operators that disagree about one show it as a divergence.

**D. Publish corrected roots.** Rejected. It changes roots already published and pending proposals, which every
reader and the checker rely on.

## 4. Parameters to set

| Parameter | Proposed |
|---|---|
| When a credit is re-read | The first epoch after the block it was credited at is final |
| Re-read budget per epoch | Shared with the refund read's ten minutes, the oldest first |
| A credit not re-read in time | Counts, and is read first next epoch, with a log line and a metric |

## 5. Consequences

- One receipt read per credit, once, or a receipt, a block and a log read where the node has pruned the receipt.
- `/attest` answers 503, not 402, for a payment whose block is not final yet, so a carrier sends it again.
- A credit's end time depends on when it was found, not when the block was replaced. A root published in
  between counted it; that is the price of requirement 1, and the next root drops it.
- A slash already filed on evidence that a removal later changes is still ruled by the committee and the admin
  Safe ([ADR 0005](0005-governance-and-emergency-powers.md)). The committee re-reads the evidence before ruling.
- The state file grows by one field per credit, the block it was read again at, and by two more on a credit that
  was removed, which should be none.

## 6. What this does not do

- It does not make Arc final. If removals happen at all, `PAYMENT_MIN_CONFIRMATIONS` and
  `PAYMENT_SCAN_CONFIRMATIONS` go up, as the checklist's finality item says.
- It does not re-read a payment chain's credits. Those are already credited at `finalized`. Option C's step 2 can
  extend to them later with no change of rule.
- It does not touch scores already finalized on chain. The next proposal carries the corrected evidence.

## 7. Rollout

1. Oracle: credit the scored chain at `finalized`; the re-read and `removedAt`; the proposer's filter and the
   audit's `endsAt` read it; `/evidence`, the log line and the metric.
2. Tests: a credit that stays; one whose transaction is gone; one moved to another block; a root committed
   before the removal still reproduces; the checker reaches the same `removedAt`.
3. Both Arc testnet operators, then the watcher's alert.
4. The checklist item ticked, before the registries go to mainnet.
