# Slash drill: the log

A scheduled demonstration on Arc testnet, run against an agent registered for the purpose.
**This was not a finding against anyone.** The evidence field of the on-chain proposal says
so verbatim, so the chain carries that statement rather than this document alone.

Sigvara's claim is that reputation carries weight because misbehaviour costs capital. The
contracts implement that and the test suite covers it, but until this ran, nobody had
watched a bond actually get taken on a live deployment. The procedure is in
[slash-drill.md](slash-drill.md); this is what happened when it was followed.

**Status: settled.** Filed 20 September 2026, window closed 27 September, executed
3 October 2026 01:14:19 UTC. The delay between the window closing and execution was five
days of nobody running it, which is itself worth recording: execution is permissionless
precisely so it does not depend on one party's attention, and it still waited on mine.

## Addresses

| Role | Address |
|---|---|
| Target agent | [`0x9a940B2e62a2c4a51E3cC38837944296717C4a96`](https://explorer.testnet.arc.io/address/0x9a940B2e62a2c4a51E3cC38837944296717C4a96) |
| Target didHash | `0x59d75ab4a3af114de90c4f6640f4dc47cee83d0895f3f8c4eb9b012dc5f6e153` |
| Operator (and victim) | `0x18CBcE50390f5f6ebe4E20Fc17833F25c8D94811` |
| Reporter (committee) | `0x045D6C1d8404297F13596061388f6598fA94a5b7` |
| Staking | `0xA69d62B2a6774D21A2c15d5d83b27277eD31d35B` |
| Identity | `0x7e3aFC532eE5d922ab3cc3FFb510c7C8151477Dd` |
| Reputation | `0x6603C96275e85F724Cdf74666b399365e4cA29ed` |

## Step 0: the target was created for this

The live deployment had exactly **one** `AgentRegistered` event in its entire history
before this drill, and it is the demo agent that the site, the on-ramp and the whitepaper
all point at. Slashing that one would have destroyed the thing every public reference
depends on, and `Slashed` is terminal, so a throwaway was registered instead.

Registered at Unix `1789932289`, bonded at exactly `minimumStake` (1,000 SVR), since half
of whatever a target holds is burned.

| Check | Value |
|---|---|
| Status before filing | `0` (Active) |
| Stake | 1,000 SVR |
| `hasMinimumStake` | true |
| Score at filing | **0** (scored `5` at 19:36:48, after filing; had risen to `12` finalized by 26 Sep as tenure accrued) |

## Day 0: filed

**Tx [`0x6c5ec3adfba5ec9fffe50b3d8d534e0b9f2511efb629e89461e37d1fdb0c72ff`](https://explorer.testnet.arc.io/tx/0x6c5ec3adfba5ec9fffe50b3d8d534e0b9f2511efb629e89461e37d1fdb0c72ff)**, block 63136962.

```
initiatedAt        1789932484   2026-09-20 19:28:04 UTC
challengeDeadline  1790537284   2026-09-27 19:28:04 UTC
window                 604800 s = 7 days exactly
state                       1   Pending
disputedAt                  0   never disputed
evidenceHash         "drill: scheduled demonstration, not a finding"
```

The agent was suspended in the same transaction, before any window ran:

| Check | Before | After filing |
|---|---|---|
| `identities().status` | `0` Active | `1` Suspended |
| `isActive()` | true | **false** |
| `getStake()` | 1,000 SVR | 1,000 SVR (frozen, not taken) |

Filing suspends and freezes. It does not transfer anything. That distinction is the whole
purpose of the challenge window.

## Day 0: early execution refused

The guard that makes the window mean anything, checked by simulating the call rather than
paying for a revert:

```bash
cast call 0xA69d62B2a6774D21A2c15d5d83b27277eD31d35B "executeSlash(bytes32)" \
  0x59d75ab4a3af114de90c4f6640f4dc47cee83d0895f3f8c4eb9b012dc5f6e153 --rpc-url arc_testnet
```

Reverted with `0x7dcc88ac` — `ChallengePeriodActive(bytes32,uint256)` — carrying
`unlocksAt = 1790537284`, which is the `challengeDeadline` from the proposal, to the
second. The deadline is snapshotted at filing, so an admin changing `challengePeriod`
afterwards cannot move an in-flight window.

## Day 13: settlement

Executed **2026-10-03 01:14:19 UTC**, in tx
[`0xf854e16389b68117523059f42788445e6cd12f0f7cc4de66590b1fbca7fa16df`](https://explorer.testnet.arc.io/tx/0xf854e16389b68117523059f42788445e6cd12f0f7cc4de66590b1fbca7fa16df)
at block `65205976`, by the committee address. 5.24 days after the window closed, and
permissionlessly: any funded address could have sent the same call.

Measured before and after, against the same RPC:

| | before | after |
|---|---|---|
| `slashProposals.state` | `1` Pending | `2` Executed |
| `stakes.amount` / `unbondingAmount` | 1,000 SVR / 0 | 0 / 0 |
| `getTotalScore` | **15** | **0** |
| `getIdentity.status` | `0` Active | `2` Slashed |
| SVR at `0xdead` | 0 | **500** |
| `claimable[victim]` | 0 | **250** |
| `claimable[reporter]` | 0 | **250** |

`SlashExecuted` carries the split directly: `500000000000000000000`,
`250000000000000000000`, `250000000000000000000`. Those sum to `1000000000000000000000`,
exactly the stake, which is the remainder term in `_settleSlash` absorbing the rounding
rather than leaving dust behind in the contract.

The score went `15 → 0`, not the `5 → 0` this document predicted in September. Twelve days
of tenure accrued while the proposal sat, and `zeroReputation` took all of it. That makes
the demonstration better than designed, and the caveat below sharper rather than weaker:
every one of those 15 points was calendar tenure and an unflagged baseline.

Proceeds are credited rather than pushed, so they are still in `claimable` and claiming is
a separate step. That is deliberate — a recipient that cannot receive the token must not be
able to make settlement revert, because this is the only path that clears the proposal and
unfreezes a bond.

## What this proves, and what it does not

**Does.** That the slashing path executes on a live deployment; that filing suspends
immediately while leaving the bond in place; that the challenge window is enforced to the
second against a deadline fixed at filing; that the bond is taken and split exactly as
documented, to the wei; and that a live, nonzero reputation is destroyed with it.

**Does not, and these are not quibbles:**

- **Nothing about governance.** The committee is a single EOA on testnet, the target was
  created by the same operator running the drill, and reporter, operator and victim are all
  addresses that operator controls. This demonstrates a mechanism, not a decision. A drill
  presented as proof that a committee will act correctly against a real adversary would be
  precisely the overclaim the rest of these documents exist to avoid.
- **Little about reputation being destroyed, but more than expected.** The target scored
  `0` at filing, because it was registered minutes earlier and had never been through an
  oracle epoch. It was then scored `5` at 19:36:48, the unflagged community baseline for a
  bonded agent with no trading history, and this section originally said the slash would
  show `5 → 0`.

  It climbed on its own instead. `12` on 26 September, and `15` when the slash executed on
  3 October. The arithmetic is entirely tenure: the agent has no payments, so `ageScore`
  falls back to calendar age. The 15 is the community 5 plus an `ageScore` of 10, and
  `ageCurve` reaches 10 between days nine and twelve, so that figure was computed a couple
  of days before the slash rather than at the moment of it: a score is proposed, waits out
  its challenge window, and only then finalizes. Nothing was done to the agent; it aged
  through its own proposal.

  So the slash showed `15 → 0`, three times the `5 → 0` this document first predicted, and
  still thin against a factor that runs to 100. It is also a reminder of what this drill
  does not cover: every one of those 15 points is calendar tenure and an unflagged
  baseline, neither of which cost an attacker anything. The interesting case remains an
  agent whose score took months of *paid* work to build, and `test/SlashDrillFork.t.sol`
  covers that by forking the live chain and slashing an agent carrying a real score.
- **Nothing about the dispute branch.** It was deliberately skipped to keep the drill to
  seven days rather than up to twenty-one. Freeze, uphold and reject are covered by the
  same fork test.
- **The cost was not representative.** Naming the operator as victim means 25% returned to
  the address that posted the bond, and the reporter's 25% is also recoverable, so the real
  cost was the 500 SVR burned. In a genuine slash the victim is the harmed counterparty and
  none of it comes back.
