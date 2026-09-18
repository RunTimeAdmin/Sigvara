// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";

import "../src/SigvaraIdentity.sol";
import "../src/SigvaraReputation.sol";
import "../src/SigvaraStaking.sol";

/// Minimal ERC20 for testing only.
contract MockSVRUpgrade is ERC20 {
    constructor() ERC20("Sigvara", "SVR") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/**
 * Upgrade path coverage.
 *
 * The slot-pinning tests in the per-contract suites prove that a mapping still
 * lives where it used to. These tests prove the other half: that an upgrade can
 * actually be performed, that only UPGRADER_ROLE can perform it, and that live
 * state written before the upgrade reads back identically afterwards. Without
 * these, the most dangerous operation in the system was unexercised.
 */
contract UpgradeTest is Test {
    /// ERC-1967 implementation slot.
    bytes32 constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    MockSVRUpgrade svr;
    SigvaraIdentity identity;
    SigvaraReputation rep;
    SigvaraStaking staking;

    address admin     = makeAddr("admin");
    address committee = makeAddr("committee");
    address oracle    = makeAddr("oracle");
    address operator  = makeAddr("operator");
    address agentAddr = makeAddr("agent");
    address stranger  = makeAddr("stranger");

    bytes32 constant PUB_KEY = bytes32(uint256(0xdeadbeef));
    uint256 constant MIN_STAKE    = 1000e18;
    uint256 constant CHALLENGE    = 7 days;
    uint256 constant UNBONDING    = 21 days;
    uint256 constant SCORE_WINDOW = 6 hours;

    bytes32 didHash;

    function setUp() public {
        svr = new MockSVRUpgrade();

        identity = SigvaraIdentity(address(new ERC1967Proxy(
            address(new SigvaraIdentity()),
            abi.encodeCall(SigvaraIdentity.initialize, (admin, address(0)))
        )));
        rep = SigvaraReputation(address(new ERC1967Proxy(
            address(new SigvaraReputation()),
            abi.encodeCall(SigvaraReputation.initialize, (admin, oracle, address(0), committee, SCORE_WINDOW))
        )));
        vm.prank(admin);
        rep.initializeV3(address(identity));
        staking = SigvaraStaking(address(new ERC1967Proxy(
            address(new SigvaraStaking()),
            abi.encodeCall(SigvaraStaking.initialize, (
                admin, address(identity), address(rep), address(svr), MIN_STAKE, CHALLENGE, UNBONDING
            ))
        )));

        vm.startPrank(admin);
        identity.initializeV2(address(staking));
        identity.grantRole(identity.STAKING_CORE_ROLE(), address(staking));
        rep.grantRole(rep.STAKING_CORE_ROLE(), address(staking));
        vm.stopPrank();

        // Live state to carry across the upgrade.
        vm.prank(operator);
        didHash = identity.registerAgent(agentAddr, PUB_KEY);

        svr.mint(operator, MIN_STAKE);
        vm.startPrank(operator);
        svr.approve(address(staking), MIN_STAKE);
        staking.depositStake(didHash, MIN_STAKE);
        vm.stopPrank();
    }

    function _impl(address proxy) internal view returns (address) {
        return address(uint160(uint256(vm.load(proxy, IMPL_SLOT))));
    }

    // -------------------------------------------------------------- identity --

    function test_upgrade_identity_preservesState() public {
        SigvaraIdentity.AgentIdentity memory before = identity.getIdentity(didHash);
        address oldImpl = _impl(address(identity));

        address newImpl = address(new SigvaraIdentity());
        vm.prank(admin);
        identity.upgradeToAndCall(newImpl, "");

        assertEq(_impl(address(identity)), newImpl, "implementation slot did not move");
        assertTrue(newImpl != oldImpl, "new implementation must differ");

        SigvaraIdentity.AgentIdentity memory afterUpgrade = identity.getIdentity(didHash);
        assertEq(afterUpgrade.operator, before.operator);
        assertEq(afterUpgrade.agentAddress, before.agentAddress);
        assertEq(afterUpgrade.ed25519PubKey, before.ed25519PubKey);
        assertEq(uint8(afterUpgrade.status), uint8(before.status));
        assertEq(afterUpgrade.registeredAt, before.registeredAt);
        assertTrue(identity.isActive(didHash));
    }

    function test_upgrade_identity_reverts_notUpgrader() public {
        address newImpl = address(new SigvaraIdentity());
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, identity.UPGRADER_ROLE()
            )
        );
        vm.prank(stranger);
        identity.upgradeToAndCall(newImpl, "");
    }

    // ------------------------------------------------------------ reputation --

    function test_upgrade_reputation_preservesFinalizedScore() public {
        SigvaraReputation.ReputationData memory data = SigvaraReputation.ReputationData({
            feeScore: 12, successScore: 22, ageScore: 15,
            externalScore: 9, communityScore: 5, propagationScore: 1,
            lastUpdated: 0
        });
        vm.prank(oracle);
        rep.proposeReputation(didHash, data);
        vm.warp(block.timestamp + SCORE_WINDOW + 1);
        rep.finalizeReputation(didHash);

        uint8 total = rep.getTotalScore(didHash);
        assertEq(total, 64);

        address newImpl = address(new SigvaraReputation());
        vm.prank(admin);
        rep.upgradeToAndCall(newImpl, "");

        assertEq(_impl(address(rep)), newImpl);
        assertEq(rep.getTotalScore(didHash), total, "score changed across upgrade");
        assertTrue(rep.meetsThreshold(didHash, 60));
    }

    function test_upgrade_reputation_reverts_notUpgrader() public {
        address newImpl = address(new SigvaraReputation());
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, rep.UPGRADER_ROLE()
            )
        );
        vm.prank(stranger);
        rep.upgradeToAndCall(newImpl, "");
    }

    // --------------------------------------------------------------- staking --

    function test_upgrade_staking_preservesStakeAndConfig() public {
        assertEq(staking.getStake(didHash), MIN_STAKE);
        uint256 tokenBalanceBefore = svr.balanceOf(address(staking));

        address newImpl = address(new SigvaraStaking());
        vm.prank(admin);
        staking.upgradeToAndCall(newImpl, "");

        assertEq(_impl(address(staking)), newImpl);
        assertEq(staking.getStake(didHash), MIN_STAKE, "stake changed across upgrade");
        assertEq(staking.minimumStake(), MIN_STAKE);
        assertEq(staking.unbondingPeriod(), UNBONDING);
        assertEq(svr.balanceOf(address(staking)), tokenBalanceBefore, "custodied tokens moved");
        assertTrue(staking.hasMinimumStake(didHash));
    }

    function test_upgrade_staking_reverts_notUpgrader() public {
        address newImpl = address(new SigvaraStaking());
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, staking.UPGRADER_ROLE()
            )
        );
        vm.prank(stranger);
        staking.upgradeToAndCall(newImpl, "");
    }

    /// The operator holds the bond but not the upgrade key: being a stakeholder
    /// must not confer the ability to swap the implementation out from under it.
    function test_upgrade_staking_reverts_operator() public {
        address newImpl = address(new SigvaraStaking());
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, operator, staking.UPGRADER_ROLE()
            )
        );
        vm.prank(operator);
        staking.upgradeToAndCall(newImpl, "");
    }

    /// Withdrawals queued before an upgrade must still be claimable afterwards on
    /// the original schedule -- an upgrade is not an escape hatch or a reset.
    function test_upgrade_staking_preservesQueuedWithdrawal() public {
        // An Active agent must keep at least minimumStake, so queue only the excess.
        svr.mint(operator, MIN_STAKE);
        vm.startPrank(operator);
        svr.approve(address(staking), MIN_STAKE);
        staking.depositStake(didHash, MIN_STAKE);
        staking.initiateWithdrawal(didHash, MIN_STAKE);
        vm.stopPrank();
        (uint256 amount, uint256 claimableAt) = staking.getPendingWithdrawal(didHash);

        // Deploy before the prank: a CREATE in the argument list would consume it.
        address newImpl = address(new SigvaraStaking());
        vm.prank(admin);
        staking.upgradeToAndCall(newImpl, "");

        (uint256 amountAfter, uint256 claimableAfter) = staking.getPendingWithdrawal(didHash);
        assertEq(amountAfter, amount, "queued amount changed");
        assertEq(claimableAfter, claimableAt, "unbonding schedule changed");

        vm.warp(claimableAt);
        vm.prank(operator);
        staking.claimWithdrawal(didHash);
        assertEq(svr.balanceOf(operator), MIN_STAKE);
    }
}
