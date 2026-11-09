// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/finance/VestingWallet.sol";

import "../script/LockTreasurySvr.s.sol";
import "../src/SVRToken.sol";

contract LockTreasurySvr_Harness is LockTreasurySvr {
    function build(address owner) external returns (VestingWallet) { return _build(owner); }
    function start() external pure returns (uint64) { return START; }
}

/**
 * The treasury share of the launch-day SVR sits in a VestingWallet with a duration of zero. Nothing leaves before
 * 9 May 2027, the owner included; everything can leave at it, and only to the owner.
 */
contract LockTreasurySvrTest is Test {
    LockTreasurySvr_Harness h;
    SVRToken svr;
    VestingWallet lock;
    address deployer = makeAddr("deployer");
    uint256 constant AMOUNT = 17_283_004_212403885962491355;

    function setUp() public {
        h = new LockTreasurySvr_Harness();
        svr = new SVRToken(address(this));
        lock = h.build(deployer);
        svr.mint(address(lock), AMOUNT);
    }

    function test_releasesAt9May2027() public view {
        assertEq(h.start(), 1809820800);
        assertEq(lock.end(), 1809820800, "everything at the start, nothing spread out");
        assertEq(lock.owner(), deployer);
    }

    /// One second before the date nothing can be released, whoever asks.
    function test_nothingLeavesEarly() public {
        vm.warp(uint256(h.start()) - 1);
        assertEq(lock.releasable(address(svr)), 0);
        vm.prank(deployer);
        lock.release(address(svr));
        assertEq(svr.balanceOf(address(lock)), AMOUNT);
        assertEq(svr.balanceOf(deployer), 0);
    }

    /// At the date all of it can be released, by anyone, and it goes to the owner.
    function test_everythingLeavesAtTheDate() public {
        vm.warp(h.start());
        assertEq(lock.releasable(address(svr)), AMOUNT);
        vm.prank(makeAddr("anyone"));
        lock.release(address(svr));
        assertEq(svr.balanceOf(deployer), AMOUNT);
        assertEq(svr.balanceOf(address(lock)), 0);
    }

    /// Handing ownership to the treasury changes where the SVR goes, not when.
    function test_aNewOwnerChangesWhereNotWhen() public {
        address treasury = makeAddr("treasury timelock");
        vm.prank(deployer);
        lock.transferOwnership(treasury);
        vm.warp(uint256(h.start()) - 1);
        assertEq(lock.releasable(address(svr)), 0);
        vm.warp(h.start());
        lock.release(address(svr));
        assertEq(svr.balanceOf(treasury), AMOUNT);
    }
}
