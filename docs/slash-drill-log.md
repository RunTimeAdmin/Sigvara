# Slash drill: the log

A scheduled demonstration on Arc testnet, run against an agent registered for the purpose.
**This was not a finding against anyone.** The evidence field of the on-chain proposal says
so verbatim, so the chain carries that statement rather than this document alone.

Sigvara's claim is that reputation carries weight because misbehaviour costs capital. The
contracts implement that and the test suite covers it, but until this ran, nobody had
watched a bond actually get taken on a live deployment. The procedure is in
[slash-drill.md](slash-drill.md); this is what happened when it was followed.

**Status: in the challenge window.** Filed 20 September 2026, settles 27 September 2026.
Sections below marked *pending* will be filled in on settlement.

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

## Day 7: settlement

*Pending. Executes on or after 2026-09-27 19:28:04 UTC.*

Expected, from a stake of 1,000 SVR: 500 burned to `0xdead`, 250 credited to the victim,
250 to the reporter, summing to the stake. Status `2` (Slashed), terminal. Proceeds are
credited rather than pushed, so claiming is a separate step and part of the demonstration.

## What this proves, and what it does not

**Does.** That the slashing path executes on a live deployment; that filing suspends
immediately while leaving the bond in place; that the challenge window is enforced to the
second against a deadline fixed at filing; and *(pending)* that the bond is taken and split
as documented.

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

  It has since climbed on its own. By 26 September the finalized score was `12` with `13`
  pending, and it will be a point or so higher at settlement. The arithmetic is entirely
  tenure: the agent has no payments, so `ageScore` falls back to calendar age, and
  `ageCurve` reads 7 at five days and 8 at six, on top of the community 5. Nothing was
  done to the agent; it simply aged through the challenge window.

  So the slash will show roughly `13 → 0`, which is a better demonstration than `5 → 0`
  and still a thin one against a factor that runs to 100. It is also a reminder of what
  this drill does not cover: every point of it is calendar tenure and an unflagged
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
