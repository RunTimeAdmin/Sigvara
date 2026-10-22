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
    address signer1     = makeAddr("signer1");
    address signer2     = makeAddr("signer2");

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
    // Initialize guards
    // -------------------------------------------------------------------------

    function _expectInitZeroAddress(address a, address token, address ben) internal {
        address impl = address(new SigvaraOracleBond());
        vm.expectRevert(SigvaraOracleBond.ZeroAddress.selector);
        new ERC1967Proxy(impl, abi.encodeCall(
            SigvaraOracleBond.initialize, (a, slasher, token, BOND, UNBOND, ben)
        ));
    }

    function test_initialize_reverts_zeroAddresses() public {
        _expectInitZeroAddress(address(0), address(svr), beneficiary);
        _expectInitZeroAddress(admin, address(0), beneficiary);
        _expectInitZeroAddress(admin, address(svr), address(0));
    }

    /// A zero slasher is allowed and simply leaves SLASHER_ROLE ungranted.
    function test_initialize_zeroSlasher_grantsNoSlasher() public {
        SigvaraOracleBond b = SigvaraOracleBond(address(new ERC1967Proxy(
            address(new SigvaraOracleBond()),
            abi.encodeCall(SigvaraOracleBond.initialize, (admin, address(0), address(svr), BOND, UNBOND, beneficiary))
        )));
        assertFalse(b.hasRole(b.SLASHER_ROLE(), address(0)));
        assertFalse(b.hasRole(b.SLASHER_ROLE(), admin));
        assertTrue(b.hasRole(b.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(b.hasRole(b.UPGRADER_ROLE(), admin));
    }

    // -------------------------------------------------------------------------
    // The slasher is never the payee
    // -------------------------------------------------------------------------

    /// One address that holds the slasher role and receives what is slashed takes an operator's bond and
    /// pays itself, which is the opposite of a performance bond. The registry refuses the pairing at every
    /// way in: the initializer, a later grant of the role, and a later change of the beneficiary.
    function test_initialize_refusesASlasherThatIsTheBeneficiary() public {
        address impl = address(new SigvaraOracleBond());
        vm.expectRevert(abi.encodeWithSelector(SigvaraOracleBond.SlasherIsBeneficiary.selector, slasher));
        new ERC1967Proxy(impl, abi.encodeCall(
            SigvaraOracleBond.initialize, (admin, slasher, address(svr), BOND, UNBOND, slasher)
        ));
    }

    function testFuzz_initialize_theSlasherAndTheBeneficiaryMustDiffer(address s, address ben) public {
        vm.assume(ben != address(0));
        address impl = address(new SigvaraOracleBond());
        if (s == ben) vm.expectRevert(abi.encodeWithSelector(SigvaraOracleBond.SlasherIsBeneficiary.selector, s));
        SigvaraOracleBond b = SigvaraOracleBond(address(new ERC1967Proxy(impl, abi.encodeCall(
            SigvaraOracleBond.initialize, (admin, s, address(svr), BOND, UNBOND, ben)
        ))));
        if (s != ben) assertEq(b.slashBeneficiary(), ben);
    }

    function test_grantSlasher_refusesTheBeneficiary() public {
        bytes32 role = bond.SLASHER_ROLE();
        vm.expectRevert(abi.encodeWithSelector(SigvaraOracleBond.SlasherIsBeneficiary.selector, beneficiary));
        vm.prank(admin); // holds UPGRADER_ROLE, which administers the slasher role
        bond.grantRole(role, beneficiary);
        assertFalse(bond.hasRole(role, beneficiary));
    }

    function test_setSlashBeneficiary_refusesAnAddressThatHoldsTheSlasherRole() public {
        vm.expectRevert(abi.encodeWithSelector(SigvaraOracleBond.SlasherIsBeneficiary.selector, slasher));
        vm.prank(admin);
        bond.setSlashBeneficiary(slasher);
        assertEq(bond.slashBeneficiary(), beneficiary, "unchanged after the refusal");
    }

    /// The refusal follows who holds the role and who is named now, not who once did: a slasher that has
    /// been revoked can be named beneficiary, and the former beneficiary can then be granted the role.
    function test_theRefusalFollowsTheCurrentHolders() public {
        bytes32 role = bond.SLASHER_ROLE();
        vm.startPrank(admin);
        bond.revokeRole(role, slasher);
        bond.setSlashBeneficiary(slasher);
        bond.grantRole(role, beneficiary);
        vm.stopPrank();
        assertEq(bond.slashBeneficiary(), slasher);
        assertTrue(bond.hasRole(role, beneficiary));
        assertFalse(bond.hasRole(role, slasher));
    }

    // -------------------------------------------------------------------------
    // Floors: a bond requirement of zero, and an exit with no delay
    // -------------------------------------------------------------------------

    function _expectInit(uint256 bondAmount_, uint256 unbonding_, bytes memory err) internal {
        address impl = address(new SigvaraOracleBond());
        vm.expectRevert(err);
        new ERC1967Proxy(impl, abi.encodeCall(
            SigvaraOracleBond.initialize, (admin, slasher, address(svr), bondAmount_, unbonding_, beneficiary)
        ));
    }

    /// A requirement of zero puts nothing at risk, which is the mode setBondAmount already
    /// refuses to reach. The initializer is the other way in.
    function test_initialize_refusesAZeroBondRequirement() public {
        _expectInit(0, UNBOND, abi.encodeWithSelector(SigvaraOracleBond.ZeroAmount.selector));
    }

    /// With no unbonding delay an operator can start to leave and withdraw in the same second,
    /// before the slasher has any window to act.
    function test_initialize_refusesAnUnbondingPeriodUnderTheFloor() public {
        _expectInit(BOND, 0, abi.encodeWithSelector(SigvaraOracleBond.PeriodTooShort.selector, 0, 1 days));
        _expectInit(
            BOND, 1 days - 1,
            abi.encodeWithSelector(SigvaraOracleBond.PeriodTooShort.selector, 1 days - 1, 1 days)
        );
    }

    function test_initialize_acceptsTheUnbondingFloor() public {
        SigvaraOracleBond b = SigvaraOracleBond(address(new ERC1967Proxy(
            address(new SigvaraOracleBond()),
            abi.encodeCall(SigvaraOracleBond.initialize, (admin, slasher, address(svr), 1, 1 days, beneficiary))
        )));
        assertEq(b.unbondingPeriod(), 1 days);
        assertEq(b.bondAmount(), 1);
    }

    function test_setUnbondingPeriod_refusesBelowTheFloor() public {
        vm.expectRevert(abi.encodeWithSelector(SigvaraOracleBond.PeriodTooShort.selector, 0, 1 days));
        vm.prank(admin);
        bond.setUnbondingPeriod(0);

        vm.expectRevert(abi.encodeWithSelector(SigvaraOracleBond.PeriodTooShort.selector, 1 days - 1, 1 days));
        vm.prank(admin);
        bond.setUnbondingPeriod(1 days - 1);

        assertEq(bond.unbondingPeriod(), UNBOND, "unchanged after the refusals");
    }

    function test_setUnbondingPeriod_acceptsTheFloor() public {
        vm.prank(admin);
        bond.setUnbondingPeriod(1 days);
        assertEq(bond.unbondingPeriod(), 1 days);
    }

    // -------------------------------------------------------------------------
    // Status guards
    // -------------------------------------------------------------------------

    function test_depositBond_whileExiting_reverts() public {
        _bondAndAdmit(op1, BOND);
        vm.prank(op1);
        bond.initiateUnbond();

        vm.expectRevert(abi.encodeWithSelector(
            SigvaraOracleBond.WrongStatus.selector, op1, SigvaraOracleBond.Status.Exiting
        ));
        vm.prank(op1);
        bond.depositBond(1e18);
    }

    function test_depositBond_topUpKeepsActiveStatus() public {
        _bondAndAdmit(op1, BOND);
        vm.prank(op1);
        bond.depositBond(500e18);
        assertEq(bond.bondOf(op1), BOND + 500e18);
        (, SigvaraOracleBond.Status status,) = bond.operators(op1);
        assertEq(uint8(status), uint8(SigvaraOracleBond.Status.Active));
        assertEq(bond.activeCount(), 1);
    }

    function test_initiateUnbond_fromBonded_doesNotTouchActiveCount() public {
        _bondAndAdmit(op2, BOND);
        vm.prank(op1);
        bond.depositBond(BOND);

        vm.prank(op1);
        bond.initiateUnbond();
        (, SigvaraOracleBond.Status status, uint256 unbondingAt) = bond.operators(op1);
        assertEq(uint8(status), uint8(SigvaraOracleBond.Status.Exiting));
        assertEq(unbondingAt, block.timestamp);
        assertEq(bond.activeCount(), 1, "only op2 was active");
    }

    function test_initiateUnbond_wrongStatus_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(
            SigvaraOracleBond.WrongStatus.selector, op1, SigvaraOracleBond.Status.None
        ));
        vm.prank(op1);
        bond.initiateUnbond();

        _bondAndAdmit(op1, BOND);
        vm.prank(op1);
        bond.initiateUnbond();
        vm.expectRevert(abi.encodeWithSelector(
            SigvaraOracleBond.WrongStatus.selector, op1, SigvaraOracleBond.Status.Exiting
        ));
        vm.prank(op1);
        bond.initiateUnbond();
    }

    function test_withdrawBond_atExactCooldown_succeeds() public {
        _bondAndAdmit(op1, BOND);
        uint256 t0 = vm.getBlockTimestamp();
        vm.prank(op1);
        bond.initiateUnbond();

        vm.warp(t0 + UNBOND - 1);
        vm.expectRevert(abi.encodeWithSelector(SigvaraOracleBond.UnbondingActive.selector, op1, t0 + UNBOND));
        vm.prank(op1);
        bond.withdrawBond();

        vm.warp(t0 + UNBOND);
        vm.prank(op1);
        bond.withdrawBond();
        assertEq(bond.bondOf(op1), 0);
    }

    function test_withdrawBond_paysWhatSurvivedTheSlash() public {
        _bondAndAdmit(op1, 2000e18);
        uint256 t0 = vm.getBlockTimestamp();
        vm.prank(op1);
        bond.initiateUnbond();
        vm.prank(slasher);
        bond.slash(op1, 300e18);

        vm.warp(t0 + UNBOND);
        uint256 before = svr.balanceOf(op1);
        vm.prank(op1);
        bond.withdrawBond();
        assertEq(svr.balanceOf(op1), before + 1700e18);
        assertEq(svr.balanceOf(address(bond)), 0);
    }

    function test_removeOperator_bonded_forcesExit() public {
        _bondAndAdmit(op2, BOND);
        vm.prank(op1);
        bond.depositBond(BOND);

        vm.prank(admin);
        bond.removeOperator(op1);
        (, SigvaraOracleBond.Status status,) = bond.operators(op1);
        assertEq(uint8(status), uint8(SigvaraOracleBond.Status.Exiting));
        assertEq(bond.activeCount(), 1);
    }

    function test_removeOperator_wrongStatus_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(
            SigvaraOracleBond.WrongStatus.selector, op1, SigvaraOracleBond.Status.None
        ));
        vm.prank(admin);
        bond.removeOperator(op1);
    }

    function test_removeOperator_notAdmin_reverts() public {
        _bondAndAdmit(op1, BOND);
        vm.expectRevert(abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, bytes32(0)
        ));
        vm.prank(stranger);
        bond.removeOperator(op1);
    }

    // -------------------------------------------------------------------------
    // Slash guards
    // -------------------------------------------------------------------------

    function test_slash_noBond_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(SigvaraOracleBond.NoBond.selector, op1));
        vm.prank(slasher);
        bond.slash(op1, 1);
    }

    function test_slash_zeroAmount_reverts() public {
        _bondAndAdmit(op1, BOND);
        vm.expectRevert(SigvaraOracleBond.ZeroAmount.selector);
        vm.prank(slasher);
        bond.slash(op1, 0);
    }

    /// A Bonded (not yet admitted) applicant can be slashed; there is nothing to demote.
    function test_slash_bondedApplicant_noDemotion() public {
        vm.prank(op1);
        bond.depositBond(BOND);

        vm.expectEmit(address(bond));
        emit SigvaraOracleBond.OperatorSlashed(op1, 400e18, BOND - 400e18, false);
        vm.prank(slasher);
        bond.slash(op1, 400e18);

        (, SigvaraOracleBond.Status status,) = bond.operators(op1);
        assertEq(uint8(status), uint8(SigvaraOracleBond.Status.Bonded));
        assertEq(bond.activeCount(), 0);
    }

    function test_slash_demotion_emitsDemotedTrue() public {
        _bondAndAdmit(op1, BOND);
        vm.expectEmit(address(bond));
        emit SigvaraOracleBond.OperatorSlashed(op1, 1, BOND - 1, true);
        vm.prank(slasher);
        bond.slash(op1, 1);
    }

    /// A slash that empties an Exiting bond clears the record, so the cooldown is reset.
    function test_slash_toZeroWhileExiting_clearsRecord() public {
        _bondAndAdmit(op1, BOND);
        vm.prank(op1);
        bond.initiateUnbond();

        vm.prank(slasher);
        bond.slash(op1, BOND);

        (uint256 b, SigvaraOracleBond.Status status, uint256 unbondingAt) = bond.operators(op1);
        assertEq(b, 0);
        assertEq(uint8(status), uint8(SigvaraOracleBond.Status.None));
        assertEq(unbondingAt, 0);
        assertEq(svr.balanceOf(beneficiary), BOND);

        vm.expectRevert(abi.encodeWithSelector(
            SigvaraOracleBond.WrongStatus.selector, op1, SigvaraOracleBond.Status.None
        ));
        vm.prank(op1);
        bond.withdrawBond();
    }

    function test_slash_goesToUpdatedBeneficiary() public {
        _bondAndAdmit(op1, 2000e18);
        vm.prank(admin);
        bond.setSlashBeneficiary(stranger);
        vm.prank(slasher);
        bond.slash(op1, 100e18);
        assertEq(svr.balanceOf(stranger), 100e18);
        assertEq(svr.balanceOf(beneficiary), 0);
    }

    function testFuzz_slash_conservesTokens(uint256 deposit, uint256 cut) public {
        deposit = bound(deposit, 1, 10_000e18);
        cut = bound(cut, 1, deposit);
        vm.prank(op1);
        bond.depositBond(deposit);
        vm.prank(slasher);
        bond.slash(op1, cut);
        assertEq(bond.bondOf(op1), deposit - cut);
        assertEq(svr.balanceOf(beneficiary), cut);
        assertEq(svr.balanceOf(address(bond)), deposit - cut);
    }

    // -------------------------------------------------------------------------
    // Signer delegation: the bond owner and the signing key are different addresses
    // -------------------------------------------------------------------------

    function _withSigner(address op, address signer) internal {
        _bondAndAdmit(op, BOND);
        vm.prank(op);
        bond.setSigner(signer);
    }

    function test_setSigner_signerSpeaksForTheOperator() public {
        _bondAndAdmit(op1, BOND);
        assertFalse(bond.isActiveOperator(signer1), "a stranger before it is named");

        vm.expectEmit(address(bond));
        emit SigvaraOracleBond.SignerSet(op1, signer1);
        vm.prank(op1);
        bond.setSigner(signer1);

        assertTrue(bond.isActiveOperator(signer1));
        assertEq(bond.operatorOfSigner(signer1), op1);
        assertEq(bond.signerOf(op1), signer1);
        assertTrue(bond.isActiveOperator(op1), "the operator still answers for itself");
    }

    /// The point of the split. Whoever holds the signing key can speak for the operator and
    /// can do nothing at all to the bond: it cannot start the unbond, withdraw, or top up.
    function test_signer_cannotMoveTheBond() public {
        _withSigner(op1, signer1);

        vm.startPrank(signer1);
        vm.expectRevert(abi.encodeWithSelector(
            SigvaraOracleBond.WrongStatus.selector, signer1, SigvaraOracleBond.Status.None
        ));
        bond.initiateUnbond();
        vm.expectRevert(abi.encodeWithSelector(
            SigvaraOracleBond.WrongStatus.selector, signer1, SigvaraOracleBond.Status.None
        ));
        bond.withdrawBond();
        vm.expectRevert(abi.encodeWithSelector(SigvaraOracleBond.AlreadySigner.selector, signer1));
        bond.depositBond(1e18);
        vm.stopPrank();

        assertEq(bond.bondOf(op1), BOND);
        assertEq(svr.balanceOf(address(bond)), BOND);
        assertEq(bond.activeCount(), 1);
    }

    /// The signer's standing is the operator's, read live. Each way an operator stops
    /// being Active with its bond takes the signer with it, without anyone having to
    /// remember the signer exists.
    function test_signer_losesStandingWhenTheOperatorLeaves() public {
        _withSigner(op1, signer1);
        vm.prank(op1);
        bond.initiateUnbond();
        assertFalse(bond.isActiveOperator(signer1), "unbond started");
    }

    function test_signer_losesStandingWhenTheOperatorIsRemoved() public {
        _withSigner(op1, signer1);
        vm.prank(admin);
        bond.removeOperator(op1);
        assertFalse(bond.isActiveOperator(signer1), "removed by governance");
    }

    function test_signer_losesStandingWhenTheOperatorIsSlashedBelowTheBond() public {
        _withSigner(op1, signer1);
        vm.prank(slasher);
        bond.slash(op1, 1);
        assertFalse(bond.isActiveOperator(signer1), "demoted");
    }

    function test_signer_losesStandingWhenTheBondRequirementRises() public {
        _withSigner(op1, signer1);
        vm.prank(admin);
        bond.setBondAmount(BOND * 2);
        assertFalse(bond.isActiveOperator(signer1), "under-bonded");
        vm.prank(op1);
        bond.depositBond(BOND);
        assertTrue(bond.isActiveOperator(signer1), "restored by topping up, as for the operator");
    }

    function test_clearSigner_endsTheSignersStanding() public {
        _withSigner(op1, signer1);

        vm.expectEmit(address(bond));
        emit SigvaraOracleBond.SignerCleared(op1, signer1);
        vm.prank(op1);
        bond.clearSigner();

        assertFalse(bond.isActiveOperator(signer1));
        assertEq(bond.operatorOfSigner(signer1), address(0));
        assertEq(bond.signerOf(op1), address(0));
        assertTrue(bond.isActiveOperator(op1), "the operator is untouched");
    }

    function test_clearSigner_withoutOne_reverts() public {
        _bondAndAdmit(op1, BOND);
        vm.expectRevert(abi.encodeWithSelector(SigvaraOracleBond.NoSigner.selector, op1));
        vm.prank(op1);
        bond.clearSigner();
    }

    /// An operator that has already started leaving must still be able to give the answer
    /// to a stolen key.
    function test_clearSigner_worksWhileExiting() public {
        _withSigner(op1, signer1);
        vm.prank(op1);
        bond.initiateUnbond();
        vm.prank(op1);
        bond.clearSigner();
        assertEq(bond.operatorOfSigner(signer1), address(0));
    }

    function test_setSigner_replacesTheOldOne() public {
        _withSigner(op1, signer1);

        vm.expectEmit(address(bond));
        emit SigvaraOracleBond.SignerCleared(op1, signer1);
        vm.expectEmit(address(bond));
        emit SigvaraOracleBond.SignerSet(op1, signer2);
        vm.prank(op1);
        bond.setSigner(signer2);

        assertFalse(bond.isActiveOperator(signer1), "the old signer is out the moment the new one is named");
        assertTrue(bond.isActiveOperator(signer2));
        assertEq(bond.operatorOfSigner(signer1), address(0));
        assertEq(bond.signerOf(op1), signer2);
    }

    /// Naming the same signer again changes nothing and does not trip over itself.
    function test_setSigner_sameSignerAgain_isRefused() public {
        _withSigner(op1, signer1);
        vm.expectRevert(abi.encodeWithSelector(SigvaraOracleBond.SignerNotFree.selector, signer1));
        vm.prank(op1);
        bond.setSigner(signer1);
        assertTrue(bond.isActiveOperator(signer1));
    }

    /// Only an operator governance has admitted, and which still holds its bond, can name
    /// a signer. Otherwise anyone could reserve addresses they do not own.
    function test_setSigner_requiresAnActiveOperator() public {
        // Not in the registry at all.
        vm.expectRevert(abi.encodeWithSelector(
            SigvaraOracleBond.WrongStatus.selector, op1, SigvaraOracleBond.Status.None
        ));
        vm.prank(op1);
        bond.setSigner(signer1);

        // Bonded, not yet admitted.
        vm.prank(op1);
        bond.depositBond(BOND);
        vm.expectRevert(abi.encodeWithSelector(
            SigvaraOracleBond.WrongStatus.selector, op1, SigvaraOracleBond.Status.Bonded
        ));
        vm.prank(op1);
        bond.setSigner(signer1);

        // Leaving.
        vm.prank(admin);
        bond.admit(op1);
        vm.prank(op1);
        bond.initiateUnbond();
        vm.expectRevert(abi.encodeWithSelector(
            SigvaraOracleBond.WrongStatus.selector, op1, SigvaraOracleBond.Status.Exiting
        ));
        vm.prank(op1);
        bond.setSigner(signer1);

        // Demoted: Active status is what counts, and a slash below the bar changes it.
        _bondAndAdmit(op2, BOND);
        vm.prank(slasher);
        bond.slash(op2, 1);
        vm.expectRevert(abi.encodeWithSelector(
            SigvaraOracleBond.WrongStatus.selector, op2, SigvaraOracleBond.Status.Bonded
        ));
        vm.prank(op2);
        bond.setSigner(signer1);
    }

    /// A signer cannot itself name a signer: it is not an operator.
    function test_setSigner_aSignerCannotNameOne() public {
        _withSigner(op1, signer1);
        vm.expectRevert(abi.encodeWithSelector(
            SigvaraOracleBond.WrongStatus.selector, signer1, SigvaraOracleBond.Status.None
        ));
        vm.prank(signer1);
        bond.setSigner(signer2);
    }

    function test_setSigner_rejectsZeroAndSelf() public {
        _bondAndAdmit(op1, BOND);
        vm.expectRevert(SigvaraOracleBond.ZeroAddress.selector);
        vm.prank(op1);
        bond.setSigner(address(0));
        vm.expectRevert(abi.encodeWithSelector(SigvaraOracleBond.SignerNotFree.selector, op1));
        vm.prank(op1);
        bond.setSigner(op1);
    }

    /// An address with any other part in the registry cannot be a signer, because
    /// isActiveOperator could not then say which of two things it was answering for.
    function test_setSigner_rejectsAddressesInUse() public {
        _withSigner(op1, signer1);
        _bondAndAdmit(op2, BOND);

        // Another operator, Active.
        vm.expectRevert(abi.encodeWithSelector(SigvaraOracleBond.SignerNotFree.selector, op1));
        vm.prank(op2);
        bond.setSigner(op1);

        // Another operator's signer.
        vm.expectRevert(abi.encodeWithSelector(SigvaraOracleBond.SignerNotFree.selector, signer1));
        vm.prank(op2);
        bond.setSigner(signer1);

        // An applicant that has bonded and not been admitted.
        svr.mint(stranger, BOND);
        vm.startPrank(stranger);
        svr.approve(address(bond), type(uint256).max);
        bond.depositBond(BOND);
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(SigvaraOracleBond.SignerNotFree.selector, stranger));
        vm.prank(op2);
        bond.setSigner(stranger);
    }

    /// The same address cannot sign for two operators.
    function test_setSigner_oneSignerForOneOperator() public {
        _withSigner(op1, signer1);
        _bondAndAdmit(op2, BOND);
        vm.expectRevert(abi.encodeWithSelector(SigvaraOracleBond.SignerNotFree.selector, signer1));
        vm.prank(op2);
        bond.setSigner(signer1);
    }

    function test_twoOperators_haveIndependentSigners() public {
        _withSigner(op1, signer1);
        _withSigner(op2, signer2);
        assertTrue(bond.isActiveOperator(signer1));
        assertTrue(bond.isActiveOperator(signer2));

        vm.prank(op1);
        bond.clearSigner();
        assertFalse(bond.isActiveOperator(signer1));
        assertTrue(bond.isActiveOperator(signer2), "the other operator's signer is untouched");
    }

    /// When an operator leaves for good the address it named is released, not reserved for a
    /// record that no longer exists.
    function test_withdrawBond_releasesTheSigner() public {
        _withSigner(op1, signer1);
        vm.prank(op1);
        bond.initiateUnbond();
        vm.warp(block.timestamp + UNBOND);

        vm.expectEmit(address(bond));
        emit SigvaraOracleBond.SignerCleared(op1, signer1);
        vm.prank(op1);
        bond.withdrawBond();

        assertEq(bond.operatorOfSigner(signer1), address(0));
        assertEq(bond.signerOf(op1), address(0));

        // The released address can now be an operator in its own right.
        svr.mint(signer1, BOND);
        vm.startPrank(signer1);
        svr.approve(address(bond), BOND);
        bond.depositBond(BOND);
        vm.stopPrank();
        assertEq(bond.bondOf(signer1), BOND);
    }

    function test_slashToZero_releasesTheSigner() public {
        _withSigner(op1, signer1);
        vm.prank(slasher);
        bond.slash(op1, BOND);
        assertEq(bond.operatorOfSigner(signer1), address(0));
        assertEq(bond.signerOf(op1), address(0));
        assertFalse(bond.isActiveOperator(signer1));
    }

    /// A partial slash that leaves a bond behind keeps the record, and the signer with it.
    function test_partialSlash_keepsTheSignerNamed() public {
        _bondAndAdmit(op1, 2 * BOND);
        vm.prank(op1);
        bond.setSigner(signer1);
        vm.prank(slasher);
        bond.slash(op1, BOND / 2);
        assertEq(bond.operatorOfSigner(signer1), op1);
        assertTrue(bond.isActiveOperator(signer1), "still above the requirement");
    }

    function test_upgrade_keepsSigners() public {
        _withSigner(op1, signer1);
        address newImpl = address(new SigvaraOracleBond());
        vm.prank(admin);
        bond.upgradeToAndCall(newImpl, "");
        assertTrue(bond.isActiveOperator(signer1));
        assertEq(bond.operatorOfSigner(signer1), op1);
        assertEq(bond.signerOf(op1), signer1);
    }

    // -------------------------------------------------------------------------
    // Upgrade authorization
    // -------------------------------------------------------------------------

    function test_upgrade_notUpgrader_reverts() public {
        address newImpl = address(new SigvaraOracleBond());
        bytes32 role = bond.UPGRADER_ROLE();
        vm.expectRevert(abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role
        ));
        vm.prank(stranger);
        bond.upgradeToAndCall(newImpl, "");
    }

    function test_upgrade_byAdmin_keepsState() public {
        _bondAndAdmit(op1, BOND);
        address newImpl = address(new SigvaraOracleBond());
        vm.prank(admin);
        bond.upgradeToAndCall(newImpl, "");
        assertTrue(bond.isActiveOperator(op1));
        assertEq(bond.bondOf(op1), BOND);
    }

    function test_implementation_cannotBeInitialized() public {
        SigvaraOracleBond impl = new SigvaraOracleBond();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(admin, slasher, address(svr), BOND, UNBOND, beneficiary);
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

    /// The signer mappings were appended after `operators`. A proxy that predates them reads
    /// both as empty, so every operator keeps acting for itself and nothing needs migrating.
    function test_storageLayout_signerMappingsPinnedToSlots6And7() public {
        _withSigner(op1, signer1);
        assertEq(
            address(uint160(uint256(vm.load(address(bond), keccak256(abi.encode(signer1, uint256(6))))))),
            op1,
            "slot 6 is signer => operator"
        );
        assertEq(
            address(uint160(uint256(vm.load(address(bond), keccak256(abi.encode(op1, uint256(7))))))),
            signer1,
            "slot 7 is operator => signer"
        );
    }

    /// An operator written the way a proxy that predates signers wrote it has empty signer
    /// mappings and must read as active exactly as before.
    function test_legacyOperator_withNoSignerMappingsStillReadsActive() public {
        _bondAndAdmit(op1, BOND);
        assertEq(uint256(vm.load(address(bond), keccak256(abi.encode(op1, uint256(7))))), 0);
        assertEq(uint256(vm.load(address(bond), keccak256(abi.encode(op1, uint256(6))))), 0);
        assertTrue(bond.isActiveOperator(op1));
    }
}
