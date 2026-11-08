// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/governance/TimelockController.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";

import "../src/SigvaraOracleBond.sol";
import "../src/SVRToken.sol";

/**
 * The treasury is a timelock the admin Safe drives (docs/adr/0005, decision 13). A slashed bond lands in it and
 * leaves only as a payment the Safe scheduled at least 48 hours before: not earlier, not after the Safe cancels
 * it, and not by anyone else scheduling one.
 */
contract TreasuryTimelockTest is Test {
    SigvaraOracleBond bond;
    SVRToken svr;
    TimelockController treasury;

    address safe = makeAddr("safe");
    address slasher = makeAddr("slasher");
    address operator = makeAddr("operator");
    address payee = makeAddr("payee");
    address anyone = makeAddr("anyone");

    bytes payment;

    function setUp() public {
        // As PHASE=deploy-treasury in script/SplitAuthority.s.sol builds it: the Safe proposes and cancels,
        // anyone executes, and the timelock is its own admin.
        address[] memory proposers = new address[](1);
        proposers[0] = safe;
        treasury = new TimelockController(48 hours, proposers, new address[](1), address(0));

        svr = new SVRToken(address(this));
        SigvaraOracleBond impl = new SigvaraOracleBond();
        bond = SigvaraOracleBond(address(new ERC1967Proxy(address(impl), abi.encodeCall(
            SigvaraOracleBond.initialize, (address(this), slasher, address(svr), 1_000e18, 7 days, address(treasury))
        ))));

        svr.mint(operator, 1_000e18);
        vm.startPrank(operator);
        svr.approve(address(bond), 1_000e18);
        bond.depositBond(1_000e18);
        vm.stopPrank();
        vm.prank(slasher);
        bond.slash(operator, 400e18);

        payment = abi.encodeCall(IERC20.transfer, (payee, 100e18));
    }

    function _schedule(uint256 delay) internal returns (bytes32 id) {
        vm.prank(safe);
        treasury.schedule(address(svr), 0, payment, bytes32(0), bytes32(0), delay);
        return treasury.hashOperation(address(svr), 0, payment, bytes32(0), bytes32(0));
    }

    function _execute() internal {
        vm.prank(anyone);
        treasury.execute(address(svr), 0, payment, bytes32(0), bytes32(0));
    }

    function test_aSlashedBondLandsInTheTreasury() public view {
        assertEq(svr.balanceOf(address(treasury)), 400e18);
    }

    /// Early execution fails, execution once the delay has run succeeds, and anyone can push it through.
    function test_aPaymentWaitsTheFullDelay() public {
        bytes32 id = _schedule(48 hours);
        vm.warp(block.timestamp + 48 hours - 1);
        vm.expectRevert(abi.encodeWithSelector(
            TimelockController.TimelockUnexpectedOperationState.selector, id, bytes32(1 << uint8(TimelockController.OperationState.Ready))
        ));
        _execute();

        vm.warp(block.timestamp + 1);
        _execute();
        assertEq(svr.balanceOf(payee), 100e18);
        assertEq(svr.balanceOf(address(treasury)), 300e18);
    }

    /// The Safe cannot ask for less notice than the treasury's delay, or shorten the delay at once.
    function test_theSafeCannotShortenTheWait() public {
        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(TimelockController.TimelockInsufficientDelay.selector, 24 hours, 48 hours));
        treasury.schedule(address(svr), 0, payment, bytes32(0), bytes32(0), 24 hours);

        vm.prank(safe);
        vm.expectRevert(abi.encodeWithSelector(TimelockController.TimelockUnauthorizedCaller.selector, safe));
        treasury.updateDelay(1 hours);
    }

    function test_aCancelledPaymentNeverExecutes() public {
        bytes32 id = _schedule(48 hours);
        vm.prank(safe);
        treasury.cancel(id);
        vm.warp(block.timestamp + 48 hours);
        vm.expectRevert(abi.encodeWithSelector(
            TimelockController.TimelockUnexpectedOperationState.selector, id, bytes32(1 << uint8(TimelockController.OperationState.Ready))
        ));
        _execute();
        assertEq(svr.balanceOf(payee), 0);
    }

    /// Only the Safe schedules. The operator whose bond was slashed, or anyone else, cannot.
    function test_onlyTheSafeSchedules() public {
        bytes32 proposer = treasury.PROPOSER_ROLE();
        address[2] memory others = [anyone, operator];
        for (uint256 i = 0; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, others[i], proposer
            ));
            treasury.schedule(address(svr), 0, payment, bytes32(0), bytes32(0), 48 hours);
        }
    }
}
