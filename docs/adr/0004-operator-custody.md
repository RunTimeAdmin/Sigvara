# ADR 0004: The key that signs does not hold the bond

**Status:** Accepted · 2026-10-22

## Context

An oracle operator's signing key lives on a server. Until this change that key was also the
operator in `SigvaraOracleBond`, which owns the bond (`withdrawBond` pays `msg.sender`), and
nothing recorded who had made a pending proposal or limited how often an agent could be
charged. A stolen key could therefore:

- start an unbond and withdraw the whole bond after the cooldown, unless the committee slashed
  it inside seven days;
- leave a proposal behind that still finalized after the operator was removed and the role
  revoked, because finalizing never asked who had proposed;
- charge every prepaid epoch-fee balance, once per call, in a loop.

Separately, the admin Safe could grant itself `UPGRADER_ROLE` and upgrade in the next
transaction, which made the 48 hour timelock that holds the role a delay on the honest path and
nothing on a compromised admin.

## Options considered

| | Approach | Buys | Costs |
|---|---|---|---|
| Now | Alerts on `UnbondInitiated` and a seven day slash playbook | No contract change | A human inside seven days, every time |
| Near | Keep the bond on the key, move the key into a KMS or HSM | A key that cannot be copied | Not available on a rented VPS; the bond still sits behind one credential |
| **Right** | **The bond owner names a signer. The signer proposes, finalizes and charges; it never owns the bond** | **A stolen signer is revoked in one transaction by someone who is not on a server, and cannot move the bond** | **A registry in the bond contract, a stored proposer, an epoch key: contract changes, so audit scope** |

## Decision

1. **Signer registry.** An Active operator calls `setSigner(address)`; `isActiveOperator(signer)`
   then answers for that operator. Only Active operators can name one (otherwise anyone could
   reserve addresses they do not control), a signer cannot hold a bond or sign for two operators,
   and an operator cannot be named. `clearSigner()` works in any status. Naming a signer grants no
   role: `ORACLE_ROLE` stays a separate admin decision on each contract.
2. **Store the proposer and ask again at finalize.** `finalizeReputation` stays permissionless but
   refuses a proposal whose proposer no longer holds `ORACLE_ROLE` or is no longer an active
   operator or signer, and `proposeIfEmpty` may replace such a proposal. The check is live, not a
   snapshot taken at proposal time, because the point is that revoking a key takes effect at once.
   The price is that removing an operator strands what it proposed until a successor replaces it.
3. **One charge per agent per calendar epoch.** An epoch is `block.timestamp / epochLength`, so it
   is the same for every caller and a late run cannot shift later boundaries, which a rolling
   window would allow. A second charge reverts `AlreadyCharged` and a caller treats that as paid.
   `chargeEpoch` also checks the operator set, and refuses to charge at all until the epoch length
   has been set, so an upgrade that forgets the reinitializer fails closed.
4. **`UPGRADER_ROLE` administers itself.** The handover has the deployer grant admin to the Safe and
   upgrader to the timelock, the Safe revoke the deployer's admin, and only then the deployer
   renounce upgrader. The script will not renounce until it finds the revocation on chain, which is
   the evidence that the Safe can execute against these contracts.

## Consequences

- An operator that names no signer behaves exactly as before.
- The primary replaces a stranded proposal only after its window has passed, because it looks at an
  agent only then; a checking operator replaces it at once. Scores stay as they were meanwhile.
- Reinitializers are `DEFAULT_ADMIN_ROLE`-gated, and the timelock is not the admin, so a timelocked
  upgrade cannot carry one: it lands with empty data and the Safe calls the reinitializer in a
  second transaction. A new reinitializer needs an unset state that fails closed.
- Proxies initialised before this change keep the old role admin. Mainnet is a fresh deployment, and
  `script/SplitAuthority.s.sol` reports any registry that is not self-administered.
- `removeOperator` does not release the signer. The address stays reserved until the operator
  withdraws or is slashed to nothing.
- The oracle names `ProposerNotAuthorized` and `AlreadyCharged` from the revert data, not from
  ethers' decoding: a send that fails at gas estimation reaches it with the data and no name.
