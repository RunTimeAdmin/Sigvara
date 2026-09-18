# Reputation Model

Sigvara reputation is a deterministic 6-factor score between 0 and 100. It is computed off-chain by the oracle network and written to the `SigvaraReputation` contract every epoch. The contract stores and serves the score; it does not compute it. This separation means the scoring logic can evolve without storage migrations.

---

## The Six Factors

| Factor | Max Points | Source | Formula |
|---|---|---|---|
| Fee Activity | 30 | On-chain transaction volume in USD | `min(30, floor(totalFeesUSD / 100))` |
| Success Rate | 25 | Cryptographic task attestations | `floor(successRate * 25)` |
| Tenure | 20 | Span of verified trading, faded by how long since the last of it | `min(20, floor(log₂(spanDays+1) × 4)) × recency` |
| External Trust | 15 | SAID Protocol / Gitcoin Passport | `floor(externalScore / 100 × 15)` |
| Community | 5 | Unresolved flags | `max(0, 5 − flags × 2)` |
| Trust Propagation | 5 | Trust graph network effects | oracle-computed |

### Fee Activity (30 pts)

Measures real economic activity. An agent that processes $3,000 in fees reaches the maximum. This is the hardest factor to fake — it requires sustained, on-chain economic participation.

```
$0     → 0 pts
$1000  → 10 pts
$2000  → 20 pts
$3000+ → 30 pts
```

### Success Rate (25 pts)

Based on cryptographic attestations submitted by counterparties. A counterparty that successfully received work from the agent submits a signed attestation. The oracle aggregates all attestations per agent over the epoch.

```
0%   → 0 pts
50%  → 12 pts
80%  → 20 pts
100% → 25 pts
```

This factor will eventually be sourced directly from CounterAudit verified packets — closing the loop between audit trail and reputation.

### Tenure (20 pts)

Logarithmic growth curve on the span between an agent's first and most recent verified payment, multiplied by how recent that last payment is.

This used to measure time since registration, and the claim here was that the logarithm prevented idle old agents dominating. It did not. It capped them, but an agent that registered two years ago and never worked still collected the full 20 points, which made this the cheapest factor in the score: register in bulk, wait a month, collect. Waiting is free.

Three properties follow from measuring trade instead:

- An agent that has never been paid at arm's length scores 0, however long ago it registered.
- Waiting and then making a single payment scores 0 too, because the span starts at first activity. There is no way to bank idle time and convert it in one transaction.
- Tenure fades once the agent stops. Two years of trading abandoned a year ago is worth about one point.

What remains expensive is the thing an attacker cannot shortcut: a long, unbroken record of paid work from independent counterparties, with a bond posted and slashable throughout.

Payments from the agent's own operator never enter the record, so the span is made of arm's-length trade only. When payment verification is off the factor falls back to the old calendar curve.

```
Day 0   → 0 pts
Day 1   → 4 pts
Day 3   → 8 pts
Day 7   → 12 pts
Day 15  → 16 pts
Day 31  → 20 pts  (maximum)
```

Formula: `min(20, floor(log₂(days+1) × 4))`

### External Trust (15 pts)

Bridges existing identity systems. Currently planned integrations:
- **SAID Protocol** — Semantic Agent Identifier standard
- **Gitcoin Passport** — weighted credential aggregator

An agent that has a verified external identity (GitHub, ENS, biometric attestation via Gitcoin) can carry up to 15 pts from that credential.

### Community Verification (5 pts)

Deducted based on unresolved community flags. The full 5 pts is the default for unflagged agents.

```
0 flags → 5 pts
1 flag  → 3 pts
2 flags → 1 pt
3 flags → 0 pts
```

Flags are submitted through a governance mechanism (separate from slashing). Slashing is economic; flags are reputational.

### Trust Propagation (5 pts)

Network-effect scoring. Agents that are trusted by other high-reputation agents propagate a fraction of that trust. If Agent A (score 80) repeatedly delegates to Agent B and attests success, Agent B gains propagation points.

This factor is currently oracle-computed from the attestation graph and is the most experimental of the six. It will be formalized in Phase 2.

---

## Inherited trust (5 pts)

An attestation is only as good as whoever made it. A payment from an agent that is
itself scored, bonded and slashable is better evidence than one from a wallet nobody
has heard of, so counterparty standing now weighs on the score in two places.

A counterparty's evidence cap rises with its own score. At the default weight, a
perfectly scored counterparty contributes twice what an anonymous wallet can, while
the cap on any single payer still holds.

The propagation factor is one point per fully trusted counterparty, pro-rated by
score, capped at five. Five counterparties with perfect scores reach the cap, and so
do ten with half. Each counterparty counts once however much it pays: this factor
measures the breadth of who will vouch for an agent, not the size of the cheques.

Two properties make it worth having rather than dangerous.

**It cannot be bootstrapped.** A ring of fresh identities all score zero and so grant
each other nothing. Someone who stands up five Sybils gains no inherited trust from
them until each has independently earned a score, which needs its own bond, its own
diverse payers and its own tenure. Collusion has to start from real standing rather
than manufacture it.

**It is damped against reflexivity.** The scores read are the matured ones, which lag
what has just been earned, so a reciprocal pair cannot lift each other inside one
epoch. Unknown counterparties and unreachable nodes both read as zero, because no
evidence of standing and no ability to check are the same thing as far as granting a
bonus goes.

## Maturity

A score is earned as soon as it finalizes, but it becomes spendable only over time.
`getTotalScore` returns the matured value, which climbs toward the earned one at a
fixed number of points per day, and `getEarnedScore` returns the raw figure. Threshold
checks use the matured value.

The attack this addresses is farm-and-cash-out: build a score quickly, get trusted at
the peak, leave. Decay already makes a farmed score perishable, but perishable is not
the same as unusable, and a burst was spendable the moment it landed. Maturity puts a
floor under how fast trust can be acquired, so the window where a farm is worth
anything is a month rather than a week, and that month is long enough for the dispute,
flagging and slashing machinery to be used.

Two details matter. A rise is released from what the agent could actually spend at the
last finalize, not from what it had earned, so re-proposing a high score does not reset
the clock. And a fall is immediate: delaying bad news would protect the agent rather
than whoever is relying on it.

### Changing hands

An agent can be transferred to a new operator in two steps: the current operator
offers it, and the recipient accepts. Two steps because a one-shot transfer to a
mistyped address would strand the identity and its bond permanently, since only the
operator can act and nobody would hold that key.

A transfer restarts maturity. The earned score survives the sale, but the buyer
re-earns the right to spend it over the usual window. Without that, aged and scored
identities would be a liquid commodity, which is the farm-and-sell market in its
most convenient form. `operatorTransferCount` is public, so a consumer can also
discount an identity that has changed hands repeatedly.

Transfers are refused while a slash is pending, so an accused agent cannot be handed
to a buyer who had no part in what it did, and refused unless the agent is bonded at
handover, so what changes hands carries collateral rather than only a reputation.

## Bond before trust

A newly registered agent is `PendingBond`, not `Active`. Registration costs only gas,
so minting an Active identity meant an unbonded agent existed the moment someone paid
for a transaction, and an unbonded agent cannot be slashed: there is no stake to take.
Bulk registration was therefore free and produced identities that could accrue
standing while being unaccountable by construction.

The first deposit that carries an agent over `minimumStake` activates it. Only from
`PendingBond`: topping up must not drag back an agent that suspended itself to
withdraw, or one the staking core suspended for a pending slash. Nothing returns to
`PendingBond` either, since an agent cannot become un-bonded. It suspends and exits.

`PendingBond` is appended to the status enum rather than inserted, because those values
are stored on a live proxy and renumbering them would reinterpret every existing
identity after an upgrade.

## New Agent Ramp-Up

A brand-new agent registers and immediately has:
- Fee Activity: 0 (no transactions yet)
- Success Rate: 0 (no attestations yet)
- Age: 0 (just registered)
- External Trust: depends on credentials
- Community: 5 (no flags)
- Propagation: 0

**Starting score: ~5 points** (community baseline only).

This is by design. A new agent cannot be trusted at the same level as one with 6 months of economic activity. The logarithmic age curve and fee activity floor mean you cannot buy reputation instantly — you have to earn it over time.

The practical ceiling for a new agent within the first week is around 15–20 points. Reaching 50+ requires sustained activity over weeks. The 90+ range requires months of strong economic activity and many successful attestations.

---

## Slashing Resets Everything

When an agent is slashed:

1. `SigvaraStaking.executeSlash()` calls `SigvaraReputation.zeroReputation(didHash)`
2. All six factor scores are set to zero
3. The agent's status is set to `Slashed` (terminal — no further transitions)
4. The stake is distributed: 50% burned, 25% to victim, 25% to reporter

The slashed DID cannot be reactivated. The operator must register a new agent address with a new DID and start from zero. This economic finality is what makes the reputation meaningful — reputation can be destroyed, so it is worth protecting.

---

## On-Chain Consumption

Any smart contract can gate on reputation:

```solidity
// Inside your contract
ISigvaraReputation reputation = ISigvaraReputation(REPUTATION_ADDRESS);

function onlyTrustedAgent(bytes32 didHash) internal view {
    require(
        reputation.meetsThreshold(didHash, 50),
        "Agent does not meet minimum reputation threshold"
    );
}
```

Or query directly:

```solidity
uint8 score = reputation.getTotalScore(didHash);
```

---

## Oracle Epochs

The reference oracle runs on a configurable interval (`EPOCH_HOURS`, default 1 hour on testnet). In Phase 2, epochs will be governed by a decentralized oracle network with consensus over the score computation. The on-chain storage format will not change — only the writer changes.

Current oracle: `oracle/` directory in this repository. Single-operator, single chain. Queries `AgentRegistered` events in 9-block chunks (Alchemy free-tier constraint) and uses an in-memory attestation map.

Phase 2 oracle: replaces the in-memory attestation map with cryptographically attested data from CounterAudit (for Success Rate) and integrates SAID / Gitcoin for External Trust.

---

## Related

- [Ecosystem Overview](ecosystem.md)
- [Quickstart: Register your first agent](quickstart.md)
- [CounterAudit Integration Guide](counteraudit-integration.md)
