// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";

import "../src/SigvaraOracleBond.sol";
import "../src/SVRToken.sol";

contract SigvaraOracleBondTest is Test {
    SigvaraOracleBond bond;
    SVRToken svr;

    address admin       = makeAddr("admin");
    address slasher     = makeAddr("slasher");
    address beneficiary = makeAddr("beneficiary");
    address op1         = makeAddr("op1");
    address op2         = makeAddr("op2");
    address stranger    = makeAddr("stranger");

    uint256 constant BOND = 1000e18;
    uint256 constant UNBOND = 7 days;

    function setUp() public {
        svr = new SVRToken(address(this));

        SigvaraOracleBond impl = new SigvaraOracleBond();
        bond = SigvaraOracleBond(address(new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                SigvaraOracleBond.initialize,
                (admin, slasher, address(svr), BOND, UNBOND, beneficiary)
            )
        )));

        svr.mint(op1, 10_000e18);
        svr.mint(op2, 10_000e18);
        vm.prank(op1); svr.approve(address(bond), type(uint256).max);
        vm.prank(op2); svr.approve(address(bond), type(uint256).max);
    }

    function _bondAndAdmit(address op, uint256 amount) internal {
        vm.prank(op);
        bond.depositBond(amount);
        vm.prank(admin);
        bond.admit(op);
    }

    // -------------------------------------------------------------------------
    // Init
    // -------------------------------------------------------------------------

    function test_init() public view {
        assertEq(address(bond.svr()), address(svr));
        assertEq(bond.bondAmount(), BOND);
        assertEq(bond.unbondingPeriod(), UNBOND);
        assertEq(bond.slashBeneficiary(), beneficiary);
        assertTrue(bond.hasRole(bond.SLASHER_ROLE(), slasher));
    }

    // -------------------------------------------------------------------------
    // Deposit / admit
    // -------------------------------------------------------------------------

    function test_depositBond_bondsApplicant() public {
        vm.prank(op1);
        bond.depositBond(1500e18);
        assertEq(bond.bondOf(op1), 1500e18);
        (, SigvaraOracleBond.Status status,) = bond.operators(op1);
        assertEq(uint8(status), uint8(SigvaraOracleBond.Status.Bonded));
        assertEq(svr.balanceOf(address(bond)), 1500e18);
    }

    function test_depositBond_zero_reverts() public {
        vm.expectRevert(SigvaraOracleBond.ZeroAmount.selector);
        vm.prank(op1);
        bond.depositBond(0);
    }

    function test_admit_activatesOperator() public {
        _bondAndAdmit(op1, BOND);
        assertTrue(bond.isActiveOperator(op1));
        assertEq(bond.activeCount(), 1);
    }

    function test_admit_insufficientBond_reverts() public {
        vm.prank(op1);
        bond.depositBond(BOND - 1);
        vm.expectRevert(abi.encodeWithSelector(SigvaraOracleBond.InsufficientBond.selector, op1, BOND - 1, BOND));
        vm.prank(admin);
        bond.admit(op1);
    }

    function test_admit_notBonded_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(
            SigvaraOracleBond.WrongStatus.selector, op1, SigvaraOracleBond.Status.None
        ));
        vm.prank(admin);
        bond.admit(op1);
    }

    function test_admit_notAdmin_reverts() public {
        vm.prank(op1);
        bond.depositBond(BOND);
        vm.expectRevert(abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, bytes32(0)
        ));
        vm.prank(stranger);
        bond.admit(op1);
    }

    // -------------------------------------------------------------------------
    // Slashing
    // -------------------------------------------------------------------------

    function test_slash_reducesBond_toBeneficiary() public {
        _bondAndAdmit(op1, 2000e18);
        vm.prank(slasher);
        bond.slash(op1, 500e18);
        assertEq(bond.bondOf(op1), 1500e18);
        assertEq(svr.balanceOf(beneficiary), 500e18);
        assertTrue(bond.isActiveOperator(op1)); // still >= bondAmount
        assertEq(bond.activeCount(), 1);
    }

    function test_slash_demotesBelowMinimum() public {
        _bondAndAdmit(op1, 1500e18);
        vm.prank(slasher);
        bond.slash(op1, 600e18); // 900 < 1000
        assertEq(bond.bondOf(op1), 900e18);
        assertFalse(bond.isActiveOperator(op1));
        assertEq(bond.activeCount(), 0);
    }

    function test_slash_exceedsBond_reverts() public {
        _bondAndAdmit(op1, BOND);
        vm.expectRevert(abi.encodeWithSelector(SigvaraOracleBond.SlashExceedsBond.selector, op1, BOND + 1, BOND));
        vm.prank(slasher);
        bond.slash(op1, BOND + 1);
    }

    function test_slash_notSlasher_reverts() public {
        _bondAndAdmit(op1, BOND);
        vm.expectRevert(abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, bond.SLASHER_ROLE()
        ));
        vm.prank(stranger);
        bond.slash(op1, 1e18);
    }

    function test_slash_duringUnbonding_stillWorks() public {
        _bondAndAdmit(op1, 2000e18);
        vm.prank(op1);
        bond.initiateUnbond(); // Exiting

        vm.prank(slasher);
        bond.slash(op1, 500e18); // still slashable in cooldown
        assertEq(bond.bondOf(op1), 1500e18);
        assertEq(svr.balanceOf(beneficiary), 500e18);
    }

    // -------------------------------------------------------------------------
    // Unbonding
    // -------------------------------------------------------------------------

    function test_initiateUnbond_exitsActiveSet() public {
        _bondAndAdmit(op1, BOND);
        vm.prank(op1);
        bond.initiateUnbond();
        assertFalse(bond.isActiveOperator(op1));
        assertEq(bond.activeCount(), 0);
    }

    function test_withdrawBond_afterCooldown() public {
        _bondAndAdmit(op1, 1500e18);
        vm.prank(op1);
        bond.initiateUnbond();

        vm.warp(block.timestamp + UNBOND);
        uint256 before = svr.balanceOf(op1);
        vm.prank(op1);
        bond.withdrawBond();
        assertEq(svr.balanceOf(op1), before + 1500e18);
        assertEq(bond.bondOf(op1), 0);
        (, SigvaraOracleBond.Status status,) = bond.operators(op1);
        assertEq(uint8(status), uint8(SigvaraOracleBond.Status.None));
    }

    function test_withdrawBond_beforeCooldown_reverts() public {
        _bondAndAdmit(op1, BOND);
        vm.prank(op1);
        bond.initiateUnbond();
        uint256 claimableAt = block.timestamp + UNBOND;
        vm.expectRevert(abi.encodeWithSelector(SigvaraOracleBond.UnbondingActive.selector, op1, claimableAt));
        vm.prank(op1);
        bond.withdrawBond();
    }

    function test_withdrawBond_whileActive_reverts() public {
        _bondAndAdmit(op1, BOND);
        vm.expectRevert(abi.encodeWithSelector(
            SigvaraOracleBond.WrongStatus.selector, op1, SigvaraOracleBond.Status.Active
        ));
        vm.prank(op1);
        bond.withdrawBond();
    }

    function test_removeOperator_forcesExit() public {
        _bondAndAdmit(op1, BOND);
        vm.prank(admin);
        bond.removeOperator(op1);
        assertFalse(bond.isActiveOperator(op1));
        assertEq(bond.activeCount(), 0);
        (, SigvaraOracleBond.Status status,) = bond.operators(op1);
        assertEq(uint8(status), uint8(SigvaraOracleBond.Status.Exiting));
    }

    // -------------------------------------------------------------------------
    // activeCount across multiple operators
    // -------------------------------------------------------------------------

    function test_activeCount_tracksSet() public {
        _bondAndAdmit(op1, BOND);
        _bondAndAdmit(op2, BOND);
        assertEq(bond.activeCount(), 2);
        vm.prank(op1);
        bond.initiateUnbond();
        assertEq(bond.activeCount(), 1);
    }

    // -------------------------------------------------------------------------
    // Admin params
    // -------------------------------------------------------------------------

    function test_setters_adminOnly() public {
        vm.startPrank(admin);
        bond.setBondAmount(2000e18);
        bond.setUnbondingPeriod(14 days);
        bond.setSlashBeneficiary(stranger);
        vm.stopPrank();
        assertEq(bond.bondAmount(), 2000e18);
        assertEq(bond.unbondingPeriod(), 14 days);
        assertEq(bond.slashBeneficiary(), stranger);

        vm.expectRevert(SigvaraOracleBond.ZeroAddress.selector);
        vm.prank(admin);
        bond.setSlashBeneficiary(address(0));

        vm.expectRevert(abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, bytes32(0)
        ));
        vm.prank(stranger);
        bond.setBondAmount(1);
    }

    // -------------------------------------------------------------------------
    // Bond requirement binds on incumbents
    // -------------------------------------------------------------------------

    /// Raising the bar must take effect for operators already admitted under a lower one.
    /// `admit` checks the bond once, so before isActiveOperator re-read it an operator let
    /// in at 1,000 kept proposing after the requirement moved to 5,000, and governance
    /// could only tighten the rule by removing each incumbent by hand.
    function test_raisingBondAmount_demotesIncumbentsOnRead() public {
        _bondAndAdmit(op1, BOND);
        assertTrue(bond.isActiveOperator(op1), "active under the original requirement");

        vm.prank(admin);
        bond.setBondAmount(BOND * 5);

        assertFalse(bond.isActiveOperator(op1), "under-bonded once the bar rose");
        // Status is untouched: only removeOperator clears the record, and topping up
        // must be enough to restore standing without a second admission.
        vm.prank(op1);
        bond.depositBond(BOND * 4);
        assertTrue(bond.isActiveOperator(op1), "restored by topping up");
    }

    /// Lowering it re-qualifies, for the same reason and by the same path.
    function test_loweringBondAmount_reQualifiesIncumbents() public {
        _bondAndAdmit(op1, BOND);
        vm.prank(admin);
        bond.setBondAmount(BOND * 5);
        assertFalse(bond.isActiveOperator(op1));

        vm.prank(admin);
        bond.setBondAmount(BOND);
        assertTrue(bond.isActiveOperator(op1), "qualified again without re-admission");
    }

    /// Zero would make the gate vacuous while still looking configured. That mode already
    /// exists — leave SigvaraReputation.operatorBond unset — and should not be reachable
    /// by passing an empty argument to a setter.
    function test_setBondAmount_rejectsZero() public {
        vm.expectRevert(SigvaraOracleBond.ZeroAmount.selector);
        vm.prank(admin);
        bond.setBondAmount(0);
        assertEq(bond.bondAmount(), BOND, "unchanged after the refusal");
    }

    // -------------------------------------------------------------------------
    // Storage layout — pins operators mapping to slot 5
    // -------------------------------------------------------------------------

    /**
     * Pins slots 0-4, which nothing covered: only the operators mapping was guarded.
     *
     * Same reasoning as the equivalents in Staking, Identity and Reputation. The one in
     * Reputation exists because this exact gap let a mapping be declared above
     * `operatorBond` and move it into a slot reading zero.
     *
     * Adding a variable: append it, add a line here, never renumber.
     */
    function test_storageLayout_allSlotsPinned() public {
        vm.prank(admin);
        bond.setBondAmount(BOND);          // write a known value rather than trusting init
        _bondAndAdmit(op1, BOND);          // so activeCount is non-zero and probeable

        assertEq(address(uint160(uint256(vm.load(address(bond), bytes32(uint256(0)))))),
            address(svr), "slot 0 is svr");
        assertEq(uint256(vm.load(address(bond), bytes32(uint256(1)))),
            bond.bondAmount(), "slot 1 is bondAmount");
        assertEq(uint256(vm.load(address(bond), bytes32(uint256(2)))),
            bond.unbondingPeriod(), "slot 2 is unbondingPeriod");
        assertEq(address(uint160(uint256(vm.load(address(bond), bytes32(uint256(3)))))),
            beneficiary, "slot 3 is slashBeneficiary");
        assertEq(uint256(vm.load(address(bond), bytes32(uint256(4)))),
            bond.activeCount(), "slot 4 is activeCount");
        assertEq(bond.activeCount(), 1, "probe value was actually written");
    }

    function test_storageLayout_operatorsPinnedToSlot5() public {
        vm.prank(op1);
        bond.depositBond(1234e18);
        // First field of Operator is `bond`.
        bytes32 slot = keccak256(abi.encode(op1, uint256(5)));
        assertEq(uint256(vm.load(address(bond), slot)), 1234e18);
    }
}
