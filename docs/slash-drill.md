# Slash drill

Executing one slash in public, end to end, on Arc testnet, and publishing what happened.

Sigvara's claim is that reputation carries weight because misbehaviour costs capital. The
contracts implement that and the contract suite covers it, but before this drill nobody had
watched a bond actually get taken. What happened is in [slash-drill-log.md](slash-drill-log.md).

> **The split changed after this drill.** The drill ran on the first split: 50% burned, 25% to
> the victim, 25% to the reporter. The code on main now burns 75%, pays the victim 25% and pays
> the reporter nothing, and refuses any committee member as the victim. The Arc testnet staking
> proxy runs the new split since 2 November 2026, so a drill now costs 750 SVR of a
> 1,000 SVR bond, not 500. The figures below are the first split's.

Budget **seven days**. `challengePeriod()` is 604800 seconds. An admin can lower it to no
less than `MIN_CHALLENGE_PERIOD` (3 days), but not for a proposal already filed, whose
deadline is snapshotted at filing. That makes this the long pole in front of anything that depends on the
protocol looking finished.

> **On the placeholders below.** `<THING>` marks a value you substitute. In bash the
> angle brackets are redirect operators, so pasting a line with them intact fails with
> `syntax error near unexpected token` before anything runs, including any `export` on
> the same line. For keys, read them into a variable instead of editing them into the
> command, which also keeps them out of your shell history:
>
> ```bash
> read -rs -p "key: " KEY; echo
> cast send ... --private-key "$KEY"
> ```
## Rehearsed first

[`test/SlashDrillFork.t.sol`](../test/SlashDrillFork.t.sol) runs this whole path against a
fork of the live deployment, so the sequence below is a replay of something that already
worked rather than a first attempt:

```bash
forge test --match-contract SlashDrillFork -vv
```

Six cases pass: the full path (including the too-early guard), dispute-freezes,
dispute-upheld, dispute-rejected, the queued-withdrawal escape attempt, and
reporter-cannot-be-victim. It forks rather than deploying
fresh on purpose, so it exercises the roles actually granted on Arc and the real
`challengePeriod`, not a clean-room copy.

Run it again before the live drill. If the fork test fails, something changed on chain and
the live sequence is no longer the rehearsed one.

## Before you start

**The committee is `0x045D6C1d8404297F13596061388f6598fA94a5b7`.**

This was an open question in the first draft of this runbook, which said the role "cannot
be read back off the contract" because `AccessControl` is not enumerable. That is true of
the getters and false of the chain. `grantRole` emits `RoleGranted(role, account, sender)`
with all three fields indexed, so the holder is recoverable from the deployment block:

```bash
# 1. find the block the staking proxy was deployed in (bisect on code presence)
cast code 0xA69d62B2a6774D21A2c15d5d83b27277eD31d35B --block <N> --rpc-url arc_testnet

# 2. read the grant out of that block. topic1 is SLASHING_COMMITTEE_ROLE,
#    topic2 is the account it was granted to.
cast logs --from-block 62662190 --to-block 62672190 \
  --address 0xA69d62B2a6774D21A2c15d5d83b27277eD31d35B \
  $(cast keccak "RoleGranted(bytes32,address,address)") \
  0x74b3625417784541f0f8acc9c70588d83c485ef84428e2b477246b26443edd28 \
  --rpc-url arc_testnet
```

Granted at block 62662196 by the deployer, in tx
`0xdf723e26fc6764806c378688a29c1fef91a074135efe55df78731b5ccef01a86`. Confirmed still
held on **both** staking and reputation. The account has roughly 20 USDC of native gas and
a nonce of 1, so it has signed exactly once: enough to pay for the drill, and a strong hint
that it has barely been used.

Verify before relying on any of that, since a role can be revoked:

```bash
cast call 0xA69d62B2a6774D21A2c15d5d83b27277eD31d35B "hasRole(bytes32,address)(bool)" \
  0x74b3625417784541f0f8acc9c70588d83c485ef84428e2b477246b26443edd28 \
  0x045D6C1d8404297F13596061388f6598fA94a5b7 --rpc-url arc_testnet
```

`test/SlashDrillFork.t.sol` now pranks this address rather than granting the role to a
fresh one, and asserts the role in `setUp`, so the rehearsal fails loudly if it ever moves.

**Knowing the address is not the same as holding the key, and that is the actual blocker.**
Confirm custody **before** step 1. Filing and `cancelSlash` both need that key, and a
proposal you cannot cancel leaves the agent suspended with its bond frozen until the
deadline, after which anyone can execute it.

**Do not target the demo agent.** `0x8414ce0b…` is the agent the site, the on-ramp and the
whitepaper all point at, with a live score and a public evidence root. Slashing it
zeroes that score permanently. `Slashed` is terminal: the agent cannot be topped back up
or restored. The fork test targets it because a fork is disposable; the live drill must
not.

**Register a throwaway instead.** This is not optional and it is not a detail: as of
20 September 2026 the live deployment has had exactly **one** `AgentRegistered` event in
its entire history, and it is the demo agent. There is no second agent to drill against.
Counted by scanning the full block range:

```bash
cast logs --from-block <deploy> --to-block latest \
  --address 0x7e3aFC532eE5d922ab3cc3FFb510c7C8151477Dd \
  $(cast keccak "AgentRegistered(bytes32,address,address,bytes32)") --rpc-url arc_testnet
```

Use the on-ramp at [sigvara.xyz/testnet](https://sigvara.xyz/testnet): faucet gas, faucet
SVR, register, bond. Bond it at `minimumStake` exactly (1,000 SVR), since half of whatever
it holds is burned. Registering the target is step 0 of the drill and it costs 500 SVR in
the end: half the bond is burned, and the rest returns through the victim and reporter shares (see below).

**Pick a victim address that is not the reporter.** `initiateSlash` reverts with
`VictimIsReporter` if they match, because one committee signature would otherwise be a 50%
self-payment out of the accused's stake. A second throwaway is fine.

**Leave the oracle alone.** The primary oracle's bond currently sits at exactly
`bondAmount`, so it qualifies by equality. It is not the target here, but be aware that any
slash against it would drop it below the floor and stop it proposing at the next epoch.

## The cast of addresses

Decided 20 September 2026. All three keys are held by the operator running the drill,
which is a property of a self-administered drill and must be disclosed in the write-up.

| Role | Address | Why |
|---|---|---|
| Reporter / committee | `0x045D6C1d8404297F13596061388f6598fA94a5b7` | Already holds `SLASHING_COMMITTEE_ROLE` on staking and reputation. ~20 USDC gas. |
| Operator / victim | `0x18CBcE50390f5f6ebe4E20Fc17833F25c8D94811` | The deployer. Holds 5,000 SVR to bond the target, and `DEFAULT_ADMIN_ROLE` as a fallback if the committee key is ever lost. |
| Target agent | created in step 0 | A throwaway. Not the demo agent. |

`initiateSlash` reverts with `VictimIsReporter` if the two match, hence the split above.

Naming the operator as victim means 25% of the bond returns to the address that posted
it, and the reporter's 25% is also recoverable, so the drill's real cost is the 50%
burned: **500 SVR**. That is a convenience of the drill, not a property of the protocol.
In a real slash the victim is the harmed counterparty and none of it comes back.

## Step 0: create the target

Skipping this and using the demo agent is the one unrecoverable mistake available here.
`Slashed` is terminal.

```bash
# A fresh agent key. Record both halves; the address is public, the key signs once.
cast wallet new
```

The agent signs a digest binding itself to its operator. Build it from the contract
rather than reconstructing it locally, so there is nothing to get wrong:

```bash
AGENT=<address from cast wallet new>
OPERATOR=0x18CBcE50390f5f6ebe4E20Fc17833F25c8D94811
PUBKEY=0x0000000000000000000000000000000000000000000000000000000000000001  # any nonzero bytes32
IDENTITY=0x7e3aFC532eE5d922ab3cc3FFb510c7C8151477Dd

DIGEST=$(cast call $IDENTITY "registrationDigest(address,address,bytes32)(bytes32)" \
  $AGENT $OPERATOR $PUBKEY --rpc-url arc_testnet)

# Bare form: a 0x message is hex-decoded, then prefixed with the Ethereum Signed
# Message header, which is exactly the toEthSignedMessageHash the contract applies.
# NOT --data (that means EIP-712 JSON typed data) and NOT --no-hash (that skips the
# prefix). Both were checked against verifyRegistration; only the bare form returns true.
SIG=$(cast wallet sign $DIGEST --private-key <AGENT_KEY>)
```

Check the signature with a free read before spending gas on it. This returns `true` or
the registration will revert:

```bash
cast call $IDENTITY "verifyRegistration(address,address,bytes32,bytes)(bool)" \
  $AGENT $OPERATOR $PUBKEY $SIG --rpc-url arc_testnet
```

Then register and bond. The operator is `msg.sender`, so these are sent from the
operator key, and `depositStake` pulls SVR from it:

```bash
STAKING=0xA69d62B2a6774D21A2c15d5d83b27277eD31d35B
SVR=0x41De2D6D55318e197a00E8f5B496eA2790e23E6c

cast send $IDENTITY "registerAgent(address,bytes32,bytes)" $AGENT $PUBKEY $SIG \
  --rpc-url arc_testnet --private-key <OPERATOR_KEY>

# didHash is derived on chain and reproducible from the agent address alone.
DID=$(cast call $IDENTITY "computeDidHash(address)(bytes32)" $AGENT --rpc-url arc_testnet)

cast send $SVR "approve(address,uint256)" $STAKING 1000000000000000000000 \
  --rpc-url arc_testnet --private-key <OPERATOR_KEY>
cast send $STAKING "depositStake(bytes32,uint256)" $DID 1000000000000000000000 \
  --rpc-url arc_testnet --private-key <OPERATOR_KEY>
```

Bond exactly `minimumStake` (1,000 SVR), since half of whatever it holds is burned.
Confirm the target is real and distinct before filing anything against it:

```bash
cast call $STAKING "getStake(bytes32)(uint256)" $DID --rpc-url arc_testnet     # 1000e18
cast call $IDENTITY "identities(bytes32)" $DID --rpc-url arc_testnet           # status 0 = Active
test "$DID" != "0x8414ce0bf4f1e1695193623e0a656a9439e356f8bed0b8bf249b179fe77c7e19" \
  && echo "OK: not the demo agent" || echo "STOP: this is the demo agent"
```

## The sequence

### Day 0: file

```bash
cast send <staking> "initiateSlash(bytes32,address,bytes)" \
  <TARGET_DID_HASH> <VICTIM> $(cast from-utf8 "drill: scheduled demonstration, not a finding") \
  --rpc-url arc_testnet --private-key <COMMITTEE_KEY>
```

The `evidenceHash` argument is stored verbatim and is public. Say plainly that this is a
drill. An unexplained slash against a real agent is worse for trust than no slash at all.

Immediately after, the agent is `Suspended` and its stake is frozen. Confirm:

```bash
cast call <staking> "getSlashProposal(bytes32)" <TARGET_DID_HASH> --rpc-url arc_testnet
cast call <identity> "identities(bytes32)" <TARGET_DID_HASH> --rpc-url arc_testnet   # status 1 = Suspended
```

Record `challengeDeadline` from the proposal. It is snapshotted at filing, so a later
change to `challengePeriod` cannot move it.

### Days 0 to 7: the window

This is the part worth showing. The operator can dispute:

```bash
cast send <staking> "disputeSlash(bytes32)" <TARGET_DID_HASH> \
  --rpc-url arc_testnet --private-key <TARGET_OPERATOR_KEY>
```

> The Arc testnet proxies run `main`, so everything below applies to them. The first drill ran on
> the 21 September code, where the committee ruled on a dispute with `resolveDispute` and the
> veto, the lapse, the re-file cooldown, the reporter check and the evidence rule did not exist.
> `test/SlashDrillFork.t.sol` rehearses the deployed behaviour.

Disputing **freezes** the bond rather than releasing it, and does not un-suspend the agent.
The admin then rules with `resolveDispute(didHash, uphold)`; the committee that filed the
slash does not. Upholding waits for `challengeDeadline`, the moment `executeSlash` opens for an
undisputed slash (`ChallengePeriodActive` before it), so a dispute never speeds a slash up;
dropping is open at any time. If the admin never rules, anyone may call `expireDispute` after
`DISPUTE_RESOLUTION_PERIOD` (14 days), so an operator is never hostage to silence. A ruling to
uphold ends where the dispute does: after those 14 days it reverts with `DisputeResolutionExpired`,
so only dropping and expiry are left and the two never race. A proposal
nobody disputes, executes or cancels lapses the same way: anyone may call `expireSlash`
14 days after its deadline. The admin can also drop a Pending or Disputed proposal with
`vetoSlash`, and after any drop the committee waits one challenge period before it can file
against the same agent again. A drill that cancels and re-files has to wait that long between
the two. After a veto, or a ruling for the agent, the same evidence is also refused for that
agent (`EvidenceAlreadyRejected`), so a drill that re-files after one has to bring new evidence.

Whether you exercise the dispute branch is a choice. Doing it demonstrates more of the
mechanism; skipping it keeps the drill to seven days instead of potentially twenty-one.

**Decided for this run: skipped.** The straight path proves the claim that matters, that
a bond is actually taken, in the minimum elapsed time. The dispute branch stays covered by
`test/SlashDrillFork.t.sol`, which exercises freeze, uphold and reject against a fork of
the live deployment. Say in the write-up that it was rehearsed rather than performed.

Executing early fails, which is the guard that makes the window mean anything:

```bash
cast send <staking> "executeSlash(bytes32)" <TARGET_DID_HASH> --rpc-url arc_testnet --private-key <ANY_KEY>
# expect: ChallengePeriodActive(didHash, unlocksAt)
```

### Day 7: settle

Execution is permissionless. Anyone can call it, which is deliberate: the committee files,
but settlement does not depend on the committee acting again. It does depend on the key that
filed still being on the committee: `executeSlash` refuses a proposal whose reporter has been
revoked (`ReporterNotAuthorized`), so do not rotate the drill key before this step.

```bash
cast send <staking> "executeSlash(bytes32)" <TARGET_DID_HASH> \
  --rpc-url arc_testnet --private-key <ANY_FUNDED_KEY>
```

Then verify every consequence:

```bash
cast call <staking> "getStake(bytes32)(uint256)" <TARGET_DID_HASH> --rpc-url arc_testnet     # 0
cast call <identity> "identities(bytes32)" <TARGET_DID_HASH> --rpc-url arc_testnet           # status 2 = Slashed
cast call <reputation> "getTotalScore(bytes32)(uint8)" <TARGET_DID_HASH> --rpc-url arc_testnet # 0
cast call <staking> "claimable(address)(uint256)" <VICTIM> --rpc-url arc_testnet             # 25%
cast call <svr> "balanceOf(address)(uint256)" 0x000000000000000000000000000000000000dEaD --rpc-url arc_testnet
```

75% is burned to `0xdead` and 25% goes to the victim; the reporter gets nothing. (The drill
in September and October ran on the first split: 50% burned, 25% victim, 25% reporter.) Proceeds are credited rather than pushed, so claim them to show
the last step works:

```bash
cast send <staking> "claimSlashProceeds()" --rpc-url arc_testnet --private-key <VICTIM_KEY>
```

## What to publish

The point is the write-up, not the transaction. Include:

- Every transaction hash with explorer links: initiate, any dispute, execute, claim.
- The agent's score before and after, and its status before and after.
- The arithmetic: stake taken, amount burned, amount to victim, amount to reporter, and
  that the three sum to the stake.
- The timestamps, showing the seven days actually elapsed and that early execution was
  refused.
- That it was a drill, stated first rather than in a footnote.

Put it in `docs/` and link it from the whitepaper's roadmap, item 2.

## What this does and does not prove

**Does:** that the slashing path works end to end on a live deployment, that the challenge
window is enforced, that a slashed agent is terminal and unscored, and that the proceeds
split matches what the documentation claims.

**Does not:** that the committee will act correctly against a real adversary. The committee
is a single EOA on testnet, the drill is self-administered, and the target is one you
created. It demonstrates the mechanism, not the governance. Say so in the write-up. A drill
presented as a governance proof is the kind of overclaim the rest of these documents exist
to avoid.

## The adversarial drill

The drill above took one slash down the happy path: filed, left alone, executed. Every other way
a proposal ends had been tested only in a clean-room deploy. This one takes them on the live
deployment, against three agents bonded for the purpose, starting 3 November 2026. What happened
goes in [slash-drill-log.md](slash-drill-log.md); what is expected is written here first, so a
result that differs is a finding rather than something explained afterwards.

| Agent | What is done to it | How it should end |
|---|---|---|
| A | Filed, disputed by its operator, dropped by the admin (`resolveDispute(false)`). Refiled on day 7 with new evidence, then withdrawn (`cancelSlash`). | Bond intact, Active. |
| B | Filed, vetoed by the admin (`vetoSlash`). | Bond intact, Active. |
| C | Filed and left alone. Expired by anyone once it lapses (`expireSlash`). | Bond intact, Active. |

Rehearsed first: [`test/SlashDrillAdversarialFork.t.sol`](../test/SlashDrillAdversarialFork.t.sol)
runs the whole sequence, guards included, against a fork of Arc testnet, from setting up the
agents the way the live drill does to day 21. Both of its cases pass.

```bash
forge test --match-contract SlashDrillAdversarialFork -vv
```

### Who signs

| Role | Address | Signs |
|---|---|---|
| Committee | `0x045D6C1d8404297F13596061388f6598fA94a5b7` | The filings, and the day-7 withdrawal |
| Admin | `0x18CBcE50390f5f6ebe4E20Fc17833F25c8D94811` (the deployer) | `vetoSlash(B)` and `resolveDispute(A, false)` |
| Drill operator | `0x11bbb7764D215c7Ab2E7c677283E226D599ce956` | Registers and bonds A, B and C, disputes A, expires C. Holds no role. Named as the victim in every filing, since the victim may not be a committee member. |
| Agents | A `0xa656eBa21833c208B5Dbe3faFf4F6438b4Cc39E7`, B `0x52900e0ec5ca59B9e57327e0c6Ba1f7B8fd88A80`, C `0xebc125b2AB79586299BF2274582C6f63dB6300F8` | Each signs its own registration, once |

The explorer marks the drill operator and its agents as Sigvara's own. Each signer runs its part with
[`scripts/slash-drill-adversarial.sh`](../scripts/slash-drill-adversarial.sh), which reads the key
from the terminal and checks the chain before it sends anything:

```bash
sh scripts/slash-drill-adversarial.sh status            # any time, no key
sh scripts/slash-drill-adversarial.sh operator-setup    # faucet 3,000 SVR, register and bond A, B, C
sh scripts/slash-drill-adversarial.sh committee-day0    # file A, B, C
sh scripts/slash-drill-adversarial.sh operator-dispute  # dispute A, with the guards either side
sh scripts/slash-drill-adversarial.sh admin-day0        # veto B, then drop A once it is disputed
sh scripts/slash-drill-adversarial.sh guards-day0       # the cooldowns, C too early; no key
sh scripts/slash-drill-adversarial.sh guards-day7       # before refiling: rejected evidence, C late; no key
sh scripts/slash-drill-adversarial.sh committee-day7    # A again with new evidence, then withdraw
sh scripts/slash-drill-adversarial.sh anyone-day21      # expire C, with the guards after it
```

### Predictions

The guards are checked with `cast call` from the account named, which costs nothing and shows the
revert the contract gives. The script runs each at the moment it has to: the admin's early uphold,
for instance, only while A is disputed and not yet dropped.

| When | Step | Expected |
|---|---|---|
| Day 0 | Bond each agent with 1,000 SVR | `PendingBond` to `Active` |
| Day 0 | File A, B, C | `SlashInitiated` each; all three `Suspended` at once |
| Day 0 | Committee names itself the victim | `VictimIsReporter` |
| Day 0 | Anyone but A's operator disputes A | `NotOperator` |
| Day 0 | Operator disputes A | `SlashDisputed`; A stays `Suspended`, its bond frozen |
| Day 0 | Admin upholds A inside the window | `ChallengePeriodActive` |
| Day 0 | Admin drops A (`resolveDispute(A, false)`) | `SlashCancelled`; A `Active`, 1,000 SVR still bonded |
| Day 0 | Committee files A again at once | `SlashCooldownActive`, with a refile time 7 days after the drop |
| Day 0 | Admin vetoes B | `SlashCancelled` and `SlashVetoed`; B `Active`, bond intact; refiling blocked for 7 days |
| Day 0 | Anyone executes or expires C | `ChallengePeriodActive`; `ExecutionPeriodActive` |
| Day 7 | Committee refiles A with the evidence the admin dropped | `EvidenceAlreadyRejected` |
| Day 7 | Committee refiles A with new evidence, then withdraws it | `SlashInitiated`, then `SlashCancelled`; A `Active` |
| Day 7 | C's operator disputes after C's deadline | `ChallengePeriodExpired` |
| Days 7 to 21 | Anyone may still execute C | See below |
| Day 21 | Anyone expires C before it lapses, then after | `ExecutionPeriodActive`, then `SlashCancelled`; C `Active`, bond intact |
| Day 21 | Committee files C again | `SlashCooldownActive` |

Day 7 is one challenge period (`challengePeriod()`, 604800 seconds) after day 0. Day 21 is C's
deadline plus `EXECUTION_PERIOD` (14 days). The exact times are in the transactions.

**The one exposure.** For two weeks after its deadline, C is a proposal nobody disputed, and
anyone may execute it, as the protocol intends: execution must not wait on the committee. A
passer-by who does burns 750 SVR of C's bond and pays 250 to the drill operator as the named
victim, and the expire path goes unshown until a rerun. The rehearsal checks this case too
(`test_lapsingProposalIsExecutableUntilItLapses`). If it happens, the log says so: it is the
protocol working, not the drill failing.

**What this proves and what it does not.** It shows each way out of a slash working on the live
deployment, with each guard firing when it should. It does not show that the admin rules well or
that the committee files in good faith: one person holds both keys on testnet, as above, and both
the accuser and the accused are ours.
