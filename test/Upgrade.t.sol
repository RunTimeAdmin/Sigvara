// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "./helpers/RegistrationHelper.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";

import "../src/SigvaraIdentity.sol";
import "../src/SigvaraReputation.sol";
import "../src/SigvaraStaking.sol";
import "../src/SigvaraEpochFees.sol";
import "../src/SigvaraOracleBond.sol";
import "../script/Upgrade.s.sol";

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
contract UpgradeTest is Test, RegistrationHelper {
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
    address agentAddr;
    uint256 agentPk;
    address stranger  = makeAddr("stranger");

    bytes32 constant PUB_KEY = bytes32(uint256(0xdeadbeef));
    uint256 constant MIN_STAKE    = 1000e18;
    uint256 constant CHALLENGE    = 7 days;
    uint256 constant UNBONDING    = 21 days;
    uint256 constant SCORE_WINDOW = 6 hours;

    bytes32 didHash;

    function setUp() public {
        (agentAddr, agentPk) = makeAddrAndKey("agent");
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
                didHash = registerSigned(identity, operator, agentPk, PUB_KEY);

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
            feeScore: 12, successScore: 12, ageScore: 25,
            externalScore: 9, communityScore: 5, propagationScore: 1,
            lastUpdated: 0
        });
        vm.prank(oracle);
        rep.proposeReputation(didHash, data, bytes32(0));
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

    // ------------------------------------------------------------ epoch fees --
    //
    // A fee registry from before the per-epoch limit has epochLength and operatorBond at zero.
    // initialize() on this code leaves the same two slots at zero, so a proxy built here
    // stands in for one that was already live.

    function _feesProxy() internal returns (SigvaraEpochFees fees) {
        fees = SigvaraEpochFees(address(new ERC1967Proxy(
            address(new SigvaraEpochFees()),
            abi.encodeCall(SigvaraEpochFees.initialize, (admin, oracle, address(svr), address(identity), admin, 0))
        )));
        svr.mint(operator, 100e18);
        vm.startPrank(operator);
        svr.approve(address(fees), 100e18);
        fees.depositFor(didHash, 100e18);
        vm.stopPrank();
    }

    /// The path the testnet proxy takes: the deployer holds both roles, so the upgrade and the
    /// reinitializer land in one transaction and there is no moment with the limit unset.
    function test_upgrade_epochFees_atomicWithInitializeV2_whenTheUpgraderIsTheAdmin() public {
        SigvaraEpochFees fees = _feesProxy();
        assertEq(fees.epochLength(), 0, "stands in for a proxy from before the limit");
        address newImpl = address(new SigvaraEpochFees());
        vm.prank(admin);
        fees.upgradeToAndCall(newImpl, abi.encodeCall(SigvaraEpochFees.initializeV2, (1 days, address(0))));

        assertEq(_impl(address(fees)), newImpl);
        assertEq(fees.balance(didHash), 100e18, "prepaid balances survive");
        assertEq(fees.epochLength(), 1 days);
        assertEq(address(fees.operatorBond()), address(0));

        vm.prank(admin);
        fees.setEpochFee(10e18);
        vm.prank(oracle);
        fees.chargeEpoch(didHash);
        assertEq(fees.balance(didHash), 90e18);
        vm.expectRevert(abi.encodeWithSelector(SigvaraEpochFees.AlreadyCharged.selector, didHash, block.timestamp / 1 days));
        vm.prank(oracle);
        fees.chargeEpoch(didHash);
    }

    /// An upgrade that forgets the reinitializer must not leave a fee registry that charges
    /// without a limit. It refuses to charge until the length is set.
    function test_upgrade_epochFees_withoutTheReinitializerRefusesToCharge() public {
        SigvaraEpochFees fees = _feesProxy();
        address newImpl = address(new SigvaraEpochFees());
        vm.startPrank(admin);
        fees.upgradeToAndCall(newImpl, "");
        fees.setEpochFee(10e18);
        vm.stopPrank();

        vm.expectRevert(SigvaraEpochFees.EpochLengthNotSet.selector);
        vm.prank(oracle);
        fees.chargeEpoch(didHash);
        assertEq(fees.balance(didHash), 100e18, "nothing was taken");

        vm.prank(admin);
        fees.initializeV2(1 days, address(0));
        vm.prank(oracle);
        fees.chargeEpoch(didHash);
        assertEq(fees.balance(didHash), 90e18);
    }

    /// After the handover the timelock holds UPGRADER_ROLE and the Safe holds the admin role.
    /// The reinitializer is admin-gated, and inside upgradeToAndCall msg.sender is still the
    /// timelock, so a timelocked upgrade cannot carry it. The upgrade goes through first and the
    /// Safe makes the second call, which is why every reinitializer here has to be fail-closed
    /// until it has run.
    function test_upgrade_epochFees_aTimelockThatIsNotTheAdminCannotCarryTheReinitializer() public {
        SigvaraEpochFees fees = _feesProxy();
        address timelock = makeAddr("timelock");
        address safe = makeAddr("safe");
        vm.startPrank(admin);
        fees.grantRole(fees.UPGRADER_ROLE(), timelock);
        fees.grantRole(fees.DEFAULT_ADMIN_ROLE(), safe);
        fees.setEpochFee(10e18);
        vm.stopPrank();

        address newImpl = address(new SigvaraEpochFees());
        vm.expectRevert(abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, timelock, fees.DEFAULT_ADMIN_ROLE()
        ));
        vm.prank(timelock);
        fees.upgradeToAndCall(newImpl, abi.encodeCall(SigvaraEpochFees.initializeV2, (1 days, address(0))));
        assertTrue(_impl(address(fees)) != newImpl, "the whole upgrade reverted");

        vm.prank(timelock);
        fees.upgradeToAndCall(newImpl, "");
        vm.expectRevert(SigvaraEpochFees.EpochLengthNotSet.selector);
        vm.prank(oracle);
        fees.chargeEpoch(didHash);

        vm.prank(safe);
        fees.initializeV2(1 days, address(0));
        vm.prank(oracle);
        fees.chargeEpoch(didHash);
        assertEq(fees.balance(didHash), 90e18);
    }
}

/// A registry from before operator transfer: no operatorChangedAt, no stakeView.
contract PreTransferIdentity {
    function getIdentity(bytes32) external pure returns (uint256) { return 1; }
}

contract CurrentIdentity {
    function operatorChangedAt(bytes32) external pure returns (uint256) { return 0; }
    function stakeView() external pure returns (address) { return address(1); }
}

/// Holds an identityRegistry the way reputation and staking do.
contract ProxyStub {
    address public identityRegistry;
    constructor(address id) { identityRegistry = id; }
}

/// Exposes the script's internal prechecks.
contract UpgradeHarness is Upgrade {
    function check(string memory target, address proxy) external view {
        _checkDependencies(target, proxy);
    }

    function shape(string memory target, address proxy) external view {
        _requireShape(target, proxy);
    }
}

contract UpgradeDependencyTest is Test {
    UpgradeHarness harness;

    function setUp() public {
        harness = new UpgradeHarness();
    }

    // -------------------------------------------------------------------------
    // The proxy is the kind the target names
    // -------------------------------------------------------------------------

    /// PROXY overrides the address read from the deployment artifact, and nothing checked it against TARGET.
    /// Every registry is a UUPS proxy, so an implementation of one kind installs cleanly on a proxy of
    /// another and bricks it: the upgrade lands, the new code reads the old storage, and nothing works.
    function _proxies() internal returns (address[5] memory p, string[5] memory names) {
        names = ["identity", "reputation", "staking", "oracleBond", "epochFees"];
        MockSVRUpgrade svr = new MockSVRUpgrade();
        address admin = address(0xAD);
        p[0] = address(new ERC1967Proxy(
            address(new SigvaraIdentity()), abi.encodeCall(SigvaraIdentity.initialize, (admin, address(0)))
        ));
        p[1] = address(new ERC1967Proxy(
            address(new SigvaraReputation()),
            abi.encodeCall(SigvaraReputation.initialize, (admin, address(0), address(0), address(0), 1 hours))
        ));
        p[2] = address(new ERC1967Proxy(
            address(new SigvaraStaking()),
            abi.encodeCall(SigvaraStaking.initialize, (admin, p[0], p[1], address(svr), 1000e18, 7 days, 21 days))
        ));
        p[3] = address(new ERC1967Proxy(
            address(new SigvaraOracleBond()),
            abi.encodeCall(SigvaraOracleBond.initialize, (admin, address(0), address(svr), 1000e18, 7 days, admin))
        ));
        p[4] = address(new ERC1967Proxy(
            address(new SigvaraEpochFees()),
            abi.encodeCall(SigvaraEpochFees.initialize, (admin, address(0), address(svr), p[0], admin, 0))
        ));
    }

    function test_shape_acceptsEachProxyForItsOwnTarget() public {
        (address[5] memory p, string[5] memory names) = _proxies();
        for (uint256 i = 0; i < 5; i++) harness.shape(names[i], p[i]);
    }

    function test_shape_refusesEveryOtherPairing() public {
        (address[5] memory p, string[5] memory names) = _proxies();
        for (uint256 t = 0; t < 5; t++) {
            for (uint256 x = 0; x < 5; x++) {
                if (x == t) continue;
                vm.expectRevert(abi.encodeWithSelector(Upgrade.ProxyIsNotTheTarget.selector, names[t], p[x]));
                harness.shape(names[t], p[x]);
            }
        }
    }

    function test_shape_refusesAnAddressWithNoCodeOrAnotherKindOfContract() public {
        vm.expectRevert(abi.encodeWithSelector(Upgrade.ProxyIsNotTheTarget.selector, "staking", address(0xABCD)));
        harness.shape("staking", address(0xABCD));

        address notAProxy = address(new CurrentIdentity());
        vm.expectRevert(abi.encodeWithSelector(Upgrade.ProxyIsNotTheTarget.selector, "reputation", notAProxy));
        harness.shape("reputation", notAProxy);
    }

    /// The exact ordering that broke Arc testnet: upgrade reputation while identity
    /// is a version behind, and every getTotalScore on the chain starts reverting.
    function test_refusesReputationAgainstAPreTransferIdentity() public {
        address proxy = address(new ProxyStub(address(new PreTransferIdentity())));
        vm.expectRevert();
        harness.check("reputation", proxy);
    }

    function test_allowsReputationOnceIdentityIsCurrent() public {
        address proxy = address(new ProxyStub(address(new CurrentIdentity())));
        harness.check("reputation", proxy); // must not revert
    }

    function test_refusesStakingAgainstAnIdentityWithoutStakeView() public {
        address proxy = address(new ProxyStub(address(new PreTransferIdentity())));
        vm.expectRevert();
        harness.check("staking", proxy);
    }

    function test_allowsStakingOnceIdentityIsCurrent() public {
        address proxy = address(new ProxyStub(address(new CurrentIdentity())));
        harness.check("staking", proxy);
    }

    /// An unwired proxy has nothing to depend on yet, and a fresh deployment must not
    /// be blocked by a check about contracts it has not been pointed at.
    function test_allowsWhenTheRegistryIsNotWiredYet() public {
        address proxy = address(new ProxyStub(address(0)));
        harness.check("reputation", proxy);
        harness.check("staking", proxy);
    }

    function test_identityUpgradeHasNoDependencies() public {
        address proxy = address(new ProxyStub(address(new PreTransferIdentity())));
        harness.check("identity", proxy);
    }
}
