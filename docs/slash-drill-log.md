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

Proceeds are credited rather than pushed, so claiming was a separate step. That is
deliberate: a recipient that cannot receive the token must not be able to make settlement
revert, because this is the only path that clears the proposal and unfreezes a bond.

**Both claims were made the same day.** `claimSlashProceeds()` from each recipient, which
takes no argument and pays `msg.sender` whatever it is owed, so there is no way to claim on
another party's behalf and no single transaction that could do both.

| | `claimable` | SVR before | SVR after |
|---|---|---|---|
| victim `0x18CBcE50…` | 250 → 0 | 1,000 | **1,250** |
| reporter `0x045D6C1d…` | 250 → 0 | 0 | **250** |

The staking contract went 5,500 → 5,000 SVR, exactly the 500 paid out: nothing leaked and
nothing was stranded. A second claim from either address now reverts
`NothingClaimable(address)` (selector `0x9837a149`, with the caller as the argument), so it
refuses for the documented reason rather than failing incidentally. The reporter is the
cleaner of the two to check: an address holding no SVR at all now holds exactly its quarter
of a bond taken from someone else.

So the full path is on chain and checkable end to end: register, bond, file, suspend, wait
out the window, execute, split, claim.

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
  falls back to calendar age. Worth being exact about why, because the deployment runs
  `PAYMENT_VERIFICATION=required` and the calendar path looks like it should be
  unreachable. `activityWindow` returns `null` for an agent with no payment events at all,
  and `ageScore` reads a null activity window as "measure from registration". The target
  never received a payment, so it took that branch for its whole life. Checked against the
  live state file: the only agent with payment events is the demo agent. That branch is gone
  where payment verification is on: since 22 October 2026 an agent with no payment events
  gets an empty window and scores 0 tenure.

  The 15 is therefore the community 5 plus an `ageScore` of 10, and `ageCurve` returns
  exactly 10 on days ten and eleven. The slash landed on day twelve, where the curve reads
  11, so the finalized 15 was computed a day or two earlier: a score is proposed, waits out
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

## The adversarial drill

The plan and the predictions, written before any of this ran, are in
[slash-drill.md, "The adversarial drill"](slash-drill.md#the-adversarial-drill). Three agents were
bonded for it, and the evidence field of every filing says it is a drill.

**Status: day 0 done, every prediction held.** A was disputed and dropped by the admin, and B was
vetoed. Both are Active with their bonds intact. C is open and suspended.
- **Day 7**, from **10 November 2026, 03:46 UTC**: A's refile cooldown ends and C's dispute window
  has closed.
- **Day 21**, from **24 November 2026, 03:45 UTC**: C lapses and can be expired.

| Agent | Address | didHash |
|---|---|---|
| A | `0xa656eBa21833c208B5Dbe3faFf4F6438b4Cc39E7` | `0x31d086504826b5cee68c36448d14e667e8535ca8a8f50bb3cb5ea72db1c3165b` |
| B | `0x52900e0ec5ca59B9e57327e0c6Ba1f7B8fd88A80` | `0xa8e330e0c4ff506ca21f786a7bfc1b37495390d2b0715996cc726e3573630453` |
| C | `0xebc125b2AB79586299BF2274582C6f63dB6300F8` | `0x30b95fc4473e5ea0f187d4955ab24bcfebd7a739a0a93c1beafd5d6445f1d93a` |

The drill operator is `0x11bbb7764D215c7Ab2E7c677283E226D599ce956`, the committee
`0x045D6C1d8404297F13596061388f6598fA94a5b7`, and the admin the deployer
`0x18CBcE50390f5f6ebe4E20Fc17833F25c8D94811`.

### Day 0, 3 November 2026: setup

The operator claimed 3,000 SVR from the token's faucet, then registered each agent (each agent
signing its own registration) and bonded it with `minimumStake`, 1,000 SVR. Each went from
`PendingBond` to `Active` on its bond.

| Step | Block | Transaction |
|---|---|---|
| Faucet, 3,000 SVR | 70456183 | `0xc2fd367582c7ce67d6fe88dc14e720b2a4cd6ae040280b0c5f76dc3ea0ed869a` |
| Approve staking | 70456188 | `0x8e2d8b3c59851607a58668ed82ca245b8b386f3848bb524267e0ea3fb52b888e` |
| Register A, bond A | 70456194, 70456199 | `0x2bde41e654eff655bbbde090c8a1d4c6e822f44eaf6282422fdff93a34c00235`, `0xf35b40dcb45b28ef261fe690f434e5bd993533e41c4cdefb830da3082c9d082a` |
| Register B, bond B | 70456207, 70456211 | `0xf36557558adc61ca736e5e6e552007cdf7297189921ab9812f4b784e58a0de9d`, `0x8e3dac90ee578fa5db3a14abb445d45dbd819c6a26a5253aee00faf23381bf97` |
| Register C, bond C | 70456220, 70456225 | `0xc5d3a69b5f7bf7a5a2bfbf45bbd43617989fe85be88a68e51214ee71f9f3fcac`, `0x73e3631eb1fed24c85c9eb7bad7157027f0772fce8ba657b12534a921f1952f8` |

### Day 0: filed, disputed, dropped, vetoed

| Time (UTC) | Step | Transaction |
|---|---|---|
| 03:44:35 | Committee files A | `0x7d79a6aa2463cedf689c96861e3da4f612161d3bd591736c738c2f620af7754d` |
| 03:44:37 | Committee files B | `0x19ab4cfb2e80e78009f19ded08c98460e27ce405773408b3b7c55257f6edd4c0` |
| 03:44:40 | Committee files C | `0x2b19c2dde280acb0b8ab623bbd4777232e3a0ae996c7abfff879b8a82c95779b` |
| 03:44:53 | Operator disputes A | `0x307e9a889f5785de214b318ad5a39ab3ee64a961eb76a25805ab65b97e882800` |
| 03:45:29 | Admin vetoes B (`SlashCancelled` and `SlashVetoed`) | `0x08c8b47d5639a6b99e9e0704fca27a156f3a801a742d7efada0cbb696027533f` |
| 03:45:31 | Admin drops A, `resolveDispute(A, false)` (`SlashCancelled`) | `0x6f7ec5c37218c16da7d24df1699ccbbdb1bd9098c1ad25ce7628726416150203` |

All three agents went `Suspended` at their filing. After the veto and the ruling, A and B were
`Active` again with 1,000 SVR each still bonded; C stayed `Suspended` with its bond frozen.

### Day 0: the guards

Each was run as a free call from the account named, at the moment the plan says. Each gave the
error predicted.

| Moment | Call | Predicted | Got |
|---|---|---|---|
| A filed, before the dispute | Committee files A naming itself the victim | `VictimIsReporter` | `VictimIsReporter` |
| A filed, before the dispute | `0x…dEaD` disputes A | `NotOperator` | `NotOperator` |
| A disputed, before the ruling | Admin upholds A | `ChallengePeriodActive` | `ChallengePeriodActive` |
| After the ruling and the veto | Committee files A again | `SlashCooldownActive` | `SlashCooldownActive` |
| After the ruling and the veto | Committee files B again | `SlashCooldownActive` | `SlashCooldownActive` |
| After the ruling and the veto | Anyone executes C | `ChallengePeriodActive` | `ChallengePeriodActive` |
| After the ruling and the veto | Anyone expires C | `ExecutionPeriodActive` | `ExecutionPeriodActive` |

The cooldowns end one challenge period after each drop: A's at 2026-11-10 03:45:31 UTC and B's at
03:45:29. C's challenge deadline is 2026-11-10 03:44:40 UTC, and it lapses 14 days after that, at
2026-11-24 03:44:40 UTC.

### Day 0: what differed from the plan

- **Signing.** The committee and admin steps were signed with `cast` in PowerShell rather than
  with `scripts/slash-drill-adversarial.sh`, which needs bash. The evidence bytes are the script's,
  checked equal with `cast from-utf8` before filing; the day-7 check refuses A's evidence by those
  exact bytes. The operator's steps and the guards ran from the script.
- **The setup's eight transaction hashes went missing from its output.** The output filter meant to
  keep keys off the screen also caught the hashes, which are the same length. They were read back
  from the chain: the faucet and approval from the token's logs, and the rest from the event index.

Nothing in the protocol differed.

### Day 7, 10 November 2026: refile and withdraw A

The guards ran first, from `scripts/slash-drill-adversarial.sh guards-day7`, as free calls. Each gave the
error predicted.

| Call | Predicted | Got |
|---|---|---|
| Committee refiles A with the evidence the admin dropped | `EvidenceAlreadyRejected` | `EvidenceAlreadyRejected` |
| C's operator disputes after C's deadline | `ChallengePeriodExpired` | `ChallengePeriodExpired` |
| Anyone expires C before it lapses | `ExecutionPeriodActive` | `ExecutionPeriodActive` |

Then the committee (`0x045D6C1d8404297F13596061388f6598fA94a5b7`) refiled A with the day-7 evidence and
withdrew it three seconds later, so no keeper could execute it:

| Step | Block | Time (UTC) | Transaction | Event |
|---|---|---|---|---|
| `initiateSlash(A, operator, EVIDENCE_A2)` | 71722299 | 14:35:02 | `0xda82818b624dd2e780543b7a043b14871f5ace6cfee3f1e78f1a26a83daf7f4c` | `SlashInitiated` |
| `cancelSlash(A)` | 71722304 | 14:35:05 | `0x96c95bfe1a734a04715bc83d77b0a931b593a598acd195ba1baba4629620398e` | `SlashCancelled` |

Afterwards `status` reads A `Active` with its proposal `Cancelled`, B `Active` and `Cancelled`, and C
`Suspended` with its proposal `Pending`. All three bonds are still 1,000 SVR. Both slash keepers log C as
held by `KEEPER_SKIP_AGENTS`, so neither will execute it before day 21.

### Day 7: what differed from the plan

- **Signing.** As on day 0, the committee's two transactions were sent with `cast` in PowerShell rather than
  `committee-day7`, with the evidence bytes built from the script's `EVIDENCE_A2` text.
- **Staking ran other code for 397 blocks before day 7's steps.** The staking proxy was upgraded to the
  `44ff8e8` build in block 71720600 along with the reputation and oracle bond proxies, by mistake, and
  restored to the implementation the drill started on in block 71720997, about 25 minutes before the
  guards ran. No drill call fell in that window, and every call above ran on the drill's own code.

Nothing in the protocol differed.
