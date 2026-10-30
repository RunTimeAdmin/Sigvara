# Reputation Model

Sigvara reputation is a deterministic 6-factor score between 0 and 100. It is computed off-chain by the oracle network and written to the `SigvaraReputation` contract every epoch. The contract stores and serves the score; it does not compute it. This separation means the scoring logic can evolve without storage migrations.

---

## The Six Factors

| Factor | Max Points | Source | Formula |
|---|---|---|---|
| Fee Activity | 20 | Settled payments to the agent, verified on chain | `min(20, decayedVolume / PAYMENT_FEE_UNIT)`, capped per payer |
| Success Rate | 15 | Outcome reported by a credentialed service (CounterAudit, whose relay is off today) | `floor(successful / (total + 5) × 15)`, on decayed weights |
| Tenure | 30 | Span of verified trading, faded by how long since the last of it | `min(30, floor(log₂(spanDays+1) × 3)) × recency` |
| External Trust | 25 | Normalized ERC-8004 feedback for a linked agent | mean of recognized rating tags × 25 |
| Community | 5 | Unresolved flags | `max(0, 5 − flags × 2)` |
| Trust Propagation | 5 | Standing of the counterparties that paid the agent | 1 pt per fully-trusted counterparty, pro-rated by its external standing |

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
  payer to that many points. At the default of 4, reaching 20 needs at least five
  distinct, separately funded payers. A trusted counterparty's cap is raised in
  proportion to its own external standing, so who pays matters as well as how much.

This is the hardest factor to fake, because faking it means genuinely moving money to
an address you do not control, repeatedly, from wallets that each had to be funded.

### Success Rate (15 pts)

Based on outcomes reported by credentialed services, such as CounterAudit, which relays
the outcome an org reports with the sealed record of the work. An attestation must
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

CounterAudit seals the agent's identity and score into every audited packet, live since
19 September. It can also relay an org's reported outcome back to the oracle; that went
live the same day, but since 30 October 2026 the production deployment relays for no org,
and no outcome has been recorded since 20 September. An
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
the whitepaper's section 5.3 say what that costs.

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

Flags decay on a half-life (30 days by default, `FLAG_HALF_LIFE_DAYS`), so the table is for fresh flags. A flag one half-life old counts as half a flag and costs one point, not two.

Flags are raised by credentialed services, such as watchdog scanners, through `POST /flag` (separate from slashing). Slashing is economic; flags are reputational.

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

A counterparty's evidence cap rises with its own external standing. At the default weight, a
counterparty with full external standing contributes twice what an anonymous wallet can, while
the cap on any single payer still holds.

The propagation factor is one point per fully trusted counterparty, pro-rated by
external standing, capped at five. Five counterparties with full standing reach the cap, and so
do ten with half. Each counterparty counts once however much it pays: this factor
measures the breadth of who will vouch for an agent, not the size of the cheques.

Two properties make it worth having rather than dangerous.

**It cannot be bootstrapped.** A ring of fresh identities all score zero and so grant
each other nothing. Collusion has to start from real standing rather than manufacture
it.

**Only the external part of a counterparty's score is inherited**, and this is
stronger than it first reads. What propagates is `min(externalScore, matured total)`,
not the total. A counterparty with an excellent fee, success and tenure score and no
ERC-8004 standing vouches for **nothing at all**.

The reason is that everything except `externalScore` can be manufactured by the party
being scored. Inheriting a total let a farmed score launder into someone else's: a
Sybil that wash-traded its way to 100 both raised its target's per-payer cap and
counted as a fully trusted voucher, measured as scored Sybils maxing the fee factor
with four payers instead of six. `externalScore` is the one factor a single party
cannot mint, because it is standing in a registry this protocol does not control.

**The network-level consequence.** Propagation is therefore gated on ERC-8004 adoption,
not on Sigvara activity. Until counterparties hold external standing, this factor is 0
for every agent however many people pay it, and the 25 external points and the 5
propagation points are one dependency rather than two independent gaps. On a network
with no linked agents the reachable ceiling is 70 of 100, which is the number to set a
threshold against. That is the design working as intended, not a defect, but it is not
visible from either call site and is easy to mistake for a bug.

**It is damped against reflexivity.** The matured total caps what is inherited, and
maturity lags what has just been earned, so a reciprocal pair cannot lift each other
inside one epoch and a linked 8004 history cannot be propagated the same epoch it is
linked. An unknown counterparty reads as zero, because no evidence of standing is the
same thing as far as granting a bonus goes. A node that cannot answer is retried, and if
it still fails the agent is skipped for that epoch: a failed read says nothing about the
counterparty, and scoring on it would lower the proposal for the wrong reason.

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

The restart does not depend on how mature the score was or on what the oracle did last.
A score that has fully matured, one the oracle has just finalized again, and one that has
fallen below what had been released all start the buyer at zero. A transfer accepted in
the same second as a finalize counts as a transfer after it: Arc timestamps have one
second granularity, and consecutive blocks can share one.

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
Fee Activity needs volume from at least five separately funded payers to reach its cap.
Success Rate approaches 15 only as observations accumulate against the `+5` prior.
Tenure needs a span of paid work that cannot be manufactured in one transaction, since
the clock starts at the first payment rather than at registration. None of the three
can be bought at once, and all three decay if the work stops.

The 90+ range therefore means an agent that has been continuously paid by a diverse set
of counterparties, over months, with a bond posted and slashable throughout, and is
still working today.

---

## Slashing Resets Everything

When an agent is slashed:

1. When a slash settles, through `SigvaraStaking.executeSlash()` after an undisputed challenge period or through
   the admin upholding a disputed one with `resolveDispute`, the staking contract calls
   `SigvaraReputation.zeroReputation(didHash)`
2. All six factor scores are set to zero
3. The agent's status is set to `Slashed` (terminal — no further transitions)
4. The stake is distributed: 50% burned, 25% to victim, 25% to reporter

The slashed DID cannot be reactivated. The operator must register a new agent address with a new DID and start from zero. This economic finality is what makes the reputation meaningful — reputation can be destroyed, so it is worth protecting.

---

## On-Chain Consumption

Any smart contract can gate on reputation. The interfaces are in
[`src/interfaces/ISigvara.sol`](../src/interfaces/ISigvara.sol):

```solidity
// Inside your contract
import {ISigvaraReader} from "sigvara/src/interfaces/ISigvara.sol";

function requireTrusted(address agent) internal view {
    require(
        ISigvaraReader(READER).isTrusted(agent, 40),
        "Agent is not in good standing at the minimum score"
    );
}
```

`SigvaraReputation.meetsThreshold(didHash, n)` compares the spendable score with `n` and
nothing else. It does not look at the agent's status, so a suspended agent passes it, and at
`n = 0` so does an address that was never registered. Nor does it look at the bond, so an
agent that holds less than a raised minimum stake passes it. `isTrusted` adds the status
check and the current bond. The [integration guide](integration.md) has the rest.

To read the score itself:

```solidity
uint8 score = ISigvaraReputation(REPUTATION_ADDRESS).getTotalScore(didHash);
```

---

## Oracle Epochs

The reference oracle lives in [`oracle/`](../oracle/) and runs on a configurable
interval (`EPOCH_HOURS`, default 24). Each epoch it scans `AgentRegistered` events in
`LOG_CHUNK_SIZE` blocks at a time (default 2000, with backoff and per-chunk progress
checkpointing so a rate-limited scan resumes instead of restarting), recomputes every
factor, and proposes a score plus a Merkle root over the evidence it used.

Two bonded operators run today, and in normal running only one of them proposes. When
`SigvaraReputation.operatorBond` is set — it is on Arc testnet — a proposer must also be
admitted and bonded in `SigvaraOracleBond`, so a bad score costs its proposer something.
Anyone may finalize, but not a proposal whose proposer has since been removed.

The second runs in checker mode: it recomputes each pending score independently and
records disagreement rather than competing for the slot, because two operators writing to
one `pendingScores` entry would produce a race and not agreement. Nothing on chain
requires them to agree, so a human committee acts on a divergence inside the challenge
window. See [architecture.md](architecture.md) for the topology.

State (attestations, flags, links, payment events, spent settlement hashes, scan
progress) is a JSON file written atomically, not an in-memory map, so it survives
restarts.

### What multiple operators needed

A second operator that proposed alongside the first would not have produced a second
opinion, because the two would not be looking at the same thing, and a fresh proposal
replaces a still-pending one, so they would race rather than check each other. Three
things had to change, and the design deliberately aims at the third rather than at
consensus:

1. **Shared inputs.** Done. Payment evidence is derivable from chain logs, so each
   operator scans for it itself ([ADR 0003](adr/0003-evidence-intake.md), enabled on both
   since 3 October 2026) instead of waiting to be told. What is genuinely off-chain is
   the outcome of the work, and only that needs a shared channel.
2. **Deterministic computation.** Half done, and the other half is currently paid for
   with a tolerance rather than fixed.

   Each epoch is anchored to a block timestamp rather than the host's wall clock, and a
   checker re-measures a pending proposal at that proposal's own `proposedAt` before
   comparing, so a disagreement means the evidence differed rather than the two epochs
   running minutes apart.

   The arithmetic is still floats. `0.5 ^ (age / halfLife)` on two runtimes can land
   either side of an integer boundary from identical inputs, so two honest operators can
   differ by a point. `DIVERGENCE_TOLERANCE`, default 3, absorbs that.

   **State the cost plainly: the same tolerance absorbs real disagreements up to 3
   points.** A primary understating a score by two points is invisible to the checker.
   That is an accepted trade today because float drift would otherwise make the checker
   cry wolf on every agent, and a checker nobody believes is worse than a loose one. It
   is not the end state. Fixed-point decay would let the tolerance go to zero, at which
   point any disagreement at all is a finding — and that, not the tolerance, is what makes
   a second operator load-bearing rather than advisory.
3. **The ability to disagree.** With bonds, a challenge window and the evidence root
   already in place, the cheaper design is one proposer per epoch and every other
   bonded operator recomputing from the committed evidence and challenging a mismatch.
   Operators never have to agree; they have to be able to prove a proposer wrong.

The on-chain storage format does not change for any of this. Only the writer does.

---

## Recomputing a score

A score cannot be recomputed from raw ERC-8004 feedback and the weights alone. ERC-8004
feedback drives one factor, External Trust, worth at most 25 of the 100 points. The other
five factors are computed from inputs ERC-8004 does not hold:

| Factor | Computed from | Where a third party can read it |
|---|---|---|
| Fee Activity (20) | ERC-20 payments to the agent's address, decayed and capped per payer | On chain. The payments the oracle counted are listed at `GET /evidence/:didHash` and committed to by the on-chain evidence root (`verifyEvidence`). |
| Tenure (30) | First and last paid activity in the same payment log | Same as above: `settledAt` is a committed field. |
| Success Rate (15) | Outcomes reported with `POST /attest` | Oracle state. The `success` field is committed in each evidence leaf, so it cannot be changed after the root is on chain, but the outcome itself is not on chain anywhere. A payment found by the chain scan carries `null` and is kept out of the ratio. |
| External Trust (25) | ERC-8004 feedback for the linked agent | The feedback is on chain. The link from Sigvara agent to ERC-8004 agent id is oracle state, set with `POST /link` and returned as `erc8004AgentId` by `GET /score/:didHash`. |
| Community (5) | Flags raised with `POST /flag`, decayed | Oracle state only. |
| Trust Propagation (5) | Payers' own external standing, capped by their matured totals | On chain, through `SigvaraReputation`, for payers that are Sigvara agents. |

The External Trust factor on its own is recomputable from public reads, given the linked
agent id. `oracle/external.js` does exactly this:

1. Score 0 unless `ownerOf(agentId)` on the ERC-8004 Identity Registry is the Sigvara
   agent's operator. Ownership is re-checked every time the score is computed.
2. For each client in `getClients(agentId)`, read feedback indexes 1 to
   `getLastIndex(agentId, client)` with `readFeedback`, skipping revoked entries.
3. Take `value / 10^valueDecimals` and the lowercased `tag1`. Keep only recognized tags:
   `quality`, `trustscore`, `reliability`, `accuracy` and `credit` are divided by 100,
   `win-rate` is used as is, and `rating`, `e2e-test` and `stars` are divided by 5. Each
   is clamped to 0..1. Every other tag is ignored.
4. The factor is the mean of the kept ratings times 25, rounded. No recognized feedback
   gives 0.

The factor caps are in `oracle/score-caps.js`, the curves in `oracle/scoring.js` and the
decay parameters in `oracle/payments.js`. When
payment verification is on, `GET /score/:didHash` also returns the half-life, per-payer cap
and trust weight the operator is running with.

So the trust model is not "recompute it yourself". The oracle proposes, and
`proposeReputation` opens a challenge window during which the slashing committee can
reject the proposal; when `operatorBond` is set the proposer must be a bonded, admitted
operator. A checker operator recomputes each pending score independently and records any
disagreement (see [Oracle Epochs](#oracle-epochs)).

Slashes are on-chain records. `SigvaraStaking` stores each proposal (reporter, victim,
evidence hash, challenge deadline, state), readable with `getSlashProposal`, and emits
`SlashInitiated`, `SlashDisputed`, `SlashCancelled` and `SlashExecuted` (amounts burned,
to the victim and to the reporter). An executed slash also marks the identity `Slashed`
and zeroes its score, emitting `ReputationZeroed`. A slash of an oracle operator's bond
emits `OperatorSlashed` from `SigvaraOracleBond`.

---

## Related

- [Payment-backed attestations](payment-backed-attestations.md) — how evidence is verified, decayed, capped and committed to on chain
- [Ecosystem Overview](ecosystem.md)
- [Quickstart: Register your first agent](quickstart.md)
- [CounterAudit Integration Guide](counteraudit-integration.md)
