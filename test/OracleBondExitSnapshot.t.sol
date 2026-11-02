// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import "../src/SigvaraOracleBond.sol";
import "../src/SVRToken.sol";

/**
 * Regression tests for fixing an oracle operator's exit time when it starts to leave.
 *
 * Before the change `withdrawBond` read `unbondingPeriod` at withdrawal, so an admin change moved
 * the exit of every operator already Exiting: lowering the period to its one day floor let an
 * operator promised seven days withdraw after one, before a slash could be filed, and raising it to
 * the 90 day ceiling held back exits that had been promised sooner. SigvaraStaking fixed the same
 * thing for withdrawals (UnbondingSnapshot.t.sol). This holds the bond registry to the same rule.
 */
contract OracleBondExitSnapshotTest is Test {
    SigvaraOracleBond bond;
    SVRToken svr;

    address admin       = makeAddr("admin");
    address slasher     = makeAddr("slasher");
    address beneficiary = makeAddr("beneficiary");
    address op          = makeAddr("op");

    uint256 constant BOND = 1000e18;
    uint256 constant UNBOND = 7 days;

    function setUp() public {
        svr = new SVRToken(address(this));
        bond = SigvaraOracleBond(address(new ERC1967Proxy(
            address(new SigvaraOracleBond()),
            abi.encodeCall(
                SigvaraOracleBond.initialize,
                (admin, slasher, address(svr), BOND, UNBOND, beneficiary)
            )
        )));

        svr.mint(op, 10 * BOND);
        vm.prank(op);
        svr.approve(address(bond), type(uint256).max);
        _bondAndAdmit();
    }

    function _bondAndAdmit() internal {
        vm.prank(op);
        bond.depositBond(BOND);
        vm.prank(admin);
        bond.admit(op);
    }

    function _unbond() internal returns (uint256 startedAt) {
        vm.prank(op);
        bond.initiateUnbond();
        return block.timestamp;
    }

    function _setPeriod(uint256 period) internal {
        vm.prank(admin);
        bond.setUnbondingPeriod(period);
    }

    function _withdrawRevertsUntil(uint256 claimableAt) internal {
        vm.expectRevert(abi.encodeWithSelector(SigvaraOracleBond.UnbondingActive.selector, op, claimableAt));
        vm.prank(op);
        bond.withdrawBond();
    }

    function _withdraw() internal {
        uint256 before = svr.balanceOf(op);
        vm.prank(op);
        bond.withdrawBond();
        assertEq(svr.balanceOf(op) - before, BOND, "the whole bond came back");
    }

    /// The admin cannot shorten an exit that has started.
    function test_loweringThePeriod_doesNotShortenAnExit() public {
        uint256 startedAt = _unbond();
        _setPeriod(1 days);
        assertEq(bond.unbondingClaimableAt(op), startedAt + UNBOND, "the time fixed at unbonding");

        vm.warp(startedAt + 1 days + 1);
        _withdrawRevertsUntil(startedAt + UNBOND);

        vm.warp(startedAt + UNBOND);
        _withdraw();
    }

    /// Nor can the admin lengthen it.
    function test_raisingThePeriod_doesNotLengthenAnExit() public {
        uint256 startedAt = _unbond();
        _setPeriod(90 days);

        vm.warp(startedAt + UNBOND);
        _withdraw();
    }

    /// An operator the admin removes gets the same fixed time as one that leaves by itself.
    function test_removeOperator_fixesTheExitTimeToo() public {
        vm.prank(admin);
        bond.removeOperator(op);
        uint256 removedAt = block.timestamp;
        assertEq(bond.unbondingClaimableAt(op), removedAt + UNBOND);

        _setPeriod(1 days);
        vm.warp(removedAt + 1 days + 1);
        _withdrawRevertsUntil(removedAt + UNBOND);

        vm.warp(removedAt + UNBOND);
        _withdraw();
    }

    /// An operator that starts to leave after a change takes the period then in force.
    function test_anExitStartedAfterAChange_usesTheNewPeriod() public {
        _setPeriod(3 days);
        uint256 startedAt = _unbond();
        assertEq(bond.unbondingClaimableAt(op), startedAt + 3 days);

        vm.warp(startedAt + 3 days);
        _withdraw();
    }

    function test_theUnbondEvent_carriesTheFixedTime() public {
        vm.expectEmit(true, false, false, true, address(bond));
        emit SigvaraOracleBond.UnbondInitiated(op, block.timestamp + UNBOND);
        _unbond();
    }

    /// Withdrawing spends the record, so a later bond and exit start clean.
    function test_withdraw_clearsTheRecord() public {
        uint256 startedAt = _unbond();
        vm.warp(startedAt + UNBOND);
        _withdraw();
        assertEq(bond.unbondingClaimableAt(op), 0);

        _bondAndAdmit();
        _setPeriod(2 days);
        uint256 again = _unbond();
        assertEq(bond.unbondingClaimableAt(op), again + 2 days, "the second exit is not the first one's");
    }

    /// A slash that takes the whole bond clears the operator's record, and the time with it.
    function test_slashToZero_clearsTheRecord() public {
        _unbond();
        vm.prank(slasher);
        bond.slash(op, BOND);

        assertEq(bond.unbondingClaimableAt(op), 0);
        (, SigvaraOracleBond.Status status, uint256 unbondingAt) = bond.operators(op);
        assertEq(uint8(status), uint8(SigvaraOracleBond.Status.None));
        assertEq(unbondingAt, 0);
    }

    /// A partial slash leaves the operator Exiting, and its exit where it was.
    function test_partialSlash_keepsTheExitTime() public {
        uint256 startedAt = _unbond();
        vm.prank(slasher);
        bond.slash(op, BOND / 4);
        assertEq(bond.unbondingClaimableAt(op), startedAt + UNBOND);

        vm.warp(startedAt + UNBOND);
        vm.prank(op);
        bond.withdrawBond();
        assertEq(svr.balanceOf(op), 10 * BOND - BOND / 4);
    }

    /// An operator that started to leave before the record existed has none, and keeps the rule
    /// it started under: the time it started plus the period in force when it withdraws.
    function test_anExitStartedBeforeTheRecordExisted_keepsTheOldRule() public {
        uint256 startedAt = _unbond();
        // What an upgraded proxy holds for an operator that was already Exiting: nothing.
        vm.store(address(bond), keccak256(abi.encode(op, uint256(8))), bytes32(0));
        assertEq(bond.unbondingClaimableAt(op), 0);

        _setPeriod(2 days);
        vm.warp(startedAt + 2 days - 1);
        _withdrawRevertsUntil(startedAt + 2 days);

        vm.warp(startedAt + 2 days);
        _withdraw();
    }

    /// Whatever the admin does between unbonding and withdrawing, the exit is the day it was promised.
    function testFuzz_exitTimeIsFixedWhenUnbonding(uint256 newPeriod, uint256 wait) public {
        newPeriod = bound(newPeriod, 1 days, 90 days);
        wait = bound(wait, 0, 120 days);

        uint256 startedAt = _unbond();
        _setPeriod(newPeriod);
        vm.warp(startedAt + wait);

        if (wait >= UNBOND) {
            _withdraw();
        } else {
            _withdrawRevertsUntil(startedAt + UNBOND);
        }
    }
}
