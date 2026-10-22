// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "./helpers/RegistrationHelper.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";

import "../src/SigvaraEpochFees.sol";
import "../src/SigvaraIdentity.sol";
import "../src/SVRToken.sol";
import "../src/interfaces/IOperatorSet.sol";

/// Stands in for SigvaraOracleBond.
contract FeesOperatorSetMock is IOperatorSet {
    mapping(address => bool) public active;
    function set(address who, bool v) external { active[who] = v; }
    function isActiveOperator(address who) external view returns (bool) { return active[who]; }
}

contract SigvaraEpochFeesTest is Test, RegistrationHelper {
    SigvaraEpochFees fees;
    SigvaraIdentity identity;
    SVRToken svr;

    address admin      = makeAddr("admin");
    address oracle     = makeAddr("oracle");
    address operator   = makeAddr("operator");
    address agent;
    uint256 agentPk;
    address funder     = makeAddr("funder");
    address rewardPool = makeAddr("rewardPool");
    address stranger   = makeAddr("stranger");

    bytes32 constant PUB_KEY = bytes32(uint256(0xdeadbeef));
    uint256 constant EPOCH_FEE = 10e18;
    uint256 constant EPOCH_LENGTH = 1 days;

    bytes32 didHash;

    function setUp() public {
        (agent, agentPk) = makeAddrAndKey("agent");
        // stake-token (testnet mintable token is fine for fixtures).
        svr = new SVRToken(address(this));

        // Identity registry behind a proxy; register one agent.
        SigvaraIdentity idImpl = new SigvaraIdentity();
        identity = SigvaraIdentity(address(new ERC1967Proxy(
            address(idImpl),
            abi.encodeCall(SigvaraIdentity.initialize, (admin, address(0)))
        )));
        didHash = registerSigned(identity, operator, agentPk, PUB_KEY);

        // Fee registry behind a proxy.
        SigvaraEpochFees feesImpl = new SigvaraEpochFees();
        fees = SigvaraEpochFees(address(new ERC1967Proxy(
            address(feesImpl),
            abi.encodeCall(
                SigvaraEpochFees.initialize,
                (admin, oracle, address(svr), address(identity), rewardPool, EPOCH_FEE)
            )
        )));

        // The epoch length is what lets chargeEpoch charge at all: without one it refuses.
        vm.prank(admin);
        fees.initializeV2(EPOCH_LENGTH, address(0));

        // Fund operator + funder and approve the registry.
        svr.mint(operator, 1_000e18);
        svr.mint(funder, 1_000e18);
        vm.prank(operator);
        svr.approve(address(fees), type(uint256).max);
        vm.prank(funder);
        svr.approve(address(fees), type(uint256).max);
    }

    // -------------------------------------------------------------------------
    // Init
    // -------------------------------------------------------------------------

    function test_init() public view {
        assertEq(address(fees.svr()), address(svr));
        assertEq(address(fees.identityRegistry()), address(identity));
        assertEq(fees.rewardPool(), rewardPool);
        assertEq(fees.epochFee(), EPOCH_FEE);
        assertEq(uint8(fees.stage()), uint8(SigvaraEpochFees.Stage.Bootstrap));
        assertTrue(fees.hasRole(fees.ORACLE_ROLE(), oracle));
    }

    // -------------------------------------------------------------------------
    // Funding
    // -------------------------------------------------------------------------

    function test_depositFor_anyoneCanFund() public {
        vm.prank(funder);
        fees.depositFor(didHash, 100e18);
        assertEq(fees.balance(didHash), 100e18);
        assertEq(svr.balanceOf(address(fees)), 100e18);
    }

    function test_depositFor_accumulates() public {
        vm.prank(operator);
        fees.depositFor(didHash, 40e18);
        vm.prank(funder);
        fees.depositFor(didHash, 60e18);
        assertEq(fees.balance(didHash), 100e18);
    }

    function test_depositFor_zero_reverts() public {
        vm.expectRevert(SigvaraEpochFees.ZeroAmount.selector);
        vm.prank(funder);
        fees.depositFor(didHash, 0);
    }

    function test_withdraw_operatorOnly() public {
        vm.prank(funder);
        fees.depositFor(didHash, 100e18);

        vm.prank(operator);
        fees.withdraw(didHash, 30e18);
        assertEq(fees.balance(didHash), 70e18);
        assertEq(svr.balanceOf(operator), 1_000e18 + 30e18);
    }

    function test_withdraw_notOperator_reverts() public {
        vm.prank(funder);
        fees.depositFor(didHash, 100e18);

        vm.expectRevert(abi.encodeWithSelector(SigvaraEpochFees.NotOperator.selector, didHash, stranger));
        vm.prank(stranger);
        fees.withdraw(didHash, 1e18);
    }

    function test_withdraw_moreThanBalance_reverts() public {
        vm.prank(operator);
        fees.depositFor(didHash, 10e18);
        vm.expectRevert(abi.encodeWithSelector(SigvaraEpochFees.InsufficientBalance.selector, didHash, 11e18, 10e18));
        vm.prank(operator);
        fees.withdraw(didHash, 11e18);
    }

    // -------------------------------------------------------------------------
    // Charging
    // -------------------------------------------------------------------------

    function test_isCovered() public {
        assertFalse(fees.isCovered(didHash));
        vm.prank(operator);
        fees.depositFor(didHash, EPOCH_FEE);
        assertTrue(fees.isCovered(didHash));
    }

    function test_chargeEpoch_covered() public {
        vm.prank(operator);
        fees.depositFor(didHash, 25e18);

        vm.prank(oracle);
        bool charged = fees.chargeEpoch(didHash);
        assertTrue(charged);
        assertEq(fees.balance(didHash), 15e18);
        assertEq(fees.collected(), EPOCH_FEE);
    }

    /// Anyone following an agent's coverage from the chain learns what was charged and
    /// what is left from this event, so both amounts are part of the contract's interface.
    function test_chargeEpoch_emitsWhatWasChargedAndWhatIsLeft() public {
        vm.prank(operator);
        fees.depositFor(didHash, 25e18);

        vm.expectEmit(address(fees));
        emit SigvaraEpochFees.EpochCharged(didHash, EPOCH_FEE, 15e18);
        vm.prank(oracle);
        fees.chargeEpoch(didHash);
    }

    /// An uncovered agent must make the charge revert, not return false. A bool the
    /// oracle forgets to inspect turns a missed payment into a free scoring run with
    /// no error recorded anywhere; a revert forces the caller to skip the agent.
    function test_chargeEpoch_uncovered_reverts_noStateChange() public {
        vm.prank(operator);
        fees.depositFor(didHash, 5e18); // < EPOCH_FEE

        vm.expectRevert(
            abi.encodeWithSelector(SigvaraEpochFees.InsufficientBalance.selector, didHash, EPOCH_FEE, 5e18)
        );
        vm.prank(oracle);
        fees.chargeEpoch(didHash);

        assertEq(fees.balance(didHash), 5e18);
        assertEq(fees.collected(), 0);
    }

    function test_chargeEpoch_feeZero_disablesGating() public {
        vm.prank(admin);
        fees.setEpochFee(0);
        assertTrue(fees.isCovered(didHash)); // covered even with 0 balance

        vm.prank(oracle);
        assertTrue(fees.chargeEpoch(didHash));
        assertEq(fees.collected(), 0); // nothing charged
    }

    function test_chargeEpoch_notOracle_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, fees.ORACLE_ROLE()
        ));
        vm.prank(stranger);
        fees.chargeEpoch(didHash);
    }

    // -------------------------------------------------------------------------
    // Distribution — three-stage routing (§6)
    // -------------------------------------------------------------------------

    function _collect(uint256 epochs) internal {
        vm.prank(funder);
        fees.depositFor(didHash, EPOCH_FEE * epochs);
        for (uint256 i = 0; i < epochs; i++) {
            vm.warp(block.timestamp + EPOCH_LENGTH); // one charge per epoch, so each is a new one
            vm.prank(oracle);
            fees.chargeEpoch(didHash);
        }
    }

    function test_distribute_bootstrap_allToPool() public {
        _collect(10); // 100e18 collected
        fees.distributeFees();
        assertEq(svr.balanceOf(rewardPool), 100e18);
        assertEq(svr.balanceOf(address(0xdead)), 0);
        assertEq(fees.collected(), 0);
    }

    function test_distribute_transition_80_20() public {
        vm.prank(admin);
        fees.setStage(SigvaraEpochFees.Stage.Transition);
        _collect(10); // 100e18
        fees.distributeFees();
        assertEq(svr.balanceOf(rewardPool), 80e18);
        assertEq(svr.balanceOf(address(0xdead)), 20e18);
    }

    function test_distribute_mature_50_50() public {
        vm.prank(admin);
        fees.setStage(SigvaraEpochFees.Stage.Mature);
        _collect(10); // 100e18
        fees.distributeFees();
        assertEq(svr.balanceOf(rewardPool), 50e18);
        assertEq(svr.balanceOf(address(0xdead)), 50e18);
    }

    function test_distribute_nothing_reverts() public {
        vm.expectRevert(SigvaraEpochFees.NothingToDistribute.selector);
        fees.distributeFees();
    }

    // -------------------------------------------------------------------------
    // Admin gating
    // -------------------------------------------------------------------------

    function test_setEpochFee_adminOnly() public {
        vm.expectRevert(abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, bytes32(0)
        ));
        vm.prank(stranger);
        fees.setEpochFee(1e18);

        vm.prank(admin);
        fees.setEpochFee(1e18);
        assertEq(fees.epochFee(), 1e18);
    }

    function test_setStage_and_setRewardPool_adminOnly() public {
        vm.prank(admin);
        fees.setStage(SigvaraEpochFees.Stage.Mature);
        assertEq(uint8(fees.stage()), uint8(SigvaraEpochFees.Stage.Mature));

        vm.prank(admin);
        fees.setRewardPool(stranger);
        assertEq(fees.rewardPool(), stranger);

        vm.expectRevert(SigvaraEpochFees.ZeroAddress.selector);
        vm.prank(admin);
        fees.setRewardPool(address(0));
    }

    // -------------------------------------------------------------------------
    // One charge per agent per epoch
    // -------------------------------------------------------------------------

    function _fund(uint256 epochs) internal {
        vm.prank(funder);
        fees.depositFor(didHash, EPOCH_FEE * epochs);
    }

    function test_chargeEpoch_secondChargeInTheSameEpochIsRefused() public {
        _fund(5);
        vm.warp(10 * EPOCH_LENGTH + 100);
        vm.prank(oracle);
        fees.chargeEpoch(didHash);

        vm.expectRevert(abi.encodeWithSelector(SigvaraEpochFees.AlreadyCharged.selector, didHash, 10));
        vm.prank(oracle);
        fees.chargeEpoch(didHash);

        assertEq(fees.balance(didHash), 4 * EPOCH_FEE, "charged once");
        assertEq(fees.collected(), EPOCH_FEE);
    }

    function test_chargeEpoch_theNextEpochChargesAgain() public {
        _fund(5);
        vm.warp(10 * EPOCH_LENGTH + 100);
        vm.prank(oracle);
        fees.chargeEpoch(didHash);

        vm.warp(11 * EPOCH_LENGTH);
        vm.prank(oracle);
        fees.chargeEpoch(didHash);
        assertEq(fees.collected(), 2 * EPOCH_FEE);
    }

    /// Epochs are calendar periods, not a rolling interval, so a run that lands a few seconds
    /// either side of the boundary is two epochs, and a run that drifts a little early is not
    /// refused for it.
    function test_chargeEpoch_epochsAreAlignedToTheClockNotTheLastCharge() public {
        _fund(5);
        vm.warp(10 * EPOCH_LENGTH + EPOCH_LENGTH - 1);   // the last second of epoch 10
        vm.prank(oracle);
        fees.chargeEpoch(didHash);

        vm.warp(11 * EPOCH_LENGTH);                      // one second later: epoch 11
        vm.prank(oracle);
        fees.chargeEpoch(didHash);
        assertEq(fees.collected(), 2 * EPOCH_FEE);

        // And inside one epoch, however far apart, it is one.
        vm.warp(12 * EPOCH_LENGTH);
        vm.prank(oracle);
        fees.chargeEpoch(didHash);
        vm.warp(13 * EPOCH_LENGTH - 1);
        vm.expectRevert(abi.encodeWithSelector(SigvaraEpochFees.AlreadyCharged.selector, didHash, 12));
        vm.prank(oracle);
        fees.chargeEpoch(didHash);
    }

    function test_chargeEpoch_recordsWhenItCharged() public {
        _fund(2);
        assertEq(fees.lastChargedAt(didHash), 0, "never");
        vm.warp(5 * EPOCH_LENGTH + 77);
        vm.prank(oracle);
        fees.chargeEpoch(didHash);
        assertEq(fees.lastChargedAt(didHash), 5 * EPOCH_LENGTH + 77);
    }

    /// Zero in lastChargedAt means never charged. A first charge in epoch 0 must not be
    /// mistaken for a repeat of it, or the first epoch of a young chain could never be charged.
    function test_chargeEpoch_aFirstChargeInEpochZeroIsAllowed() public {
        _fund(2);
        vm.warp(1);
        vm.prank(oracle);
        fees.chargeEpoch(didHash);
        assertEq(fees.collected(), EPOCH_FEE);

        vm.expectRevert(abi.encodeWithSelector(SigvaraEpochFees.AlreadyCharged.selector, didHash, 0));
        vm.prank(oracle);
        fees.chargeEpoch(didHash);
    }

    /// A charge that reverts for want of balance leaves no mark, so funding the agent and
    /// trying again inside the same epoch works.
    function test_chargeEpoch_anUncoveredAgentIsNotMarkedCharged() public {
        vm.warp(10 * EPOCH_LENGTH);
        vm.expectRevert(abi.encodeWithSelector(
            SigvaraEpochFees.InsufficientBalance.selector, didHash, EPOCH_FEE, 0
        ));
        vm.prank(oracle);
        fees.chargeEpoch(didHash);
        assertEq(fees.lastChargedAt(didHash), 0);

        _fund(1);
        vm.prank(oracle);
        fees.chargeEpoch(didHash);
        assertEq(fees.collected(), EPOCH_FEE);
    }

    function test_chargeEpoch_limitIsPerAgent() public {
        (, uint256 agent2Pk) = makeAddrAndKey("agent2");
        bytes32 did2 = registerSigned(identity, operator, agent2Pk, PUB_KEY);
        _fund(3);
        vm.prank(funder);
        fees.depositFor(did2, 3 * EPOCH_FEE);

        vm.warp(10 * EPOCH_LENGTH);
        vm.prank(oracle);
        fees.chargeEpoch(didHash);
        vm.prank(oracle);
        fees.chargeEpoch(did2);
        assertEq(fees.collected(), 2 * EPOCH_FEE, "each agent once");
    }

    /// A stolen oracle key used to be able to empty every prepaid balance in a loop. It can now
    /// take what the agent would have paid anyway, once an epoch.
    function test_theft_aStolenKeyCanTakeOneFeePerEpochAndNoMore() public {
        _fund(50);
        vm.warp(10 * EPOCH_LENGTH);

        uint256 taken;
        for (uint256 i = 0; i < 40; i++) {
            vm.prank(oracle);
            try fees.chargeEpoch(didHash) returns (bool) { taken++; } catch {}
        }
        assertEq(taken, 1, "forty attempts, one charge");
        assertEq(fees.balance(didHash), 49 * EPOCH_FEE);

        // And the honest oracle running later in the same epoch finds the agent charged, which
        // is the answer it needs.
        vm.expectRevert(abi.encodeWithSelector(SigvaraEpochFees.AlreadyCharged.selector, didHash, 10));
        vm.prank(oracle);
        fees.chargeEpoch(didHash);
    }

    function testFuzz_chargesFollowTheClock(uint32[8] memory gaps) public {
        _fund(20); // more than the eight attempts can use
        uint256 t = 5 * EPOCH_LENGTH;
        uint256 lastEpoch;
        bool charged;
        uint256 count;
        for (uint256 i = 0; i < gaps.length; i++) {
            t += uint256(gaps[i]) % (3 * EPOCH_LENGTH);
            vm.warp(t);
            uint256 epoch = t / EPOCH_LENGTH;
            bool shouldCharge = !charged || epoch > lastEpoch;
            vm.prank(oracle);
            try fees.chargeEpoch(didHash) returns (bool) {
                assertTrue(shouldCharge, "charged twice in one epoch");
                charged = true;
                lastEpoch = epoch;
                count++;
            } catch {
                assertFalse(shouldCharge, "refused a charge that was due");
            }
        }
        assertEq(fees.collected(), count * EPOCH_FEE);
        assertEq(fees.balance(didHash), (20 - count) * EPOCH_FEE);
    }

    /// Changing the length re-reads the last charge against the new epochs. Pinned so the
    /// consequence is a known one: lengthening can refuse a charge that was due under the old
    /// length, and shortening can allow one that was not.
    function test_setEpochLength_isReadAgainstTheLastCharge() public {
        _fund(5);
        vm.warp(10 * EPOCH_LENGTH);               // epoch 10 at one day, epoch 5 at two days
        vm.prank(oracle);
        fees.chargeEpoch(didHash);

        vm.prank(admin);
        fees.setEpochLength(2 * EPOCH_LENGTH);
        vm.warp(11 * EPOCH_LENGTH);               // epoch 11 at one day, but still epoch 5 at two
        vm.expectRevert(abi.encodeWithSelector(SigvaraEpochFees.AlreadyCharged.selector, didHash, 5));
        vm.prank(oracle);
        fees.chargeEpoch(didHash);

        vm.prank(admin);
        fees.setEpochLength(EPOCH_LENGTH);
        vm.prank(oracle);
        fees.chargeEpoch(didHash);
        assertEq(fees.collected(), 2 * EPOCH_FEE);
    }

    // -------------------------------------------------------------------------
    // Epoch length and the operator set
    // -------------------------------------------------------------------------

    function _freshFees(uint256 fee) internal returns (SigvaraEpochFees f) {
        f = SigvaraEpochFees(address(new ERC1967Proxy(
            address(new SigvaraEpochFees()),
            abi.encodeCall(SigvaraEpochFees.initialize, (admin, oracle, address(svr), address(identity), rewardPool, fee))
        )));
    }

    function test_initializeV2_setsTheEpochLengthAndTheOperatorSet() public {
        SigvaraEpochFees f = _freshFees(EPOCH_FEE);
        FeesOperatorSetMock set = new FeesOperatorSetMock();

        vm.expectEmit(address(f));
        emit SigvaraEpochFees.EpochLengthUpdated(6 hours);
        vm.expectEmit(address(f));
        emit SigvaraEpochFees.OperatorBondSet(address(set));
        vm.prank(admin);
        f.initializeV2(6 hours, address(set));

        assertEq(f.epochLength(), 6 hours);
        assertEq(address(f.operatorBond()), address(set));
    }

    function test_initializeV2_adminOnly_andOnlyOnce() public {
        SigvaraEpochFees f = _freshFees(EPOCH_FEE);

        vm.expectRevert(abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, bytes32(0)
        ));
        vm.prank(stranger);
        f.initializeV2(1 days, address(0));

        vm.prank(admin);
        f.initializeV2(1 days, address(0));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        vm.prank(admin);
        f.initializeV2(2 days, address(0));
        assertEq(f.epochLength(), 1 days, "the second call changed nothing");
    }

    function test_epochLength_refusesAnythingUnderTheFloor() public {
        SigvaraEpochFees f = _freshFees(EPOCH_FEE);
        vm.expectRevert(abi.encodeWithSelector(
            SigvaraEpochFees.EpochLengthBelowFloor.selector, 0, 1 hours
        ));
        vm.prank(admin);
        f.initializeV2(0, address(0));

        vm.expectRevert(abi.encodeWithSelector(
            SigvaraEpochFees.EpochLengthBelowFloor.selector, 1 hours - 1, 1 hours
        ));
        vm.prank(admin);
        fees.setEpochLength(1 hours - 1);

        vm.prank(admin);
        fees.setEpochLength(1 hours);
        assertEq(fees.epochLength(), 1 hours);
    }

    /// A registry that charges with no per-epoch limit looks configured and is not. Until an
    /// epoch length is set the charge refuses, and a stranger cannot set one.
    function test_chargeEpoch_withoutAnEpochLengthRefuses() public {
        SigvaraEpochFees f = _freshFees(EPOCH_FEE);
        vm.expectRevert(SigvaraEpochFees.EpochLengthNotSet.selector);
        vm.prank(oracle);
        f.chargeEpoch(didHash);
    }

    /// While the fee is zero nothing is charged and nothing needs configuring.
    function test_chargeEpoch_feeZeroNeedsNoEpochLength() public {
        SigvaraEpochFees f = _freshFees(0);
        vm.prank(oracle);
        assertTrue(f.chargeEpoch(didHash));
    }

    function test_setEpochLength_andSetOperatorBond_adminOnly() public {
        vm.expectRevert(abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, bytes32(0)
        ));
        vm.prank(stranger);
        fees.setEpochLength(2 days);

        vm.expectRevert(abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, bytes32(0)
        ));
        vm.prank(stranger);
        fees.setOperatorBond(address(1));

        FeesOperatorSetMock set = new FeesOperatorSetMock();
        vm.expectEmit(address(fees));
        emit SigvaraEpochFees.OperatorBondSet(address(set));
        vm.prank(admin);
        fees.setOperatorBond(address(set));
        assertEq(address(fees.operatorBond()), address(set));
    }

    function test_chargeEpoch_withAnOperatorSetNeedsAnActiveOperator() public {
        FeesOperatorSetMock set = new FeesOperatorSetMock();
        vm.prank(admin);
        fees.setOperatorBond(address(set));
        _fund(3);

        vm.warp(10 * EPOCH_LENGTH);
        assertTrue(fees.hasRole(fees.ORACLE_ROLE(), oracle), "holds the role");
        vm.expectRevert(abi.encodeWithSelector(SigvaraEpochFees.OracleNotBonded.selector, oracle));
        vm.prank(oracle);
        fees.chargeEpoch(didHash);

        set.set(oracle, true);
        vm.prank(oracle);
        fees.chargeEpoch(didHash);
        assertEq(fees.collected(), EPOCH_FEE);

        // Removed from the set: the next epoch's charge is refused, with no role to revoke.
        set.set(oracle, false);
        vm.warp(11 * EPOCH_LENGTH);
        vm.expectRevert(abi.encodeWithSelector(SigvaraEpochFees.OracleNotBonded.selector, oracle));
        vm.prank(oracle);
        fees.chargeEpoch(didHash);
    }

    /// Bonding does not grant the right to charge: the role is still needed.
    function test_chargeEpoch_bondWithoutTheRoleIsStillRefused() public {
        FeesOperatorSetMock set = new FeesOperatorSetMock();
        vm.prank(admin);
        fees.setOperatorBond(address(set));
        set.set(stranger, true);
        _fund(1);
        bytes32 role = fees.ORACLE_ROLE();
        vm.expectRevert(abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role
        ));
        vm.prank(stranger);
        fees.chargeEpoch(didHash);
    }

    function test_chargeEpoch_operatorSetCanBeTurnedBackOff() public {
        FeesOperatorSetMock set = new FeesOperatorSetMock();
        vm.startPrank(admin);
        fees.setOperatorBond(address(set));
        fees.setOperatorBond(address(0));
        vm.stopPrank();
        _fund(1);
        vm.prank(oracle);
        fees.chargeEpoch(didHash);
        assertEq(fees.collected(), EPOCH_FEE);
    }

    // -------------------------------------------------------------------------
    // Storage layout — pins balance mapping to slot 6 for upgrade safety
    // -------------------------------------------------------------------------

    function test_storageLayout_balancePinnedToSlot6() public {
        vm.prank(funder);
        fees.depositFor(didHash, 42e18);
        bytes32 slot = keccak256(abi.encode(didHash, uint256(6)));
        assertEq(uint256(vm.load(address(fees), slot)), 42e18);
    }

    /// Appended after `balance`. A proxy that predates them reads all three as empty, which
    /// is why an upgraded proxy refuses to charge until initializeV2 has run.
    function test_storageLayout_newVariablesPinnedToSlots7To9() public {
        FeesOperatorSetMock set = new FeesOperatorSetMock();
        vm.prank(admin);
        fees.setOperatorBond(address(set));
        _fund(1);
        vm.warp(7 * EPOCH_LENGTH + 5);
        set.set(oracle, true);
        vm.prank(oracle);
        fees.chargeEpoch(didHash);

        assertEq(address(uint160(uint256(vm.load(address(fees), bytes32(uint256(7)))))), address(set),
            "slot 7 is operatorBond");
        assertEq(uint256(vm.load(address(fees), bytes32(uint256(8)))), EPOCH_LENGTH, "slot 8 is epochLength");
        assertEq(
            uint256(vm.load(address(fees), keccak256(abi.encode(didHash, uint256(9))))),
            7 * EPOCH_LENGTH + 5,
            "slot 9 is lastChargedAt"
        );
        // And what was there before did not move.
        assertEq(uint256(vm.load(address(fees), bytes32(uint256(5)))), EPOCH_FEE, "slot 5 is collected");
    }
}
