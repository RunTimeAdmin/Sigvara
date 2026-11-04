// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "./helpers/StackFixture.sol";

import "../src/SigvaraOracleBond.sol";
import "../src/SigvaraEpochFees.sol";
import "../src/SigvaraRewardDistributor.sol";

/**
 * The reward distributor on the real registries: two bonded operators, each with a cold key
 * that owns the bond and a signer that runs the oracle, proposing scores that go live through
 * the distributor. What it pays is decided by points earned and nothing else, so every test
 * below is about who earns a point, when a period's tokens are fixed, and who may take them.
 */
contract SigvaraRewardDistributorTest is StackFixture {
    SigvaraOracleBond bondReg;
    SigvaraRewardDistributor dist;

    address cold = makeAddr("coldOperator");
    address signer = makeAddr("signer");
    address cold2 = makeAddr("coldOperator2");
    address signer2 = makeAddr("signer2");
    address slasher = makeAddr("slasher");
    address beneficiary = makeAddr("beneficiary");

    uint256 constant BOND = 2_500_000e18;
    uint256 constant UNBOND = 7 days;
    uint256 constant PERIOD = 7 days;
    uint256 constant CLAIM_PERIODS = 4;

    bytes32[] agents;

    function setUp() public {
        _deployStack();

        bondReg = SigvaraOracleBond(address(new ERC1967Proxy(
            address(new SigvaraOracleBond()),
            abi.encodeCall(SigvaraOracleBond.initialize, (admin, slasher, address(svr), BOND, UNBOND, beneficiary))
        )));
        vm.prank(admin);
        reputation.setOperatorBond(address(bondReg));

        _onboard(cold, signer);
        _onboard(cold2, signer2);

        for (uint256 i = 0; i < 6; i++) {
            (, uint256 pk) = makeAddrAndKey(string.concat("agent", vm.toString(i)));
            agents.push(_registerAndBond(pk, MIN_STAKE));
        }

        dist = new SigvaraRewardDistributor(address(svr), address(reputation), address(bondReg), PERIOD, CLAIM_PERIODS);
    }

    function _onboard(address owner, address key) internal {
        svr.mint(owner, BOND);
        vm.startPrank(owner);
        svr.approve(address(bondReg), type(uint256).max);
        bondReg.depositBond(BOND);
        vm.stopPrank();
        vm.prank(admin);
        bondReg.admit(owner);
        vm.prank(owner);
        bondReg.setSigner(key);
        bytes32 role = reputation.ORACLE_ROLE();
        vm.prank(admin);
        reputation.grantRole(role, key);
    }

    /// `key` proposes for `didHash`; the window passes; the distributor finalizes it.
    function _serve(address key, bytes32 didHash) internal {
        vm.prank(key);
        reputation.proposeReputation(didHash, _score40(), bytes32(0));
        vm.warp(block.timestamp + SCORE_WINDOW + 1);
        dist.finalize(didHash);
    }

    function _fund(uint256 amount) internal {
        svr.mint(address(dist), amount);
    }

    function _endPeriod() internal {
        vm.warp(dist.start() + (dist.currentPeriod() + 1) * PERIOD);
    }

    // -------------------------------------------------------------------------
    // Earning
    // -------------------------------------------------------------------------

    function test_aLiveScoreEarnsItsBondOwnerAPoint_notTheSigner() public {
        _serve(signer, agents[0]);

        assertEq(dist.pointsOf(0, cold), 1, "the operator that owns the bond");
        assertEq(dist.pointsOf(0, signer), 0, "not the hot key that sent it");
        assertEq(dist.totalPoints(0), 1);
        assertFalse(reputation.getPendingScore(agents[0]).exists, "and the score is live");
        assertEq(reputation.getReputation(agents[0]).lastUpdated, block.timestamp);
    }

    function test_anOperatorWithNoSignerEarnsAsItself() public {
        vm.prank(cold);
        bondReg.clearSigner();
        bytes32 role = reputation.ORACLE_ROLE();
        vm.prank(admin);
        reputation.grantRole(role, cold);

        _serve(cold, agents[0]);
        assertEq(dist.pointsOf(0, cold), 1);
    }

    function test_finalizeFailsExactlyAsReputationDoes() public {
        vm.expectRevert(abi.encodeWithSelector(SigvaraReputation.NoScorePending.selector, agents[0]));
        dist.finalize(agents[0]);

        vm.prank(signer);
        reputation.proposeReputation(agents[0], _score40(), bytes32(0));
        uint256 at = reputation.getPendingScore(agents[0]).finalizableAt;
        vm.expectRevert(abi.encodeWithSelector(SigvaraReputation.ChallengeWindowActive.selector, agents[0], at));
        dist.finalize(agents[0]);
        assertEq(dist.totalPoints(0), 0);
    }

    function test_aRejectedProposalEarnsNothing() public {
        vm.prank(signer);
        reputation.proposeReputation(agents[0], _score40(), bytes32(0));
        vm.prank(committee);
        reputation.rejectReputation(agents[0]);
        vm.warp(block.timestamp + SCORE_WINDOW + 1);

        vm.expectRevert(abi.encodeWithSelector(SigvaraReputation.NoScorePending.selector, agents[0]));
        dist.finalize(agents[0]);
        assertEq(dist.totalPoints(0), 0);
    }

    function test_aScoreFinalizedAroundTheDistributorEarnsNothing() public {
        vm.prank(signer);
        reputation.proposeReputation(agents[0], _score40(), bytes32(0));
        vm.warp(block.timestamp + SCORE_WINDOW + 1);
        reputation.finalizeReputation(agents[0]);
        assertEq(dist.totalPoints(0), 0);
    }

    // -------------------------------------------------------------------------
    // Closing and claiming
    // -------------------------------------------------------------------------

    function test_aClosedPeriodIsSplitByPoints() public {
        _serve(signer, agents[0]);
        _serve(signer, agents[1]);
        _serve(signer2, agents[2]);
        _fund(300e18);

        _endPeriod();
        dist.close();
        assertEq(dist.allotted(0), 300e18);
        assertEq(dist.reserved(), 300e18);

        vm.prank(cold);
        dist.claim(0);
        vm.prank(cold2);
        dist.claim(0);
        assertEq(svr.balanceOf(cold), 200e18);
        assertEq(svr.balanceOf(cold2), 100e18);
        assertEq(dist.reserved(), 0);
    }

    function test_periodsCloseOldestFirst_andOnlyOnceEnded() public {
        vm.expectRevert(abi.encodeWithSelector(SigvaraRewardDistributor.NothingToClose.selector, 0));
        dist.close();

        _endPeriod();
        dist.close();
        vm.expectRevert(abi.encodeWithSelector(SigvaraRewardDistributor.NothingToClose.selector, 1));
        dist.close();

        // Three periods later, three more close one at a time.
        vm.warp(block.timestamp + 3 * PERIOD);
        dist.close();
        dist.close();
        dist.close();
        assertEq(dist.nextToClose(), 4);
    }

    function test_tokensWaitThroughAPeriodWithNoPoints() public {
        _fund(100e18);
        _endPeriod();
        dist.close();
        assertEq(dist.allotted(0), 0, "nobody earned anything in period 0");

        _serve(signer2, agents[0]);
        _fund(50e18);
        _endPeriod();
        dist.close();
        assertEq(dist.allotted(1), 150e18, "the first period with points gets it all");
    }

    function test_whatArrivesAfterAClose_goesToTheNextPeriod() public {
        _serve(signer, agents[0]);
        _fund(100e18);
        _endPeriod();
        dist.close();
        _fund(40e18);

        _serve(signer2, agents[1]);
        _endPeriod();
        dist.close();
        assertEq(dist.allotted(0), 100e18);
        assertEq(dist.allotted(1), 40e18);
    }

    function test_onlyTheBondOwnerCanClaim_andOnlyOnce() public {
        _serve(signer, agents[0]);
        _fund(10e18);

        vm.expectRevert(abi.encodeWithSelector(SigvaraRewardDistributor.PeriodNotClosed.selector, 0));
        vm.prank(cold);
        dist.claim(0);

        _endPeriod();
        dist.close();

        // The signer answers isActiveOperator for its operator but holds no points of its own.
        vm.expectRevert(abi.encodeWithSelector(SigvaraRewardDistributor.NothingToClaim.selector, 0, signer));
        vm.prank(signer);
        dist.claim(0);

        address stranger = makeAddr("stranger");
        vm.expectRevert(abi.encodeWithSelector(SigvaraRewardDistributor.NotActiveOperator.selector, stranger));
        vm.prank(stranger);
        dist.claim(0);

        vm.prank(cold);
        dist.claim(0);
        vm.expectRevert(abi.encodeWithSelector(SigvaraRewardDistributor.AlreadyClaimed.selector, 0, cold));
        vm.prank(cold);
        dist.claim(0);
    }

    function test_anOperatorSlashedBelowItsBondCannotClaim_andItsShareReturns() public {
        _serve(signer, agents[0]);
        _serve(signer2, agents[1]);
        _fund(100e18);
        _endPeriod();
        dist.close();

        vm.prank(slasher);
        bondReg.slash(cold, 1e18);
        vm.expectRevert(abi.encodeWithSelector(SigvaraRewardDistributor.NotActiveOperator.selector, cold));
        vm.prank(cold);
        dist.claim(0);

        vm.prank(cold2);
        dist.claim(0);
        assertEq(svr.balanceOf(cold2), 50e18);

        // The window runs out and the forfeited half goes back to the pool.
        uint256 until = dist.closedAt(0) + CLAIM_PERIODS * PERIOD;
        vm.expectRevert(abi.encodeWithSelector(SigvaraRewardDistributor.ClaimWindowOpen.selector, 0, until));
        dist.release(0);
        vm.warp(until);
        dist.release(0);
        assertEq(dist.reserved(), 0);

        vm.expectRevert(abi.encodeWithSelector(SigvaraRewardDistributor.AlreadyReleased.selector, 0));
        vm.prank(cold2);
        dist.claim(0);

        // Periods 1 to 4 ended with no points while the window ran; they close empty.
        for (uint256 p = 1; p < dist.currentPeriod(); p++) dist.close();
        _serve(signer2, agents[2]);
        _endPeriod();
        dist.close();
        assertEq(dist.allotted(dist.nextToClose() - 1), 50e18, "a later period with points takes it");
    }

    function test_roundingIsReleasedWithTheRest() public {
        // Three operators, one point each, 100 wei: each claims 33 and 1 is left.
        address cold3 = makeAddr("coldOperator3");
        address signer3 = makeAddr("signer3");
        _onboard(cold3, signer3);
        _serve(signer, agents[0]);
        _serve(signer2, agents[1]);
        _serve(signer3, agents[2]);
        _fund(100);
        _endPeriod();
        dist.close();

        vm.prank(cold);
        dist.claim(0);
        vm.prank(cold2);
        dist.claim(0);
        vm.prank(cold3);
        dist.claim(0);
        assertEq(dist.paid(0), 99);
        assertEq(dist.reserved(), 1);

        vm.warp(dist.closedAt(0) + CLAIM_PERIODS * PERIOD);
        dist.release(0);
        assertEq(dist.reserved(), 0);
        assertEq(svr.balanceOf(address(dist)), 1, "free for the next period with points");
    }

    function testFuzz_neverPaysMoreThanItAllotted(uint8 a, uint8 b, uint96 amount) public {
        a = uint8(bound(a, 1, 5));
        b = uint8(bound(b, 0, 5));
        uint256 i;
        for (; i < a; i++) _serve(signer, _agent(i));
        for (uint256 j; j < b; j++) _serve(signer2, _agent(i + j));
        _fund(amount);
        _endPeriod();
        dist.close();

        // A share that rounds to nothing is not claimable, and says so.
        address[2] memory ops = [cold, cold2];
        for (uint256 k; k < 2; k++) {
            if (dist.claimable(0, ops[k]) == 0) continue;
            vm.prank(ops[k]);
            dist.claim(0);
        }
        assertLe(dist.paid(0), dist.allotted(0));
        assertEq(dist.reserved(), dist.allotted(0) - dist.paid(0));
        assertGe(svr.balanceOf(address(dist)), dist.reserved());
        // Rounding loses at most one wei per claimant.
        assertLe(dist.allotted(0) - dist.paid(0), 2);
    }

    /// Agents beyond the six from setUp, registered as the fuzz test needs them.
    function _agent(uint256 i) internal returns (bytes32) {
        if (i < agents.length) return agents[i];
        (, uint256 pk) = makeAddrAndKey(string.concat("agent", vm.toString(i)));
        agents.push(_registerAndBond(pk, MIN_STAKE));
        return agents[i];
    }

    // -------------------------------------------------------------------------
    // Fed by the fee registry
    // -------------------------------------------------------------------------

    function test_theFeeRegistrySweepsItsRewardShareHere() public {
        SigvaraEpochFees fees = SigvaraEpochFees(address(new ERC1967Proxy(
            address(new SigvaraEpochFees()),
            abi.encodeCall(SigvaraEpochFees.initialize, (admin, address(0), address(svr), address(identity), address(dist), 10e18))
        )));
        bytes32 role = fees.ORACLE_ROLE();
        vm.startPrank(admin);
        fees.initializeV2(1 days, address(bondReg));
        fees.grantRole(role, signer);
        vm.stopPrank();

        address payer = makeAddr("payer");
        svr.mint(payer, 100e18);
        vm.startPrank(payer);
        svr.approve(address(fees), type(uint256).max);
        fees.depositFor(agents[0], 100e18);
        vm.stopPrank();

        vm.prank(signer);
        fees.chargeEpoch(agents[0]);
        _serve(signer, agents[0]);
        fees.distributeFees(); // Bootstrap: all of it to the reward pool

        _endPeriod();
        dist.close();
        vm.prank(cold);
        dist.claim(0);
        assertEq(svr.balanceOf(cold), 10e18, "the fee the agent paid reached the operator that scored it");
    }

    // -------------------------------------------------------------------------
    // Construction
    // -------------------------------------------------------------------------

    function test_constructorRefusesWhatCannotWork() public {
        vm.expectRevert(SigvaraRewardDistributor.ZeroAddress.selector);
        new SigvaraRewardDistributor(address(0), address(reputation), address(bondReg), PERIOD, CLAIM_PERIODS);
        vm.expectRevert(SigvaraRewardDistributor.ZeroAddress.selector);
        new SigvaraRewardDistributor(address(svr), address(reputation), address(0), PERIOD, CLAIM_PERIODS);
        vm.expectRevert(abi.encodeWithSelector(SigvaraRewardDistributor.PeriodTooShort.selector, 1 hours, 1 days));
        new SigvaraRewardDistributor(address(svr), address(reputation), address(bondReg), 1 hours, CLAIM_PERIODS);
        vm.expectRevert(SigvaraRewardDistributor.ZeroClaimPeriods.selector);
        new SigvaraRewardDistributor(address(svr), address(reputation), address(bondReg), PERIOD, 0);
    }
}
