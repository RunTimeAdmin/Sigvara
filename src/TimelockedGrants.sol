// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";

/**
 * @title TimelockedGrants
 * @notice A role that only the upgrader grants can still be taken away by the admin at once.
 *
 * @dev    Why it exists. A role that can take bonded funds, or change an agent's standing, is as
 *         consequential as an upgrade, and the admin Safe used to be able to grant it to itself in
 *         the next transaction, so the 48 hour timelock covered upgrades and nothing else. Those
 *         roles are now administered by UPGRADER_ROLE, which the timelock holds (each registry's
 *         initialize calls `_setRoleAdmin(role, UPGRADER_ROLE)`), so granting one takes the delay.
 *
 *         What this adds is the other direction. Left alone, a role's admin would also be the only
 *         one who could revoke it, and a compromised slasher would have to be removed through the
 *         same 48 hours it needs to do its damage. So the admin, which holds DEFAULT_ADMIN_ROLE,
 *         may revoke any role the upgrader administers, at once. It may not revoke UPGRADER_ROLE:
 *         that is the role the arrangement protects, and it stays out of the admin's reach.
 *
 *         There is no storage here. AccessControl keeps the role admins, and
 *         `getRoleAdmin(role) == UPGRADER_ROLE` is the whole test of whether a role is timelocked,
 *         so a proxy initialized by older code, whose roles are still administered by the admin,
 *         behaves exactly as it did.
 */
abstract contract TimelockedGrants is AccessControlUpgradeable {
    bytes32 private constant UPGRADER = keccak256("UPGRADER_ROLE");

    /// @inheritdoc AccessControlUpgradeable
    function revokeRole(bytes32 role, address account) public virtual override {
        if (role != UPGRADER && getRoleAdmin(role) == UPGRADER && hasRole(DEFAULT_ADMIN_ROLE, _msgSender())) {
            _revokeRole(role, account);
            return;
        }
        super.revokeRole(role, account);
    }
}
