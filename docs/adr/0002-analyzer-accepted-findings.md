# ADR 0002 — Accepted static-analysis findings

**Status:** Accepted · 2026-09-17

## Context

Foundry's linter and Slither both flag patterns in the contracts that are
intentional. Slither now runs in CI and fails the build on High findings only,
so Medium and Low findings need a written disposition rather than a silent
warning an auditor discovers cold. This record lists what was reviewed, why
it stays, and what would change the decision.

Slither 0.11.5 over `src/` on 17 September 2026 reported 16 findings: 0 High,
4 Medium, 10 Low, 2 Informational.

## Accepted

### `timestamp` (Low, 10 sites)

`block.timestamp` gates the slash challenge period (7 days), the unbonding
period (21 days), the score challenge window (6 hours) and the oracle-bond
unbonding period. Validators can skew a block's timestamp by seconds. None of
these windows is short enough for that skew to matter: the smallest is 6 hours,
about four orders of magnitude above the skew a block producer controls.
Block-number windows would trade this for a dependency on the target chain's
block cadence, which on Arc is sub-second and not fixed. Timestamps stay.

Reconsider if any window is ever set below a few minutes.

### `incorrect-equality` (Medium, 3 sites)

- `SigvaraStaking.initiateWithdrawal` and `claimWithdrawal` test
  `unbondingAmount != 0` / `== 0` to detect a queued withdrawal.
- `SigvaraOracleBond.isActiveOperator` compares an enum to `Status.Active`.

Slither flags strict equality because balances derived from external token
transfers can be off by dust. Neither site compares a token balance: one is a
contract-owned accounting field that is only ever set to an exact amount or
zero, the other is an enum. Accepted.

### `unindexed-event-address` (Informational, 2 sites)

Event address parameters that are not `indexed`. Indexing changes the ABI of
already-deployed testnet contracts' events and the oracle's log parsing; not
worth a breaking change for a filtering convenience. Revisit at the next
event-signature change.

## Fixed

### `uninitialized-local` (Medium, 1 site)

`SigvaraOracleBond.slash` declared `bool demoted;` and assigned it only in one
branch. Solidity zero-initialises locals so behaviour was correct, but the
explicit `= false` removes the finding and the ambiguity. Fixed in the same
change that introduced this ADR.

## Consequences

- CI fails on High findings only. Anything Medium or Low that is new must be
  either fixed or added to this list in the same pull request.
- The audit brief should point the auditor at this file so time is not spent
  re-deriving these dispositions.
