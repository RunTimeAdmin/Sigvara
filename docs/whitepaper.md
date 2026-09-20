# Sigvara

**Computed reputation and staked accountability for autonomous agents.**

Version 0.4, 20 September 2026. Live on Arc testnet (chain 5042002). Not yet audited,
not on mainnet.

---

## Abstract

Autonomous agents increasingly transact with each other and with people. Almost nothing
makes an agent's claims about itself costly to falsify. Sigvara makes an agent's history
legible and its dishonesty expensive: an agent registers an on-chain identity, bonds
collateral it can lose, and accumulates a reputation score computed from payments that
actually settled on chain rather than from self-reported outcomes.

Three properties distinguish it from a reputation API. The payer of an attested payment
is read from the transfer log rather than asserted by the caller, so the party with an
incentive to lie is not the party supplying the fact. The score is published with a
Merkle commitment to the payments it was computed from, so a third party can refetch the
leaves, re-verify each payment against the chain, rebuild the root and compare it with
the one the contract holds. And a proposed score sits through a challenge window during
which a slashing committee can reject it, so no single oracle write is trusted
immediately.

This document describes the design, states plainly what must still be trusted, and lists
what is not yet built. Section 10 is a set of commands that check the claims here against
the chain.

---

## 1. The problem

An agent asking to be paid, or asking to be trusted with a task, has a reputation problem
that predates agents: its history is not verifiable by the party deciding. The usual
answers do not transfer well.

**Self-reported history is worthless** when the reporter benefits from the report. An
agent listing its successful jobs is providing marketing, not evidence.

**Platform reputation does not travel.** A five-star rating on one marketplace says
nothing anywhere else, and the marketplace has its own reasons to keep it that way.

**Web-of-trust schemes bootstrap badly.** If an agent's standing derives from other
agents vouching for it, a ring of fresh agents can vouch for each other at no cost, and
a system that grants nothing to anyone until someone has standing never starts.

**Identity without collateral is free to discard.** Any scheme where a bad reputation is
cheaper to abandon than to avoid earning is a scheme that punishes nobody. Sybil identity
is the default state of software.

Sigvara's answer is that reputation should be derived from facts the chain already
records, weighted by capital the agent will lose if it lies, and published in a form a
stranger can recompute.

---

## 2. Design

Five moving parts, in the order an agent encounters them.

```
  register  ->  bond  ->  transact  ->  attest  ->  score  ->  consequence
  identity     staking    (off-chain    oracle     reputation   slashing
  registry     escrow      or on)       verifies   contract     committee
```

### 2.1 Identity

An agent registers with `SigvaraIdentity`, which records an operator address (the wallet
that controls the stake), the agent's own address, an Ed25519 public key, a status and a
registration timestamp.

The identifier is a DID:

```
did:sigvara:<chainId>:<agentAddress>
```

and its hash, used as the key everywhere else, is derived rather than assigned:

```solidity
didHash = keccak256(abi.encodePacked("did:sigvara:", block.chainid, ":", agentAddress))
```

Deriving it means any party can compute an agent's key offline from its address, with no
round trip and nothing to look up. It also means an address maps to exactly one identity
per chain, so an agent cannot quietly hold two.

Registration requires proof of control of the agent key: the operator submits a signature
over a registration digest, so an operator cannot register an address it does not hold.

An agent has four states:

| Status | Meaning |
|---|---|
| `PendingBond` | Registered and visible, below `minimumStake`. Not scoreable, not slashable. |
| `Active` | Bonded at or above the minimum. Scoreable and slashable. |
| `Suspended` | Withdrew below the minimum, or frozen by a pending slash. |
| `Slashed` | Terminal. Score zeroed, cannot be topped back up. |

`PendingBond` exists so that registering is free and meaningless. An agent that has not
bonded has not made a commitment, and the protocol treats it as what it is: an address
that filled in a form.

### 2.2 Stake

`SigvaraStaking` holds the agent's collateral. Only the operator can deposit or withdraw,
and crossing `minimumStake` is what moves a `PendingBond` agent to `Active`.

Withdrawal is a two-step with a 21-day unbonding period. That delay is the point: a
window long enough that an agent cannot misbehave and exit before anyone notices.
Slashing takes the unbonding amount too, so queueing a withdrawal does not protect
capital that is already at risk:

```solidity
uint256 totalSlashed = s.amount + s.unbondingAmount;
```

A slash is proposed by the committee, sits for a 7-day challenge period, and can be
disputed by the operator, which freezes the bond rather than releasing it. On execution
the stake is distributed:

| Share | Destination | Why |
|---|---|---|
| 50% | burned to `0xdead` | Nobody profits from slashing volume. |
| 25% | the victim | The harmed counterparty is made partly whole. |
| 25% | the reporter | Finding misbehaviour has to be worth doing. |

Proceeds are credited and claimed, never pushed, so a recipient that cannot accept a
transfer cannot brick the settlement.

### 2.3 Attestation

An attestation is a claim that an agent did a piece of work and that it went well or
badly. The design problem is that the claimant has an incentive to lie.

Sigvara's answer is that **a positive attestation must be backed by a payment that
settled on chain**, and the oracle reads the payer from the transfer log rather than
believing the submitter:

- The caller supplies a settlement transaction hash.
- The oracle fetches that transaction, confirms it is a transfer to the agent's address
  as recorded in its identity, and takes the payer, amount and timestamp from the log.
- The transaction hash is recorded as spent, so one settlement cannot be presented twice.
- Self-payment is refused, and per-payer contribution is capped.

This inverts the usual trust direction. The party with a motive to exaggerate does not
get to supply the facts, only to point at them. A payment that never happened cannot be
attested, because there is no log to read.

Negative outcomes are different: they need a credential, because an uncredentialed
negative attestation is a free denial-of-service against a competitor. Positive
payment-backed attestations are open to anyone, since the payment is itself the
credential and forging it means forging a chain transfer.

What this does not fix: a payment that settled but which nobody submits. Detecting
unreported work requires an independent watcher of the chain, which Sigvara does not
have.

### 2.4 Reputation

Six factors, capped at 100 in total. Each is bounded so no single input can carry a
score.

| Factor | Max | What it measures |
|---|---|---|
| Fee | 20 | Value actually settled through the agent, age-weighted. Falls back to an attestation-count proxy only when payment verification is off. |
| Success | 15 | Ratio of successful to total outcomes, smoothed by a Bayesian prior so three lucky jobs do not outrank thirty solid ones. |
| Age | 30 | Span between first and last paid activity, multiplied by recency. Not calendar age. An agent that traded for two years and stopped keeps very little. |
| External | 25 | ERC-8004 feedback, for agents that have linked an 8004 identity they demonstrably own. |
| Community | 5 | `max(0, 5 - 2 x flags)`, where flags decay on a half-life rather than lasting forever. |
| Propagation | 5 | Breadth of counterparties that are themselves trusted. One point per fully-scored payer, pro-rated by that payer's score, each counting once however much it pays. |

Two deliberate choices are worth naming.

**Age is tenure, not enrolment.** Registering early and doing nothing earns zero. The
quantity that cannot be shortcut is sustained paid operation, so that is what is measured.

**Propagation uses matured scores.** A counterparty's contribution is computed from its
finalized score, which lags what it has just earned. Two agents paying each other
therefore cannot lift each other inside one epoch, which is the cheapest attack on any
inherited-trust design.

A new agent ramps rather than starting at zero forever, and a slash resets everything.

### 2.5 Consequence

Reputation with no consequence is a leaderboard. The consequence is the bond: an agent
that misbehaves loses capital, and the size of that capital is public, on chain, and
checkable before you transact.

---

## 3. The oracle

The score is computed off chain and published on chain. This is a real trust
concentration and section 5 treats it as one. The design tries to make each individual
write cheap to check and cheap to reverse.

### 3.1 Epochs and the challenge window

Each epoch the oracle gathers signals for every scorable agent, computes the six factors,
and calls:

```solidity
proposeReputation(bytes32 didHash, ReputationData data, bytes32 evidenceRoot)
```

The contract rejects any factor above its cap and refuses to score an unbonded agent. The
proposal then sits for a challenge window, 6 hours on Arc. During it,
`SLASHING_COMMITTEE_ROLE` may reject the proposal outright. After it, **anyone** may call
`finalizeReputation(didHash)` to make the score live.

Finalization is permissionless on purpose. It is mechanical and cannot change the number,
and gating it would let an operator's absence strand every score it had proposed.

`pendingScores` holds one proposal per agent. A second `proposeReputation` overwrites the
first and restarts its window, which is why the oracle skips an agent whose proposal is
still inside its window rather than re-proposing every epoch.

### 3.2 Bonded operators

An oracle cannot propose unless it both holds `ORACLE_ROLE` and is an admitted, bonded
operator in `SigvaraOracleBond`:

```solidity
return op.status == Status.Active && op.bond >= bondAmount;
```

That check is evaluated live, so raising the bond floor immediately stops any operator
that falls below it. Admission is by governance vote, not by posting capital, so the bond
is not the defence against a hostile operator set. Its job is to be something the
committee can take, and `slash()` caps only at the bond itself, so the whole amount is at
risk.

Exit takes 7 days, during which the bond stays slashable.

### 3.3 Checking operators

A second operator that simply also proposed would not produce agreement. With one pending
slot per agent, two proposers produce a race whose loser is discarded silently, and every
overwrite restarts the challenge window and pushes the score further out of the
committee's reach.

So a second operator runs as a **checker**. It recomputes every score independently, from
its own view of the chain, and:

| Pending proposal | Checker does |
|---|---|
| none | proposes, covering a silent primary |
| agrees, window open | nothing |
| agrees, window elapsed | finalizes |
| **disagrees** | **records a divergence and touches nothing** |

It never finalizes or overwrites a score it disputes, because finalizing would launder a
number it was run to question and overwriting would buy that number another window beyond
the committee's reach. Divergences are published at `GET /divergence`, unauthenticated,
because the point of a second operator is that its disagreements are visible to someone
other than its own operator.

The committee has always held the power to reject a bad proposal. What it has never had
is anything telling it when to look. That signal is what a checker produces.

Comparison fails closed: any value that cannot be compared, whether an unparseable
tolerance or a factor that did not decode, is treated as a divergence rather than as
agreement.

---

## 4. Evidence

A score is a number. Without the inputs, it is a number you take on faith.

Each proposal carries an `evidenceRoot`, a Merkle commitment over the payment events the
score was computed from. The oracle serves the leaves and proofs at
`GET /evidence/:didHash`, unauthenticated. A verifier can:

1. Fetch the leaves.
2. Re-verify each settlement transaction directly against the chain.
3. Rebuild the root.
4. Compare it with the root the reputation contract holds.

A commitment only its author can open is not a commitment to anyone else, which is why
the endpoint needs no token.

The response states exactly what the root covers:

```json
"committedFields": ["txHash", "payer", "amount", "settledAt", "success"]
```

Anything outside that list is corroboration, not evidence. A CounterAudit packet id, when
an attestation carried one, is returned as `counterauditPacketId` and is deliberately not
in the leaf: committing to it would change the leaf format and make every root already
published unreproducible, for a field the verifier confirms against CounterAudit
independently anyway.

---

## 5. Trust model

The honest section. A protocol that hides this is asking to be taken on faith, which is
the thing it claims to replace.

### 5.1 What you must trust today

- **The oracle operator.** The score is computed off chain. The chain stores the result
  and a commitment to the inputs, not the computation. A dishonest operator can propose a
  wrong score, and the defences are the challenge window, the committee, and the
  evidence root being publicly checkable. Checker mode is designed and tested but not yet
  deployed with a second operator.
- **The slashing committee.** It can reject any pending proposal and propose slashes. On
  testnet it is a single EOA. On mainnet it must be a multisig, and that is a stated
  precondition for mainnet, not an aspiration.
- **`DEFAULT_ADMIN_ROLE`.** It admits operators, sets `minimumStake`, `bondAmount` and
  the challenge window, and can upgrade the UUPS proxies.

### 5.2 What you need not trust

- **That a payment happened.** Attested payments are read from transfer logs. You can
  refetch every one.
- **That the score matches its inputs.** Fetch the evidence, rebuild the root, compare.
- **That a proposal is final.** It is not, for the length of the challenge window.
- **That the oracle is bonded.** `isActiveOperator` is a public view.
- **That an agent is collateralised.** `getStake` and `hasMinimumStake` are public views.

### 5.3 What a fake score costs

Every claim above is about what the protocol does when used as intended. This one is
about what it does against someone buying a number, which is a different question and
has a measured answer.

The defences assume payers are a cost. In a wash ring they are not: an attacker paying
its own agent from its own wallets is floating capital, not spending it. The money comes
back. What it spends is gas and patience.

`oracle/adversarial.test.js` feeds attacker-crafted payment sets through the real
scoring pipeline, assembled exactly as the oracle assembles it each epoch. Measured, for
a ring active over roughly six weeks:

| Sybil wallets | Fee | Success | Tenure | Community | **Total** |
|---|---|---|---|---|---|
| 1 | 5 | 7 | 16 | 5 | **33** |
| 3 | 15 | 11 | 16 | 5 | **47** |
| 6 | 20 | 12 | 16 | 5 | **53** |
| 20 | 20 | 14 | 16 | 5 | **55** |

Four wallets now saturate the fee factor, because `maxPerPayer` caps any single
counterparty at 5 points and the factor is worth 20. Beyond that, more wallets buy
almost nothing. If the sybils are themselves scored agents this changes nothing: the
web-of-trust weighting reads their **hard** standing, meaning ERC-8004 reputation capped
by the matured total, so a counterparty that farmed its own score to 100 is worth exactly
what an anonymous wallet is worth. Reaching 59 requires counterparties with genuine
outside standing, which is the one input an attacker cannot manufacture.

**What holds.** The per-payer cap binds, and splitting one wallet's volume across
hundreds of dust payments does not defeat it. A ring of zero-scored agents grants its
members nothing, so the web of trust cannot bootstrap from nothing. The Bayesian prior
stops a handful of perfect outcomes outranking a sustained record. An abandoned farm
decays from 53 to 10 over 400 days, so a bought score does not sit. A credentialed
flagger can take exactly 5 points, not the score.

**What does not.** Four of the six factors are farmable by a single party with enough
wallets, and tenure is farmable by one with enough patience. Only `externalScore`
resists structurally, because it requires standing in ERC-8004, a system the attacker
does not control. That puts the practical ceiling for a self-contained farm near 55 and
the honest ceiling near 89.

An attacker willing to buy outside standing is a different matter, and the weights do
not stop one. A ring that acquires a full ERC-8004 identity reaches the high seventies
under every weighting that was measured, including the two rejected ones. Weighting
bounds cheap attacks. Only a slashing path that actually executes bounds expensive ones,
and Sigvara's has been rehearsed against a fork but never run on the live chain. Until
it has, treat the numbers above as the cost of a *cheap* forgery, not of any forgery.

**This measurement changed the protocol, twice.** Tenure previously reached its cap at
day 31, which handed the entire factor to six weeks of wash payments and made the same
ring score **76**. The curve now reaches its cap at roughly 2.8 years, matching what the
factor was always documented to represent. That took the ring to 66.

The weights then followed. Fee and success were 30 and 25, so 55 of the 100 points rested
on the two inputs a ring manufactures for the price of gas. They are now 20 and 15, and
the 20 points released went to tenure (20 to 30) and external trust (15 to 25), the two
factors that cannot be bought with wallets. That took the ring from 66 to **55** and an
honest agent with outside standing from 91 to 89, which is the trade: nine points off the
forgery for two off the genuine article.

A bond-coverage factor was designed, implemented and measured as the alternative, and
rejected. It scored the agent on how much stake stood behind its volume, which reads well
until you notice that a bond is only a cost if it is slashed. Against a funded attacker it
inverted the ranking outright: the ring bought the factor and finished two points **above**
the best honest agent. The implementation is in the history at `17fe5cf`, reverted in
`6524e3a`, kept because the measurement is worth more than the code.

**What this means for consumers.** `meetsThreshold(didHash, 50)` distinguishes nothing:
a six-wallet ring clears it in weeks. Thresholds only begin carrying information above
roughly 60, and they do so mainly because the remaining points require an outside
identity and years of continuous paid activity. Note what that does not say: a score of
80 is not proof of honesty, only proof that forging it was expensive. Anyone gating a
real decision on a Sigvara score should read this paragraph before choosing a number.

The tables above are printed by the test suite on every run, so they stay current rather
than becoming a claim in a document that quietly stops being true.

### 5.4 Known weaknesses

Stated because they are true, not because they are solved.

1. **One oracle operator.** The concentration this creates is the protocol's largest
   open weakness. Checker mode exists to reduce it; a second operator is not yet running.
2. **Agreement is not enforced on chain.** Even with a checker, nothing in the contract
   requires two operators to agree. A human committee must act on the divergence. Making
   agreement a protocol guarantee needs N-of-M on `pendingScores` and a UUPS upgrade.
3. **The checker can rarely overwrite.** It re-reads the pending slot immediately before
   writing, which narrows the race to one round trip but does not close it.
   `proposeReputation` has no compare-and-swap. A `proposeIfEmpty` variant would close it.
4. **No slash has been executed in public.** The mechanism is tested; it has not been
   exercised against a real agent where anyone could watch.
5. **No external audit.** A precondition for mainnet.
6. **Unreported work is invisible.** Payment verification detects a fabricated or altered
   payment. It cannot detect a real payment nobody submitted. That needs an independent
   chain watcher.
7. **Common ownership in the integration loop.** CounterAudit both consumes the score and
   writes attestations into it, and both are operated by the same party. This is
   disclosed rather than hidden, and a second independent operator is the fix.
8. **`rewardPool` is a plain address.** `distributeFees()` sends the non-burned share
   there, and the onward spend is manual rather than a protocol path.

---

## 6. The token

SVR is the bond and fee asset. It is not a governance token and it is not a claim on
revenue.

**Supply** is 1,000,000,000, fixed at creation. The contract is a plain ERC-20 with no
owner, no mint, no pause, no blacklist and no transfer tax.

**Distribution** has no team allocation, no treasury allocation, no vesting and no sale.
The whole supply enters the liquidity pool at launch. Every position the team holds is
bought on the open market and published with its amount, transaction and purpose.

**The treasury** is funded by buybacks from the creator share of pool fees and by
disclosed open-market purchases. Treasury SVR is spent only on oracle bonds, operator
incentives, slashing-committee costs and staking rewards.

**Staking rewards** are not live and cannot pay out before the mainnet registries exist.
When they do, eligibility is limited to `Active` bonded agents and admitted operators
with no slash in the period, funded from treasury SVR rather than emission, capped per
quarter, and published before the period they apply to. Holding SVR earns nothing.
Providing liquidity earns nothing. The reward is for bonded, slashable service.

**Parameters** at mainnet initialization:

| Parameter | Testnet (on chain today) | Mainnet | Share of supply |
|---|---|---|---|
| `bondAmount` | 25,000 SVR | 2,500,000 SVR | 0.25% |
| `minimumStake` | 1,000 SVR | 10,000 SVR | 0.001% |
| `epochFee` | 0 (registry not deployed) | 0 at launch | n/a |

The testnet bond was raised from 1,000 to 25,000 on 20 September 2026. The faucet mints
10,000 per address per day, so a 1,000 bond was a tenth of one free claim and bonded
nothing. Section 10 shows how to check every figure here against the chain.

Both are denominated in SVR rather than pegged to a currency. A bond fixed in SVR tracks
the payoff from attacking the protocol, because both follow the same value. Governance
reviews them when a single attested settlement exceeds 20% of the bond's market value,
when active agents pass 250, or when SVR's 30-day average moves threefold, and at minimum
every two quarters.

The testnet token is a separate contract with a public faucet. It carries the SVR name
and symbol, anyone can mint it, it is worth nothing, and it is not the token. Full detail
in [token.md](token.md).

---

## 7. Current state

Live on Arc testnet, chain 5042002, where USDC is the native gas asset.

| Contract | Address |
|---|---|
| `SigvaraIdentity` | `0x7e3aFC532eE5d922ab3cc3FFb510c7C8151477Dd` |
| `SigvaraReputation` | `0x6603C96275e85F724Cdf74666b399365e4cA29ed` |
| `SigvaraStaking` | `0xA69d62B2a6774D21A2c15d5d83b27277eD31d35B` |
| `SigvaraOracleBond` | `0x3c9c12F27DDCa7048840eE3fbF0CAa1C547D8171` |
| testnet `SVRToken` | `0x41De2D6D55318e197a00E8f5B496eA2790e23E6c` |

All are UUPS proxies except the token.

**Running:** hourly oracle epochs proposing and finalizing scores; payment-verified
attestations with evidence roots; public unauthenticated reads at `/health`, `/score`,
`/evidence`; third-party `POST /attest` for positive payment-backed outcomes; flag
raising and resolution with half-life decay; a two-way integration with CounterAudit that
both enriches audit packets with Sigvara identity and reports settlement outcomes back.

**Built and tested, not yet deployed:** checker mode, awaiting a second bonded operator,
and the divergence watcher that consumes its output. Both are blocked on the same thing.

**Not deployed:** `SigvaraEpochFees`. Scoring on Arc testnet is free and nothing is
charged. The app disables every fee control rather than pointing at an address with no
code.

**Test coverage**, all passing: 246 contract tests across 12 Foundry suites including
fuzz and invariant tests, 266 oracle tests, 58 SDK tests. CI runs Foundry, the oracle and
SDK suites, and Slither static analysis on every push, plus a documentation check that
fails when the site states something the contracts do not.

---

## 8. Roadmap

Ordered by what unblocks what, not by difficulty.

1. **A second bonded operator in checker mode.** The only item that reduces the
   concentration in 5.4. Runbook written, contracts ready.
2. **A public slash.** *In progress.* Filed on Arc testnet on 20 September 2026 against a
   throwaway agent registered for the purpose, and now sitting in its seven-day challenge
   window; it settles on 27 September. Filing suspended the agent and froze its bond
   without moving anything, and early execution was refused with `ChallengePeriodActive`
   carrying the deadline snapshotted at filing. The running account is
   [slash-drill-log.md](slash-drill-log.md); the procedure is
   [slash-drill.md](slash-drill.md); the rehearsal is `test/SlashDrillFork.t.sol` (6 cases
   against a fork of the live deployment).

   The log states its own limits and they are worth repeating here: the target scored 0,
   so this cannot demonstrate reputation being destroyed; reporter, operator and victim
   are all addresses one party controls, so it demonstrates a mechanism and not a
   governance decision. Until it settles, the consequence side of the protocol is still
   theory. After it settles, it is a demonstration, not a proof.
3. ~~**A divergence watcher.**~~ Built. Polls a checker's `/divergence`, re-verifies
   each disagreement against the live slot, and alerts the committee while rejection is
   still possible, escalating as the window closes. Treats a silent checker as an alert
   rather than as quiet. Holds no key. Waiting on item 1, since there is no checker to
   watch until a second operator runs.
4. **`proposeIfEmpty`.** Closes the checker's remaining overwrite race properly.
5. **A reward distributor.** Replaces `rewardPool` as a plain address with a contract
   paying operators for epochs served.
6. **External audit**, then Arc mainnet with a committee multisig.

---

## 9. Related work

**ERC-8004** defines identity and reputation registries for agents. Sigvara consumes it
rather than competing: an agent that links an 8004 identity it demonstrably owns earns up
to 15 of its 100 points from 8004 feedback. The remaining 85 come from facts Sigvara
verifies itself.

**Bonding and escrow protocols** secure a specific transaction with collateral posted for
that transaction. Sigvara's stake is persistent rather than per-deal, which is what lets
history accumulate against it, and the two compose: an escrow can require a Sigvara score
before releasing.

**Platform ratings** are richer but do not travel, cannot be recomputed by the reader,
and are controlled by a party with its own interests.

**Attestation frameworks** provide signed statements. The gap they leave is that a signed
statement is only as good as the signer's incentive to be honest. Sigvara's contribution
is tying the statement to a settled payment and the signer to slashable capital.

---

## 10. Verifying these claims

Every number above is readable from the chain. `cast` is from Foundry.

```bash
export ARC=https://rpc.testnet.arc.io
export REP=0x6603C96275e85F724Cdf74666b399365e4cA29ed
export STK=0xA69d62B2a6774D21A2c15d5d83b27277eD31d35B
export BOND=0x3c9c12F27DDCa7048840eE3fbF0CAa1C547D8171

# Parameters this paper asserts
cast call $REP "challengeWindow()(uint256)"  --rpc-url $ARC   # 21600 (6h)
cast call $STK "minimumStake()(uint256)"     --rpc-url $ARC
cast call $STK "unbondingPeriod()(uint256)"  --rpc-url $ARC   # 1814400 (21d)
cast call $BOND "bondAmount()(uint256)"      --rpc-url $ARC
cast call $BOND "activeCount()(uint256)"     --rpc-url $ARC   # operators bonded today
```

Pick any agent and check the whole chain of reasoning behind its score:

```bash
DID=0x8414ce0bf4f1e1695193623e0a656a9439e356f8bed0b8bf249b179fe77c7e19

cast call $REP "getTotalScore(bytes32)(uint8)" $DID --rpc-url $ARC
cast call $STK "getStake(bytes32)(uint256)"    $DID --rpc-url $ARC

curl -s https://oracle.sigvara.xyz/score/$DID      # the factors, recomputed live
curl -s https://oracle.sigvara.xyz/evidence/$DID   # the payments, with proofs
```

The evidence response gives you every settlement transaction hash behind the score.
Fetch each from the chain, confirm the payer and amount match, rebuild the Merkle root
from the leaves, and compare it with the `evidenceRoot` the contract holds. If they
differ, the oracle is lying and you can prove it.

That last sentence is the whole design, compressed.

---

## Related documents

- [architecture.md](architecture.md) — signal topology
- [reputation-model.md](reputation-model.md) — the six factors in detail
- [payment-backed-attestations.md](payment-backed-attestations.md) — verification design
- [token.md](token.md) — supply, treasury, staking rewards
- [arc.md](arc.md) — deployment and operations
- [ecosystem.md](ecosystem.md) — how Sigvara sits alongside CounterAudit
- [lineage.md](lineage.md) — the Robinhood Chain testnet run this came from
