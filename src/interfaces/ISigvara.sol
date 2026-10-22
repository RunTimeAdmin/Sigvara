// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title Sigvara read interfaces
 * @notice The slice of each registry that another contract needs in order to decide
 *         whether to deal with an agent. Read-only: nothing declared here changes state.
 *
 * @dev    Standalone on purpose. This file imports nothing, so a consumer can copy it
 *         into their own tree, or install this repository and import it, without
 *         pulling in the registries or their upgradeable dependencies.
 *
 *         The types are declared here rather than imported, so they have to match the
 *         registries field for field and in the same order. The registries return them
 *         ABI-encoded, and a mismatch reverts or decodes as garbage. test/SigvaraReader.t.sol
 *         calls every function below on real deployments and compares each result with
 *         the registry's own, which is what keeps the two from drifting.
 *
 *         Point these at the registry PROXY addresses in deployments/<chainId>.json.
 *         The proxies never move; the implementations behind them do.
 */

interface ISigvaraIdentity {
    /// @dev Same order as SigvaraIdentity.AgentStatus, whose values are persisted.
    ///      Active is zero, so an address that was never registered reads as Active
    ///      with registeredAt == 0. Check registeredAt, or call isActive, before
    ///      reading anything into a status.
    enum AgentStatus { Active, Suspended, Slashed, PendingBond }

    struct AgentIdentity {
        address operator;
        address agentAddress;
        bytes32 ed25519PubKey;
        AgentStatus status;
        uint256 registeredAt;
    }

    /// @notice keccak256("did:sigvara:", chainId, ":", agentAddress). The key every
    ///         other read below is indexed by.
    function computeDidHash(address agentAddress) external view returns (bytes32);

    function getIdentity(bytes32 didHash) external view returns (AgentIdentity memory);

    /// @notice True when the agent is registered and its status is Active. An agent
    ///         becomes Active when its bond first reaches minimumStake.
    function isActive(bytes32 didHash) external view returns (bool);

    /// @notice When the operator last changed, or zero if it never has.
    function operatorChangedAt(bytes32 didHash) external view returns (uint256);

    /// @notice How many times the agent has changed hands.
    function operatorTransferCount(bytes32 didHash) external view returns (uint32);
}

interface ISigvaraReputation {
    struct ReputationData {
        uint8 feeScore;
        uint8 successScore;
        uint8 ageScore;
        uint8 externalScore;
        uint8 communityScore;
        uint8 propagationScore;
        uint256 lastUpdated;
    }

    /// @notice The spendable score, 0 to 100. This is the number to gate on.
    function getTotalScore(bytes32 didHash) external view returns (uint8);

    /// @notice The score as computed, before maturity is applied.
    function getEarnedScore(bytes32 didHash) external view returns (uint8);

    /// @notice getTotalScore(didHash) >= threshold. It does not look at the agent's
    ///         status or its bond: a Suspended agent keeps its score, an agent that holds
    ///         less than a raised minimum stake keeps its score, and a threshold of zero is
    ///         met by an address that was never registered. SigvaraReader.isTrusted
    ///         adds the status and the bond.
    function meetsThreshold(bytes32 didHash, uint8 threshold) external view returns (bool);

    /// @notice The six factors behind the earned score.
    function getReputation(bytes32 didHash) external view returns (ReputationData memory);

    /// @notice Points of earned score released per day.
    function maturityRatePerDay() external view returns (uint256);

    /// @notice Seconds a proposed score stays open to challenge before it can finalize.
    function challengeWindow() external view returns (uint256);
}

interface ISigvaraStaking {
    /// @dev Same order as SigvaraStaking.SlashState.
    enum SlashState { None, Pending, Executed, Cancelled, Disputed }

    struct SlashProposal {
        bytes32 didHash;
        address reporter;
        address victim;
        uint256 initiatedAt;
        SlashState state;
        bytes evidenceHash;
        uint256 challengeDeadline;
        uint256 disputedAt;
    }

    /// @notice Bond held for the agent. Excludes any amount queued for withdrawal.
    function getStake(bytes32 didHash) external view returns (uint256);

    function hasMinimumStake(bytes32 didHash) external view returns (bool);

    /// @notice An amount the operator has queued for withdrawal, and when it becomes
    ///         claimable. It stays slashable until it is claimed.
    function getPendingWithdrawal(bytes32 didHash)
        external
        view
        returns (uint256 amount, uint256 claimableAt);

    /// @notice The latest slash proposal for the agent. state is None if there never
    ///         was one.
    function getSlashProposal(bytes32 didHash) external view returns (SlashProposal memory);

    function minimumStake() external view returns (uint256);

    /// @notice Seconds an operator has to dispute a slash before it can be executed.
    function challengePeriod() external view returns (uint256);

    /// @notice Seconds a queued withdrawal waits before it can be claimed.
    function unbondingPeriod() external view returns (uint256);
}

/**
 * @notice One-call standing of an agent. Implemented by SigvaraReader.
 */
interface ISigvaraReader {
    struct Trust {
        /// False for an address that was never registered. Every other field is then
        /// zero, and `status` carries no information.
        bool registered;
        ISigvaraIdentity.AgentStatus status;
        /// status == Active. The same answer as ISigvaraIdentity.isActive.
        bool active;
        /// The spendable score, 0 to 100: what meetsThreshold compares. After an
        /// increase it rises toward `earned` over time; a fall applies at once.
        uint8 score;
        /// The score as computed, before maturity. The spendable score never exceeds it.
        uint8 earned;
        /// Bond held for the agent, in the bond token's units. Excludes any amount the
        /// operator has queued for withdrawal, which stays slashable until it is claimed.
        uint256 stake;
        /// Where the latest slash proposal stands. Pending and Disputed mean one is open
        /// now, Executed means the agent was slashed, and Cancelled means one was dropped.
        ISigvaraStaking.SlashState slash;
        /// The bond held now meets the staking contract's current minimum. `active` is a
        /// stored status and does not change when the minimum is raised, so an agent admitted
        /// at the old minimum stays Active and keeps its score while holding less than the
        /// new one asks. This is the field that says so. Appended last, so a caller built
        /// against the struct without it still decodes the rest.
        bool collateralized;
        /// When the score was last written: the time the latest proposal finalized, or the score was
        /// zeroed. Zero for an agent that has never been scored. Nothing decays a score on chain, so one
        /// left over from before an oracle outage, or from while proposals were paused, keeps its old time
        /// here and keeps satisfying `score` until the oracle writes again. A consumer that cannot accept
        /// that compares this with block.timestamp, or calls isTrustedFresh. Appended last, like the field
        /// before it.
        uint256 scoreUpdatedAt;
    }

    /// @notice The didHash for an agent address on this chain.
    function didHashOf(address agent) external view returns (bytes32);

    /// @notice The agent's standing. Never reverts for an unknown address.
    function trust(address agent) external view returns (Trust memory);

    /// @notice Same as trust, for a caller that already holds the didHash.
    function trustByDid(bytes32 didHash) external view returns (Trust memory);

    /// @notice True when the agent is Active, its bond meets the staking contract's current
    ///         minimum, and its spendable score is at least `minScore`. False for an address
    ///         that was never registered, whatever the threshold.
    function isTrusted(address agent, uint8 minScore) external view returns (bool);

    /// @notice isTrusted, and the score was written no more than `maxAgeSeconds` ago. False for an agent
    ///         that has never been scored, whatever the age: a score that was never written is not a
    ///         fresh one. A maximum age of zero asks for a score written in this very second. Use this
    ///         instead of isTrusted wherever an oracle outage, or a pause on proposals, should not leave a
    ///         stale score admitting an agent. Pick the age against the oracle's epoch length, which is
    ///         how often a live oracle writes.
    function isTrustedFresh(address agent, uint8 minScore, uint256 maxAgeSeconds) external view returns (bool);
}
