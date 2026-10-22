// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";

import "../src/SigvaraIdentity.sol";
import "../src/SigvaraReputation.sol";
import "../src/SigvaraStaking.sol";
import "../src/SigvaraOracleBond.sol";
import "../src/SigvaraEpochFees.sol";
import "../src/SVRToken.sol";

/**
 * The admin Safe could grant itself UPGRADER_ROLE and upgrade in the next transaction,
 * which made the 48 hour timelock a delay on the honest path and nothing on a compromised
 * admin. Every registry now initializes with UPGRADER_ROLE as its own admin.
 *
 * test/SplitAuthority.t.sol runs the whole handover and shows the Safe refused at the end.
 * These pin the property on each of the five contracts on its own.
 */
contract UpgraderRoleAdminTest is Test {
    bytes32 constant ADMIN_ROLE = 0x00;
    bytes32 constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    address admin = makeAddr("admin");
    address safe = makeAddr("safe");
    address timelock = makeAddr("timelock");
    address stranger = makeAddr("stranger");

    address[5] internal proxies;
    string[5] internal names = ["identity", "reputation", "staking", "oracleBond", "epochFees"];

    function setUp() public {
        SVRToken svr = new SVRToken(address(this));
        address identity = address(new ERC1967Proxy(
            address(new SigvaraIdentity()),
            abi.encodeCall(SigvaraIdentity.initialize, (admin, address(0)))
        ));
        address reputation = address(new ERC1967Proxy(
            address(new SigvaraReputation()),
            abi.encodeCall(SigvaraReputation.initialize, (admin, address(0), address(0), address(0), 1 hours))
        ));
        address staking = address(new ERC1967Proxy(
            address(new SigvaraStaking()),
            abi.encodeCall(SigvaraStaking.initialize, (admin, identity, reputation, address(svr), 1000e18, 7 days, 21 days))
        ));
        address bond = address(new ERC1967Proxy(
            address(new SigvaraOracleBond()),
            abi.encodeCall(SigvaraOracleBond.initialize, (admin, address(0), address(svr), 1000e18, 7 days, admin))
        ));
        address fees = address(new ERC1967Proxy(
            address(new SigvaraEpochFees()),
            abi.encodeCall(SigvaraEpochFees.initialize, (admin, address(0), address(svr), identity, admin, 0))
        ));
        proxies = [identity, reputation, staking, bond, fees];
    }

    function test_upgraderRoleAdministersItself() public view {
        for (uint256 i = 0; i < proxies.length; i++) {
            assertEq(IAccessControl(proxies[i]).getRoleAdmin(UPGRADER_ROLE), UPGRADER_ROLE, names[i]);
        }
    }

    function test_deployerKeepsBothRolesAtDeploy() public view {
        for (uint256 i = 0; i < proxies.length; i++) {
            assertTrue(IAccessControl(proxies[i]).hasRole(ADMIN_ROLE, admin), names[i]);
            assertTrue(IAccessControl(proxies[i]).hasRole(UPGRADER_ROLE, admin), names[i]);
        }
    }

    /// The case the change exists for. An account with DEFAULT_ADMIN_ROLE and nothing else
    /// cannot give itself the role, cannot take it from the timelock, and cannot upgrade.
    function test_anAdminThatIsNotAnUpgraderCannotUpgradeOrGrantItselfTheRole() public {
        address freshImpl = address(new SigvaraStaking());

        for (uint256 i = 0; i < proxies.length; i++) {
            IAccessControl c = IAccessControl(proxies[i]);
            vm.startPrank(admin);
            c.grantRole(ADMIN_ROLE, safe);
            c.grantRole(UPGRADER_ROLE, timelock);
            vm.stopPrank();
            assertTrue(c.hasRole(ADMIN_ROLE, safe), names[i]);
            assertFalse(c.hasRole(UPGRADER_ROLE, safe), names[i]);

            vm.startPrank(safe);
            vm.expectRevert(abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, safe, UPGRADER_ROLE
            ));
            c.grantRole(UPGRADER_ROLE, safe);

            vm.expectRevert(abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, safe, UPGRADER_ROLE
            ));
            c.revokeRole(UPGRADER_ROLE, timelock);

            vm.expectRevert(abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, safe, UPGRADER_ROLE
            ));
            IUpgradeable(proxies[i]).upgradeToAndCall(freshImpl, "");
            vm.stopPrank();

            assertFalse(c.hasRole(UPGRADER_ROLE, safe), names[i]);
            assertTrue(c.hasRole(UPGRADER_ROLE, timelock), names[i]);
        }
    }

    /// The holders of the role administer it: that is how the timelock hands it on, and how
    /// the deployer gives it to the timelock to begin with.
    function test_anUpgraderCanGrantAndRevokeTheRole() public {
        for (uint256 i = 0; i < proxies.length; i++) {
            IAccessControl c = IAccessControl(proxies[i]);
            vm.prank(admin);
            c.grantRole(UPGRADER_ROLE, timelock);
            assertTrue(c.hasRole(UPGRADER_ROLE, timelock), names[i]);

            vm.prank(timelock);
            c.grantRole(UPGRADER_ROLE, stranger);
            assertTrue(c.hasRole(UPGRADER_ROLE, stranger), names[i]);

            vm.prank(timelock);
            c.revokeRole(UPGRADER_ROLE, stranger);
            assertFalse(c.hasRole(UPGRADER_ROLE, stranger), names[i]);
        }
    }

    /// Only that one role moved. Admin still administers every other role, and itself.
    function test_everyOtherRoleIsStillAdministeredByAdmin() public view {
        for (uint256 i = 0; i < proxies.length; i++) {
            assertEq(IAccessControl(proxies[i]).getRoleAdmin(ADMIN_ROLE), ADMIN_ROLE, names[i]);
        }
        assertEq(IAccessControl(proxies[1]).getRoleAdmin(keccak256("ORACLE_ROLE")), ADMIN_ROLE);
        assertEq(IAccessControl(proxies[1]).getRoleAdmin(keccak256("SLASHING_COMMITTEE_ROLE")), ADMIN_ROLE);
        assertEq(IAccessControl(proxies[1]).getRoleAdmin(keccak256("STAKING_CORE_ROLE")), ADMIN_ROLE);
        assertEq(IAccessControl(proxies[3]).getRoleAdmin(keccak256("SLASHER_ROLE")), ADMIN_ROLE);
        assertEq(IAccessControl(proxies[4]).getRoleAdmin(keccak256("ORACLE_ROLE")), ADMIN_ROLE);
    }

    /// A deployer that renounces upgrader leaves nobody able to grant it but its holders:
    /// pinned so the consequence of the change is stated, since it is the reason the
    /// handover grants upgrader to the timelock while the deployer still holds it.
    function test_renouncingTheLastUpgraderFreezesTheRoleForGood() public {
        for (uint256 i = 0; i < proxies.length; i++) {
            IAccessControl c = IAccessControl(proxies[i]);
            vm.prank(admin);
            c.renounceRole(UPGRADER_ROLE, admin);

            vm.prank(admin); // still the admin
            vm.expectRevert(abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, admin, UPGRADER_ROLE
            ));
            c.grantRole(UPGRADER_ROLE, admin);
        }
    }
}

interface IUpgradeable {
    function upgradeToAndCall(address newImplementation, bytes calldata data) external payable;
}
