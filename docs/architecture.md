# Architecture — signal topology

Sigvara is the **computed-reputation and staked-slashing layer on top of
[ERC-8004](https://eips.ethereum.org/EIPS/eip-8004)**. ERC-8004 provides the
canonical agent identity and a raw feedback ledger; Sigvara turns that
feedback (plus its own signals) into one normalized score and puts slashable
stake behind it — the parts the standard deliberately leaves out. See
[ADR 0001](adr/0001-erc8004-as-identity-layer.md) for that decision.

Every path a trust signal takes:

```mermaid
graph TB
    subgraph sources["Signal sources"]
        CA["CounterAudit<br/>work-outcome attestations"]
        WD["Watchdog scanners<br/>rug / abuse flags"]
    end

    subgraph erc8004["ERC-8004 · identity + feedback (canonical)"]
        EID["Identity Registry<br/>agent identity"]
        EREP["Reputation Registry<br/>raw feedback"]
    end

    subgraph sigvara["Sigvara · the trust layer"]
        OR(["Reputation Oracle<br/>computes the score"])
        REP["SigvaraReputation<br/>computed-score anchor"]
        ST["SigvaraStaking<br/>bonds + slashing"]
    end

    CONS["SDK · consumers · on-chain readers"]

    CA -->|"success / fail"| OR
    WD -->|"flags"| OR
    EID -->|"identity + age"| OR
    EREP -->|"feedback to externalScore"| OR
    OR -->|"propose / finalize"| REP
    ST -->|"slash · zero score"| REP
    CA -->|"giveFeedback"| EREP
    REP -->|"getTotalScore · meetsThreshold"| CONS
```

## Signals in

The oracle recomputes every factor each epoch from observable data:

- **Payment-backed attestations** — a consuming platform reports, per completed
  job, whether the agent succeeded or failed, and cites the settlement
  transaction of the payment for that job.
  [CounterAudit](counteraudit-integration.md) does this today. The oracle
  verifies the transfer on chain and takes the payer from the log rather than
  from the request, which is what makes the attester an identity rather than a
  claim. This drives the success-rate and fee-activity factors.
- **Flags** — watchdog scanners (e.g. rug detectors on the same chain) report
  misbehaving agents. Flags subtract from the community factor.
- **ERC-8004 feedback** — for an agent linked to an ERC-8004 identity it owns,
  the oracle reads that agent's on-chain feedback and normalizes the rating
  dimensions it recognizes into the external-trust factor (`externalScore`).
- **Counterparty standing** — the matured scores of the agents that paid, which
  raise how much their evidence is worth and feed the propagation factor.
- **Tenure** — the span between the agent's first and most recent verified
  payment, faded by how long ago that last one was. Deliberately not calendar
  age since registration: waiting is free, and trading is not.

## Score out

The oracle proposes the computed score to `SigvaraReputation`, together with a Merkle
root over the evidence behind it; after a challenge window (rejectable) it finalizes
on-chain. `SigvaraStaking` can slash a misbehaving agent, which zeroes its score.
Consumers read the finalized score with a single view call (`getTotalScore` /
`meetsThreshold`).

Two gates sit on that path. Only a bonded agent can be scored at all, and when
`operatorBond` is wired only a bonded oracle operator can propose. Finalizing stays
permissionless, so nobody can hold a score hostage by declining to write it.

The evidence root is what makes the off-chain half checkable: the oracle serves the
leaves it counted, and anyone can re-verify each payment against the chain, rebuild the
root, and compare it with what the contract holds.

## A deliberate loop-break

CounterAudit feeds the oracle directly (attestations → success factor) **and**
publishes outcomes to the ERC-8004 Reputation Registry (`giveFeedback`) for
ecosystem visibility. The oracle also reads ERC-8004 feedback for
`externalScore` — so CounterAudit's signal could enter a score twice. It does
not: CounterAudit's feedback carries a distinct `counteraudit` tag that the
`externalScore` normalizer excludes, so the circle is cut on purpose. No signal
is double-counted.
