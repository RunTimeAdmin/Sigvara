// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./helpers/StackFixture.sol";
import {
    ISigvaraIdentity,
    ISigvaraReputation,
    ISigvaraStaking,
    ISigvaraReader
} from "../src/interfaces/ISigvara.sol";

contract SigvaraReaderTest is StackFixture {
    address agent;
    uint256 agentPk;
    address buyer = makeAddr("buyer");

    function setUp() public {
        _deployStack();
        (agent, agentPk) = makeAddrAndKey("agent");
    }

    // =========================================================================
    // What the reader reports
    // =========================================================================

    /// An address nobody registered. The status field reads as Active because Active
    /// is the zero value, so the reader has to say plainly that nothing is registered,
    /// and has to refuse trust even at a threshold of zero.
    function test_trust_unknownAddressIsNotRegisteredAndNeverTrusted() public {
        address stranger = makeAddr("stranger");

        ISigvaraReader.Trust memory t = reader.trust(stranger);
        assertFalse(t.registered, "registered");
        assertFalse(t.active, "active");
        assertEq(t.score, 0, "score");
        assertEq(t.earned, 0, "earned");
        assertEq(t.stake, 0, "stake");
        assertEq(uint8(t.slash), uint8(ISigvaraStaking.SlashState.None), "slash");

        assertFalse(reader.isTrusted(stranger, 0), "unknown agent trusted at threshold zero");
        assertFalse(reader.isTrusted(stranger, 1));

        // The raw threshold read is the reason isTrusted checks status. For an address
        // that was never registered it passes at zero, so gating on it alone lets
        // anyone through.
        assertTrue(reputation.meetsThreshold(reader.didHashOf(stranger), 0));
    }

    function test_trust_registeredButUnbondedIsNotTrusted() public {
        bytes32 didHash = registerSigned(identity, operator, agentPk, PUB_KEY);

        ISigvaraReader.Trust memory t = reader.trust(agent);
        assertTrue(t.registered);
        assertEq(uint8(t.status), uint8(ISigvaraIdentity.AgentStatus.PendingBond));
        assertFalse(t.active);
        assertEq(t.stake, 0);
        assertFalse(reader.isTrusted(agent, 0), "an unbonded agent is not trusted");
        assertEq(didHash, reader.didHashOf(agent));
    }

    function test_trust_bondedAndScoredIsTrustedUpToItsScore() public {
        bytes32 didHash = _registerAndBond(agentPk, 2 * MIN_STAKE);
        _finalize(didHash, _score40());

        ISigvaraReader.Trust memory t = reader.trust(agent);
        assertTrue(t.registered);
        assertEq(uint8(t.status), uint8(ISigvaraIdentity.AgentStatus.Active));
        assertTrue(t.active);
        assertEq(t.score, 40);
        assertEq(t.earned, 40);
        assertEq(t.stake, 2 * MIN_STAKE);
        assertEq(uint8(t.slash), uint8(ISigvaraStaking.SlashState.None));

        assertTrue(reader.isTrusted(agent, 0));
        assertTrue(reader.isTrusted(agent, 40), "a score meets a threshold equal to it");
        assertFalse(reader.isTrusted(agent, 41), "and not one above it");
    }

    /// With maturity on, a new score is released over time. The reader returns the
    /// spendable score, which is what the threshold check uses, and the earned score
    /// beside it so a caller can see how much is still to come.
    function test_trust_scoreIsTheSpendableOneAndEarnedIsReportedBesideIt() public {
        vm.prank(admin);
        reputation.initializeV4(10); // ten points a day

        bytes32 didHash = _registerAndBond(agentPk, 2 * MIN_STAKE);
        _finalize(didHash, _score40());

        // The first finalize anchors at zero and the clock starts here. A little over an
        // hour of the challenge window has gone by, which releases nothing yet.
        vm.warp(block.timestamp + 1 days);
        ISigvaraReader.Trust memory t = reader.trust(agent);
        assertEq(t.earned, 40);
        assertGt(t.score, 0);
        assertLt(t.score, t.earned, "still being released");
        assertEq(t.score, reputation.getTotalScore(didHash));

        assertTrue(reader.isTrusted(agent, t.score));
        assertFalse(reader.isTrusted(agent, t.score + 1));

        vm.warp(block.timestamp + 5 days);
        t = reader.trust(agent);
        assertEq(t.score, 40, "fully released");
        assertTrue(reader.isTrusted(agent, 40));
    }

    /// Suspension does not touch the score, so the raw threshold read still passes. The
    /// reader does not.
    function test_trust_suspendedKeepsItsScoreButIsNotTrusted() public {
        bytes32 didHash = _registerAndBond(agentPk, 2 * MIN_STAKE);
        _finalize(didHash, _score40());

        vm.prank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Suspended);

        ISigvaraReader.Trust memory t = reader.trust(agent);
        assertEq(uint8(t.status), uint8(ISigvaraIdentity.AgentStatus.Suspended));
        assertFalse(t.active);
        assertEq(t.score, 40, "suspension leaves the score alone");
        assertEq(uint8(t.slash), uint8(ISigvaraStaking.SlashState.None), "an operator suspension is not a slash");

        assertTrue(reputation.meetsThreshold(didHash, 40), "the raw read still passes");
        assertFalse(reader.isTrusted(agent, 40), "the reader does not");

        vm.prank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Active);
        assertTrue(reader.isTrusted(agent, 40));
    }

    /// The minimum stake can be raised after an agent was admitted. Its status stays Active,
    /// because nothing walks the registry to re-check it, and its score stays: reputation writes
    /// stop for an agent below the new minimum, but what it already earned does not. The reader
    /// is what consumers trust, so it has to ask the staking contract what is held now.
    function test_isTrusted_aRaisedMinimumStakeStopsTrustUntilTheAgentTopsUp() public {
        bytes32 didHash = _registerAndBond(agentPk, MIN_STAKE);
        _finalize(didHash, _score40());
        assertTrue(reader.isTrusted(agent, 40));

        vm.prank(admin);
        staking.setMinimumStake(2 * MIN_STAKE);

        assertTrue(identity.isActive(didHash), "the stored status does not change");
        assertEq(reputation.getTotalScore(didHash), 40, "and neither does the score");
        assertFalse(reader.isTrusted(agent, 40), "but the bond no longer meets the minimum");
        assertFalse(reader.isTrusted(agent, 0));

        vm.prank(operator);
        staking.depositStake(didHash, MIN_STAKE);
        assertTrue(reader.isTrusted(agent, 40), "trusted again once it tops up");
    }

    /// The same fact, reported rather than only applied: a consumer that reads the struct can see
    /// why an Active agent is not trusted, and what it holds against what is asked.
    function test_trust_collateralizedReflectsTheCurrentMinimum() public {
        assertFalse(reader.trust(makeAddr("stranger")).collateralized, "nothing to hold for an unknown address");

        bytes32 didHash = _registerAndBond(agentPk, MIN_STAKE);
        assertTrue(reader.trust(agent).collateralized);

        vm.prank(admin);
        staking.setMinimumStake(2 * MIN_STAKE);
        ISigvaraReader.Trust memory t = reader.trust(agent);
        assertTrue(t.active, "still Active by status");
        assertFalse(t.collateralized, "but under the new minimum");
        assertEq(t.stake, MIN_STAKE, "the bond is what it was");

        vm.prank(operator);
        staking.depositStake(didHash, MIN_STAKE);
        assertTrue(reader.trust(agent).collateralized);
    }

    /// An open slash shows up as Pending and then Disputed and keeps the agent out. A
    /// dropped one leaves a Cancelled record and the agent trusted again.
    function test_trust_slashProceedingIsVisibleAndBlocksTrust() public {
        bytes32 didHash = _registerAndBond(agentPk, 2 * MIN_STAKE);
        _finalize(didHash, _score40());
        assertTrue(reader.isTrusted(agent, 40));

        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "evidence");

        ISigvaraReader.Trust memory t = reader.trust(agent);
        assertEq(uint8(t.slash), uint8(ISigvaraStaking.SlashState.Pending));
        assertEq(uint8(t.status), uint8(ISigvaraIdentity.AgentStatus.Suspended));
        assertFalse(reader.isTrusted(agent, 0));

        vm.prank(operator);
        staking.disputeSlash(didHash);
        t = reader.trust(agent);
        assertEq(uint8(t.slash), uint8(ISigvaraStaking.SlashState.Disputed));
        assertFalse(reader.isTrusted(agent, 0));

        vm.prank(admin);
        staking.resolveDispute(didHash, false);
        t = reader.trust(agent);
        assertEq(uint8(t.slash), uint8(ISigvaraStaking.SlashState.Cancelled));
        assertEq(uint8(t.status), uint8(ISigvaraIdentity.AgentStatus.Active));
        assertEq(t.score, 40, "a dropped slash leaves the score alone");
        assertTrue(reader.isTrusted(agent, 40));
    }

    function test_trust_executedSlashZeroesScoreAndStake() public {
        bytes32 didHash = _registerAndBond(agentPk, 2 * MIN_STAKE);
        _finalize(didHash, _score40());

        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "evidence");
        vm.warp(block.timestamp + SLASH_WINDOW + 1);
        staking.executeSlash(didHash);

        ISigvaraReader.Trust memory t = reader.trust(agent);
        assertTrue(t.registered, "a slashed agent is still on record");
        assertEq(uint8(t.status), uint8(ISigvaraIdentity.AgentStatus.Slashed));
        assertFalse(t.active);
        assertEq(t.score, 0);
        assertEq(t.earned, 0);
        assertEq(t.stake, 0);
        assertEq(uint8(t.slash), uint8(ISigvaraStaking.SlashState.Executed));
        assertFalse(reader.isTrusted(agent, 0));
    }

    function test_trustByDid_matchesTrustByAddress() public {
        bytes32 didHash = _registerAndBond(agentPk, 2 * MIN_STAKE);
        _finalize(didHash, _score40());

        assertEq(didHash, reader.didHashOf(agent));
        assertEq(didHash, identity.computeDidHash(agent));

        ISigvaraReader.Trust memory a = reader.trust(agent);
        ISigvaraReader.Trust memory b = reader.trustByDid(didHash);
        assertEq(a.registered, b.registered);
        assertEq(uint8(a.status), uint8(b.status));
        assertEq(a.active, b.active);
        assertEq(a.score, b.score);
        assertEq(a.earned, b.earned);
        assertEq(a.stake, b.stake);
        assertEq(uint8(a.slash), uint8(b.slash));
    }

    function test_constructor_rejectsZeroAddresses() public {
        address ok = address(identity);

        vm.expectRevert(SigvaraReader.ZeroAddress.selector);
        new SigvaraReader(address(0), ok, ok);
        vm.expectRevert(SigvaraReader.ZeroAddress.selector);
        new SigvaraReader(ok, address(0), ok);
        vm.expectRevert(SigvaraReader.ZeroAddress.selector);
        new SigvaraReader(ok, ok, address(0));
    }

    // =========================================================================
    // The interfaces against the real registries
    // =========================================================================

    /// Every function in src/interfaces/ISigvara.sol, called on real deployments and
    /// compared with the registry's own answer. The interfaces declare their own types,
    /// so this is what catches a wrong selector or a struct that no longer lines up.
    /// The state is chosen so no comparison is between two zeros: a bond with part of
    /// it queued for withdrawal, a score, an agent that has changed hands once, and a
    /// slash proposal open.
    function test_interfaces_matchTheRegistries() public {
        bytes32 didHash = _registerAndBond(agentPk, 3 * MIN_STAKE);
        _finalize(didHash, _score40());

        vm.prank(operator);
        staking.initiateWithdrawal(didHash, MIN_STAKE);

        vm.prank(operator);
        identity.offerOperatorTransfer(didHash, buyer);
        vm.prank(buyer);
        identity.acceptOperatorTransfer(didHash);

        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "evidence");

        _assertIdentityMatches(didHash);
        _assertReputationMatches(didHash);
        _assertStakingMatches(didHash);

        // And the reader's summary agrees with what those reads say.
        ISigvaraReader.Trust memory t = reader.trust(agent);
        assertEq(t.stake, 2 * MIN_STAKE, "the queued third is not counted");
        assertEq(uint8(t.status), uint8(ISigvaraIdentity.AgentStatus.Suspended));
        assertEq(uint8(t.slash), uint8(ISigvaraStaking.SlashState.Pending));
    }

    function _assertIdentityMatches(bytes32 didHash) internal view {
        ISigvaraIdentity viaInterface = ISigvaraIdentity(address(identity));

        assertEq(viaInterface.computeDidHash(agent), identity.computeDidHash(agent));

        ISigvaraIdentity.AgentIdentity memory a = viaInterface.getIdentity(didHash);
        SigvaraIdentity.AgentIdentity memory b = identity.getIdentity(didHash);
        assertEq(a.operator, b.operator);
        assertEq(a.agentAddress, b.agentAddress);
        assertEq(a.ed25519PubKey, b.ed25519PubKey);
        assertEq(uint8(a.status), uint8(b.status));
        assertEq(a.registeredAt, b.registeredAt);
        assertEq(a.operator, buyer, "the identity has changed hands");
        assertGt(a.registeredAt, 0);

        assertEq(viaInterface.isActive(didHash), identity.isActive(didHash));
        assertEq(viaInterface.operatorChangedAt(didHash), identity.operatorChangedAt(didHash));
        assertGt(viaInterface.operatorChangedAt(didHash), 0);
        assertEq(viaInterface.operatorTransferCount(didHash), identity.operatorTransferCount(didHash));
        assertEq(viaInterface.operatorTransferCount(didHash), 1);
    }

    function _assertReputationMatches(bytes32 didHash) internal view {
        ISigvaraReputation viaInterface = ISigvaraReputation(address(reputation));

        assertEq(viaInterface.getTotalScore(didHash), reputation.getTotalScore(didHash));
        assertEq(viaInterface.getEarnedScore(didHash), reputation.getEarnedScore(didHash));
        assertEq(viaInterface.getEarnedScore(didHash), 40);
        assertEq(viaInterface.meetsThreshold(didHash, 40), reputation.meetsThreshold(didHash, 40));
        assertEq(viaInterface.meetsThreshold(didHash, 41), reputation.meetsThreshold(didHash, 41));
        assertEq(viaInterface.maturityRatePerDay(), reputation.maturityRatePerDay());
        assertEq(viaInterface.challengeWindow(), reputation.challengeWindow());
        assertEq(viaInterface.challengeWindow(), SCORE_WINDOW);

        ISigvaraReputation.ReputationData memory a = viaInterface.getReputation(didHash);
        SigvaraReputation.ReputationData memory b = reputation.getReputation(didHash);
        assertEq(a.feeScore, b.feeScore);
        assertEq(a.successScore, b.successScore);
        assertEq(a.ageScore, b.ageScore);
        assertEq(a.externalScore, b.externalScore);
        assertEq(a.communityScore, b.communityScore);
        assertEq(a.propagationScore, b.propagationScore);
        assertEq(a.lastUpdated, b.lastUpdated);
        assertEq(a.feeScore, 10);
        assertGt(a.lastUpdated, 0);
    }

    function _assertStakingMatches(bytes32 didHash) internal view {
        ISigvaraStaking viaInterface = ISigvaraStaking(address(staking));

        assertEq(viaInterface.getStake(didHash), staking.getStake(didHash));
        assertEq(viaInterface.getStake(didHash), 2 * MIN_STAKE);
        assertEq(viaInterface.hasMinimumStake(didHash), staking.hasMinimumStake(didHash));
        assertEq(viaInterface.minimumStake(), staking.minimumStake());
        assertEq(viaInterface.challengePeriod(), staking.challengePeriod());
        assertEq(viaInterface.challengePeriod(), SLASH_WINDOW);
        assertEq(viaInterface.unbondingPeriod(), staking.unbondingPeriod());
        assertEq(viaInterface.unbondingPeriod(), UNBONDING);

        (uint256 amountA, uint256 claimableA) = viaInterface.getPendingWithdrawal(didHash);
        (uint256 amountB, uint256 claimableB) = staking.getPendingWithdrawal(didHash);
        assertEq(amountA, amountB);
        assertEq(claimableA, claimableB);
        assertEq(amountA, MIN_STAKE);
        assertGt(claimableA, 0);

        ISigvaraStaking.SlashProposal memory a = viaInterface.getSlashProposal(didHash);
        SigvaraStaking.SlashProposal memory b = staking.getSlashProposal(didHash);
        assertEq(a.didHash, b.didHash);
        assertEq(a.reporter, b.reporter);
        assertEq(a.victim, b.victim);
        assertEq(a.initiatedAt, b.initiatedAt);
        assertEq(uint8(a.state), uint8(b.state));
        assertEq(a.evidenceHash, b.evidenceHash);
        assertEq(a.challengeDeadline, b.challengeDeadline);
        assertEq(a.disputedAt, b.disputedAt);
        assertEq(a.reporter, committee);
        assertEq(a.victim, victim);
        assertEq(uint8(a.state), uint8(ISigvaraStaking.SlashState.Pending));
        assertEq(a.challengeDeadline, a.initiatedAt + SLASH_WINDOW);
    }
}
