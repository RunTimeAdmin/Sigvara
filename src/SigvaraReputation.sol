// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

import "./SigvaraIdentity.sol";

/**
 * @notice The slice of SigvaraOracleBond this contract needs.
 * @dev    An interface rather than an import: the bond registry is deployed by its own
 *         script and is optional, so reputation should not carry a hard dependency on
 *         a contract that may not exist on a given chain.
 */
interface IOperatorSet {
    function isActiveOperator(address operator) external view returns (bool);
}

/**
 * @title SigvaraReputation
 * @notice Stores the 6-factor reputation score for each registered agent.
 *
 * All scoring computation happens off-chain in the oracle network. This contract
 * is a verified store: it accepts oracle-proposed score updates and exposes them
 * to on-chain consumers (e.g., agent-to-agent trust checks).
 *
 * Score factors and weights (total: 100):
 *   feeScore        — max 20 — on-chain fee/transaction volume
 *   successScore    — max 15 — attestation-confirmed task completions
 *   ageScore        — max 30 — span of verified paid activity, faded by how long since
 *                              the last of it: min(30, floor(log2(spanDays+1) * 3)) × recency
 *   externalScore   — max 25 — normalized ERC-8004 cross-protocol feedback
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
 *
 * Bonded oracles:
 *   When an operator set is configured, proposing a score requires the caller to be an
 *   admitted, bonded operator in it, on top of holding ORACLE_ROLE. The role says who
 *   is allowed to speak; the bond is what they lose for speaking falsely. Optional,
 *   because the registry is deployed separately and a chain may not have one: with no
 *   operator set configured the role alone governs, which is the single-operator
 *   arrangement this started from.
 *
 * Maturity:
 *   A score is earned immediately but becomes spendable only over time. Reads return
 *   the matured value, which climbs toward the earned one at a bounded rate. Without
 *   this, a score built quickly can be used the moment it peaks, which is exactly the
 *   shape of a farm-and-cash-out: accumulate, get trusted, leave. Falls are not
 *   delayed. A drop applies at once, because slowing bad news down would protect the
 *   agent rather than whoever is relying on it.
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
    //
    // Fee and success were 30 and 25, together 55 of the 100 points. Both are measures
    // of activity, and activity is the one thing a wash ring can manufacture: when an
    // attacker pays its own agent from its own wallets the money comes back, so the
    // volume costs gas and float rather than value. Measured in oracle/adversarial.test.js,
    // a six-wallet ring reached 66/100 with no outside identity and no real trading
    // history, and 51 of those points came from these two factors.
    //
    // The 20 points released move to the two factors that resist structurally. Tenure
    // cannot be bought at any price, only waited out, and the span is measured from
    // first verified payment so idle time banks nothing. External trust requires
    // standing in a registry this protocol does not control and cannot mint.
    //
    // This is a repricing, not a fix. A funded attacker who also acquires an ERC-8004
    // identity still reaches the high seventies under any weighting tried. See
    // docs/whitepaper.md 5.4: the weights bound cheap attacks, and only a slashing
    // path that actually executes bounds expensive ones.
    // -------------------------------------------------------------------------

    uint8 public constant MAX_FEE_SCORE = 20;
    uint8 public constant MAX_SUCCESS_SCORE = 15;
    uint8 public constant MAX_AGE_SCORE = 30;
    uint8 public constant MAX_EXTERNAL_SCORE = 25;
    uint8 public constant MAX_COMMUNITY_SCORE = 5;
    uint8 public constant MAX_PROPAGATION_SCORE = 5;

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    struct ReputationData {
        uint8 feeScore;          // max 20
        uint8 successScore;      // max 15
        uint8 ageScore;          // max 30
        uint8 externalScore;     // max 25
        uint8 communityScore;    // max  5
        uint8 propagationScore;  // max  5
        uint256 lastUpdated;     // block.timestamp of last finalized write
    }

    struct PendingScore {
        ReputationData data;
        uint256 proposedAt;
        bool exists;
        // Appended, not inserted. ReputationData is nested above and is also stored on
        // its own in `reputations`, so a field added inside it would shift proposedAt
        // and exists here and corrupt every live proposal after an upgrade.
        bytes32 evidenceRoot;
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

    /// Points of matured score per day. Appended, like everything after it.
    uint256 public maturityRatePerDay;

    /// Matured score as at `maturedAt`, the anchor reads extrapolate from.
    mapping(bytes32 => uint8) public maturedScore;
    mapping(bytes32 => uint256) public maturedAt;

    /// `operatorChangedAt(bytes32)`. Written out rather than taken from the contract
    /// type because it is an auto-generated mapping getter, which has no `.selector`.
    bytes4 private constant OPERATOR_CHANGED_AT = 0xcd46167a;

    /// Bonded operator registry. Unset means the check is off, which is a deliberate
    /// mode rather than a misconfiguration: the registry is a separate deployment.
    IOperatorSet public operatorBond;

    /// Merkle root of the evidence behind each agent's finalized score.
    ///
    /// A score is computed off-chain from payments the oracle verified, and until now
    /// the only record of which payments those were lived in the oracle's own JSON
    /// file. Anyone wanting to check the arithmetic had to trust that file. The root
    /// commits to the evidence set at proposal time, so a third party can be handed the
    /// leaves, re-verify each payment against the chain itself, and confirm the set is
    /// the one that was actually scored.
    ///
    /// Declared LAST, after operatorBond, because operatorBond is already live on the
    /// Arc testnet proxy. Inserting this above it moved operatorBond down one slot,
    /// where it read zero, and zero is the "bonded-operator check disabled" mode: the
    /// upgrade would have quietly removed the requirement without reverting anything.
    /// Caught by the fork rehearsal in test/VerifyUpgradeFork.t.sol. Anything added
    /// here goes below this line.
    mapping(bytes32 => bytes32) public evidenceRoots;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event ScoreProposed(bytes32 indexed didHash, uint256 proposedAt, bytes32 evidenceRoot);
    event ReputationUpdated(bytes32 indexed didHash, uint8 totalScore, uint256 timestamp, bytes32 evidenceRoot);
    event ScoreRejected(bytes32 indexed didHash, address indexed committee);
    event ReputationZeroed(bytes32 indexed didHash);
    event ChallengeWindowUpdated(uint256 newWindow);
    event IdentityRegistrySet(address indexed identityRegistry);
    event MaturityRateUpdated(uint256 pointsPerDay);
    event OperatorBondSet(address indexed operatorBond);

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
    error MaturityRateZero();
    error OracleNotBonded(address oracle);

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
    function proposeReputation(bytes32 didHash, ReputationData calldata data, bytes32 evidenceRoot)
        external
        onlyRole(ORACLE_ROLE)
    {
        _requireScorable(didHash);
        _requireBondedOracle();

        if (data.feeScore > MAX_FEE_SCORE)               revert ScoreOutOfRange("feeScore", data.feeScore, MAX_FEE_SCORE);
        if (data.successScore > MAX_SUCCESS_SCORE)        revert ScoreOutOfRange("successScore", data.successScore, MAX_SUCCESS_SCORE);
        if (data.ageScore > MAX_AGE_SCORE)                revert ScoreOutOfRange("ageScore", data.ageScore, MAX_AGE_SCORE);
        if (data.externalScore > MAX_EXTERNAL_SCORE)      revert ScoreOutOfRange("externalScore", data.externalScore, MAX_EXTERNAL_SCORE);
        if (data.communityScore > MAX_COMMUNITY_SCORE)    revert ScoreOutOfRange("communityScore", data.communityScore, MAX_COMMUNITY_SCORE);
        if (data.propagationScore > MAX_PROPAGATION_SCORE) revert ScoreOutOfRange("propagationScore", data.propagationScore, MAX_PROPAGATION_SCORE);

        pendingScores[didHash] = PendingScore({
            data: data,
            proposedAt: block.timestamp,
            exists: true,
            evidenceRoot: evidenceRoot
        });

        emit ScoreProposed(didHash, block.timestamp, evidenceRoot);
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
        // Snapshot what was spendable under the OLD score before overwriting it, and
        // restart the clock from there. Taking the matured value rather than the
        // earned one is the whole point: a jump in the earned score is released from
        // where the agent actually stood, not from where it claimed to be.
        uint8 anchor = getTotalScore(didHash);

        ReputationData memory data = pending.data;
        data.lastUpdated = block.timestamp;
        bytes32 root = pending.evidenceRoot;
        reputations[didHash] = data;
        evidenceRoots[didHash] = root;
        delete pendingScores[didHash];

        maturedScore[didHash] = anchor;
        maturedAt[didHash] = block.timestamp;

        uint16 total = uint16(data.feeScore)
            + uint16(data.successScore)
            + uint16(data.ageScore)
            + uint16(data.externalScore)
            + uint16(data.communityScore)
            + uint16(data.propagationScore);
        // Each factor is validated at propose time, so total <= 100.
        // forge-lint: disable-next-line(unsafe-typecast)
        emit ReputationUpdated(didHash, uint8(total), block.timestamp, root);
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
        delete evidenceRoots[didHash];
        maturedScore[didHash] = 0;
        maturedAt[didHash] = block.timestamp;

        emit ReputationZeroed(didHash);
    }

    /**
     * @notice Sets the rate at which an earned score becomes spendable.
     * @dev    Separate initializer for the same reason as the others: the live proxy
     *         has consumed earlier versions, so this has to run through
     *         upgradeToAndCall. A rate of zero would freeze every score at its anchor
     *         forever, so it is rejected rather than treated as "no maturity".
     */
    function initializeV4(uint256 pointsPerDay)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        reinitializer(4)
    {
        if (pointsPerDay == 0) revert MaturityRateZero();
        maturityRatePerDay = pointsPerDay;
        emit MaturityRateUpdated(pointsPerDay);
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
    /// @dev Checked on propose only. Finalization stays permissionless: it is
    ///      mechanical, it cannot change the number, and gating it on operator status
    ///      would let an oracle's exit strand every score it had already proposed.
    function _requireBondedOracle() internal view {
        IOperatorSet set = operatorBond;
        if (address(set) == address(0)) return;
        if (!set.isActiveOperator(msg.sender)) revert OracleNotBonded(msg.sender);
    }

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

    /**
     * @notice Point at the bonded operator registry, or pass address(0) to turn the
     *         requirement off.
     * @dev    A plain setter rather than another initializer. Unset is a safe, working
     *         state, so there is nothing that must land atomically with an upgrade;
     *         the other wirings needed initializers precisely because their unset state
     *         was not safe.
     *
     *         Turning this on stops every oracle that has not bonded and been admitted,
     *         so set it after the operators are in the registry, not before.
     */
    function setOperatorBond(address operatorBond_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        operatorBond = IOperatorSet(operatorBond_);
        emit OperatorBondSet(operatorBond_);
    }

    function setMaturityRate(uint256 pointsPerDay) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (pointsPerDay == 0) revert MaturityRateZero();
        maturityRatePerDay = pointsPerDay;
        emit MaturityRateUpdated(pointsPerDay);
    }

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

    /**
     * @notice The spendable score: what the agent has earned, released over time.
     * @dev    This is what consumers should read, and what meetsThreshold uses. It
     *         climbs from the anchor set at the last finalize toward the earned score
     *         at maturityRatePerDay, and never exceeds it. A fall is immediate.
     *
     *         Extrapolating on read rather than on write means maturity accrues with
     *         wall-clock time even if the oracle stops proposing, so an outage cannot
     *         hold an honest agent below its earned score indefinitely.
     */
    function getTotalScore(bytes32 didHash) public view returns (uint8) {
        uint8 earned = getEarnedScore(didHash);
        uint8 anchor = maturedScore[didHash];
        if (earned <= anchor) return earned;


        uint256 since = maturedAt[didHash];

        // A handover restarts maturity. The reputation was earned by whoever held the
        // agent before, so a buyer should not get it instantly spendable: that would
        // make aged, scored identities a liquid commodity, which is the farm-and-sell
        // market this is meant to price out. The score itself survives; only the right
        // to spend it is re-earned, over the same window as any other rise.
        // Read through a raw staticcall rather than the typed getter. An identity
        // registry deployed before operator transfer existed has no such function, and
        // a typed call to it reverts, taking this view down with it. getTotalScore is
        // what every consumer reads, so a version skew between the two proxies would
        // make every score on the chain unreadable. It degrades to "no handover known"
        // instead, which is the state of the world on a registry that cannot record
        // one. Learned the hard way on Arc testnet.
        address registry = address(identityRegistry);
        if (registry != address(0)) {
            (bool ok, bytes memory ret) = registry.staticcall(
                abi.encodeWithSelector(OPERATOR_CHANGED_AT, didHash)
            );
            if (ok && ret.length == 32) {
                uint256 changed = abi.decode(ret, (uint256));
                if (changed > since) {
                    since = changed;
                    anchor = 0;
                }
            }
        }

        // Before the first finalize there is no anchor to grow from, and a zero
        // timestamp would extrapolate from 1970 and mature everything instantly.
        if (since == 0 || maturityRatePerDay == 0) return earned;

        uint256 released = uint256(anchor)
            + ((block.timestamp - since) * maturityRatePerDay) / 1 days;
        // Safe: this branch only runs when released < earned, and earned is a sum of
        // capped factors that cannot exceed 100.
        // forge-lint: disable-next-line(unsafe-typecast)
        return released >= earned ? earned : uint8(released);
    }

    /**
     * @notice Whether `leaf` is part of the evidence behind this agent's live score.
     * @dev    The leaf is built by the caller from a payment they can check on chain
     *         themselves, so this proves the oracle counted that payment without
     *         anyone having to trust the oracle's records. An agent with no root, or
     *         one whose score predates this, verifies nothing rather than everything.
     */
    function verifyEvidence(bytes32 didHash, bytes32 leaf, bytes32[] calldata proof)
        external
        view
        returns (bool)
    {
        bytes32 root = evidenceRoots[didHash];
        if (root == bytes32(0)) return false;
        return MerkleProof.verify(proof, root, leaf);
    }

    /// @notice The score as computed, before maturity is applied. Max 100.
    function getEarnedScore(bytes32 didHash) public view returns (uint8) {
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
