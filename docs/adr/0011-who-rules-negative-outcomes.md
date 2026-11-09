# ADR 0011: Who rules a contested negative outcome

**Status:** Accepted · 2026-11-09, the owner's choice of option D (section 3). Rollout steps 1 and 2 are built in
`oracle/negative-hold.js`, off unless `PAYER_OUTCOMES=both`. Operators keep `PAYER_OUTCOMES=positive` until rollout step 3.

## 1. Context

- **ADR 0006** lets a payer sign `1` delivered or `2` not delivered for a payment it made. One outcome per payer
  and payment leg, no revision; a refund is a separate, linked event. Operators run `PAYER_OUTCOMES=positive`:
  a signed "not delivered" is refused (`oracle/index.js:2330`, `2811`) until "a challenge process exists", and
  once on, negatives are "presented as payer-reported, not as verified fact". A negative already costs a real
  payment to the agent it criticises, and the per-payer cap and decay apply (ADR 0006, section 5).
- **ADR 0010** lists non-delivery as slashable (A3): paid and neither delivered nor refunded, by 3 independent
  payers in 30 days or one unrefunded loss of at least 25% of the bond. A refund before the ruling cures it. A3
  cannot be used until the challenge process exists, and ADR 0010 leaves "who rules on contested facts" to this ADR.
- **ADR 0005** already has a judge for slashes: the committee files, the agent can dispute, and the admin Safe
  rules (`resolveDispute`) or vetoes. The committee and the admin Safe share no owner.
- **Outside the protocol**, x402 now has a refundable escrow scheme and x402r adds an arbiter per payment, but
  delivery receipts are still proposals (ADR 0006, section 2). Most payments Sigvara counts are plain transfers.

There are two different questions, and they need not have the same answer:

1. **The score.** When does a payer's "not delivered" lower an agent's Success Rate, and how can the agent answer it?
2. **A slash.** When non-delivery is the ground for taking a bond (A3), who decides the facts?

ADR 0010's first principle applies to both: a stranger must be able to check the evidence from chain data or
signatures, without trusting the committee.

## 2. What any answer must keep

- The agent can answer every negative before it counts.
- Nobody can lower a score without paying the agent first (ADR 0006).
- What counts can be recomputed by anyone from the chain and the signed outcomes.
- The committee's and the admin's judgments stay for slashes, which are rare and final, not for every job.

## 3. Options considered, and the decision

### A. Mechanical: a refund is the only answer

A negative is held for a contest window (7 days from when the operators accept it). It counts unless, inside the
window, the agent refunds the payment: a transfer from the agent's address to the payer, in the payment's asset,
on the payment's chain, of at least the amount. A refund also cures A3. No judge for the score at all.

- For: anyone can check it from the chain; no workload; matches A3's own cure; refunding is what an agent that
  failed should do anyway.
- Against: an agent that delivered and does not want to refund has no other recourse. Griefing is limited only by
  its cost (a real payment per negative), the per-payer cap and decay.

### B. The committee rules each contested negative

The agent files a counter-statement inside the window; the committee (3 of 5) decides delivered or not; the admin
Safe hears appeals.

- For: an honest agent that delivered has someone to persuade.
- Against: a human judgment per job, which is the workload ADR 0010 avoids; the judgment cannot be checked by a
  stranger; today the committee is run by the team; slow.

### C. An outside arbiter only

A negative counts only for a payment that went through an escrow with an arbiter (x402r), and the arbiter's
ruling is the outcome. Plain transfers carry positives only.

- For: the judge is chosen by both parties when they pay; nothing for Sigvara to staff.
- Against: the interfaces have not settled, and almost no payment Sigvara counts goes through one, so negatives
  would in practice stay off.

### D. Hybrid: the decision

- **Score: A.** A negative is payer-reported, held 7 days, and counts unless refunded in that window. It moves
  Success Rate by the same weight as a positive, under the same per-payer cap and decay.
- **Slash: the existing process.** A3 can only be filed on negatives that counted, unrefunded, at A3's thresholds.
  The committee files, the agent can dispute, the admin Safe rules (ADR 0005). The committee never rules on
  delivery for the score.
- **Outside arbiter: later.** When a payment went through an escrow whose arbiter ruled, that ruling decides its
  outcome and a refund ordered by it cures. This waits for x402's escrow and arbiter interfaces to settle.

Why D was chosen: the score stays mechanical and checkable, which is what makes it worth reading; the only human judgment is
where a bond is at stake and a judge already exists; and the outside arbiter fits in without being needed first.

## 4. Parameters to set

| | Proposal |
|---|---|
| Contest window | 7 days from the first operator's acceptance of the negative, and never from before the payer signed it. An operator that accepted the same negative later moves to the first acceptance's block when it imports it. Once a negative's refunds are read past the window, a later change of its length does not move that negative |
| What cures | A transfer agent to payer, same asset and chain, at least the payment amount, in a block after the payment's and before the window closes. Partial refunds do not cure. A refund is not used up: one transfer that meets these terms for several negatives of the same payer cures each of them |
| Weight | The same as a positive |
| Price of a negative | `PAYER_NEGATIVE_MIN_AMOUNT`, starting at `PAYMENT_MIN_AMOUNT` (ADR 0006) |
| Label | Payer-reported in `/evidence` and the explorer; "refunded" when cured |
| Switching mode | `PAYER_OUTCOMES` decides what an operator takes. Negatives already taken under `both` are still held, read and counted after a switch back to `positive` or `off` |

## 5. Consequences

- `PAYER_OUTCOMES=both` becomes possible on testnet once the oracle holds negatives for the window and detects
  refunds; the scan already reads transfers to the agent and would also read the agent's transfers to its payers.
- An agent's Success Rate can fall for the first time since 20 September. Explain that on the site before it does.
- A3 becomes usable, with its evidence being the counted, unrefunded negatives plus their payments.
- A refund window is a cost to an honest agent's cash flow only when it chooses to refund.

## 6. What this does not do

- It does not prove a negative is true, only that the payer paid, signed and was not refunded.
- It adds no escrow and no arbiter contract. The outside arbiter waits for x402.
- It does not change who files or rules slashes (ADR 0005, ADR 0010).

## 7. Rollout

1. Oracle: hold negatives for the window, detect refunds, count after the window; `both` stays off by default.
2. Tests: a negative that counts, one cured by a refund, a partial refund that does not cure, a refund from
   another address that does not cure, and a negative older than the window.
3. Arc testnet with `both`, after the site explains payer-reported negatives.
4. A3 enabled in the committee's runbook once 3 is live.
