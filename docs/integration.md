# Integrating Sigvara

For contracts and services that need to decide whether to deal with an agent. To register an
agent, see the [quickstart](quickstart.md). For how the score is built, see the
[reputation model](reputation-model.md).

## The short version

```solidity
import {ISigvaraReader} from "sigvara/src/interfaces/ISigvara.sol";

ISigvaraReader sigvara = ISigvaraReader(READER); // a deployed SigvaraReader

require(sigvara.isTrusted(agent, 40), "agent not in good standing");
```

`isTrusted(agent, minScore)` is true when the agent is Active, the bond it holds now meets the
staking contract's current minimum, and its spendable score is at least `minScore`. It takes
the agent's address, so there is no didHash to derive first. The bond is read at call time
because status is stored: if the minimum is raised, an agent admitted at the old one stays
Active and keeps its score while holding less than the new one asks, and `isTrusted` stops
returning true for it until it tops up. `trust(agent).collateralized` reports the same check.
`SigvaraReader` is a small stateless contract that reads the three registries. See
[Deploying a reader](#deploying-a-reader).

## Which read to use

| You want | Call | Notes |
|---|---|---|
| A yes or no | `reader.isTrusted(agent, minScore)` | Status, current bond and score together |
| A yes or no that refuses a stale score | `reader.isTrustedFresh(agent, minScore, maxAgeSeconds)` | `isTrusted`, and the score was written no more than `maxAgeSeconds` ago. See [How old the score is](#how-old-the-score-is) |
| The standing behind it | `reader.trust(agent)`, or `trustByDid(didHash)` | One struct, described below |
| One registry fact | the interfaces in `src/interfaces/ISigvara.sol` | Keyed by didHash, from `computeDidHash(agent)` |
| An off-chain service that wants proof the caller controls the agent | `SigvaraGate` in the SDK | Challenge and response, then the same checks. See the [README](../README.md#refusing-work-to-an-agent-without-standing) |

## Getting the interfaces

`src/interfaces/ISigvara.sol` imports nothing and is MIT licensed, so either copy that one
file into your project or install this repository as a dependency:

```bash
forge install RunTimeAdmin/Sigvara
# remappings.txt
sigvara/=lib/Sigvara/
```

It declares `ISigvaraIdentity`, `ISigvaraReputation`, `ISigvaraStaking` and `ISigvaraReader`.
Point them at the registry proxy addresses in `deployments/<chainId>.json`. The proxies do not
move, though the code behind them does.

## What `isTrusted` checks

1. The agent is registered and its status is Active. An agent becomes Active when its bond
   reaches `minimumStake`. It stops being Active when its operator suspends it, when a slash
   proposal is opened against it, or when it is slashed.
2. Its spendable score is at least `minScore`.

It does not check how much is staked. If you need a floor, read `stake` from `trust()` and
apply your own. The status is stored, so an agent that was Active when governance raised
`minimumStake` stays Active until something else changes its status, and the oracle cannot
write a new score for an agent that sits below the minimum.

### Why not call `meetsThreshold` directly

`SigvaraReputation.meetsThreshold(didHash, n)` compares the spendable score with `n` and
nothing else. A suspended agent keeps its score, so it passes. At `n = 0` every address
passes, including ones that were never registered. An agent that holds less than a raised
minimum stake passes too, because the score does not move when the minimum does. `isTrusted`
adds the status check and the current bond.

## The `Trust` struct

`reader.trust(agent)` never reverts for an unknown address.

| Field | Meaning |
|---|---|
| `registered` | False if the address was never registered. Every other field is then zero. |
| `status` | `Active`, `Suspended`, `Slashed` or `PendingBond`. Meaningful only when `registered`. `Active` is the zero value, which is why `registered` exists. |
| `active` | `status == Active`. |
| `score` | The spendable score, 0 to 100. This is what thresholds compare. |
| `earned` | The score as computed, before maturity. `score` never exceeds it. |
| `stake` | Bond held for the agent, in the bond token's units. Excludes any amount queued for withdrawal. |
| `slash` | Where the latest slash proposal stands: `None`, `Pending`, `Disputed`, `Executed` or `Cancelled`. |
| `collateralized` | The bond held now meets the staking contract's current minimum. `active` is a stored status and does not change when the minimum is raised, so an `Active` agent can hold less than the minimum asks. `isTrusted` requires this. |
| `scoreUpdatedAt` | When the score was last written, or zero if it never was. Nothing decays a score on chain, so one left over from an oracle outage keeps its old time here. See [How old the score is](#how-old-the-score-is). |

### Spendable and earned score

A new score is not spendable at once. A rise is released at `maturityRatePerDay` points a day,
a fall applies immediately, and a handover to a new operator restarts the release. So `score`
can sit below `earned` for a while after an increase. Gate on `score`. Show both if you want
people to see that an agent is rising.

The score also moves with time alone, so no event announces some changes. Poll `trust()` for
the current number and use events to learn when to look again.

## How old the score is

Nothing on chain ages a score. The oracle writes one each epoch; if it stops, or proposals are
paused (ADR 0005), the last score stays as it was and `isTrusted` keeps answering from it. For a
gate that is the difference between "this agent is in good standing" and "this agent was in good
standing the last time anyone looked". `trust(agent).scoreUpdatedAt` is the time the score was last
written, and `isTrustedFresh(agent, minScore, maxAgeSeconds)` is `isTrusted` plus a limit on that
age. It fails closed: an agent that has never been scored is not fresh at any age, and a score older
than the limit is refused with no other change.

Choose the age against how often a live oracle writes. On mainnet the primary proposes once a day
and a proposal finalizes after the 6 hour score challenge window, so a healthy agent's score is
about a day old just before the next one lands, and older when an epoch runs late. Two days
tolerates one late epoch; a shorter limit shows a missed one sooner and turns a late one into
refusals; a much longer one is the stale read this replaces. If you read `trust()` and apply your
own limit, compare `scoreUpdatedAt` with `block.timestamp`. A score that is current still moves
with maturity, so freshness answers when it was written, not whether it is still rising.

## What can change under you

A consumer of the Reader trusts the parties that govern the registries, and should know which of their powers move an answer without warning. The detail is in [ADR 0005](adr/0005-governance-and-emergency-powers.md).

- **Parameters, at once.** The admin Safe sets the minimum stake, the challenge and unbonding periods, the score window and the maturity rate, each between a floor and a ceiling. A raised minimum stake makes `isTrusted` false for an agent that holds less, immediately.
- **Standing, through a slash.** The committee files a slash. It executes after the challenge period unless the operator disputes it, in which case the admin Safe rules, or the admin Safe vetoes it. A slashed agent is terminal: `isTrusted` is false for good.
- **Code, after 48 hours.** Upgrades and the wiring between registries go through a timelock, and its delay is the public notice. Watch the timelock if you cannot accept a change in behaviour.
- **Inflows, for up to three days.** A guardian can pause registrations, stake deposits, score proposals and bond deposits. Reads, exits, slashes and finalization carry on, so a pause shows up as a score that stops moving, which `isTrustedFresh` catches.
- **Scores, from an oracle the project runs today.** A proposal waits out a challenge window the committee can use to reject it, and a second operator re-scores each one and logs a divergence. Both are run by the same party, so that is a check on mistakes and not an independent source.

## Patterns

- **Gate at entry.** `isTrusted` at the point where the agent asks for something. The example
  in [`examples/gated-marketplace`](../examples/gated-marketplace/GatedMarketplace.sol) does
  this in `list`.
- **Keep the gate honest.** Standing changes after entry. Offer a way to re-check or remove
  anyone who no longer qualifies, as `delistIfUntrusted` does there, instead of trusting what
  was true when they arrived.
- **Soft signal.** Rank by `score` and show `stake`. More bond means more to lose, which is not
  the same as more trustworthy.
- **Slash proceedings.** `Pending` or `Disputed` means the committee has accused the agent and
  the proceeding is open. It is an allegation and not a verdict, and the agent is suspended
  meanwhile. `Executed` is final. `Cancelled` records a proposal that was dropped.
- **Exits.** An operator can queue a withdrawal while the agent stays Active. The queued amount
  stays slashable until it is claimed, but the agent is leaving. `getPendingWithdrawal` on the
  staking registry reports it.
- **Handovers.** `operatorTransferCount` and `operatorChangedAt` on the identity registry show
  whether an agent has changed hands. It is reported and not scored, so what a frequently traded
  identity is worth is your call.

## Showing it to people

Show the facts and the date they were read:

> Score 47 of 100, rising to 62 · Bond 10,000 · No slash proceedings · Read at block 1,234,567

Avoid wording that claims more than the data does: "Trusted by Sigvara", "Verified safe",
"Audited", "Insured", "Guaranteed". Next to the score, one line is enough:

> An oracle computes the score from payments verified on chain, outcomes reported by the payer
> and the other signals in the reputation model. A bond stands behind it that a committee can
> slash. It is not an audit, insurance or a guarantee.

Some factors read zero until an agent has linked an ERC-8004 identity, so check the current
reachable maximum in the [reputation model](reputation-model.md) before you pick a threshold.
The protocol's current status, including what has and has not been audited, is in the README
under "Where this stands".

## Events

Re-read an agent's standing when one of these fires for its didHash.

| Registry | Event | What changed |
|---|---|---|
| Reputation | `ReputationUpdated(didHash, totalScore, timestamp, evidenceRoot)` | A new score was finalized |
| Reputation | `ReputationZeroed(didHash)` | The agent was slashed and its score cleared |
| Reputation | `ScoreProposed`, `ScoreRejected` | A score entered its challenge window, or was rejected. The live score is unchanged until `ReputationUpdated`. |
| Identity | `AgentStatusUpdated(didHash, newStatus)` | The agent became Active, Suspended or Slashed |
| Identity | `OperatorTransferred(didHash, from, to)` | The agent changed hands, and score release restarts |
| Staking | `StakeDeposited`, `WithdrawalInitiated`, `WithdrawalClaimed` | The bond changed |
| Staking | `SlashInitiated`, `SlashDisputed`, `SlashCancelled`, `SlashExecuted` | A slash proceeding opened, moved on, was dropped, or settled |

## Parameters worth showing

So people can see the rules and not only the result:

| Getter | Registry | Meaning |
|---|---|---|
| `minimumStake()` | Staking | Bond an agent needs to become Active |
| `challengePeriod()` | Staking | Seconds an operator has to dispute a slash |
| `unbondingPeriod()` | Staking | Seconds a queued withdrawal waits |
| `maturityRatePerDay()` | Reputation | Points of earned score released per day |
| `challengeWindow()` | Reputation | Seconds a proposed score stays open to challenge |

## Deploying a reader

`SigvaraReader` has no proxy, no roles and nothing to initialize. Its constructor takes the
identity, reputation and staking proxy addresses and keeps them as immutables. Nothing in the
protocol reads from it, so deploying or replacing one carries no protocol risk. To point at
different registries, deploy another.

```bash
IDENTITY_ADDRESS=... REPUTATION_ADDRESS=... STAKING_ADDRESS=... \
SMOKE_AGENT=<a registered agent> \
forge script script/DeployReader.s.sol --rpc-url $RPC --broadcast -vvvv
```

`SMOKE_AGENT` is optional. When set, the script reads that agent's standing through the new
reader and fails if it cannot, which exercises every registry call and would expose a proxy
running older code than the interfaces expect. Registry addresses are in
`deployments/<chainId>.json`, which does not list a reader. If a registry upgrade ever changes
a function the reader calls, deploy a new reader.

## Example

[`examples/gated-marketplace/GatedMarketplace.sol`](../examples/gated-marketplace/GatedMarketplace.sol)
lists only trusted agents, lets anyone remove one that stops qualifying, and exposes the live
`Trust` struct for a frontend. It is illustrative and unaudited.
[`test/GatedMarketplace.t.sol`](../test/GatedMarketplace.t.sol) runs it against the real
registries.
