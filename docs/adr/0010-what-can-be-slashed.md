# ADR 0010: What can be slashed

**Status:** Accepted · 2026-11-06, with David's decisions below. This is policy: no contract or oracle
code changes with it. It adds one use to the treasury policy in `docs/token.md`.

## Context

`SigvaraStaking.initiateSlash` takes any `evidenceHash` bytes from the slashing committee, and
`SigvaraOracleBond.slash` takes an amount from `SLASHER_ROLE`. Neither says what a slash is for, and
until now no document did. The whitepaper says misbehaviour costs capital without saying what counts.

The two penalties are not alike:

- **An agent slash has one size.** It takes the whole stake and any queued withdrawal, zeroes the score
  and ends the DID for good. Filing it suspends the agent at once.
- **An operator slash is partial and immediate.** There is no challenge window in the contract.

So an operator of an agent cannot tell what it can lose its stake for, a committee has no rule to be held
to, and "the probability a violation is slashed" means nothing, because no violation is defined.

## Decision

### 1. What any ground has to meet

1. A stranger must be able to check the evidence without trusting the committee, from chain data or
   signatures.
2. An agent slash is final, so it is only for deliberate wrongdoing. Everything else uses the lesser
   tools: a rejected proposal, a flag, a payer's outcome, or nothing.
3. This list is published before mainnet and applies only to conduct after that.

### 2. Agent violations

| ID | Violation | What proves it |
|---|---|---|
| A1 | **Theft.** Moving a counterparty's funds beyond what it signed for. | The signed authorization, and the transaction that exceeds it. |
| A2 | **Closed-loop wash trading.** At least half of the payment volume counted toward the score in the last 90 days came from wallets the agent or its operator funded first, or that sent the money back within 7 days. | The on-chain trail between the agent or operator and the payer. "Funded first" means within two hops, the same `FUNDER_HOPS` the reviewer check uses. |
| A3 | **Non-delivery.** Paid and neither delivered nor refunded: 3 independent payers in 30 days, or one unrefunded loss of at least 25% of the bond. | Payer-signed claims tied to settled payments, a deadline in signed terms, and no delivery proof from the agent during the challenge period. Payers are independent when they share no funder within two hops. |
| A4 | **Forged proof.** Submitting a forged signature or delivery record to the protocol, an oracle or a dispute, under the agent's own key. | The signature or hash fails to verify, and the submission is signed by the agent. |

A refund before the ruling cures A3, and only A3. Returning stolen funds once caught does not undo A1.

A2 asks for a closed loop, not a common funder. Public faucets fund many unrelated wallets, so a shared
funder proves nothing. The 50% bar stops ordinary refunds from tripping it.

A3 cannot be used yet. Payer negatives are paused until the challenge process exists
([ADR 0006](0006-payer-signed-outcomes.md)).

### 3. Operator violations

The first response to either is `rejectReputation`, inside the challenge window.

| ID | Violation | What proves it | Slash |
|---|---|---|---|
| O1 | **Fabricated evidence.** A committed root holds a payment that does not exist, or does not pay that agent that amount. | The evidence leaf, its proof against the root, and the chain. | The whole bond. |
| O2 | **A score its own evidence does not produce.** Replaying the operator's published evidence, at its commit and block, gives a total outside the divergence tolerance (3 by default). | The replay, published so anyone can run it. | 10% for a first offence, the whole bond if repeated within 90 days. |

Disagreement between operators proves nothing by itself, since live operators differ within an hour
through timing. Only a replay counts.

The contract gives an operator no window, so policy does: three days' public notice before any
`slash()`. An operator's exit takes seven days and the bond stays slashable throughout, so notice does not
let it leave first.

### 4. What is not slashable

- Running many agents, or a Sybil fleet that commits nothing above. Payer caps, tenure and maturity deal
  with that.
- A common funder, a graph pattern or a flag on its own. Flags stay reputational.
- Poor quality, late or malformed delivery, an outage or an honest bug. These go through outcomes and the
  score, once negatives are on.
- A duplicate charge. That is a refund matter, recorded as evidence.
- A payer's claim with no settled payment behind it.
- For operators: downtime, late proposals, or disagreement explained by timing. The answer to those is no
  reward, not a slash.
- Anything off protocol: speech, token price, governance votes, or a legal dispute with no protocol
  evidence.

### 5. Who receives the victim's 25%

The contract takes one address, and it cannot be zero, the reporter, a committee member or the admin.

- One payer harmed: that payer.
- Several payers under A3: the largest unrefunded payer. The others receive nothing from the slash.
- Nobody harmed, as under A2: name `0xdead`. The credit then stays locked in `claimable`. That is not a
  burn, as `_settleSlash` says of crediting that address, but nobody can spend it.
- Never an address under the agent's control. An agent will not dispute a slash that pays itself, so this
  check falls on the committee and the admin's veto.

### 6. Evidence

`evidenceHash` is free-form, so no contract change is needed. The bytes read
`sigvara/slash/v1;ground=A1;sha256=<hash of the package>`, and the package is published when the slash is
filed, as the drill's log was.

### 7. Wrongful slashes and stolen keys

- **Before execution,** the dispute, the veto and the expiry already exist
  ([ADR 0005](0005-governance-and-emergency-powers.md)). Nothing compensates the time spent suspended.
- **After execution, a slash can be repaid but not undone.** The status is terminal, the score is zero and
  75% is burned, and the contract has no way back. The admin may publish a finding that the slash was wrong,
  naming the slash and the evidence, and [the treasury policy](../token.md#treasury-policy) then lets treasury
  SVR return what the slash took to the operator who lost it. The victim keeps its 25%, and an agent's
  operator starts a new DID from zero. Repayment is not owed. It is limited to what the treasury holds, which
  is nothing until buybacks start, and it never goes to a team-operated agent or oracle operator, because the
  finding is a judgment and this cannot be a payment the team directs to itself.
- **Stolen keys:** an operator answers for its keys, as the whitepaper says of signers. A prompt
  self-report with evidence lets the committee decline to file, and nothing guarantees that it will.

## Consequences

- **A Sybil fleet that breaks none of these rules is not slashable, on purpose.** The bond costs it capital
  and nothing more, and scoring has to do the rest. This matches the whitepaper's warning that a score
  of 80 is proof that forging it was expensive, not proof of honesty.
- **A2 does not catch every ring.** It catches a ring that leaves its trail on chain, and raises the cost of
  hiding one. It is the only ground that needs no report. No scan for it exists, so until there are outside
  consumers the committee checks a suspect by hand.
- **Reported grounds race the exit.** Filing freezes the stake and sweeps a queued withdrawal, so launch
  unbonding of 21 days is the outer limit for a report to reach the committee and be filed.
- **A partial operator slash can demote.** An operator left below `bondAmount` leaves the active set until
  it tops up and is admitted again, so a first O2 can take a bonded operator out of service.
- **A wrongful execution can be repaid, not undone.** The score and the DID stay gone, and repayment depends
  on a finding and on what the treasury holds. That raises the bar for the committee, and it should be said
  plainly to anyone bonding.
- **Today's setup cannot fully apply this.** On testnet one key holds committee and admin, so accuser and
  judge are the same until the handover, and one party runs both operators.

## What this does not do

- It enforces nothing on chain. The contract still takes any bytes, and the committee and the admin remain
  the check on them.
- It does not build the challenge process, or say who rules on contested facts. [ADR 0011](0011-who-rules-negative-outcomes.md)
  does: a refund is the only answer for the score, and A3 goes through the committee and the admin Safe.
- It does not set how much an integrator should trust an agent for, or how large a job a bond should back.
