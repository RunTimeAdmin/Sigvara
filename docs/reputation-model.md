# Reputation Model

Sigvara reputation is a deterministic 6-factor score between 0 and 100. It is computed off-chain by the oracle network and written to the `SigvaraReputation` contract every epoch. The contract stores and serves the score; it does not compute it. This separation means the scoring logic can evolve without storage migrations.

---

## The Six Factors

| Factor | Max Points | Source | Formula |
|---|---|---|---|
| Fee Activity | 20 | Settled payments to the agent, verified on chain | `min(20, decayedVolume / PAYMENT_FEE_UNIT)`, capped per payer |
| Success Rate | 15 | Outcome reported by the party that paid | `floor(successful / (total + 5) × 15)`, on decayed weights |
| Tenure | 30 | Span of verified trading, faded by how long since the last of it | `min(30, floor(log₂(spanDays+1) × 3)) × recency` |
| External Trust | 25 | Normalized ERC-8004 feedback for a linked agent | mean of recognized rating tags × 25 |
| Community | 5 | Unresolved flags | `max(0, 5 − flags × 2)` |
| Trust Propagation | 5 | Standing of the counterparties that paid the agent | 1 pt per fully-trusted counterparty, pro-rated by its score |

All six are live. Only a **bonded** agent is scored at all: a newly registered agent is
`PendingBond` and `proposeReputation` refuses it.

### Fee Activity (20 pts)

Measures real economic activity: the volume of payments that actually settled to the
agent's own address, in the configured asset, as read from the `Transfer` logs of the
transactions the attestations cite. One point per `PAYMENT_FEE_UNIT` of volume. At the
default of 100 USDC per point the 20-point cap lands at 2,000 USDC of settled trade.

```
0 USDC     → 0 pts
500        → 5 pts
1,000      → 10 pts
2,000+     → 20 pts  (maximum)
```

Two things bend that ladder, and they are the point of the factor rather than caveats
on it:

- **Volume decays.** Each payment is weighted `0.5 ^ (age / half-life)` from the moment
  it settled on chain, not the moment its receipt was handed in. At the default 90-day
  half-life, 2,000 USDC of trade a year ago is worth about a sixteenth of that today.
  The cap is a running rate, not a lifetime total.
- **One counterparty can only carry so much.** `PAYMENT_MAX_PER_PAYER` limits any single
  payer to that many points. At the default of 5, reaching 20 needs at least four
  distinct, separately funded payers. A trusted counterparty's cap is raised in
  proportion to its own score, so who pays matters as well as how much.

This is the hardest factor to fake, because faking it means genuinely moving money to
an address you do not control, repeatedly, from wallets that each had to be funded.

### Success Rate (15 pts)

Based on outcomes reported by the parties that paid for the work. An attestation must
carry the settlement transaction of a real payment to the agent, and the attester is
taken from the transfer log rather than asserted by the caller. The oracle aggregates
these per agent, decaying each by age and capping any one payer's contribution.

The formula divides by `total + 5`, not by `total`. Those five pseudo-observations do
two jobs. They stop one lucky job outscoring a long record, because 1/1 and 99/99 are
both a perfect ratio otherwise. And they stop a decayed record holding its marks
forever: a ratio is scale-invariant, so ten successes faded to 0.44 out of 0.44 still
reads 100%, and an agent that stopped working a year ago would keep full points. With
the prior, as decayed weight tends to zero so does the score.

The consequence is that the factor measures rate *and* volume together:

| Observations | at 100% | at 80% | at 50% |
|---|---|---|---|
| 5 | 7 | 6 | 3 |
| 10 | 10 | 8 | 5 |
| 25 | 12 | 10 | 6 |
| 100 | 14 | 11 | 7 |

The full 15 is approached, never reached. These figures assume fresh evidence; decayed
weights are fractional and pull every row down as the record ages.

CounterAudit seals the agent's identity and score into every audited packet, and attests
the outcome of work it audits back to the oracle. Both went live on 19 September. An
outcome must carry the settlement transaction that paid for the work, which the oracle
re-verifies against the chain. See [counteraudit-integration.md](counteraudit-integration.md).

### Tenure (30 pts)

Logarithmic growth curve on the span between an agent's first and most recent verified payment, multiplied by how recent that last payment is.

This used to measure time since registration, and the claim here was that the logarithm prevented idle old agents dominating. It did not. It capped them, but an agent that registered two years ago and never worked still collected the whole factor, which made it the cheapest points in the score: register in bulk, wait a month, collect. Waiting is free.

Three properties follow from measuring trade instead:

- An agent that has never been paid at arm's length scores 0, however long ago it registered.
- Waiting and then making a single payment scores 0 too, because the span starts at first activity. There is no way to bank idle time and convert it in one transaction.
- Tenure fades once the agent stops. Two years of trading abandoned a year ago is worth about one point.

What remains expensive is the thing an attacker cannot shortcut: a long, unbroken record of paid work from independent counterparties, with a bond posted and slashable throughout.

Payments from the agent's own operator never enter the record, so the span is made of arm's-length trade only. When payment verification is off the factor falls back to the old calendar curve.

The curve, applied to the **span between first and last verified payment** — not to
calendar days since registration:

```
Span 1 day      → 3 pts
Span 7 days     → 9 pts
Span 31 days    → 15 pts
Span 90 days    → 19 pts
Span 1 year     → 25 pts
Span 2 years    → 28 pts
Span 1023 days  → 30 pts  (maximum)
```

Formula: `min(30, floor(log₂(spanDays+1) × 3)) × recency`, where `recency` runs from 1
for an agent working today down to 0 for one that has long since stopped. A two-year
span abandoned a year ago is worth about a point.

The multiplier was 4 until 20 September 2026, which capped the factor at day 31. That
made the whole factor reachable with six weeks of wash payments, measured in
`oracle/adversarial.test.js`. Fixing what the factor measures (paid activity rather than
time since registration) was necessary and insufficient: an attacker who must pay for a
month instead of wait for a month is spending gas and floating capital, which is a real
cost, but it is weeks of cost for a factor that claims to represent years.

The factor grew from 20 points to 30 on the same day, taking half the weight released by
cutting fee and success. The amplitude tracks the cap, so the shape did not change: full
marks still arrive at day 1023, they are simply worth more. Elapsed paid activity is one
of only two inputs in the score that cannot be bought at any price, and it was carrying
less weight than the volume figure an attacker can manufacture for the cost of gas.

The trade is a slower ramp for honest agents. Six months of trading is 22 of 30 rather
than the full 30. That is the intended shape: a factor everyone maxes in a month
distinguishes nobody.

### External Trust (25 pts)

Carries in reputation the agent already has under [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004).
An operator links its Sigvara agent to an ERC-8004 identity it owns (`POST /link`), and
the oracle reads that agent's on-chain feedback from the ERC-8004 Reputation Registry,
normalizes the rating dimensions it recognizes, and scales the mean to 25 points.

This factor grew from 15 points to 25 on 20 September 2026, taking the other half of the
weight released by cutting fee and success. It is the only factor in the score that an
attacker cannot manufacture from wallets it controls, because the standing lives in a
registry this protocol does not operate. It is not, however, unbuyable: an attacker
willing to build genuine ERC-8004 reputation can carry it here, and the measurements in
the whitepaper's section 5.4 say what that costs.

This is 0 unless the link is configured and the linked agent has feedback. Feedback
CounterAudit wrote is deliberately excluded from the normalizer, because CounterAudit
already feeds the success factor directly and would otherwise count twice — see
[architecture.md](architecture.md).

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

Network-effect scoring. An agent paid by counterparties that hold **outside** standing,
meaning ERC-8004 reputation capped by their matured total, inherits a fraction of it.
Deliberately not their total Sigvara score: weighting by the total let a farmed number be
inherited, so a wash-traded counterparty vouched for its own ring. It is live; the mechanics,
and the two properties that keep it from being a Sybil amplifier, are in
[Inherited trust](#inherited-trust-5-pts) below.

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

A brand-new agent has **no score at all**, not a low one. Registration leaves it
`PendingBond`, and `proposeReputation` refuses an agent that is not bonded. There is
nothing to read until the operator posts `minimumStake`.

Once bonded, the first epoch gives it:

- Fee Activity: 0 (nothing has paid it)
- Success Rate: 0 (no attestations)
- Tenure: 0 (no span of activity yet — correct, it is new)
- External Trust: 0 unless it links an ERC-8004 identity with existing feedback
- Community: 5 (no flags)
- Propagation: 0 (no counterparties)

**Starting score: 5 points**, the community baseline, and even that is not immediately
spendable: `getTotalScore` matures toward the earned figure at a fixed rate per day.

Climbing from there is deliberately slow, and each factor is slow for its own reason.
Fee Activity needs volume from at least four separately funded payers to reach its cap.
Success Rate approaches 25 only as observations accumulate against the `+5` prior.
Tenure needs a span of paid work that cannot be manufactured in one transaction, since
the clock starts at the first payment rather than at registration. None of the three
can be bought at once, and all three decay if the work stops.

The 90+ range therefore means an agent that has been continuously paid by a diverse set
of counterparties, over months, with a bond posted and slashable throughout, and is
still working today.

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

The reference oracle lives in [`oracle/`](../oracle/) and runs on a configurable
interval (`EPOCH_HOURS`, default 24). Each epoch it scans `AgentRegistered` events in
`LOG_CHUNK_SIZE` blocks at a time (default 2000, with backoff and per-chunk progress
checkpointing so a rate-limited scan resumes instead of restarting), recomputes every
factor, and proposes a score plus a Merkle root over the evidence it used.

It is a single operator today. When `SigvaraReputation.operatorBond` is set — it is on
Arc testnet — that operator must also be admitted and bonded in `SigvaraOracleBond`, so
a bad score costs its proposer something. Finalizing stays permissionless.

State (attestations, flags, links, payment events, spent settlement hashes, scan
progress) is a JSON file written atomically, not an in-memory map, so it survives
restarts.

### What multiple operators will need

Running a second operator today would not produce a second opinion, because the two
would not be looking at the same thing, and a fresh proposal replaces a still-pending
one — so they would race rather than check each other. Three things have to change
first, and the design deliberately aims at the third rather than at consensus:

1. **Shared inputs.** Payment evidence is derivable from chain logs and should be
   scanned rather than submitted. What is genuinely off-chain is the success flag, the
   payer's opinion, and only that needs a shared channel.
2. **Deterministic computation.** Scoring currently reads the wall clock, so two
   operators computing seconds apart can round to different integers. Each epoch needs
   to be anchored to a block timestamp, and the decay arithmetic kept in integers
   rather than floats.
3. **The ability to disagree.** With bonds, a challenge window and the evidence root
   already in place, the cheaper design is one proposer per epoch and every other
   bonded operator recomputing from the committed evidence and challenging a mismatch.
   Operators never have to agree; they have to be able to prove a proposer wrong.

The on-chain storage format does not change for any of this. Only the writer does.

---

## Related

- [Payment-backed attestations](payment-backed-attestations.md) — how evidence is verified, decayed, capped and committed to on chain
- [Ecosystem Overview](ecosystem.md)
- [Quickstart: Register your first agent](quickstart.md)
- [CounterAudit Integration Guide](counteraudit-integration.md)
