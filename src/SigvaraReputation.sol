// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import "./SigvaraIdentity.sol";

/**
 * @title SigvaraReputation
 * @notice Stores the 6-factor reputation score for each registered agent.
 *
 * All scoring computation happens off-chain in the oracle network. This contract
 * is a verified store: it accepts oracle-proposed score updates and exposes them
 * to on-chain consumers (e.g., agent-to-agent trust checks).
 *
 * Score factors and weights (total: 100):
 *   feeScore        — max 30 — on-chain fee/transaction volume
 *   successScore    — max 25 — attestation-confirmed task completions
 *   ageScore        — max 20 — logarithmic age: min(20, floor(log2(days+1) * 4))
 *   externalScore   — max 15 — SAID Protocol / Gitcoin Passport cross-platform score
 *   communityScore  — max  5 — flag-free community standing
 *   propagationScore — max 5 — inherited trust from high-reputation vouchers
 *
 * Optimistic scoring model:
 *   - The oracle proposes a score via proposeReputation(). A challenge window opens.
 *   - If unchallenged, anyone may call finalizeReputation() once the window elapses.
 *   - During the window, SLASHING_COMMITTEE_ROLE may reject a bad proposal outright —
 *     the committee's challenge is itself the ruling, mirroring how slash disputes
 *     already work in SigvaraStaking, rather than introducing a separate
 *     propose-then-arbitrate step.
 *   - A fresh proposal for the same agent replaces any still-pending one and restarts
 *     the window; the previous pending proposal is simply abandoned.
 *
 * Identity binding:
 *   Scores are only meaningful for agents that exist and are not terminated. This
 *   contract therefore reads SigvaraIdentity on every write path. Without that check
 *   a score could be written for a didHash that was never registered, letting anyone
 *   pre-seed a reputation before the real operator claims the DID, and a slashed
 *   agent could be scored back up to 100 after SigvaraStaking had zeroed it.
 *
 * Bond requirement:
 *   An agent must hold minimumStake to be scored at all. Registration costs only gas,
 *   so without this an attacker could stand up identities in bulk, score them, and
 *   never be exposed to a slash, because slashing reverts when there is no stake to
 *   take. The bond is what makes a score accountable, and reputation is where it has
 *   to be enforced: SigvaraStaking cannot refuse a score it never sees.
 */
contract SigvaraReputation is Initializable, AccessControlUpgradeable, UUPSUpgradeable {
    // -------------------------------------------------------------------------
    // Roles
    // -------------------------------------------------------------------------

    /// Granted to the oracle consensus contract(s) authorized to propose scores.
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");

    /// Granted to the StakingCore so it can zero scores on slash.
    bytes32 public constant STAKING_CORE_ROLE = keccak256("STAKING_CORE_ROLE");

    /// Same committee that resolves slash disputes in SigvaraStaking — granted
    /// here separately since each contract keeps its own independent role registry.
    bytes32 public constant SLASHING_COMMITTEE_ROLE = keccak256("SLASHING_COMMITTEE_ROLE");

    /// Granted to admin/governance timelock for upgrades.
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    // -------------------------------------------------------------------------
    // Score caps (sum to 100)
    // -------------------------------------------------------------------------

    uint8 public constant MAX_FEE_SCORE = 30;
    uint8 public constant MAX_SUCCESS_SCORE = 25;
    uint8 public constant MAX_AGE_SCORE = 20;
    uint8 public constant MAX_EXTERNAL_SCORE = 15;
    uint8 public constant MAX_COMMUNITY_SCORE = 5;
    uint8 public constant MAX_PROPAGATION_SCORE = 5;

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    struct ReputationData {
        uint8 feeScore;          // max 30
        uint8 successScore;      // max 25
        uint8 ageScore;          // max 20
        uint8 externalScore;     // max 15
        uint8 communityScore;    // max  5
        uint8 propagationScore;  // max  5
        uint256 lastUpdated;     // block.timestamp of last finalized write
    }

    struct PendingScore {
        ReputationData data;
        uint256 proposedAt;
        bool exists;
    }

    // -------------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------------

    mapping(bytes32 => ReputationData) public reputations;
    mapping(bytes32 => PendingScore) public pendingScores;

    /// Seconds a proposed score sits open to challenge before it can be finalized.
    uint256 public challengeWindow;

    /// Source of truth for whether a didHash exists and what state it is in.
    /// Appended after challengeWindow: existing proxies keep their storage layout.
    SigvaraIdentity public identityRegistry;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event ScoreProposed(bytes32 indexed didHash, uint256 proposedAt);
    event ReputationUpdated(bytes32 indexed didHash, uint8 totalScore, uint256 timestamp);
    event ScoreRejected(bytes32 indexed didHash, address indexed committee);
    event ReputationZeroed(bytes32 indexed didHash);
    event ChallengeWindowUpdated(uint256 newWindow);
    event IdentityRegistrySet(address indexed identityRegistry);

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error ScoreOutOfRange(string factor, uint8 value, uint8 max);
    error NoScorePending(bytes32 didHash);
    error ChallengeWindowActive(bytes32 didHash, uint256 finalizableAt);
    error ChallengeWindowExpired(bytes32 didHash, uint256 expiredAt);
    error IdentityRegistryNotSet();
    error StakeViewNotSet();
    error AgentNotRegistered(bytes32 didHash);
    error AgentSlashed(bytes32 didHash);
    error AgentNotBonded(bytes32 didHash);

    // -------------------------------------------------------------------------
    // Constructor / Initializer
    // -------------------------------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @param admin           DEFAULT_ADMIN_ROLE + UPGRADER_ROLE. Governance timelock on mainnet.
     * @param oracle          Initial oracle address granted ORACLE_ROLE. Additional oracles
     *                        can be granted via DEFAULT_ADMIN.
     * @param stakingCore     Granted STAKING_CORE_ROLE to zero scores on slash.
     * @param slashingCommittee Granted SLASHING_COMMITTEE_ROLE to reject bad proposals.
     * @param challengeWindow_ Seconds a proposed score can be challenged before finalizing
     *                        (e.g. 3600 = 1 hour, 21600 = 6 hours).
     */
    function initialize(
        address admin,
        address oracle,
        address stakingCore,
        address slashingCommittee,
        uint256 challengeWindow_
    ) external initializer {
        __AccessControl_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);

        if (oracle != address(0)) _grantRole(ORACLE_ROLE, oracle);
        if (stakingCore != address(0)) _grantRole(STAKING_CORE_ROLE, stakingCore);
        if (slashingCommittee != address(0)) _grantRole(SLASHING_COMMITTEE_ROLE, slashingCommittee);

        challengeWindow = challengeWindow_;
    }

    /**
     * @notice Upgrade initializer for proxies deployed before optimistic scoring.
     * @dev    The live proxy already consumed initializer version 1, so the new
     *         initialize() can never run there — without this, challengeWindow would
     *         silently stay 0 after the upgrade, making every proposal instantly
     *         finalizable and rejection impossible. Call via upgradeToAndCall so
     *         upgrade + config are atomic. Admin-gated because on FRESH deployments
     *         version 2 is still unconsumed after initialize(), and this must not be
     *         callable by a stranger.
     */
    function initializeV2(address slashingCommittee, uint256 challengeWindow_)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        reinitializer(2)
    {
        if (slashingCommittee != address(0)) _grantRole(SLASHING_COMMITTEE_ROLE, slashingCommittee);
        challengeWindow = challengeWindow_;
        emit ChallengeWindowUpdated(challengeWindow_);
    }

    /**
     * @notice Points this contract at the identity registry. Required before any score
     *         can be proposed or finalized.
     * @dev    Follows the initializeV2 pattern: the live proxy has already consumed
     *         earlier initializer versions, so call this through upgradeToAndCall to
     *         keep the upgrade and the wiring in one transaction. Fresh deployments
     *         call it straight after initialize(), where version 3 is still unconsumed.
     *
     *         Deliberately fail-closed. If the upgrade lands without this being called,
     *         proposals revert with IdentityRegistryNotSet instead of continuing to
     *         accept unchecked writes, because a silently skipped check is the exact
     *         defect this is fixing.
     */
    function initializeV3(address identityRegistry_)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        reinitializer(3)
    {
        if (identityRegistry_ == address(0)) revert IdentityRegistryNotSet();
        identityRegistry = SigvaraIdentity(identityRegistry_);
        emit IdentityRegistrySet(identityRegistry_);
    }

    // -------------------------------------------------------------------------
    // Write functions
    // -------------------------------------------------------------------------

    /**
     * @notice Oracle proposes a score update for an agent. Opens a challenge window.
     * @dev    Validates each factor against its cap before accepting. Replaces any
     *         still-pending proposal for the same agent and restarts the window —
     *         the newer proposal reflects fresher on-chain state.
     */
    function proposeReputation(bytes32 didHash, ReputationData calldata data)
        external
        onlyRole(ORACLE_ROLE)
    {
        _requireScorable(didHash);

        if (data.feeScore > MAX_FEE_SCORE)               revert ScoreOutOfRange("feeScore", data.feeScore, MAX_FEE_SCORE);
        if (data.successScore > MAX_SUCCESS_SCORE)        revert ScoreOutOfRange("successScore", data.successScore, MAX_SUCCESS_SCORE);
        if (data.ageScore > MAX_AGE_SCORE)                revert ScoreOutOfRange("ageScore", data.ageScore, MAX_AGE_SCORE);
        if (data.externalScore > MAX_EXTERNAL_SCORE)      revert ScoreOutOfRange("externalScore", data.externalScore, MAX_EXTERNAL_SCORE);
        if (data.communityScore > MAX_COMMUNITY_SCORE)    revert ScoreOutOfRange("communityScore", data.communityScore, MAX_COMMUNITY_SCORE);
        if (data.propagationScore > MAX_PROPAGATION_SCORE) revert ScoreOutOfRange("propagationScore", data.propagationScore, MAX_PROPAGATION_SCORE);

        pendingScores[didHash] = PendingScore({
            data: data,
            proposedAt: block.timestamp,
            exists: true
        });

        emit ScoreProposed(didHash, block.timestamp);
    }

    /**
     * @notice Finalize a proposed score once its challenge window has elapsed unrejected.
     * @dev    Permissionless — execution doesn't depend on any single party's liveness.
     */
    function finalizeReputation(bytes32 didHash) external {
        // Re-checked here, not just at propose time: the agent can be slashed while
        // its proposal sits in the challenge window, and finalize is permissionless.
        _requireScorable(didHash);

        PendingScore storage pending = pendingScores[didHash];
        if (!pending.exists) revert NoScorePending(didHash);

        uint256 finalizableAt = pending.proposedAt + challengeWindow;
        if (block.timestamp < finalizableAt) revert ChallengeWindowActive(didHash, finalizableAt);

        // Stamp lastUpdated in memory so the struct is written to storage once,
        // and compute the event's total from the same memory copy instead of
        // re-reading the six factors back out of storage.
        ReputationData memory data = pending.data;
        data.lastUpdated = block.timestamp;
        reputations[didHash] = data;
        delete pendingScores[didHash];

        uint16 total = uint16(data.feeScore)
            + uint16(data.successScore)
            + uint16(data.ageScore)
            + uint16(data.externalScore)
            + uint16(data.communityScore)
            + uint16(data.propagationScore);
        // Each factor is validated at propose time, so total <= 100.
        // forge-lint: disable-next-line(unsafe-typecast)
        emit ReputationUpdated(didHash, uint8(total), block.timestamp);
    }

    /**
     * @notice Committee rejects a pending proposal during its challenge window.
     * @dev    The committee's rejection is itself the ruling — no separate dispute
     *         resolution step, mirroring how slash initiation works in SigvaraStaking.
     *         The agent's existing finalized score is untouched; only the pending
     *         proposal is discarded.
     */
    function rejectReputation(bytes32 didHash) external onlyRole(SLASHING_COMMITTEE_ROLE) {
        PendingScore storage pending = pendingScores[didHash];
        if (!pending.exists) revert NoScorePending(didHash);

        uint256 finalizableAt = pending.proposedAt + challengeWindow;
        if (block.timestamp >= finalizableAt) revert ChallengeWindowExpired(didHash, finalizableAt);

        delete pendingScores[didHash];

        emit ScoreRejected(didHash, msg.sender);
    }

    /**
     * @notice Zero out an agent's score after a slash. Called by StakingCore.
     * @dev    Sets all scores to 0 but preserves lastUpdated so history is not lost.
     *         Also clears any pending proposal — a slashed agent's score is terminal.
     */
    function zeroReputation(bytes32 didHash) external onlyRole(STAKING_CORE_ROLE) {
        reputations[didHash] = ReputationData({
            feeScore: 0,
            successScore: 0,
            ageScore: 0,
            externalScore: 0,
            communityScore: 0,
            propagationScore: 0,
            lastUpdated: block.timestamp
        });
        delete pendingScores[didHash];

        emit ReputationZeroed(didHash);
    }

    // -------------------------------------------------------------------------
    // Internal
    // -------------------------------------------------------------------------

    /// @dev Rejects writes for a didHash that was never registered, for one whose agent
    ///      has been slashed, and for one that is not bonded. Suspended agents stay
    ///      scorable while they remain bonded: suspension is a normal, reversible
    ///      operator state used during withdrawal, not a verdict.
    ///
    ///      The bond is read through the identity registry's stake view rather than a
    ///      reference of this contract's own, so there is a single wiring point and the
    ///      two registries cannot disagree about what counts as bonded.
    ///
    ///      Queued withdrawals do not count. They remain slashable until claimed, but an
    ///      agent on its way out should stop accruing reputation rather than keep
    ///      earning while it unwinds.
    function _requireScorable(bytes32 didHash) internal view {
        SigvaraIdentity registry = identityRegistry;
        if (address(registry) == address(0)) revert IdentityRegistryNotSet();

        SigvaraIdentity.AgentIdentity memory id = registry.getIdentity(didHash);
        if (id.registeredAt == 0) revert AgentNotRegistered(didHash);
        if (id.status == SigvaraIdentity.AgentStatus.Slashed) revert AgentSlashed(didHash);

        IStakeView stakeView = registry.stakeView();
        if (address(stakeView) == address(0)) revert StakeViewNotSet();
        if (!stakeView.hasMinimumStake(didHash)) revert AgentNotBonded(didHash);
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    function setChallengeWindow(uint256 newWindow) external onlyRole(DEFAULT_ADMIN_ROLE) {
        challengeWindow = newWindow;
        emit ChallengeWindowUpdated(newWindow);
    }

    // -------------------------------------------------------------------------
    // View functions
    // -------------------------------------------------------------------------

    function getReputation(bytes32 didHash) external view returns (ReputationData memory) {
        return reputations[didHash];
    }

    function getPendingScore(bytes32 didHash) external view returns (PendingScore memory) {
        return pendingScores[didHash];
    }

    /// @notice Returns the sum of all 6 factor scores. Max 100.
    function getTotalScore(bytes32 didHash) public view returns (uint8) {
        ReputationData storage rep = reputations[didHash];
        uint16 total = uint16(rep.feeScore)
            + uint16(rep.successScore)
            + uint16(rep.ageScore)
            + uint16(rep.externalScore)
            + uint16(rep.communityScore)
            + uint16(rep.propagationScore);
        // Each factor is validated at propose time, so total <= 100.
        assert(total <= 100);
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint8(total);
    }

    function meetsThreshold(bytes32 didHash, uint8 threshold) external view returns (bool) {
        return getTotalScore(didHash) >= threshold;
    }

    // -------------------------------------------------------------------------
    // UUPS upgrade authorization
    // -------------------------------------------------------------------------

    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}
}
