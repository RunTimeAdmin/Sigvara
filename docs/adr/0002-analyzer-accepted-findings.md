# ADR 0002 — Accepted static-analysis findings

**Status:** Accepted · 2026-09-17

## Context

Foundry's linter and Slither both flag patterns in the contracts that are
intentional. Slither now runs in CI and fails the build on High findings only,
so Medium and Low findings need a written disposition rather than a silent
warning an auditor discovers cold. This record lists what was reviewed, why
it stays, and what would change the decision.

Slither 0.11.5 over `src/` on 17 September 2026 reported 16 findings: 0 High,
4 Medium, 10 Low, 2 Informational. After the dispute-freeze change it reports
16 again (3 Medium, 11 Low, 2 Informational): `expireDispute` joined the same
timestamp class, and the previously listed uninitialized-local was fixed.

On 22 October 2026, after the operator-custody change (signer registry, stored
proposer, once-per-epoch charge), it reports 27: 0 High, 4 Medium, 17 Low,
6 Informational. Four are new in that change and are dispositioned below under
"Added with the operator-custody change". One Informational finding went away:
`SigvaraOracleBond` now inherits `IOperatorSet`. The older counts above were
not re-derived.

## Accepted

### `timestamp` (Low, 11 sites)

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

### Added with the operator-custody change

- `incorrect-equality` (Medium), `SigvaraOracleBond._isFree`: an enum compared
  to `Status.None` and two mapping entries compared to `address(0)`, to decide
  whether an address is unused by the registry. Same class and same
  disposition as `isActiveOperator` above: no token balance is compared.
- `timestamp` (Low), `SigvaraEpochFees.chargeEpoch`: `last / length >= epoch`,
  where an epoch is `block.timestamp / length`. This is the once-per-epoch
  limit, and it is a real use of the clock. The epoch length has a floor of one
  hour (`MIN_EPOCH_LENGTH`), so a few seconds of skew moves a boundary by a few
  seconds, and a charge landing in the neighbouring epoch is bounded by the
  same limit. Reconsider if the floor is ever lowered to minutes.
- `timestamp` (Low), `SigvaraOracleBond._isFree` and `setSigner`: neither reads
  the clock. Slither follows the `operators` mapping, whose struct also holds
  `unbondingAt`, and treats a read of any field as a read of the timestamp.
  False positives, listed so that nobody has to re-derive that.

### Added with the review fixes

- `timestamp` (Low), `InflowGuard.pauseInflows`, `resumeInflows`, `inflowsPaused`
  and the `whenInflowsOpen` modifier: a pause lasts three days and the cooldown
  before the next one is a day. The shortest window is a day, several orders of
  magnitude above the skew a block producer controls, and a few seconds either
  way moves the end of a pause by a few seconds. Reconsider if either figure is
  ever set below a few minutes.
- `timestamp` (Low), `SigvaraStaking.initiateSlash`: the re-file cooldown
  compares the clock with the time of the last dropped proposal plus one
  challenge period, which has a floor of three days. Same disposition as the
  challenge period above.
- `assembly` (Informational), `InflowGuard._inflowGuard`: one line that points a
  storage struct at the ERC-7201 slot, the pattern OpenZeppelin's upgradeable
  contracts use for namespaced storage. A test recomputes the slot from the
  namespace string.
- `timestamp` (Low), `SigvaraStaking.expireSlash`: a slash proposal that nobody executed
  or cancelled lapses 14 days after its challenge deadline. The window is a
  fortnight, far above the skew a block producer controls, and a few seconds
  either way moves the end of it by a few seconds.

### Added with the fourth review's fixes

- `timestamp` (Low), `SigvaraStaking.resolveDispute`: an upheld ruling is refused until the
  challenge deadline fixed when the slash was filed, the moment `executeSlash` opens for an
  undisputed one. The deadline is at least three days out, far above the skew a block producer
  controls, and a few seconds either way moves it by a few seconds. Same disposition as the
  challenge period above.
- `timestamp` (Low), `SigvaraReader.isTrustedFresh`: the time since the score was last written
  is compared with the age the caller will accept. The caller chooses the age, and anything
  shorter than a few minutes is a poor choice whatever the skew, so a few seconds of it do not
  change an answer a caller can rely on.

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
