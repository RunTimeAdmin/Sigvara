// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";
import "../src/SigvaraIdentity.sol";
import "../src/SigvaraReputation.sol";

contract SigvaraReputationTest is Test {
    SigvaraReputation rep;
    SigvaraIdentity identity;

    address admin     = makeAddr("admin");
    address oracle    = makeAddr("oracle");
    address staking   = makeAddr("staking");
    address committee = makeAddr("committee");
    address stranger  = makeAddr("stranger");
    address operator  = makeAddr("operator");
    address agentAddr = makeAddr("agent");

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
        identity = SigvaraIdentity(address(new ERC1967Proxy(
            address(new SigvaraIdentity()),
            abi.encodeCall(SigvaraIdentity.initialize, (admin, address(0)))
        )));
        vm.prank(operator);
        DID = identity.registerAgent(agentAddr, bytes32(uint256(0xdeadbeef)));

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
        rep.proposeReputation(didHash, data);
        vm.warp(block.timestamp + CHALLENGE_WINDOW + 1);
        rep.finalizeReputation(didHash);
    }

    // -------------------------------------------------------------------------
    // proposeReputation
    // -------------------------------------------------------------------------

    function test_proposeReputation_success() public {
        vm.prank(oracle);
        rep.proposeReputation(DID, maxScore);

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
        rep.proposeReputation(DID, maxScore);
    }

    function test_proposeReputation_replacesExistingPending() public {
        vm.startPrank(oracle);
        rep.proposeReputation(DID, maxScore);

        SigvaraReputation.ReputationData memory lower = maxScore;
        lower.feeScore = 10;
        vm.warp(block.timestamp + 10);
        rep.proposeReputation(DID, lower);
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
        rep.proposeReputation(DID, bad);
    }

    function test_proposeReputation_reverts_successScoreOverMax() public {
        SigvaraReputation.ReputationData memory bad = maxScore;
        bad.successScore = 26;
        vm.expectRevert(
            abi.encodeWithSelector(SigvaraReputation.ScoreOutOfRange.selector, "successScore", 26, 25)
        );
        vm.prank(oracle);
        rep.proposeReputation(DID, bad);
    }

    function test_proposeReputation_reverts_ageScoreOverMax() public {
        SigvaraReputation.ReputationData memory bad = maxScore;
        bad.ageScore = 21;
        vm.expectRevert(
            abi.encodeWithSelector(SigvaraReputation.ScoreOutOfRange.selector, "ageScore", 21, 20)
        );
        vm.prank(oracle);
        rep.proposeReputation(DID, bad);
    }

    function test_proposeReputation_reverts_externalScoreOverMax() public {
        SigvaraReputation.ReputationData memory bad = maxScore;
        bad.externalScore = 16;
        vm.expectRevert(
            abi.encodeWithSelector(SigvaraReputation.ScoreOutOfRange.selector, "externalScore", 16, 15)
        );
        vm.prank(oracle);
        rep.proposeReputation(DID, bad);
    }

    function test_proposeReputation_reverts_communityScoreOverMax() public {
        SigvaraReputation.ReputationData memory bad = maxScore;
        bad.communityScore = 6;
        vm.expectRevert(
            abi.encodeWithSelector(SigvaraReputation.ScoreOutOfRange.selector, "communityScore", 6, 5)
        );
        vm.prank(oracle);
        rep.proposeReputation(DID, bad);
    }

    function test_proposeReputation_reverts_propagationScoreOverMax() public {
        SigvaraReputation.ReputationData memory bad = maxScore;
        bad.propagationScore = 6;
        vm.expectRevert(
            abi.encodeWithSelector(SigvaraReputation.ScoreOutOfRange.selector, "propagationScore", 6, 5)
        );
        vm.prank(oracle);
        rep.proposeReputation(DID, bad);
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
        rep.proposeReputation(DID, maxScore);

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
        rep.proposeReputation(DID, maxScore);
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
        rep.proposeReputation(DID, maxScore);

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
        rep.proposeReputation(DID, lower);

        vm.prank(committee);
        rep.rejectReputation(DID);

        assertEq(rep.getTotalScore(DID), 100);
    }

    function test_rejectReputation_reverts_notCommittee() public {
        vm.prank(oracle);
        rep.proposeReputation(DID, maxScore);

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
        rep.proposeReputation(DID, maxScore);
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
        rep.proposeReputation(DID, maxScore);

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
        rep.proposeReputation(ghost, maxScore);
    }

    /// Suspension is a normal, reversible operator state used during withdrawal.
    /// It must not stop an agent being scored, or self-suspending would be a way to
    /// freeze a score in place.
    function test_proposeReputation_allowsSuspendedAgent() public {
        vm.prank(operator);
        identity.updateStatus(DID, SigvaraIdentity.AgentStatus.Suspended);

        vm.prank(oracle);
        rep.proposeReputation(DID, maxScore);
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
