// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";

import "../src/SigvaraIdentity.sol";
import "../src/SigvaraReputation.sol";
import "../src/SigvaraStaking.sol";
import "../src/SigvaraOracleBond.sol";
import "../src/SVRToken.sol";

/**
 * A compromised admin Safe could grant itself SLASHER_ROLE, point the slash beneficiary at itself and
 * slash every operator's bond in one batch, with no delay: none of that is an upgrade, so the timelock
 * did not touch it. The roles that can take bonded funds or change an agent's standing, and the
 * beneficiary that decides where slashed funds go, are now granted only through the timelock. The admin
 * can still take any of them away at once.
 */
contract TimelockedGrantsTest is Test {
    bytes32 constant ADMIN_ROLE = 0x00;
    bytes32 constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 constant STAKING_CORE_ROLE = keccak256("STAKING_CORE_ROLE");
    bytes32 constant COMMITTEE_ROLE = keccak256("SLASHING_COMMITTEE_ROLE");
    bytes32 constant SLASHER_ROLE = keccak256("SLASHER_ROLE");
    bytes32 constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    bytes32 constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    uint256 constant DELAY = 48 hours;

    address deployer = makeAddr("deployer");
    address safe = makeAddr("safe");
    address committee = makeAddr("committee");
    address slasher = makeAddr("slasher");
    address treasury = makeAddr("treasury");
    address attacker = makeAddr("attacker");
    address stranger = makeAddr("stranger");

    TimelockController timelock;
    SigvaraIdentity identity;
    SigvaraReputation reputation;
    SigvaraStaking staking;
    SigvaraOracleBond bond;

    /// One row per (contract, role) pair that moves into the timelock.
    struct Pair {
        string name;
        address target;
        bytes32 role;
    }

    Pair[] internal pairs;

    function setUp() public {
        SVRToken svr = new SVRToken(address(this));
        identity = SigvaraIdentity(address(new ERC1967Proxy(
            address(new SigvaraIdentity()),
            abi.encodeCall(SigvaraIdentity.initialize, (deployer, address(0)))
        )));
        reputation = SigvaraReputation(address(new ERC1967Proxy(
            address(new SigvaraReputation()),
            abi.encodeCall(SigvaraReputation.initialize, (deployer, address(0), address(0), committee, 1 hours))
        )));
        staking = SigvaraStaking(address(new ERC1967Proxy(
            address(new SigvaraStaking()),
            abi.encodeCall(
                SigvaraStaking.initialize,
                (deployer, address(identity), address(reputation), address(svr), 1000e18, 7 days, 21 days)
            )
        )));
        bond = SigvaraOracleBond(address(new ERC1967Proxy(
            address(new SigvaraOracleBond()),
            abi.encodeCall(SigvaraOracleBond.initialize, (deployer, slasher, address(svr), 1000e18, 7 days, treasury))
        )));

        pairs.push(Pair("identity STAKING_CORE", address(identity), STAKING_CORE_ROLE));
        pairs.push(Pair("reputation STAKING_CORE", address(reputation), STAKING_CORE_ROLE));
        pairs.push(Pair("reputation COMMITTEE", address(reputation), COMMITTEE_ROLE));
        pairs.push(Pair("staking COMMITTEE", address(staking), COMMITTEE_ROLE));
        pairs.push(Pair("bond SLASHER", address(bond), SLASHER_ROLE));

        address[] memory proposers = new address[](1);
        proposers[0] = safe;
        address[] memory executors = new address[](1);
        executors[0] = address(0);
        timelock = new TimelockController(DELAY, proposers, executors, address(0));
    }

    /// The state after the handover: the Safe is admin and nothing else, the timelock is the upgrader, and
    /// the deployer holds neither.
    function _handover() internal {
        address[4] memory all = [address(identity), address(reputation), address(staking), address(bond)];
        for (uint256 i = 0; i < all.length; i++) {
            IAccessControl c = IAccessControl(all[i]);
            vm.startPrank(deployer);
            c.grantRole(ADMIN_ROLE, safe);
            c.grantRole(UPGRADER_ROLE, address(timelock));
            vm.stopPrank();
            vm.prank(safe);
            c.revokeRole(ADMIN_ROLE, deployer);
            vm.prank(deployer);
            c.renounceRole(UPGRADER_ROLE, deployer);
        }
    }

    function _schedule(address target, bytes memory data) internal returns (bytes32 salt) {
        salt = keccak256(data);
        vm.prank(safe);
        timelock.schedule(target, 0, data, bytes32(0), salt, DELAY);
    }

    function _execute(address target, bytes memory data) internal {
        timelock.execute(target, 0, data, bytes32(0), keccak256(data));
    }

    function _unauthorized(address who, bytes32 role) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, who, role);
    }

    // ---------------------------------------------------------------------
    // The arrangement
    // ---------------------------------------------------------------------

    function test_theFundMovingRolesAreAdministeredByTheUpgrader() public view {
        for (uint256 i = 0; i < pairs.length; i++) {
            assertEq(IAccessControl(pairs[i].target).getRoleAdmin(pairs[i].role), UPGRADER_ROLE, pairs[i].name);
        }
    }

    /// The oracle and the guardian stay with the admin: a replacement oracle key has to be enabled
    /// in an incident, neither role takes funds, and a pause is a nuisance with an instant remedy.
    function test_oracleAndGuardianGrantsStayWithTheAdmin() public view {
        assertEq(reputation.getRoleAdmin(ORACLE_ROLE), ADMIN_ROLE);
        address[4] memory all = [address(identity), address(reputation), address(staking), address(bond)];
        for (uint256 i = 0; i < all.length; i++) {
            assertEq(IAccessControl(all[i]).getRoleAdmin(GUARDIAN_ROLE), ADMIN_ROLE);
        }
    }

    /// The deployer holds both roles until the handover, so the deploy script's grants still work.
    function test_theDeployerCanStillGrantTheseRolesBeforeTheHandover() public {
        vm.startPrank(deployer);
        identity.grantRole(STAKING_CORE_ROLE, address(staking));
        staking.grantRole(COMMITTEE_ROLE, committee);
        bond.grantRole(SLASHER_ROLE, slasher);
        vm.stopPrank();
        assertTrue(staking.hasRole(COMMITTEE_ROLE, committee));
    }

    // ---------------------------------------------------------------------
    // After the handover
    // ---------------------------------------------------------------------

    /// The Safe cannot give any of these roles to anyone, itself included.
    function test_theAdminSafeCannotGrantThem() public {
        _handover();
        for (uint256 i = 0; i < pairs.length; i++) {
            vm.expectRevert(_unauthorized(safe, UPGRADER_ROLE));
            vm.prank(safe);
            IAccessControl(pairs[i].target).grantRole(pairs[i].role, safe);
            assertFalse(IAccessControl(pairs[i].target).hasRole(pairs[i].role, safe), pairs[i].name);
        }
    }

    /// The timelock can, after its delay, and not before.
    function test_theTimelockGrantsThemAfterTheDelay() public {
        _handover();
        for (uint256 i = 0; i < pairs.length; i++) {
            bytes memory data = abi.encodeCall(IAccessControl.grantRole, (pairs[i].role, stranger));
            _schedule(pairs[i].target, data);

            vm.expectRevert();
            _execute(pairs[i].target, data); // too early

            vm.warp(block.timestamp + DELAY);
            _execute(pairs[i].target, data);
            assertTrue(IAccessControl(pairs[i].target).hasRole(pairs[i].role, stranger), pairs[i].name);
            vm.warp(block.timestamp + 1);
        }
    }

    /// What the admin keeps: taking a role away at once, from a holder it did not grant to.
    function test_theAdminSafeCanRevokeThemAtOnce() public {
        vm.startPrank(deployer);
        staking.grantRole(COMMITTEE_ROLE, committee);
        bond.grantRole(SLASHER_ROLE, slasher);
        identity.grantRole(STAKING_CORE_ROLE, address(staking));
        vm.stopPrank();
        _handover();

        vm.startPrank(safe);
        staking.revokeRole(COMMITTEE_ROLE, committee);
        bond.revokeRole(SLASHER_ROLE, slasher);
        identity.revokeRole(STAKING_CORE_ROLE, address(staking));
        vm.stopPrank();
        assertFalse(staking.hasRole(COMMITTEE_ROLE, committee));
        assertFalse(bond.hasRole(SLASHER_ROLE, slasher));
        assertFalse(identity.hasRole(STAKING_CORE_ROLE, address(staking)));
    }

    /// Nobody else can revoke them: not a stranger, and not the holder's neighbour.
    function test_aStrangerCannotRevokeThem() public {
        vm.prank(deployer);
        bond.grantRole(SLASHER_ROLE, slasher);
        _handover();
        vm.expectRevert(_unauthorized(stranger, UPGRADER_ROLE));
        vm.prank(stranger);
        bond.revokeRole(SLASHER_ROLE, slasher);
        assertTrue(bond.hasRole(SLASHER_ROLE, slasher));
    }

    /// The exception is not a way around the one rule the timelock exists for: the admin still cannot
    /// touch UPGRADER_ROLE, and the admin role is still administered by itself.
    function test_theAdminSafeStillCannotTouchTheUpgraderRole() public {
        _handover();
        address[4] memory all = [address(identity), address(reputation), address(staking), address(bond)];
        for (uint256 i = 0; i < all.length; i++) {
            IAccessControl c = IAccessControl(all[i]);
            vm.expectRevert(_unauthorized(safe, UPGRADER_ROLE));
            vm.prank(safe);
            c.revokeRole(UPGRADER_ROLE, address(timelock));

            vm.expectRevert(_unauthorized(safe, UPGRADER_ROLE));
            vm.prank(safe);
            c.grantRole(UPGRADER_ROLE, safe);

            assertTrue(c.hasRole(UPGRADER_ROLE, address(timelock)));
        }
    }

    /// The other roles behave exactly as before: the Safe grants the oracle and the guardian at once.
    function test_theAdminSafeStillGrantsTheOracleAndTheGuardian() public {
        _handover();
        vm.startPrank(safe);
        reputation.grantRole(ORACLE_ROLE, stranger);
        bond.grantRole(GUARDIAN_ROLE, stranger);
        vm.stopPrank();
        assertTrue(reputation.hasRole(ORACLE_ROLE, stranger));
        assertTrue(bond.hasRole(GUARDIAN_ROLE, stranger));
    }

    // ---------------------------------------------------------------------
    // The slash beneficiary
    // ---------------------------------------------------------------------

    function test_theSlashBeneficiaryNeedsTheUpgrader() public {
        _handover();
        vm.expectRevert(_unauthorized(safe, UPGRADER_ROLE));
        vm.prank(safe);
        bond.setSlashBeneficiary(attacker);
        assertEq(bond.slashBeneficiary(), treasury);

        bytes memory data = abi.encodeCall(SigvaraOracleBond.setSlashBeneficiary, (stranger));
        _schedule(address(bond), data);
        vm.warp(block.timestamp + DELAY);
        _execute(address(bond), data);
        assertEq(bond.slashBeneficiary(), stranger);
    }

    function test_theSlashBeneficiaryStillRefusesTheZeroAddress() public {
        vm.prank(deployer);
        vm.expectRevert(SigvaraOracleBond.ZeroAddress.selector);
        bond.setSlashBeneficiary(address(0));
    }

    // ---------------------------------------------------------------------
    // The drain, as the review described it
    // ---------------------------------------------------------------------

    /// Grant itself the slasher role, point the beneficiary at itself, slash every bond. The first step
    /// is now refused, so nothing after it can run, and the second is refused on its own.
    function test_aCompromisedAdminSafeCannotDrainTheBonds() public {
        address op = makeAddr("operator");
        SVRToken token = SVRToken(address(bond.svr()));
        token.mint(op, 1000e18);
        vm.startPrank(op);
        token.approve(address(bond), type(uint256).max);
        bond.depositBond(1000e18);
        vm.stopPrank();
        _handover();

        vm.startPrank(safe); // the compromised admin
        vm.expectRevert(_unauthorized(safe, UPGRADER_ROLE));
        bond.grantRole(SLASHER_ROLE, safe);
        vm.expectRevert(_unauthorized(safe, UPGRADER_ROLE));
        bond.setSlashBeneficiary(safe);
        vm.expectRevert(_unauthorized(safe, SLASHER_ROLE));
        bond.slash(op, 1000e18);
        vm.stopPrank();

        assertEq(token.balanceOf(address(bond)), 1000e18, "the bond is untouched");
        assertEq(token.balanceOf(safe), 0);
    }
}
