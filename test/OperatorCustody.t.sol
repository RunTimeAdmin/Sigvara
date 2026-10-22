// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "./helpers/StackFixture.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";

import "../src/SigvaraOracleBond.sol";
import "../src/SigvaraEpochFees.sol";

/**
 * The oracle's custody arrangement end to end, on the real contracts: a cold key that owns
 * the bond, a signer that runs the oracle, and what a thief holding the signer's key can and
 * cannot do. The unit tests cover each contract on its own. This is the scenario that they
 * were all written for.
 *
 * Before the split the oracle's one key owned the 2,500,000 SVR bond, so a thief with it
 * could start an unbond and withdraw seven days later, could leave pending proposals that
 * finalized after the key was revoked, and could empty every prepaid fee balance in a loop.
 */
contract OperatorCustodyTest is StackFixture {
    SigvaraOracleBond bondReg;
    SigvaraEpochFees fees;

    address cold = makeAddr("coldOperator");   // owns the bond: a hardware key or a Safe
    address signer = makeAddr("signer");       // the key on the oracle host
    address cold2 = makeAddr("coldOperator2"); // a second operator, for the checker
    address signer2 = makeAddr("signer2");
    address slasher = makeAddr("slasher");
    address beneficiary = makeAddr("beneficiary");
    address funder = makeAddr("funder");

    uint256 constant BOND = 2_500_000e18;
    uint256 constant UNBOND = 7 days;
    uint256 constant FEE = 10e18;
    uint256 constant EPOCH = 1 days;

    bytes32 didHash;

    function setUp() public {
        _deployStack();

        bondReg = SigvaraOracleBond(address(new ERC1967Proxy(
            address(new SigvaraOracleBond()),
            abi.encodeCall(SigvaraOracleBond.initialize, (admin, slasher, address(svr), BOND, UNBOND, beneficiary))
        )));
        fees = SigvaraEpochFees(address(new ERC1967Proxy(
            address(new SigvaraEpochFees()),
            abi.encodeCall(SigvaraEpochFees.initialize, (
                admin, address(0), address(svr), address(identity), makeAddr("rewardPool"), FEE
            ))
        )));

        vm.startPrank(admin);
        fees.initializeV2(EPOCH, address(bondReg));
        reputation.setOperatorBond(address(bondReg));
        vm.stopPrank();

        _onboard(cold, signer);

        (, uint256 agentPk) = makeAddrAndKey("agent");
        didHash = _registerAndBond(agentPk, MIN_STAKE);

        svr.mint(funder, 1_000e18);
        vm.startPrank(funder);
        svr.approve(address(fees), type(uint256).max);
        fees.depositFor(didHash, 100 * FEE);
        vm.stopPrank();
    }

    /// The bring-up in order: the cold key bonds, governance admits it, the cold key names
    /// its signer, governance gives the signer the role on both contracts.
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
        vm.startPrank(admin);
        reputation.grantRole(role, key);
        fees.grantRole(role, key);
        vm.stopPrank();
    }

    function _propose(address who, SigvaraReputation.ReputationData memory data) internal {
        vm.prank(who);
        reputation.proposeReputation(didHash, data, bytes32(0));
    }

    function _perfect() internal view returns (SigvaraReputation.ReputationData memory) {
        return SigvaraReputation.ReputationData({
            feeScore: reputation.MAX_FEE_SCORE(),
            successScore: reputation.MAX_SUCCESS_SCORE(),
            ageScore: reputation.MAX_AGE_SCORE(),
            externalScore: reputation.MAX_EXTERNAL_SCORE(),
            communityScore: reputation.MAX_COMMUNITY_SCORE(),
            propagationScore: reputation.MAX_PROPAGATION_SCORE(),
            lastUpdated: 0
        });
    }

    // -------------------------------------------------------------------------
    // The arrangement works
    // -------------------------------------------------------------------------

    function test_theSignerRunsTheOracle() public {
        // The role that existed before the registry was switched on is no longer enough.
        vm.expectRevert(abi.encodeWithSelector(SigvaraReputation.OracleNotBonded.selector, oracle));
        _propose(oracle, _score40());

        _propose(signer, _score40());
        assertEq(reputation.getPendingScore(didHash).proposer, signer);
        vm.warp(block.timestamp + SCORE_WINDOW + 1);
        reputation.finalizeReputation(didHash);
        assertEq(reputation.getEarnedScore(didHash), 40);

        vm.warp(block.timestamp + EPOCH);
        vm.prank(signer);
        fees.chargeEpoch(didHash);
        assertEq(fees.collected(), FEE);
    }

    function test_theOperatorItselfStillAnswersForItself_whenItHoldsTheRole() public {
        // The old arrangement keeps working for an operator that never names a signer.
        svr.mint(cold2, BOND);
        vm.startPrank(cold2);
        svr.approve(address(bondReg), type(uint256).max);
        bondReg.depositBond(BOND);
        vm.stopPrank();
        vm.prank(admin);
        bondReg.admit(cold2);
        bytes32 role = reputation.ORACLE_ROLE();
        vm.prank(admin);
        reputation.grantRole(role, cold2);

        _propose(cold2, _score40());
        assertEq(reputation.getPendingScore(didHash).proposer, cold2);
    }

    // -------------------------------------------------------------------------
    // A thief holding the signer's key
    // -------------------------------------------------------------------------

    /// The bond is out of reach. Every route to it is the operator's.
    function test_aStolenSigner_cannotTouchTheBond() public {
        vm.startPrank(signer);
        vm.expectRevert(abi.encodeWithSelector(
            SigvaraOracleBond.WrongStatus.selector, signer, SigvaraOracleBond.Status.None
        ));
        bondReg.initiateUnbond();
        vm.expectRevert(abi.encodeWithSelector(
            SigvaraOracleBond.WrongStatus.selector, signer, SigvaraOracleBond.Status.None
        ));
        bondReg.withdrawBond();
        vm.expectRevert(abi.encodeWithSelector(SigvaraOracleBond.AlreadySigner.selector, signer));
        bondReg.depositBond(1);
        vm.expectRevert(abi.encodeWithSelector(
            SigvaraOracleBond.WrongStatus.selector, signer, SigvaraOracleBond.Status.None
        ));
        bondReg.setSigner(makeAddr("somewhereElse"));
        vm.stopPrank();

        assertEq(bondReg.bondOf(cold), BOND);
        assertEq(svr.balanceOf(address(bondReg)), BOND);
        assertEq(bondReg.signerOf(cold), signer, "and the thief cannot name a different signer either");
    }

    /// The thief proposes a perfect score. The operator clears the signer inside the
    /// challenge window and the proposal never goes live, with no committee action.
    function test_aStolenSigner_proposalDiesWhenTheOperatorClearsIt() public {
        _propose(signer, _perfect());

        vm.prank(cold);
        bondReg.clearSigner();

        vm.warp(block.timestamp + SCORE_WINDOW + 1);
        vm.expectRevert(abi.encodeWithSelector(SigvaraReputation.ProposerNotAuthorized.selector, didHash, signer));
        reputation.finalizeReputation(didHash);
        assertEq(reputation.getEarnedScore(didHash), 0);

        // And the key is useless from the moment it was cleared. The score is built first: an
        // argument that is itself a call would use up the expectation.
        SigvaraReputation.ReputationData memory perfect = _perfect();
        vm.expectRevert(abi.encodeWithSelector(SigvaraReputation.OracleNotBonded.selector, signer));
        _propose(signer, perfect);
    }

    /// The same by governance, for an operator that is unreachable: removing it from the
    /// set is one transaction and ends the signer's pending proposals as well.
    function test_aStolenSigner_proposalDiesWhenGovernanceRemovesTheOperator() public {
        _propose(signer, _perfect());

        vm.prank(admin);
        bondReg.removeOperator(cold);

        vm.warp(block.timestamp + SCORE_WINDOW + 1);
        vm.expectRevert(abi.encodeWithSelector(SigvaraReputation.ProposerNotAuthorized.selector, didHash, signer));
        reputation.finalizeReputation(didHash);
        assertEq(reputation.getEarnedScore(didHash), 0);
    }

    /// And revoking the role on reputation alone is enough for the pending proposal, though
    /// the registry is the one place to do it.
    function test_aStolenSigner_proposalDiesWhenTheRoleIsRevoked() public {
        _propose(signer, _perfect());
        bytes32 role = reputation.ORACLE_ROLE();
        vm.prank(admin);
        reputation.revokeRole(role, signer);

        vm.warp(block.timestamp + SCORE_WINDOW + 1);
        vm.expectRevert(abi.encodeWithSelector(SigvaraReputation.ProposerNotAuthorized.selector, didHash, signer));
        reputation.finalizeReputation(didHash);
    }

    /// The thief cannot empty the prepaid balances. It gets one charge per agent per epoch,
    /// which is what the agent would have paid anyway, and none once the signer is cleared.
    function test_aStolenSigner_cannotDrainTheFees() public {
        vm.warp(10 * EPOCH);
        uint256 charged;
        for (uint256 i = 0; i < 25; i++) {
            vm.prank(signer);
            try fees.chargeEpoch(didHash) returns (bool) { charged++; } catch {}
        }
        assertEq(charged, 1);
        assertEq(fees.balance(didHash), 99 * FEE);

        vm.prank(cold);
        bondReg.clearSigner();
        vm.warp(11 * EPOCH);
        vm.expectRevert(abi.encodeWithSelector(SigvaraEpochFees.OracleNotBonded.selector, signer));
        vm.prank(signer);
        fees.chargeEpoch(didHash);
        assertEq(fees.balance(didHash), 99 * FEE);
    }

    // -------------------------------------------------------------------------
    // Recovery
    // -------------------------------------------------------------------------

    /// The operator names a new signer and governance gives it the role. Its first proposal
    /// replaces the stranded one and finalizes.
    function test_theOperatorRecovers_withANewSigner() public {
        _propose(signer, _perfect());
        vm.prank(cold);
        bondReg.clearSigner();

        address fresh = makeAddr("freshSigner");
        vm.prank(cold);
        bondReg.setSigner(fresh); // the operator is still Active: clearing does not change that
        bytes32 role = reputation.ORACLE_ROLE();
        vm.prank(admin);
        reputation.grantRole(role, fresh);

        _propose(fresh, _score40());
        assertEq(reputation.getPendingScore(didHash).proposer, fresh);
        vm.warp(block.timestamp + SCORE_WINDOW + 1);
        reputation.finalizeReputation(didHash);
        assertEq(reputation.getEarnedScore(didHash), 40, "the new signer's number, not the thief's");
    }

    /// A checker covering for a primary that was removed replaces the dead proposal through
    /// the compare-and-swap entry point, which would otherwise refuse because the slot is full.
    function test_theCheckerCoversForARemovedPrimary() public {
        _onboard(cold2, signer2);
        _propose(signer, _perfect());

        vm.prank(admin);
        bondReg.removeOperator(cold);

        vm.prank(signer2);
        reputation.proposeIfEmpty(didHash, _score40(), bytes32(0));
        assertEq(reputation.getPendingScore(didHash).proposer, signer2);

        vm.warp(block.timestamp + SCORE_WINDOW + 1);
        reputation.finalizeReputation(didHash);
        assertEq(reputation.getEarnedScore(didHash), 40);
    }

    /// And it still refuses to overwrite a primary that is alive.
    function test_theCheckerCannotOverwriteALivePrimary() public {
        _onboard(cold2, signer2);
        _propose(signer, _score40());

        SigvaraReputation.ReputationData memory perfect = _perfect();
        vm.expectRevert(abi.encodeWithSelector(
            SigvaraReputation.ScoreAlreadyPending.selector, didHash, block.timestamp
        ));
        vm.prank(signer2);
        reputation.proposeIfEmpty(didHash, perfect, bytes32(0));
    }

    // -------------------------------------------------------------------------
    // The bond's own path out
    // -------------------------------------------------------------------------

    function test_theColdOperatorWithdrawsToItself() public {
        vm.prank(cold);
        bondReg.initiateUnbond();
        assertFalse(bondReg.isActiveOperator(signer), "the signer is out the moment the operator is");

        vm.warp(block.timestamp + UNBOND);
        vm.prank(cold);
        bondReg.withdrawBond();
        assertEq(svr.balanceOf(cold), BOND);
        assertEq(bondReg.operatorOfSigner(signer), address(0), "and the signer is released");
    }

    /// Slashing is of the operator, because that is who owns the bond. The signer holds none.
    function test_theCommitteeSlashesTheOperatorNotTheSigner() public {
        vm.expectRevert(abi.encodeWithSelector(SigvaraOracleBond.NoBond.selector, signer));
        vm.prank(slasher);
        bondReg.slash(signer, 1);

        vm.prank(slasher);
        bondReg.slash(cold, BOND / 2);
        assertEq(svr.balanceOf(beneficiary), BOND / 2);
        assertFalse(bondReg.isActiveOperator(signer), "demoted below the requirement, so its signer is out too");
        assertEq(bondReg.operatorOfSigner(signer), cold, "still named until the operator tops up, leaves or clears it");
    }
}
