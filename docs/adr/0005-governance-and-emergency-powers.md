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
  and the only fix is a timelocked upgrade, 48 hours away.

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
- The audit pack lists the veto as an admin power and the two setters as upgrade-class.
- Two further decisions of the same review, an inflow-only pause and the deferral of the epoch-fee
  module, are recorded in this file when they land.
