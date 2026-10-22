# ADR 0005: Who can do what in an emergency, and who can stop whom

**Status:** Accepted · 2026-10-22

## Context

Two outside security reviews of `main` at `1177e25` agreed on one theme. The upgrade path was
gated (a self-administered `UPGRADER_ROLE` behind a 48 hour timelock), but a good deal else
was not:

- the admin Safe could repoint what decides who counts as bonded (`setStakeView`) or switch the
  bonded-operator check off (`setOperatorBond(0)`) in one transaction, which changes behaviour
  about as much as an upgrade;
- the committee both filed slashes and was the only party that could drop one, and a slash pays a
  quarter of the bond to whoever filed it and a quarter to the victim it names;
- the committee could drop a proposal and file the next in the same block, so a stake could be held
  frozen for good;
- there was no way to stop new value or new state entering a registry while a bug was being fixed,
  and the only fix is a timelocked upgrade, 48 hours away;
- the epoch-fee module charges an agent in a call that is separate from the score it pays for, and cuts
  epochs on calendar boundaries, so an agent can be charged for an epoch in which nothing was scored,
  and two charges can land seconds apart across a boundary. Neither matters while the fee is zero.
  Both do once it is not.

This ADR records what was decided about each, and what was left as a stated trust assumption.

## Decisions

1. **Wiring that decides who counts as bonded is upgrade-class.** `SigvaraIdentity.setStakeView` and
   `SigvaraReputation.setOperatorBond` require `UPGRADER_ROLE`, which the timelock holds, instead of
   the admin role. After the handover the admin Safe cannot make either call; it schedules it on the
   timelock and it executes after the delay. Both are tested through a real `TimelockController`.
2. **A second key can stop a slash.** `SigvaraStaking.vetoSlash(didHash)` lets the admin drop a
   Pending proposal, including after its challenge deadline and before anyone executes it, or a
   Disputed one. The committee accuses and rules; the admin Safe is a separate key that can stop it.
   It adds no power the admin did not have (it can grant itself the committee role), so the change
   is to make the check explicit and usable without a grant in the middle of an incident.
3. **The committee cannot file again at once.** Every drop (cancelled, vetoed, expired after a
   dispute, resolved in the agent's favour) records `lastDroppedAt`, and `initiateSlash` refuses
   for one challenge period after it. An operator always gets a window to act, and a withdrawal it
   queues in that window stays slashable.
4. **Floors are enforced where the value is set.** The reputation challenge window (one hour), the
   bond registry's unbonding period (one day) and bond requirement (above zero), staking's challenge
   (three days) and unbonding (one day) periods, and a minimum stake above zero are refused in the
   initializers as well as the setters.
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

## What stays on the admin Safe, and why

Role grants and revocations, and every parameter that now has a floor, stay on the admin Safe and are
not delayed. A compromised admin Safe can therefore still grant itself the committee, slasher or
oracle role at once. That is a stated trust assumption, not an oversight:

- Delaying grants would mean a 48 hour wait before a replacement oracle key could be enabled in an
  incident, which is the moment it is needed.
- Revocation is instant and must stay so.
- The remaining protection is the committee's challenge period on every slash, the admin veto above,
  the floors, and the Safe itself: its threshold and owners are verified on chain before launch and
  published.

## Consequences

- A change of stake view or operator registry takes 48 hours of notice. A redeployed staking
  contract is therefore a scheduled operation, not an instant one.
- The audit pack lists the veto as an admin power, the two setters as upgrade-class, and the guardian.
- A pause can be used against the protocol by a compromised guardian: it can close new registrations,
  deposits, proposals and bonds for three of every four days until the admin revokes it. That is a
  nuisance with an instant remedy, and the price of being able to stop a live bug while a fix is built.
- Mainnet launches without `SigvaraEpochFees`. The oracle's `FEE_REGISTRY_ADDRESS` stays unset and the
  app's fee controls stay off, as they are on testnet today. Turning fees on later is a new deployment
  of a reworked module, not a switch.
