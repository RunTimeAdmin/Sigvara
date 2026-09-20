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

Decided, not built. The immediate consequence is that the divergence being left live on
20 September should be triaged in public as a delivery failure rather than quietly seeded
away — see [divergence-log.md](../divergence-log.md). Seeding the checker by hand would
have hidden the very defect that justifies this decision.
