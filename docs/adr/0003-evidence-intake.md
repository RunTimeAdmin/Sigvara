# ADR 0003 — Payment evidence enters by pull, not by delivery

**Status:** Accepted · 2026-09-20

## Context

A payment settles on chain as an ERC-20 `Transfer` to the agent's address. Evidence of it
enters an operator's state only when somebody `POST`s to **that operator's** `/attest`,
carrying the settlement hash. The oracle then re-verifies the transaction against the
chain, reads the payer off the transfer log, and refuses anything it cannot confirm.

So the verification is already chain-based. Only the *notification* is not.

With one operator that distinction is invisible. With two it is a defect, and today it
produced one on purpose: six payers each paid the demo agent 500 SVR, every settlement was
attested to the primary, and the checker — holding the same chain, the same code and the
same rules — was left scoring 23 SVR of volume against the primary's 3,023. The predicted
gap was around 29 points against a 3-point tolerance. Nobody misbehaved. The evidence
simply never arrived, because arrival is per-operator and by HTTP.

Two operators make it an annoyance. Ten make it a broadcast problem, and one where the
failure is silent: an operator that is never told looks exactly like an operator that
disagrees.

There is a second, older symptom of the same root. Whitepaper §5.4.6 records that
**unreported work is invisible**: payment verification detects a fabricated or altered
payment and cannot detect a real payment nobody submitted. That is not a separate gap. It
is this one, seen from the agent's side rather than the operator's.

## Options considered

| | Approach | Buys | Costs |
|---|---|---|---|
| Now | Document dual-post as a known footgun | Honesty, immediately | Still O(N) per payment, and O(N) human discipline |
| Near | Fan-out relay: one `/attest`, relay re-posts to every bonded operator | Works for N≈2–10 with no protocol change | A new trusted component |
| **Right** | **Pull: every operator indexes `Transfer` logs to agent addresses itself. `/attest` becomes a hint, not the only door** | **Removes the failure mode** | **Scanning cost per operator** |
| Later | On-chain attestation log for outcomes | True broadcast of success/fail | Gas, and a contract change |

### Why not the relay

It is the obvious answer and it is the wrong one.

A relay is a single intake path wearing a distribution costume. It needs its own
availability, authentication, retry and monitoring, and when it fails it fails *quietly* —
an operator that stops receiving relayed attestations is indistinguishable from an
operator that disagrees, which is the exact failure this ADR exists to remove. It would
add a component that every operator must trust, to a system whose entire premise is not
trusting single components.

It also buys nothing toward the end state. Relay work is thrown away when pull lands.

## Decision

**Payment evidence is pulled from the chain by each operator independently.**

1. Every operator scans `Transfer` logs of the configured payment asset to the addresses
   of registered agents, the same way it already scans `AgentRegistered`. The scanner,
   its chunking, its checkpointing and its rate-limit backoff already exist.

2. `POST /attest` remains, and keeps two jobs it alone can do:
   - **carrying the success flag.** "Money moved" is on chain; "the work was good" is not,
     and never will be. Outcomes stay push, and CounterAudit's negative attestations stay
     the only source of failures.
   - **acting as a hint.** "Check this transaction now" is useful when a caller does not
     want to wait for the next scan.

3. A payment counts because it happened, not because somebody reported it. This is a
   deliberate change of meaning and it closes §5.4.6: work an agent was paid for is no
   longer invisible because nobody filled in a form.

4. The existing defences are unchanged and still do the work. Self-payments are refused,
   `PAYMENT_MAX_PER_PAYER` caps what any single counterparty can contribute, volume decays
   on a half-life, and the payer is read from the transfer log rather than asserted. None
   of those depended on the attestation being the entry point.

## Consequences

- **Two operators with the same chain view converge by construction.** A divergence in
  fee or tenure then means a real disagreement, not a delivery failure, which is what
  makes a second operator load-bearing rather than advisory.
- **Scanning cost rises.** Each operator queries logs for one token contract filtered to
  known agent addresses, per chunk, forever. That is the same shape and roughly the same
  cost as the registration scan it already runs. On a free-tier RPC it is the thing most
  likely to hit a rate limit, and the existing backoff is what it will lean on.
- **The attest cooldown stops being a throttle on fee volume.** It never was the binding
  constraint — `maxPerPayer` is — but the reasoning should not be left implicit.
- **Attestation becomes optional for fee and tenure, and required for success.** That
  asymmetry is worth stating plainly in the docs, because "do I need to attest?" now has
  two different answers depending on which factor you care about.
- **§5.4.6 closes when this ships**, and not before. Until then the whitepaper should keep
  saying unreported work is invisible, because it is.

## What this does not change

This is not N-of-M consensus and does not pretend to be. Operators still compute
independently and the contract still does not require them to agree; a committee still
acts on a divergence. That is a different gap with a different fix.

It also does nothing about operators being run by the same party, which remains the real
decentralisation gap. Shared evidence intake is a precondition for independent operators
being useful, not a substitute for having them.

## Status of the work

**Built, not yet enabled** (22 September 2026).

`oracle/payment-scan.js` implements the scan: ERC-20 Transfer logs to registered agent
addresses, chunked and checkpointed like the registration scan, with its own backoff via
`chain.readWithBackoff`. Credits are planned purely and every refusal is named —
`self_payment`, `below_minimum`, `already_credited` — because a silent filter here is
indistinguishable from an agent nobody paid, which is the ambiguity this ADR exists to
remove.

`PAYMENT_SCAN_ENABLED` is `0` by default. Enabling it changes scores, since an operator
that has been missing payments starts counting them, and that should not happen by
surprise during a slash drill. **It must be enabled on every operator or on none**: two
scanning and one not is the same delivery asymmetry, pointed the other way.

Consequence 3 required a change to scoring, not just to intake. A pulled payment carries
no outcome, so it is credited with `success: null` and `payments.hasOutcome` keeps it out
of **both** sides of the success ratio while still counting it as fee volume. The earlier
code did `success: !!success`, which would have turned "nobody reported an outcome" into
"the work failed" and damaged agents nobody had complained about.

**§5.4.6 is not yet closed.** It closes when this is enabled on the live operators, not
when the code merges. Until then the whitepaper should keep saying unreported work is
invisible, because on the running deployment it still is.

Two further consequences surfaced only on audit, on 25 September, and both had the same
shape: an invariant that held while an attestation was the only way in, and stopped
holding once the scan existed. Recorded here because the pattern is more useful than
either instance.

**The third outcome state had to reach the Merkle leaf.** Scoring learned to tell
`success: null` from `false`; the leaf did not, and encoded `Boolean(success)`. A payment
nobody had judged therefore hashed identically to a payment somebody had failed, so the
evidence root no longer committed to the arithmetic behind the score, and two operators
holding contradictory outcomes published matching roots. The outcome is now a `uint8`:
0 failed, 1 succeeded, 2 not reported. ABI-encodes a `bool` as a 32-byte 0 or 1, which is
byte-for-byte a `uint8` 0 or 1, so no root published before the change moved.

**A settlement is credited once per recipient and sender, not once per transaction.** The
dedupe key was the transaction hash alone, which was correct while one attestation named
one agent. The scan reads every agent's transfers out of the same logs, so a transfer batch
paying several registered agents is ordinary traffic, and all but the first were silently
dropped: not counted as credited, not recorded as skipped, with the checkpoint moving past
the block regardless. Nothing is weakened by narrowing it, because what stops a receipt
being spent on an agent it never paid is the recipient check in both entry paths, not the
dedupe key.

The sender joined the key on 25 September, for a reason that only appeared once both paths
existed. Each collapsed several senders in one transaction down to one payer, and they did
it differently: the attested path took the largest contributor, the scan the earliest log.
The same transaction therefore credited a different payer depending on which route saw it,
and payer identity drives the per-payer cap, the distinct counterparty count, propagation
and the self-payment refusal. Two honest operators could diverge over a payment nobody
disputed, which is the delivery asymmetry this ADR removed returning as an interpretation
asymmetry.

Both now group by `(transaction, agent, sender)`, which deletes the rule rather than
reconciling two versions of it: there is no payer to select. Totals are unchanged and
counterparty diversity stops being understated, so the per-payer cap binds where it should
have. An attested outcome goes on the largest leg alone, because an attestation reports on
one piece of work and repeating its boolean per sender would count one job several times in
the success ratio; the other legs are money that moved with nobody reporting on it, which
is what `success: null` already means.


Originally decided, not built. The immediate consequence is that the divergence being left live on
20 September should be triaged in public as a delivery failure rather than quietly seeded
away — see [divergence-log.md](../divergence-log.md). Seeding the checker by hand would
have hidden the very defect that justifies this decision.
