# ADR 0007: The committee takes no share of a slash

**Status:** Accepted · 2026-11-02. Built on main. The Arc testnet staking proxy still runs the
earlier split until it is upgraded to this version.

## Context

`SigvaraStaking` split a slashed agent bond three ways: 50% burned, 25% to the victim and 25% to
the reporter. The reporter is whichever `SLASHING_COMMITTEE_ROLE` member called `initiateSlash`, and
that member also names the victim. The only check on the victim was that it was not the reporter
itself.

So a member who filed a slash was paid a quarter of the bond for filing it. A member working with a
second address, or with another member named as the victim, could take half. The whitepaper gave the
reporter's share as the reward that makes finding misbehaviour worth doing, but the reporter is not a
member of the public reporting harm: it is the enforcer, and an enforcer paid from what it enforces
has a reason to enforce more. The docs elsewhere say nobody profits from slashing volume, which this
split did not make true.

## Decision

1. The reporter's share is burned. A slash now burns 75% and credits 25% to the victim. The burn
   absorbs rounding dust.
2. `initiateSlash` refuses a victim that holds `SLASHING_COMMITTEE_ROLE` (`VictimIsCommittee`), as
   well as the reporter itself (`VictimIsReporter`, unchanged). An address that has left the
   committee can be a victim again.
3. `SlashExecuted` carries the two amounts that exist: `burned` and `toVictim`.

## Consequences

- No committee member is paid by a slash. The committee's reason to act is its role, not the stake.
- A victim is still named by the member who files, so an outside address named in bad faith is
  possible. The accused operator sees the victim in `SlashInitiated` and can dispute; the admin rules
  and can veto. That is the check on it.
- Storage is unchanged, so the staking proxy upgrades in place. Credits already in `claimable` stay
  claimable. Until the upgrade, the testnet contract keeps the earlier split, and
  `test/SlashDrillFork.t.sol`, which checks the live deployment, keeps asserting it; that test
  changes with the upgrade.
- `SlashExecuted`'s signature changes. Nothing in this repository decodes it; an outside indexer
  that does sees the new topic from the upgrade on.
- Operator bonds are slashed through `SigvaraOracleBond.slash`, which sends the whole amount to
  `slashBeneficiary` and is not changed here. That address can never be a slasher.
