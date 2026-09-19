// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "./helpers/RegistrationHelper.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";
import "../src/SigvaraIdentity.sol";
import "../src/SigvaraReputation.sol";

/// Stands in for SigvaraStaking. These are reputation unit tests, so the bond
/// answer is set directly rather than built up through a real stake.
contract RepStakeViewMock is IStakeView {
    bool public bonded = true;
    function set(bool v) external { bonded = v; }
    function hasMinimumStake(bytes32) external view returns (bool) { return bonded; }
}

/// Stands in for SigvaraOracleBond.
contract OperatorSetMock is IOperatorSet {
    mapping(address => bool) public active;
    function set(address who, bool v) external { active[who] = v; }
    function isActiveOperator(address who) external view returns (bool) { return active[who]; }
}

/// An identity registry from before operator transfer: it answers what the bond and
/// scorability checks need, and has no operatorChangedAt at all.
contract LegacyIdentityMock {
    IStakeView public stakeView;
    address private op;
    address private agent;

    constructor(address stakeView_, address operator_, address agent_) {
        stakeView = IStakeView(stakeView_);
        op = operator_;
        agent = agent_;
    }

    function getIdentity(bytes32) external view returns (SigvaraIdentity.AgentIdentity memory) {
        return SigvaraIdentity.AgentIdentity({
            operator: op,
            agentAddress: agent,
            ed25519PubKey: bytes32(uint256(1)),
            status: SigvaraIdentity.AgentStatus.Active,
            registeredAt: 1
        });
    }
}

contract SigvaraReputationTest is Test, RegistrationHelper {
    SigvaraReputation rep;
    SigvaraIdentity identity;
    RepStakeViewMock stakeView;

    address admin     = makeAddr("admin");
    address oracle    = makeAddr("oracle");
    address staking   = makeAddr("staking");
    address committee = makeAddr("committee");
    address stranger  = makeAddr("stranger");
    address operator  = makeAddr("operator");
    address agentAddr;
    uint256 agentPk;

    // Reputation now rejects writes for a didHash the identity registry does not
    // know, so this has to be a really registered agent rather than a bare hash.
    bytes32 DID;
    uint256 constant CHALLENGE_WINDOW = 1 hours;

    SigvaraReputation.ReputationData maxScore = SigvaraReputation.ReputationData({
        feeScore: 30,
        successScore: 25,
        ageScore: 20,
        externalScore: 15,
        communityScore: 5,
        propagationScore: 5,
        lastUpdated: 0
    });

    function setUp() public {
        (agentAddr, agentPk) = makeAddrAndKey("agent");
        identity = SigvaraIdentity(address(new ERC1967Proxy(
            address(new SigvaraIdentity()),
            abi.encodeCall(SigvaraIdentity.initialize, (admin, address(0)))
        )));
        DID = registerSigned(identity, operator, agentPk, bytes32(uint256(0xdeadbeef)));

        stakeView = new RepStakeViewMock();
        vm.prank(admin);
        identity.initializeV2(address(stakeView));

        SigvaraReputation impl = new SigvaraReputation();
        bytes memory init = abi.encodeCall(
            SigvaraReputation.initialize,
            (admin, oracle, staking, committee, CHALLENGE_WINDOW)
        );
        rep = SigvaraReputation(address(new ERC1967Proxy(address(impl), init)));
        vm.prank(admin);
        rep.initializeV3(address(identity));
    }

    // Propose then warp past the challenge window and finalize — the common path
    // used by tests that just need a score live on-chain.
    function _proposeAndFinalize(bytes32 didHash, SigvaraReputation.ReputationData memory data) internal {
        vm.prank(oracle);
        rep.proposeReputation(didHash, data, bytes32(0));
        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);
        rep.finalizeReputation(didHash);
    }

    // -------------------------------------------------------------------------
    // proposeReputation
    // -------------------------------------------------------------------------

    function test_proposeReputation_success() public {
        vm.prank(oracle);
        rep.proposeReputation(DID, maxScore, bytes32(0));

        SigvaraReputation.PendingScore memory pending = rep.getPendingScore(DID);
        assertTrue(pending.exists);
        assertEq(pending.data.feeScore, 30);
        assertEq(pending.proposedAt, block.timestamp);

        // Not live yet — still zero until finalized.
        assertEq(rep.getTotalScore(DID), 0);
    }

    function test_proposeReputation_reverts_notOracle() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                stranger,
                rep.ORACLE_ROLE()
            )
        );
        vm.prank(stranger);
        rep.proposeReputation(DID, maxScore, bytes32(0));
    }

    function test_proposeReputation_replacesExistingPending() public {
        vm.startPrank(oracle);
        rep.proposeReputation(DID, maxScore, bytes32(0));

        SigvaraReputation.ReputationData memory lower = maxScore;
        lower.feeScore = 10;
        vm.warp(block.timestamp + 10);
        rep.proposeReputation(DID, lower, bytes32(0));
        vm.stopPrank();

        SigvaraReputation.PendingScore memory pending = rep.getPendingScore(DID);
        assertEq(pending.data.feeScore, 10);
        assertEq(pending.proposedAt, block.timestamp);
    }

    function test_proposeReputation_reverts_feeScoreOverMax() public {
        SigvaraReputation.ReputationData memory bad = maxScore;
        bad.feeScore = 31;
        vm.expectRevert(
            abi.encodeWithSelector(SigvaraReputation.ScoreOutOfRange.selector, "feeScore", 31, 30)
        );
        vm.prank(oracle);
        rep.proposeReputation(DID, bad, bytes32(0));
    }

    function test_proposeReputation_reverts_successScoreOverMax() public {
        SigvaraReputation.ReputationData memory bad = maxScore;
        bad.successScore = 26;
        vm.expectRevert(
            abi.encodeWithSelector(SigvaraReputation.ScoreOutOfRange.selector, "successScore", 26, 25)
        );
        vm.prank(oracle);
        rep.proposeReputation(DID, bad, bytes32(0));
    }

    function test_proposeReputation_reverts_ageScoreOverMax() public {
        SigvaraReputation.ReputationData memory bad = maxScore;
        bad.ageScore = 21;
        vm.expectRevert(
            abi.encodeWithSelector(SigvaraReputation.ScoreOutOfRange.selector, "ageScore", 21, 20)
        );
        vm.prank(oracle);
        rep.proposeReputation(DID, bad, bytes32(0));
    }

    function test_proposeReputation_reverts_externalScoreOverMax() public {
        SigvaraReputation.ReputationData memory bad = maxScore;
        bad.externalScore = 16;
        vm.expectRevert(
            abi.encodeWithSelector(SigvaraReputation.ScoreOutOfRange.selector, "externalScore", 16, 15)
        );
        vm.prank(oracle);
        rep.proposeReputation(DID, bad, bytes32(0));
    }

    function test_proposeReputation_reverts_communityScoreOverMax() public {
        SigvaraReputation.ReputationData memory bad = maxScore;
        bad.communityScore = 6;
        vm.expectRevert(
            abi.encodeWithSelector(SigvaraReputation.ScoreOutOfRange.selector, "communityScore", 6, 5)
        );
        vm.prank(oracle);
        rep.proposeReputation(DID, bad, bytes32(0));
    }

    function test_proposeReputation_reverts_propagationScoreOverMax() public {
        SigvaraReputation.ReputationData memory bad = maxScore;
        bad.propagationScore = 6;
        vm.expectRevert(
            abi.encodeWithSelector(SigvaraReputation.ScoreOutOfRange.selector, "propagationScore", 6, 5)
        );
        vm.prank(oracle);
        rep.proposeReputation(DID, bad, bytes32(0));
    }

    // -------------------------------------------------------------------------
    // finalizeReputation
    // -------------------------------------------------------------------------

    function test_finalizeReputation_success() public {
        _proposeAndFinalize(DID, maxScore);

        SigvaraReputation.ReputationData memory stored = rep.getReputation(DID);
        assertEq(stored.feeScore, 30);
        assertEq(stored.successScore, 25);
        assertEq(stored.ageScore, 20);
        assertEq(stored.externalScore, 15);
        assertEq(stored.communityScore, 5);
        assertEq(stored.propagationScore, 5);

        SigvaraReputation.PendingScore memory pending = rep.getPendingScore(DID);
        assertFalse(pending.exists);
    }

    function test_finalizeReputation_reverts_beforeWindowElapsed() public {
        uint256 proposedAt = block.timestamp;
        vm.prank(oracle);
        rep.proposeReputation(DID, maxScore, bytes32(0));

        vm.expectRevert(
            abi.encodeWithSelector(
                SigvaraReputation.ChallengeWindowActive.selector,
                DID,
                proposedAt + CHALLENGE_WINDOW
            )
        );
        rep.finalizeReputation(DID);
    }

    function test_finalizeReputation_reverts_noPending() public {
        vm.expectRevert(
            abi.encodeWithSelector(SigvaraReputation.NoScorePending.selector, DID)
        );
        rep.finalizeReputation(DID);
    }

    function test_finalizeReputation_callableByAnyone() public {
        vm.prank(oracle);
        rep.proposeReputation(DID, maxScore, bytes32(0));
        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);

        vm.prank(stranger);
        rep.finalizeReputation(DID);

        assertEq(rep.getTotalScore(DID), 100);
    }

    // -------------------------------------------------------------------------
    // rejectReputation
    // -------------------------------------------------------------------------

    function test_rejectReputation_success() public {
        vm.prank(oracle);
        rep.proposeReputation(DID, maxScore, bytes32(0));

        vm.prank(committee);
        rep.rejectReputation(DID);

        SigvaraReputation.PendingScore memory pending = rep.getPendingScore(DID);
        assertFalse(pending.exists);
        // Existing finalized score (none yet) is untouched — still zero, not the rejected proposal.
        assertEq(rep.getTotalScore(DID), 0);
    }

    function test_rejectReputation_doesNotAffectExistingFinalizedScore() public {
        _proposeAndFinalize(DID, maxScore);

        SigvaraReputation.ReputationData memory lower = maxScore;
        lower.feeScore = 5;
        vm.prank(oracle);
        rep.proposeReputation(DID, lower, bytes32(0));

        vm.prank(committee);
        rep.rejectReputation(DID);

        assertEq(rep.getTotalScore(DID), 100);
    }

    function test_rejectReputation_reverts_notCommittee() public {
        vm.prank(oracle);
        rep.proposeReputation(DID, maxScore, bytes32(0));

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                stranger,
                rep.SLASHING_COMMITTEE_ROLE()
            )
        );
        vm.prank(stranger);
        rep.rejectReputation(DID);
    }

    function test_rejectReputation_reverts_noPending() public {
        vm.expectRevert(
            abi.encodeWithSelector(SigvaraReputation.NoScorePending.selector, DID)
        );
        vm.prank(committee);
        rep.rejectReputation(DID);
    }

    function test_rejectReputation_reverts_afterWindowExpired() public {
        uint256 proposedAt = block.timestamp;
        vm.prank(oracle);
        rep.proposeReputation(DID, maxScore, bytes32(0));
        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                SigvaraReputation.ChallengeWindowExpired.selector,
                DID,
                proposedAt + CHALLENGE_WINDOW
            )
        );
        vm.prank(committee);
        rep.rejectReputation(DID);
    }

    // -------------------------------------------------------------------------
    // getTotalScore
    // -------------------------------------------------------------------------

    function test_getTotalScore_maxIs100() public {
        _proposeAndFinalize(DID, maxScore);
        assertEq(rep.getTotalScore(DID), 100);
    }

    function test_getTotalScore_zeroBeforeFirstUpdate() public view {
        assertEq(rep.getTotalScore(DID), 0);
    }

    function testFuzz_getTotalScore_neverExceeds100(
        uint8 fee,
        uint8 success,
        uint8 age,
        uint8 ext,
        uint8 community,
        uint8 propagation
    ) public {
        fee         = uint8(bound(fee, 0, 30));
        success     = uint8(bound(success, 0, 25));
        age         = uint8(bound(age, 0, 20));
        ext         = uint8(bound(ext, 0, 15));
        community   = uint8(bound(community, 0, 5));
        propagation = uint8(bound(propagation, 0, 5));

        SigvaraReputation.ReputationData memory data = SigvaraReputation.ReputationData({
            feeScore: fee,
            successScore: success,
            ageScore: age,
            externalScore: ext,
            communityScore: community,
            propagationScore: propagation,
            lastUpdated: 0
        });

        _proposeAndFinalize(DID, data);

        assertLe(rep.getTotalScore(DID), 100);
    }

    // -------------------------------------------------------------------------
    // zeroReputation
    // -------------------------------------------------------------------------

    function test_zeroReputation_clearsAllScores() public {
        _proposeAndFinalize(DID, maxScore);
        assertEq(rep.getTotalScore(DID), 100);

        vm.prank(staking);
        rep.zeroReputation(DID);

        assertEq(rep.getTotalScore(DID), 0);
    }

    function test_zeroReputation_clearsPendingProposal() public {
        vm.prank(oracle);
        rep.proposeReputation(DID, maxScore, bytes32(0));

        vm.prank(staking);
        rep.zeroReputation(DID);

        SigvaraReputation.PendingScore memory pending = rep.getPendingScore(DID);
        assertFalse(pending.exists);
    }

    function test_zeroReputation_reverts_notStaking() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                stranger,
                rep.STAKING_CORE_ROLE()
            )
        );
        vm.prank(stranger);
        rep.zeroReputation(DID);
    }

    // -------------------------------------------------------------------------
    // meetsThreshold
    // -------------------------------------------------------------------------

    function test_meetsThreshold_trueAbove() public {
        _proposeAndFinalize(DID, maxScore);
        assertTrue(rep.meetsThreshold(DID, 60));
        assertTrue(rep.meetsThreshold(DID, 100));
    }

    function test_meetsThreshold_falseBelow() public view {
        assertFalse(rep.meetsThreshold(DID, 1));
    }

    // -------------------------------------------------------------------------
    // setChallengeWindow
    // -------------------------------------------------------------------------

    function test_setChallengeWindow_success() public {
        vm.prank(admin);
        rep.setChallengeWindow(2 hours);
        assertEq(rep.challengeWindow(), 2 hours);
    }

    function test_setChallengeWindow_reverts_notAdmin() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                stranger,
                bytes32(0) // DEFAULT_ADMIN_ROLE
            )
        );
        vm.prank(stranger);
        rep.setChallengeWindow(2 hours);
    }

    // -------------------------------------------------------------------------
    // Upgrade safety
    // -------------------------------------------------------------------------

    function test_storageLayout_reputationsMappingPinnedToSlot0() public {
        _proposeAndFinalize(DID, maxScore);

        // reputations must stay at slot 0 — the original proxy layout was deployed with
        // this layout. New variables go after challengeWindow (slot 2), never
        // above the mappings. The six uint8 factors pack into the struct's first
        // slot in declaration order.
        bytes32 repSlot = keccak256(abi.encode(DID, uint256(0)));
        uint256 packed = uint256(vm.load(address(rep), repSlot));
        uint256 expected = 30
            | (uint256(25) << 8)
            | (uint256(20) << 16)
            | (uint256(15) << 24)
            | (uint256(5) << 32)
            | (uint256(5) << 40);
        assertEq(packed, expected);
    }

    /**
     * Pins every storage variable to its literal slot.
     *
     * The test above only pinned slot 0, and the convention was carried in a comment
     * saying new variables go at the end. A comment does not fail a build: `evidenceRoots`
     * was declared above `operatorBond`, which on a live proxy moved operatorBond down a
     * slot to read zero. Zero is the "bonded-operator check disabled" mode, so the upgrade
     * would have silently removed the requirement while every existing test passed.
     *
     * The unit tests could not catch it because they upgrade from the current source to
     * the current source, so both sides share whatever layout is in the file. Only a fork
     * against the deployed bytecode noticed. This makes the layout explicit instead, so an
     * insertion breaks here rather than on chain.
     *
     * If you add a variable: append it to the contract, add a line here, and never
     * renumber. If this test fails after a deliberate append, the append was not at the end.
     */
    function test_storageLayout_allSlotsPinned() public {
        OperatorSetMock set = new OperatorSetMock();
        vm.startPrank(admin);
        rep.setChallengeWindow(3 hours);
        rep.setMaturityRate(7);
        rep.setOperatorBond(address(set));
        vm.stopPrank();

        assertEq(uint256(vm.load(address(rep), bytes32(uint256(2)))), 3 hours,
            "slot 2 is challengeWindow");
        assertEq(address(uint160(uint256(vm.load(address(rep), bytes32(uint256(3)))))),
            address(rep.identityRegistry()), "slot 3 is identityRegistry");
        assertEq(uint256(vm.load(address(rep), bytes32(uint256(4)))), 7,
            "slot 4 is maturityRatePerDay");
        assertEq(address(uint160(uint256(vm.load(address(rep), bytes32(uint256(7)))))),
            address(set), "slot 7 is operatorBond");

        // Mappings: the declared slot is the hashing seed, so probe a written key.
        bytes32 root = keccak256("evidence");
        vm.prank(admin);
        rep.setOperatorBond(address(0)); // let the plain oracle propose
        vm.prank(oracle);
        rep.proposeReputation(DID, maxScore, root);
        vm.warp(block.timestamp + 3 hours + 1);
        rep.finalizeReputation(DID);

        assertEq(uint8(uint256(vm.load(address(rep), keccak256(abi.encode(DID, uint256(5)))))),
            rep.maturedScore(DID), "slot 5 is maturedScore");
        assertEq(uint256(vm.load(address(rep), keccak256(abi.encode(DID, uint256(6))))),
            rep.maturedAt(DID), "slot 6 is maturedAt");
        assertEq(vm.load(address(rep), keccak256(abi.encode(DID, uint256(8)))), root,
            "slot 8 is evidenceRoots");
    }

    function test_initializeV2_grantsCommitteeAndSetsWindow_onceOnly() public {
        // Deliberately not the shared proxy: setUp() runs initializeV3 on that one,
        // which consumes initializer version 3 and puts version 2 permanently out of
        // reach. This mirrors a proxy that has been upgraded for optimistic scoring
        // but not yet bound to the identity registry.
        SigvaraReputation fresh = SigvaraReputation(address(new ERC1967Proxy(
            address(new SigvaraReputation()),
            abi.encodeCall(
                SigvaraReputation.initialize,
                (admin, oracle, staking, committee, CHALLENGE_WINDOW)
            )
        )));

        address newCommittee = makeAddr("newCommittee");
        vm.prank(admin);
        fresh.initializeV2(newCommittee, 2 hours);

        assertEq(fresh.challengeWindow(), 2 hours);
        assertTrue(fresh.hasRole(fresh.SLASHING_COMMITTEE_ROLE(), newCommittee));

        vm.expectRevert(abi.encodeWithSignature("InvalidInitialization()"));
        vm.prank(admin);
        fresh.initializeV2(newCommittee, 3 hours);
    }

    /// initializeV3 is the wiring step. It must not be reachable twice, and a zero
    /// address must not be accepted, since either would leave the check unenforced.
    function test_initializeV3_onceOnly_andRejectsZero() public {
        SigvaraReputation fresh = SigvaraReputation(address(new ERC1967Proxy(
            address(new SigvaraReputation()),
            abi.encodeCall(
                SigvaraReputation.initialize,
                (admin, oracle, staking, committee, CHALLENGE_WINDOW)
            )
        )));

        vm.expectRevert(SigvaraReputation.IdentityRegistryNotSet.selector);
        vm.prank(admin);
        fresh.initializeV3(address(0));

        vm.prank(admin);
        fresh.initializeV3(address(identity));
        assertEq(address(fresh.identityRegistry()), address(identity));

        vm.expectRevert(abi.encodeWithSignature("InvalidInitialization()"));
        vm.prank(admin);
        fresh.initializeV3(address(identity));
    }

    /// The whole point of the binding: a didHash the registry has never seen cannot
    /// be given a score. Without this, anyone could pre-seed a reputation for a DID
    /// before its real operator registers it.
    function test_proposeReputation_reverts_unregisteredDid() public {
        bytes32 ghost = keccak256("did:sigvara:5042002:0xnever-registered");
        vm.expectRevert(abi.encodeWithSelector(SigvaraReputation.AgentNotRegistered.selector, ghost));
        vm.prank(oracle);
        rep.proposeReputation(ghost, maxScore, bytes32(0));
    }

    // -------------------------------------------------------------------------
    // maturity
    // -------------------------------------------------------------------------

    /// Enables maturity at `rate` points/day and finalizes `maxScore` for DID.
    function _finalizeWithMaturity(uint256 rate) internal {
        vm.prank(admin);
        rep.initializeV4(rate);
        vm.prank(oracle);
        rep.proposeReputation(DID, maxScore, bytes32(0));
        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);
        rep.finalizeReputation(DID);
    }

    /// The farm-and-cash-out shape: build a score fast, spend it at the peak. The
    /// earned score is available immediately; the spendable one is not.
    function test_maturity_scoreIsNotSpendableImmediately() public {
        _finalizeWithMaturity(4);

        assertEq(rep.getEarnedScore(DID), 100, "earned in full");
        assertEq(rep.getTotalScore(DID), 0, "none of it spendable yet");
        assertFalse(rep.meetsThreshold(DID, 1), "thresholds use the matured score");
    }

    function test_maturity_releasesAtTheConfiguredRate() public {
        _finalizeWithMaturity(4);

        vm.warp(block.timestamp + 1 days);
        assertEq(rep.getTotalScore(DID), 4);

        vm.warp(block.timestamp + 9 days);
        assertEq(rep.getTotalScore(DID), 40);
    }

    function test_maturity_stopsAtTheEarnedScore() public {
        _finalizeWithMaturity(4);
        vm.warp(block.timestamp + 365 days);
        assertEq(rep.getTotalScore(DID), 100, "never overshoots what was earned");
    }

    /// Maturity accrues with wall-clock time, not with oracle activity, so an oracle
    /// outage cannot pin an honest agent below the score it earned.
    function test_maturity_accruesWithoutFurtherFinalizations() public {
        _finalizeWithMaturity(4);
        vm.warp(block.timestamp + 5 days);
        assertEq(rep.getTotalScore(DID), 20);
    }

    /// A fall is not delayed. Slowing bad news would protect the agent rather than
    /// whoever is relying on it.
    function test_maturity_dropsApplyImmediately() public {
        _finalizeWithMaturity(4);
        vm.warp(block.timestamp + 25 days);
        assertEq(rep.getTotalScore(DID), 100);

        SigvaraReputation.ReputationData memory low = maxScore;
        low.feeScore = 0; low.successScore = 0; low.ageScore = 0;
        low.externalScore = 0; low.propagationScore = 0; // leaves communityScore 5
        vm.prank(oracle);
        rep.proposeReputation(DID, low, bytes32(0));
        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);
        rep.finalizeReputation(DID);

        assertEq(rep.getTotalScore(DID), 5, "the drop is visible at once");
    }

    /// A later rise is released from where the agent actually stood, not from the
    /// number it had claimed, so a score cannot be reset high by churning proposals.
    function test_maturity_anchorsOnTheMaturedValueNotTheEarnedOne() public {
        _finalizeWithMaturity(4);
        vm.warp(block.timestamp + 2 days);
        assertEq(rep.getTotalScore(DID), 8);

        // Re-finalize the same perfect score. If the anchor took the earned value,
        // this would jump to 100.
        vm.prank(oracle);
        rep.proposeReputation(DID, maxScore, bytes32(0));
        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);
        uint256 atFinalize = rep.getTotalScore(DID);
        rep.finalizeReputation(DID);

        assertEq(rep.getTotalScore(DID), atFinalize, "no jump from re-finalizing");
        assertLt(rep.getTotalScore(DID), 100);
    }

    /// A slash zeroes the score. The anchor has to go with it, or the agent would
    /// climb back out on its own the moment anything was proposed again.
    function test_maturity_slashResetsTheAnchor() public {
        _finalizeWithMaturity(4);
        vm.warp(block.timestamp + 25 days);
        assertEq(rep.getTotalScore(DID), 100);

        vm.prank(staking);
        rep.zeroReputation(DID);

        assertEq(rep.getTotalScore(DID), 0);
        assertEq(rep.maturedScore(DID), 0, "anchor cleared");
        vm.warp(block.timestamp + 365 days);
        assertEq(rep.getTotalScore(DID), 0, "stays at zero without a new score");
    }

    /// The farm-and-sell market: build an aged, scored identity and sell it. The
    /// buyer inherits the score, but not the right to spend it straight away.
    function test_maturity_restartsWhenTheAgentChangesHands() public {
        _finalizeWithMaturity(4);
        vm.warp(block.timestamp + 25 days);
        assertEq(rep.getTotalScore(DID), 100, "seller has matured it fully");

        address buyer = makeAddr("buyer");
        vm.prank(operator);
        identity.offerOperatorTransfer(DID, buyer);
        vm.prank(buyer);
        identity.acceptOperatorTransfer(DID);

        assertEq(rep.getEarnedScore(DID), 100, "the record survives the sale");
        assertEq(rep.getTotalScore(DID), 0, "but none of it is spendable yet");

        vm.warp(block.timestamp + 5 days);
        assertEq(rep.getTotalScore(DID), 20, "the buyer re-earns the right to spend it");
    }

    /// A hardcoded selector that drifts would not fail loudly: the staticcall would
    /// simply miss, the branch would be skipped, and maturity would silently stop
    /// restarting on a handover. I got this constant wrong once already.
    function test_maturity_operatorChangedAtSelectorIsCorrect() public pure {
        assertEq(bytes4(keccak256("operatorChangedAt(bytes32)")), bytes4(0xcd46167a));
    }

    /// An identity registry from before operator transfer has no operatorChangedAt.
    /// getTotalScore is what every consumer reads, so it must degrade rather than
    /// revert when the two proxies are a version apart. This is the exact failure
    /// that took every score on Arc testnet unreadable.
    function test_maturity_survivesAnOlderIdentityRegistry() public {
        LegacyIdentityMock legacy = new LegacyIdentityMock(address(stakeView), operator, agentAddr);

        SigvaraReputation old = SigvaraReputation(address(new ERC1967Proxy(
            address(new SigvaraReputation()),
            abi.encodeCall(
                SigvaraReputation.initialize,
                (admin, oracle, staking, committee, CHALLENGE_WINDOW)
            )
        )));
        vm.startPrank(admin);
        old.initializeV3(address(legacy));
        old.initializeV4(4);
        vm.stopPrank();

        vm.prank(oracle);
        old.proposeReputation(DID, maxScore, bytes32(0));
        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);
        old.finalizeReputation(DID);

        // Would revert here if the typed getter were still used.
        assertEq(old.getEarnedScore(DID), 100);
        assertEq(old.getTotalScore(DID), 0, "matures from zero, no revert");

        vm.warp(block.timestamp + 3 days);
        assertEq(old.getTotalScore(DID), 12, "keeps maturing against a legacy registry");
    }

    // -------------------------------------------------------------------------
    // evidence commitments
    // -------------------------------------------------------------------------

    // Fixture produced by oracle/merkle.js over three payments. The point of pinning it
    // here is cross-implementation: the JS builds the tree, this checks the contract
    // accepts it. A mismatch in leaf encoding, pair ordering or odd-node handling would
    // pass both sides' own tests and fail only in production.
    bytes32 constant EV_ROOT  = 0x439f0128d168464f60c009baeeccb7518d69d99b226617cd601d89f8e34680c1;
    bytes32 constant EV_LEAF0 = 0x2e7874cee2b10acbffa6dc8754834b7a7c30c7a52e28ba30d1b99fa298dc427c;
    bytes32 constant EV_LEAF1 = 0xaec877709997027a936dbd9a8735b1a99a1c2c76a5d8a6f0d34a781194fa3ecd;
    bytes32 constant EV_LEAF2 = 0x334937b7b479e0998b5f6e09e0026c8c45adb3c5b9fc1fd0cc3a6c94330b8c9e;

    function _proof0() internal pure returns (bytes32[] memory p) {
        p = new bytes32[](2);
        p[0] = EV_LEAF1;
        p[1] = EV_LEAF2;
    }

    function _proof2() internal pure returns (bytes32[] memory p) {
        p = new bytes32[](1);
        p[0] = 0xd17bb8827637bbeecdd8ad818a1d3c9a38559913ab4b6d39dd0263dad5f5dd10;
    }

    function _finalizeWithRoot(bytes32 root) internal {
        vm.prank(oracle);
        rep.proposeReputation(DID, maxScore, root);
        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);
        rep.finalizeReputation(DID);
    }

    /// The whole point: a third party holding a payment can prove the oracle counted
    /// it, without being given or having to trust the oracle's records.
    function test_evidence_provesAPaymentWasCounted() public {
        _finalizeWithRoot(EV_ROOT);

        assertEq(rep.evidenceRoots(DID), EV_ROOT);
        assertTrue(rep.verifyEvidence(DID, EV_LEAF0, _proof0()), "first leaf is in the set");
        assertTrue(rep.verifyEvidence(DID, EV_LEAF2, _proof2()), "odd leaf is too");
    }

    /// A payment the oracle did not count cannot be made to verify.
    function test_evidence_rejectsALeafThatIsNotInTheSet() public {
        _finalizeWithRoot(EV_ROOT);
        assertFalse(rep.verifyEvidence(DID, keccak256("invented"), _proof0()));
    }

    /// Proofs do not carry between agents, so evidence cannot be borrowed.
    function test_evidence_isScopedToTheAgent() public {
        _finalizeWithRoot(EV_ROOT);
        bytes32 other = keccak256("did:sigvara:5042002:0xsomebodyelse");
        assertFalse(rep.verifyEvidence(other, EV_LEAF0, _proof0()));
    }

    /// An agent with no committed evidence verifies nothing rather than everything.
    function test_evidence_noRootVerifiesNothing() public {
        _finalizeWithRoot(bytes32(0));
        assertEq(rep.evidenceRoots(DID), bytes32(0));
        assertFalse(rep.verifyEvidence(DID, EV_LEAF0, _proof0()));
    }

    /// The root travels with the score it belongs to and only lands on finalization.
    function test_evidence_rootIsHeldOnThePendingProposal() public {
        vm.prank(oracle);
        rep.proposeReputation(DID, maxScore, EV_ROOT);

        assertEq(rep.getPendingScore(DID).evidenceRoot, EV_ROOT, "held with the proposal");
        assertEq(rep.evidenceRoots(DID), bytes32(0), "not live until finalized");

        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);
        rep.finalizeReputation(DID);
        assertEq(rep.evidenceRoots(DID), EV_ROOT);
    }

    /// A slash clears the evidence with the score. Leaving it would let a terminated
    /// agent keep proving the record that got it slashed.
    function test_evidence_clearedOnSlash() public {
        _finalizeWithRoot(EV_ROOT);
        vm.prank(staking);
        rep.zeroReputation(DID);
        assertEq(rep.evidenceRoots(DID), bytes32(0));
        assertFalse(rep.verifyEvidence(DID, EV_LEAF0, _proof0()));
    }

    function test_maturity_rateOfZeroIsRejected() public {
        vm.expectRevert(SigvaraReputation.MaturityRateZero.selector);
        vm.prank(admin);
        rep.initializeV4(0);
    }

    function test_maturity_setMaturityRate_onlyAdmin() public {
        vm.prank(admin);
        rep.initializeV4(4);
        vm.expectRevert();
        vm.prank(stranger);
        rep.setMaturityRate(10);
    }

    // -------------------------------------------------------------------------
    // bonded oracles
    // -------------------------------------------------------------------------

    /// With no operator set configured the role alone governs, which is the
    /// single-operator arrangement this protocol started from.
    function test_operatorBond_unsetMeansTheCheckIsOff() public {
        assertEq(address(rep.operatorBond()), address(0));
        vm.prank(oracle);
        rep.proposeReputation(DID, maxScore, bytes32(0));
        assertTrue(rep.getPendingScore(DID).exists);
    }

    /// Holding ORACLE_ROLE is no longer enough. The role says who may speak; the bond
    /// is what they lose for speaking falsely.
    function test_operatorBond_roleAloneIsNotEnoughOnceSet() public {
        OperatorSetMock set = new OperatorSetMock();
        vm.prank(admin);
        rep.setOperatorBond(address(set));

        assertTrue(rep.hasRole(rep.ORACLE_ROLE(), oracle), "still has the role");
        vm.expectRevert(abi.encodeWithSelector(SigvaraReputation.OracleNotBonded.selector, oracle));
        vm.prank(oracle);
        rep.proposeReputation(DID, maxScore, bytes32(0));
    }

    function test_operatorBond_admittedOperatorCanPropose() public {
        OperatorSetMock set = new OperatorSetMock();
        vm.prank(admin);
        rep.setOperatorBond(address(set));
        set.set(oracle, true);

        vm.prank(oracle);
        rep.proposeReputation(DID, maxScore, bytes32(0));
        assertTrue(rep.getPendingScore(DID).exists);
    }

    /// Bonding does not grant the right to speak on its own, or anyone able to post a
    /// bond could write scores.
    function test_operatorBond_bondWithoutTheRoleIsStillRefused() public {
        OperatorSetMock set = new OperatorSetMock();
        vm.prank(admin);
        rep.setOperatorBond(address(set));
        set.set(stranger, true);

        vm.expectRevert();
        vm.prank(stranger);
        rep.proposeReputation(DID, maxScore, bytes32(0));
    }

    /// An operator that exits must not strand the scores it already proposed.
    /// Finalization is mechanical and stays permissionless.
    function test_operatorBond_finalizeStillWorksAfterTheOracleExits() public {
        OperatorSetMock set = new OperatorSetMock();
        vm.prank(admin);
        rep.setOperatorBond(address(set));
        set.set(oracle, true);

        vm.prank(oracle);
        rep.proposeReputation(DID, maxScore, bytes32(0));

        set.set(oracle, false); // ejected, or unbonded, mid-window
        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);
        rep.finalizeReputation(DID);

        assertEq(rep.getEarnedScore(DID), 100);
    }

    function test_operatorBond_canBeTurnedBackOff() public {
        OperatorSetMock set = new OperatorSetMock();
        vm.prank(admin);
        rep.setOperatorBond(address(set));
        vm.prank(admin);
        rep.setOperatorBond(address(0));

        vm.prank(oracle);
        rep.proposeReputation(DID, maxScore, bytes32(0));
        assertTrue(rep.getPendingScore(DID).exists);
    }

    function test_operatorBond_onlyAdminCanSetIt() public {
        vm.expectRevert();
        vm.prank(stranger);
        rep.setOperatorBond(address(1));
    }

    /// Registration costs only gas, so an unbonded agent must not be scoreable. It
    /// also cannot be slashed, since slashing needs stake to take, which is what made
    /// bulk identity creation the cheapest attack on the score.
    function test_proposeReputation_reverts_whenAgentIsNotBonded() public {
        stakeView.set(false);
        vm.expectRevert(abi.encodeWithSelector(SigvaraReputation.AgentNotBonded.selector, DID));
        vm.prank(oracle);
        rep.proposeReputation(DID, maxScore, bytes32(0));
    }

    /// The bond has to hold for the whole optimistic window, not just at proposal.
    /// Otherwise an agent could be scored, withdraw, and have the score finalized
    /// after the collateral was gone.
    function test_finalizeReputation_reverts_whenBondIsWithdrawnMidWindow() public {
        vm.prank(oracle);
        rep.proposeReputation(DID, maxScore, bytes32(0));

        stakeView.set(false);
        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);

        vm.expectRevert(abi.encodeWithSelector(SigvaraReputation.AgentNotBonded.selector, DID));
        rep.finalizeReputation(DID);
    }

    /// Suspension is a normal, reversible operator state used during withdrawal.
    /// It must not stop an agent being scored, or self-suspending would be a way to
    /// freeze a score in place.
    function test_proposeReputation_allowsSuspendedAgent() public {
        vm.prank(operator);
        identity.updateStatus(DID, SigvaraIdentity.AgentStatus.Suspended);

        vm.prank(oracle);
        rep.proposeReputation(DID, maxScore, bytes32(0));
        assertTrue(rep.getPendingScore(DID).exists);
    }

    function test_initializeV2_reverts_notAdmin() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                stranger,
                bytes32(0) // DEFAULT_ADMIN_ROLE
            )
        );
        vm.prank(stranger);
        rep.initializeV2(stranger, 0);
    }
}
