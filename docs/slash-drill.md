# Slash drill

Executing one slash in public, end to end, on Arc testnet, and publishing what happened.

Sigvara's claim is that reputation carries weight because misbehaviour costs capital. The
contracts implement that and 246 tests cover it, but nobody has ever watched a bond
actually get taken. Until they have, the consequence half of the protocol is an assertion.
This closes that.

Budget **seven days**. `challengePeriod()` is 604800 seconds, and there is no way to
shorten it. That makes this the long pole in front of anything that depends on the
protocol looking finished.

## Rehearsed first

[`test/SlashDrillFork.t.sol`](../test/SlashDrillFork.t.sol) runs this whole path against a
fork of the live deployment, so the sequence below is a replay of something that already
worked rather than a first attempt:

```bash
forge test --match-contract SlashDrillFork -vv
```

Six cases pass: the full path, the too-early guard, dispute-freezes, dispute-upheld,
dispute-rejected, and the queued-withdrawal escape attempt. It forks rather than deploying
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
Confirm custody **before** step 1. A proposal filed with no way to resolve it leaves an
agent suspended and its bond frozen until someone calls `cancelSlash`, which needs the
same key.

**Do not target the demo agent.** `0x8414ce0b…` is the agent the site, the on-ramp and the
whitepaper all point at, with a live score of 12 and a public evidence root. Slashing it
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
it holds is burned. Registering the target is step 0 of the drill and it costs a real
1,000 SVR that does not come back.

**Pick a victim address that is not the reporter.** `initiateSlash` reverts with
`VictimIsReporter` if they match, because one committee signature would otherwise be a 50%
self-payment out of the accused's stake. A second throwaway is fine.

**Leave the oracle alone.** The primary oracle's bond currently sits at exactly
`bondAmount`, so it qualifies by equality. It is not the target here, but be aware that any
slash against it would drop it below the floor and stop it proposing at the next epoch.

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

This is the part worth showing. The agent can dispute:

```bash
cast send <staking> "disputeSlash(bytes32)" <TARGET_DID_HASH> \
  --rpc-url arc_testnet --private-key <TARGET_OPERATOR_KEY>
```

Disputing **freezes** the bond rather than releasing it, and does not un-suspend the agent.
The committee then resolves with `resolveDispute(didHash, uphold)`. If it never does,
anyone may call `expireDispute` after `DISPUTE_RESOLUTION_PERIOD` (14 days), so an operator
is never hostage to committee silence.

Whether you exercise the dispute branch is a choice. Doing it demonstrates more of the
mechanism; skipping it keeps the drill to seven days instead of potentially twenty-one.

Executing early fails, which is the guard that makes the window mean anything:

```bash
cast send <staking> "executeSlash(bytes32)" <TARGET_DID_HASH> --rpc-url arc_testnet --private-key <ANY_KEY>
# expect: ChallengePeriodActive(didHash, unlocksAt)
```

### Day 7: settle

Execution is permissionless. Anyone can call it, which is deliberate: the committee files,
but settlement does not depend on the committee still being around.

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

The split is 50% burned to `0xdead`, 25% to the victim, 25% to the reporter. Proceeds are
credited rather than pushed, so claim them to show the last step works:

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

Put it in `docs/` and link it from the whitepaper's roadmap, where item 2 currently says a
public slash does not exist yet.

## What this does and does not prove

**Does:** that the slashing path works end to end on a live deployment, that the challenge
window is enforced, that a slashed agent is terminal and unscored, and that the proceeds
split matches what the documentation claims.

**Does not:** that the committee will act correctly against a real adversary. The committee
is a single EOA on testnet, the drill is self-administered, and the target is one you
created. It demonstrates the mechanism, not the governance. Say so in the write-up. A drill
presented as a governance proof is the kind of overclaim the rest of these documents exist
to avoid.
