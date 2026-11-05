// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./helpers/StackFixture.sol";

/// A score's age runs from when it was proposed. Finalizing is open to anyone at any time after the
/// window, so if the age ran from the finalize, whoever chose that moment would choose the age.
contract LateFinalizeTest is StackFixture {
    uint256 internal constant MAX_AGE = 2 days;

    address internal agent;
    uint256 internal agentPk;
    bytes32 internal didHash;

    function setUp() public {
        _deployStack();
        (agent, agentPk) = makeAddrAndKey("agent");
        didHash = _registerAndBond(agentPk, 2 * MIN_STAKE);
    }

    function _propose() internal returns (uint256 proposedAt) {
        vm.prank(oracle);
        reputation.proposeReputation(didHash, _score40(), bytes32(0));
        return block.timestamp;
    }

    function test_aMonthOldProposalFinalizedByAStranger_readsAsAMonthOld() public {
        uint256 proposedAt = _propose();

        vm.warp(proposedAt + SCORE_WINDOW + 30 days);
        vm.prank(makeAddr("anyone at all"));
        reputation.finalizeReputation(didHash);

        assertEq(reputation.getReputation(didHash).lastUpdated, proposedAt);
        assertEq(reader.trust(agent).scoreUpdatedAt, proposedAt);
        assertFalse(reader.isTrustedFresh(agent, 40, MAX_AGE));
        assertTrue(reader.isTrustedFresh(agent, 40, 31 days), "a longer limit still takes it");
    }

    /// The score goes live, late or not. What it cannot do is read as new.
    function test_aScoreAlreadyRefusedStaysRefused() public {
        _finalize(didHash, _score40());
        uint256 proposedAt = _propose();

        vm.warp(proposedAt + MAX_AGE + 90 days);
        assertFalse(reader.isTrustedFresh(agent, 40, MAX_AGE), "refused before");

        reputation.finalizeReputation(didHash);
        assertFalse(reader.isTrustedFresh(agent, 40, MAX_AGE), "refused after");
        assertEq(reputation.getEarnedScore(didHash), 40);
    }

    /// The most a chosen moment can do is what a prompt finalize would have done.
    function testFuzz_whenItIsFinalizedChangesNothingAboutItsAge(uint32 late) public {
        uint256 proposedAt = _propose();
        vm.warp(proposedAt + SCORE_WINDOW + late);
        reputation.finalizeReputation(didHash);
        assertEq(reputation.getReputation(didHash).lastUpdated, proposedAt);
    }

    /// Finalize, then propose, every epoch: a score is two epochs old the moment before the next one
    /// lands. So a limit has to be more than two epochs, which is what the docs ask for.
    function test_aHealthyOracle_isTwoEpochsOldAtWorst() public {
        uint256 epoch = SCORE_WINDOW + 1;
        for (uint256 i = 0; i < 6; i++) {
            _propose();
            vm.warp(block.timestamp + epoch);
            if (i > 0) {
                assertTrue(reader.isTrustedFresh(agent, 40, 2 * epoch), "at two epochs");
                assertFalse(reader.isTrustedFresh(agent, 40, 2 * epoch - 1), "not much sooner");
            }
            reputation.finalizeReputation(didHash);
            assertTrue(reader.isTrustedFresh(agent, 40, epoch), "one epoch old once it lands");
        }
    }

    function test_theAgeOnlyMovesForward() public {
        uint256 first = _propose();
        vm.warp(first + SCORE_WINDOW + 5 days);
        reputation.finalizeReputation(didHash);

        uint256 second = _propose();
        assertGt(second, first);
        vm.warp(second + SCORE_WINDOW);
        reputation.finalizeReputation(didHash);
        assertEq(reputation.getReputation(didHash).lastUpdated, second);
    }

    /// A slash is not a proposal: a zeroed score is dated when it was zeroed.
    function test_aZeroedScoreIsDatedWhenItWasZeroed() public {
        _finalize(didHash, _score40());
        vm.warp(block.timestamp + 3 days);
        vm.prank(address(staking));
        reputation.zeroReputation(didHash);
        assertEq(reputation.getReputation(didHash).lastUpdated, block.timestamp);
    }
}
