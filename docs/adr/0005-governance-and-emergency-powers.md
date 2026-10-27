# ADR 0005: Who can do what in an emergency, and who can stop whom

**Status:** Accepted · 2026-10-22

## Context

Two outside security reviews of `main` at `1177e25` agreed on one theme. The upgrade path was
gated (a self-administered `UPGRADER_ROLE` behind a 48 hour timelock), but a good deal else
was not:

- the admin Safe could repoint what decides who counts as bonded (`setStakeView`) or switch the
  bonded-operator check off (`setOperatorBond(0)`) in one transaction, which changes behaviour
  about as much as an upgrade;
- the admin Safe could grant itself `SLASHER_ROLE`, point the slash beneficiary at itself and slash every
  operator's bond in one batch. None of that is an upgrade, so the timelock never saw it, and neither
  did the challenge period, because the bond registry slashes at once;
- nothing stopped one address from being both the slasher and the beneficiary, so a registry set up that
  way would take an operator's bond and pay itself;
- the committee both filed slashes and was the only party that could drop one, and a slash pays a
  quarter of the bond to whoever filed it and a quarter to the victim it names;
- the committee could drop a proposal and file the next in the same block, so a stake could be held
  frozen for good;
- the committee also ruled on the operator's dispute, and could uphold it the moment it was filed, which
  cut short the whole challenge period the admin's veto relies on. Moving the ruling to the admin did
  not by itself fix the timing: an upheld ruling had no deadline of its own, so a disputed slash could
  still be settled in the block its dispute was filed in, sooner than an undisputed one could;
- the reputation challenge window was read live when a score finalized or was rejected, so an admin
  who changed it moved the end of every proposal already pending;
- a slash proposal that nobody executed or cancelled never lapsed. Once its window closed the operator
  could no longer dispute it, so a stake could sit frozen until the admin vetoed it;
- there was no way to stop new value or new state entering a registry while a bug was being fixed,
  and the only fix is a timelocked upgrade, 48 hours away;
- the epoch-fee module charges an agent in a call that is separate from the score it pays for, and cuts
  epochs on calendar boundaries, so an agent can be charged for an epoch in which nothing was scored,
  and two charges can land seconds apart across a boundary. Neither matters while the fee is zero.
  Both do once it is not.

This ADR records what was decided about each, and what was left as a stated trust assumption.

## Decisions

1. **Wiring that decides who counts as bonded, and where slashed funds go, is upgrade-class.**
   `SigvaraIdentity.setStakeView`, `SigvaraReputation.setOperatorBond` and
   `SigvaraOracleBond.setSlashBeneficiary` require `UPGRADER_ROLE`, which the timelock holds, instead
   of the admin role. After the handover the admin Safe cannot make any of these calls; it schedules
   it on the timelock and it executes after the delay. Each is tested through a real
   `TimelockController`.
2. **A second key stops a slash and rules on disputes.** `SigvaraStaking.vetoSlash(didHash)` lets the
   admin drop a Pending proposal, including after its challenge deadline and before anyone executes
   it, or a Disputed one. `resolveDispute` is the admin's too: the committee files a slash and no longer
   rules on it, so nobody is accuser, judge and payee at once. A dispute cannot bring a slash forward
   either: `resolveDispute(didHash, true)` reverts until the challenge deadline fixed when the slash was
   filed has passed, which is the moment `executeSlash` opens for an undisputed slash, while dropping is
   open at any time. A dispute filed on the first day can be upheld from day 7 and expires on day 14. If
   the admin never rules, anyone can expire the dispute after 14 days and the agent keeps its stake. The
   committee still files and cancels.
3. **The committee cannot file again at once.** Every drop (cancelled, vetoed, expired after a
   dispute, resolved in the agent's favour) records `lastDroppedAt`, and `initiateSlash` refuses
   for one challenge period after it. An operator always gets a window to act, and a withdrawal it
   queues in that window stays slashable. Evidence the admin has ruled against, by a veto or by a
   ruling for the agent, is also refused for that agent from then on (`evidenceRejected`,
   `EvidenceAlreadyRejected`), so a re-file needs something new to point at. The committee chooses the
   evidence bytes, so this is a speed bump rather than a wall. A proposal the committee cancelled, that
   lapsed, or whose dispute expired unruled was never ruled against, and its evidence can be filed again.
4. **Floors and ceilings are enforced where the value is set.** The reputation challenge window (one
   hour), the bond registry's unbonding period (one day) and bond requirement (above zero), staking's
   challenge (three days) and unbonding (one day) periods, and a minimum stake above zero are refused in
   the initializers as well as the setters. So are values above a ceiling:

   | Parameter | Contract | Floor | Ceiling |
   | --------- | -------- | ----- | ------- |
   | Score challenge window | `SigvaraReputation` | 1 hour | 7 days |
   | Maturity rate | `SigvaraReputation` | above 0 | 100 points a day |
   | Slash challenge period | `SigvaraStaking` | 3 days | 30 days |
   | Unbonding period | `SigvaraStaking` | 1 day | 90 days |
   | Unbonding period | `SigvaraOracleBond` | 1 day | 90 days |

   The ceilings exist because the admin can change each of these at once and nothing else stood in the
   way of a typo or a compromised key. The bond registry's unbonding period is read when a withdrawal is
   claimed, so one huge value locks every queued exit, including those already waiting. Staking's is fixed
   when a withdrawal is queued, so there it locks only what is queued while it stands. A window or a rate near the
   integer limit overflows the sum that dates a proposal or the product that releases a score, which
   stops proposals or score reads. A rate of 100 a day already releases a whole score in a day, so a
   higher rate adds nothing. The ceilings are generous against the intended values (6 hours, 4 a day,
   7 days, 21 days, 7 days); raising one is a contract upgrade, which takes the timelock. The deploy
   scripts check them first on mainnet and name the variable.

   Staking's unbonding period is also the one period fixed per request. `initiateWithdrawal` records when
   the withdrawal becomes claimable (`unbondingClaimableAt`) and `claimWithdrawal` honours that, so a later
   change moves only the withdrawals queued after it. Before, the period was read at claim time, and the
   admin could release every waiting exit early by lowering it to its floor, or hold exits back by raising
   it, the way the challenge deadline of a slash and the review window of a score had already been fixed
   when they start. A withdrawal queued before the field existed has no record and keeps the old rule,
   its queue time plus the period in force when it is claimed. `SigvaraOracleBond` still reads its
   period when a withdrawal is claimed.
5. **A guardian can stop new inflows, and nothing else.** `GUARDIAN_ROLE` may call `pauseInflows()` on
   identity, staking, reputation and the bond registry. It closes only the ways something new enters:
   `registerAgent`, `depositStake`, `proposeReputation` and `proposeIfEmpty`, `depositBond`. It never
   touches withdrawals and claims, unbonding, disputes, rulings, slash execution, finalizing or
   rejecting a score already proposed, operator transfers, or any admin call, so a pause cannot hold
   anyone's funds or stop accountability. One pause lasts three days and ends by itself. That is longer
   than the 48 hour upgrade delay, so a pause can bridge an emergency upgrade. The next pause cannot
   begin until a day after the last one would have ended, counted from its start even if it was lifted
   early, so a guardian cannot hold inflows shut for good. The guardian or the admin can lift one early,
   and the admin revokes a guardian at once. The state sits in an ERC-7201 namespaced slot, so adding it
   to a live proxy shifts no existing variable. The guardian is a separate, lighter key: the deploy
   scripts require it on mainnet and refuse the deployer, the oracle, the committee and the slasher.
   The admin can grant itself the role, so this separates duties and adds no new trust assumption.
6. **The epoch-fee module is left out of launch and out of the first audit.** `SigvaraEpochFees` has
   never been deployed, and at launch its fee would be zero, so it would add a contract to deploy,
   operate and audit that does nothing yet. `script/DeployEpochFees.s.sol` now refuses on mainnet, with
   no override. The post-deploy checks (`scripts/check-mainnet.sh`, `scripts/check-role-holders.mjs`)
   treat `epochFees` as optional and say so when it is absent from the artifact. The contract and its
   tests stay in the repository. When fees are to be turned on, the charge moves into the proposal
   transaction, so a fee can only be paid by a score that was actually proposed, and the module is
   audited then.
7. **A slash nobody finishes lapses.** Once the challenge window closes the operator cannot dispute, and a
   Pending proposal that nobody executed or cancelled used to stay Pending for good, with the agent
   suspended and its withdrawals blocked. `expireSlash(didHash)` now lets anyone drop it 14 days after its
   deadline, the counterpart of `expireDispute`. Until then it can still be executed by anyone, and a
   slash worth executing is worth a fortnight, since the victim and the reporter are paid from it. A
   lapsed proposal is dropped like any other, so the agent is reinstated and the committee waits one
   challenge period before it can file again. The cooldown stays shorter than the unbonding period on
   purpose: a withdrawal queued after a drop stays slashable until it is claimed, so a cancelled slash
   cannot become a way to exit before the committee can re-file. What bounds a freeze is the lapse, not
   a longer cooldown.
8. **Roles that move funds or change an agent's standing are granted through the timelock.**
   `SLASHER_ROLE` on the bond registry, `SLASHING_COMMITTEE_ROLE` on staking and reputation, and
   `STAKING_CORE_ROLE` on identity and reputation are administered by `UPGRADER_ROLE`, as the upgrader
   role itself is, so granting one takes the 48 hour delay and the admin Safe cannot install a slasher
   or a committee member in the next transaction. The other direction stays instant: the admin can
   revoke any of them at once. The registries allow that through a small shared base,
   `TimelockedGrants`, which lets `DEFAULT_ADMIN_ROLE` revoke any role the upgrader administers, except
   `UPGRADER_ROLE` itself. Without it a compromised slasher would have to be removed through the same
   48 hours it needs to do its damage. `ORACLE_ROLE` and `GUARDIAN_ROLE` grants stay with the admin,
   for the reasons below.
9. **A score's review window is fixed when it is proposed.** `finalizeReputation` and
   `rejectReputation` used to read the live `challengeWindow`, so shortening it hurried a proposal past
   the committee's review and cut the time the committee had to reject it. `PendingScore.finalizableAt`
   is now set at proposal time to the time of the proposal plus the window in force then, and both calls
   read it, the way staking snapshots its challenge deadline. A proposal that was pending before the
   field existed reads zero and is judged against the live window, as it always was.
10. **The slasher is never the payee.** `SigvaraOracleBond` refuses one address as both the holder of
    `SLASHER_ROLE` and the slash beneficiary: in `initialize`, in every later grant of the role (the check
    sits in `_grantRole`, so a grant through the timelock is covered) and in `setSlashBeneficiary`. The
    slash itself stays immediate and partial, as before. `script/DeployOracleBond.s.sol` says so before
    anything is sent, so a deploy that states neither address now stops, since both default to the
    deployer. `scripts/check-mainnet.sh` adds what an address check can reach: the treasury is not the
    committee, holds no slasher role, and is not an owner of the admin Safe or of the committee Safe.
    Whether different addresses are different people cannot be read from the chain; the owner lists are
    confirmed by the signers, as for the other Safe checks.
11. **The mainnet scripts hold the launch amounts as floors.** `script/Deploy.s.sol` refuses a minimum
    stake under 10,000 SVR and `script/DeployOracleBond.s.sol` a bond under 2,500,000 SVR on chain 5042,
    the figures published in `docs/token.md`. Refusing only the exact testnet default stopped a forgotten
    variable and let a nominal figure through that merely differed from it. The contracts' setters stay
    free: both are parameters the admin Safe tunes after launch, and a floor in the contract would be
    argued again with every change in the token's price. What is fixed is the launch. Starting lower is
    an edit to a constant in a script, which is reviewed like any change. After launch,
    `scripts/check-mainnet.sh` compares the live figures with the targets, and the admin lowering either
    later is visible on chain as `minimumStake` and `bondAmount`; the Reader's `collateralized` follows
    `minimumStake`. The three places the figures are written (the scripts, the check and `docs/token.md`) are
    compared by `scripts/check-docs.mjs`, which fails the build when they differ.
12. **A slash is executed only while its reporter is still on the committee.** Execution stays
    permissionless, but `executeSlash` refuses a proposal whose reporter no longer holds
    `SLASHING_COMMITTEE_ROLE` (`ReporterNotAuthorized`). Decision 8 made revoking a committee member
    instant, as the remedy for a compromised key, but a revocation stopped only new filings: proposals
    already filed stayed Pending, anyone could execute them once their windows closed, and the revoked
    reporter was paid its quarter. The only way to stop them was a veto per agent inside a window that can
    be three days long. `SigvaraReputation` already holds a pending score to this rule, so an operator or
    governance can kill a stolen key's proposals at once, and staking now does the same. The proposal is
    not stranded: any current member can cancel it, anyone can expire it 14 days after its deadline, and
    the committee can file again after the cooldown. The admin's ruling on a disputed slash
    (`resolveDispute`) does not depend on the reporter, since it is a decision taken now by a key that is
    not the accuser. The cost is some of the liveness decision 7 protects: a slash whose reporter is
    removed before anyone executes it cannot be executed, so a committee about to be replaced should
    execute or cancel what is ripe before it revokes.

## What stays on the admin Safe, and why

The admin Safe grants `ORACLE_ROLE` and `GUARDIAN_ROLE`, revokes any role except `UPGRADER_ROLE`, and
sets every parameter that has a floor and a ceiling. None of that is delayed. A compromised admin Safe can
therefore still grant itself the oracle or guardian role at once, and move a parameter between its floor
and its ceiling. That is a stated trust assumption, not an oversight:

- Delaying the oracle grant would mean a 48 hour wait before a replacement oracle key could be enabled
  in an incident, which is the moment it is needed. Neither role takes funds: a score sits in a
  challenge window the committee can reject and dies when its proposer loses its role, and a guardian
  can only pause inflows, for three days at a time.
- Revocation is instant and must stay so.
- The roles that can take funds or change an agent's standing are no longer on this list (decision 8).
  A compromised admin Safe cannot install a slasher or a committee member, or route slashed funds,
  without 48 hours of public notice.
- The remaining protection is the committee's challenge period on every slash, the admin's veto and
  ruling above, the floors and ceilings, and the Safe itself: its threshold and owners are verified on chain before
  launch and published, and the admin Safe and the committee share no owner, because the veto and the
  ruling are a second key only if the two are different people (`scripts/check-mainnet.sh` fails if
  an address is an owner of both).

## Consequences

- A change of stake view, operator registry or slash beneficiary takes 48 hours of notice. A
  redeployed staking contract is therefore a scheduled operation, not an instant one, and so is
  replacing the committee or the slasher. Taking a role away is immediate.
- A delay protects funds only as far as notice helps: an agent's stake takes 21 days to leave and an
  operator's bond 7, and both stay slashable while they wait, so the 48 hours is time to see and
  respond, not time to get out.
- Changing the reputation window changes it for proposals made afterwards. One already pending keeps
  the end it was made under. A proposal that was pending when a proxy from before decision 9 is upgraded
  has no fixed end (`finalizableAt` reads zero) and is judged against the live window until it
  finalizes or is replaced. So clear the pending proposals before upgrading such a proxy, and do not
  change the window while one is pending. Mainnet is a fresh deployment and has none. The Arc testnet
  upgrade of 26 October 2026 carried two such proposals, and both finalized on the new code at the
  first checker epoch after their window ran out.
- Proxies initialised by the older code, the Arc testnet ones among them, keep the admin as the
  grantor of these roles. Mainnet is a fresh deployment, and `scripts/check-mainnet.sh` reads the
  role admins to confirm the arrangement. Their implementations were upgraded on 26 October 2026, so the slasher/payee
  guard now covers new grants and `setSlashBeneficiary`, but the upgrade does not re-check the
  pairing they were set up with.
- The audit pack lists the veto and the dispute ruling as admin powers, the two setters as upgrade-class,
  and the guardian.
- A slash that is legitimate has to be executed within 14 days of its deadline, or it lapses and has to
  be filed again after the cooldown, so it should be executed as soon as the window closes.
- Replacing the committee address (a new Safe, say) orphans the proposals of the one it replaces. They
  can no longer be executed by anyone, and lapse 14 days after their deadline unless a member of the new
  committee cancels them first (decision 12). Execute what is ripe, and cancel the rest, before the
  old address is revoked. The rule has applied on the Arc testnet proxies since the upgrade of 26 October
  2026.
- A dispute turns an automatic slash into one the admin has to uphold, and it cannot be upheld sooner
  than an undisputed slash could have been executed. Disputing buys the operator a ruling, never a
  faster loss.
- A pause can be used against the protocol by a compromised guardian: it can close new registrations,
  deposits, proposals and bonds for three of every four days until the admin revokes it. That is a
  nuisance with an instant remedy, and the price of being able to stop a live bug while a fix is built.
- Mainnet launches without `SigvaraEpochFees`. The oracle's `FEE_REGISTRY_ADDRESS` stays unset and the
  app's fee controls stay off, as they are on testnet today. Turning fees on later is a new deployment
  of a reworked module, not a switch.
