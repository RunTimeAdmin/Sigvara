// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
 * @notice The slice of SigvaraStaking this contract needs.
 * @dev    Declared as an interface rather than importing SigvaraStaking, which
 *         already imports this file. Keeping the dependency one-way avoids a
 *         circular import for a single view call.
 */
interface IStakeView {
    function hasMinimumStake(bytes32 didHash) external view returns (bool);
}

/**
 * @title SigvaraIdentity
 * @notice Anchors AI agent identities on-chain. Each agent is indexed by a deterministic
 *         didHash derived from the agent's Ethereum address and the current chain ID:
 *
 *         didHash = keccak256(abi.encodePacked("did:sigvara:", block.chainid, ":", agentAddress))
 *
 *         This makes the DID trustlessly reproducible off-chain without querying the contract.
 *         The Ed25519 public key (raw 32 bytes) is stored for off-chain challenge-response auth.
 */
contract SigvaraIdentity is Initializable, AccessControlUpgradeable, UUPSUpgradeable {
    // -------------------------------------------------------------------------
    // Roles
    // -------------------------------------------------------------------------

    /// Granted to the StakingCore contract so it can mark agents as Slashed.
    bytes32 public constant STAKING_CORE_ROLE = keccak256("STAKING_CORE_ROLE");

    /// Granted to admin/governance timelock for contract upgrades.
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    enum AgentStatus { Active, Suspended, Slashed }

    struct AgentIdentity {
        address operator;       // Ethereum wallet that controls this agent's stake
        address agentAddress;   // Agent's Ethereum address (forms the DID)
        bytes32 ed25519PubKey;  // Raw 32-byte Ed25519 public key
        AgentStatus status;
        uint256 registeredAt;
    }

    // -------------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------------

    /// Primary index: didHash => identity
    mapping(bytes32 => AgentIdentity) public identities;

    /// Secondary index: operator => list of didHashes they control
    mapping(address => bytes32[]) public operatorAgents;

    // Appended after the original layout. New storage must always be declared
    // AFTER existing variables so a UUPS upgrade doesn't shift the base slots of
    // the mappings above (see the same discipline in SigvaraStaking).
    //
    /// True while the agent is Suspended because the staking core initiated a
    /// slash. The operator may NOT lift this suspension — only the staking core
    /// can (on dispute resolution). Without this, an operator could call
    /// updateStatus(Active) to un-suspend themselves mid-challenge-window,
    /// defeating the halt initiateSlash relies on.
    mapping(bytes32 => bool) public slashSuspended;

    /// Collateral oracle for status transitions. Appended after slashSuspended so
    /// deployed proxies keep their layout.
    IStakeView public stakeView;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event AgentRegistered(
        bytes32 indexed didHash,
        address indexed operator,
        address indexed agentAddress,
        bytes32 ed25519PubKey
    );
    event StakeViewSet(address indexed stakeView);
    event AgentStatusUpdated(bytes32 indexed didHash, AgentStatus newStatus);
    event PublicKeyRotated(bytes32 indexed didHash, bytes32 newEd25519PubKey);

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error AlreadyRegistered(bytes32 didHash);
    error NotRegistered(bytes32 didHash);
    error NotOperator(bytes32 didHash, address caller);
    error ZeroPubKey();
    error ZeroAgentAddress();
    error SlashedAgentImmutable(bytes32 didHash);
    error SlashSuspensionLocked(bytes32 didHash);
    error StakeViewNotSet();
    error InsufficientCollateral(bytes32 didHash);

    // -------------------------------------------------------------------------
    // Constructor / Initializer
    // -------------------------------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @param admin       Granted DEFAULT_ADMIN_ROLE and UPGRADER_ROLE.
     *                    Should be a governance timelock on mainnet.
     * @param stakingCore Granted STAKING_CORE_ROLE. Pass address(0) if deploying
     *                    identity before staking; grant the role separately afterward.
     */
    function initialize(address admin, address stakingCore) external initializer {
        __AccessControl_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);

        if (stakingCore != address(0)) {
            _grantRole(STAKING_CORE_ROLE, stakingCore);
        }
    }

    /**
     * @notice Points this contract at the staking contract, so a status change back to
     *         Active can be checked against the agent's collateral.
     * @dev    Staking is deployed after identity, so its address is not known at
     *         initialize() time. Call this through upgradeToAndCall on a live proxy, or
     *         immediately after initialize() on a fresh deployment.
     *
     *         Fail-closed, like the reputation registry's identity binding: until this
     *         runs, an operator-driven return to Active reverts with StakeViewNotSet
     *         rather than skipping the collateral check.
     */
    function initializeV2(address stakeView_)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        reinitializer(2)
    {
        if (stakeView_ == address(0)) revert StakeViewNotSet();
        stakeView = IStakeView(stakeView_);
        emit StakeViewSet(stakeView_);
    }

    // -------------------------------------------------------------------------
    // Write functions
    // -------------------------------------------------------------------------

    /**
     * @notice Register a new agent identity. The caller becomes the operator.
     * @dev    didHash is derived on-chain for trustless determinism. Any party can
     *         reproduce it without querying storage:
     *         keccak256(abi.encodePacked("did:sigvara:", block.chainid, ":", agentAddress))
     *
     *         Staking enforcement is handled by SigvaraStaking, which should be called
     *         before or atomically with this function via a registration helper/script.
     *
     * @param agentAddress  The agent's Ethereum address. Forms the identity component of the DID.
     * @param ed25519PubKey Raw 32-byte Ed25519 public key (no multibase prefix).
     * @return didHash      The computed DID hash, emitted in the event and returned for convenience.
     */
    function registerAgent(address agentAddress, bytes32 ed25519PubKey)
        external
        returns (bytes32 didHash)
    {
        if (agentAddress == address(0)) revert ZeroAgentAddress();
        if (ed25519PubKey == bytes32(0)) revert ZeroPubKey();

        didHash = computeDidHash(agentAddress);
        if (identities[didHash].registeredAt != 0) revert AlreadyRegistered(didHash);

        identities[didHash] = AgentIdentity({
            operator: msg.sender,
            agentAddress: agentAddress,
            ed25519PubKey: ed25519PubKey,
            status: AgentStatus.Active,
            registeredAt: block.timestamp
        });

        operatorAgents[msg.sender].push(didHash);

        emit AgentRegistered(didHash, msg.sender, agentAddress, ed25519PubKey);
    }

    /**
     * @notice Rotate the Ed25519 public key. Only the operator can rotate.
     * @dev    Suspended agents may rotate to recover after a key compromise.
     *         Slashed agents are permanently terminated and cannot rotate.
     */
    function rotatePublicKey(bytes32 didHash, bytes32 newEd25519PubKey) external {
        AgentIdentity storage id = _requireRegistered(didHash);
        _requireOperator(id, didHash);
        if (id.status == AgentStatus.Slashed) revert SlashedAgentImmutable(didHash);
        if (newEd25519PubKey == bytes32(0)) revert ZeroPubKey();

        id.ed25519PubKey = newEd25519PubKey;
        emit PublicKeyRotated(didHash, newEd25519PubKey);
    }

    /**
     * @notice Update agent status.
     * @dev    Operator can toggle Active <-> Suspended.
     *         Only STAKING_CORE_ROLE can set Slashed.
     *         Slashed is terminal: no further status updates are allowed.
     */
    function updateStatus(bytes32 didHash, AgentStatus newStatus) external {
        AgentIdentity storage id = _requireRegistered(didHash);

        if (id.status == AgentStatus.Slashed) revert SlashedAgentImmutable(didHash);

        bool isStakingCore = hasRole(STAKING_CORE_ROLE, msg.sender);

        if (newStatus == AgentStatus.Slashed) {
            _checkRole(STAKING_CORE_ROLE);
        } else if (!isStakingCore) {
            // Staking core can suspend (slash initiation) or reinstate without operator consent.
            // Everyone else must be the operator.
            _requireOperator(id, didHash);
            // An operator cannot clear a suspension the staking core applied for a
            // pending slash. Only the staking core reinstates it (via disputeSlash).
            if (slashSuspended[didHash]) revert SlashSuspensionLocked(didHash);
        }

        // Track/clear the staking-applied suspension lock so the operator can't
        // reactivate mid-slash, while normal operator self-suspends stay unlocked.
        // The bond is what makes a status meaningful. An operator could otherwise
        // self-suspend, drain the whole stake (the minimumStake floor only applies
        // while Active), claim it once unbonding elapsed, and walk straight back to
        // Active carrying its reputation with nothing behind it. In that state
        // initiateSlash reverts for want of stake, so the agent is unslashable.
        //
        // Draining to zero stays legal: that is how an operator exits. What is closed
        // is the return trip.
        //
        // This applies to the staking core too. Exempting it left the same escape one
        // step further round: queue a withdrawal while Suspended, draw a slash, dispute
        // it, and the reinstatement that follows a dropped proposal put the agent back
        // to Active under-collateralised. SigvaraStaking checks the bond before
        // reinstating and leaves the agent Suspended otherwise, so this never reverts a
        // permissionless call.
        if (newStatus == AgentStatus.Active) {
            if (address(stakeView) == address(0)) revert StakeViewNotSet();
            if (!stakeView.hasMinimumStake(didHash)) revert InsufficientCollateral(didHash);
        }

        if (isStakingCore) {
            if (newStatus == AgentStatus.Suspended) {
                slashSuspended[didHash] = true;
            } else if (newStatus == AgentStatus.Active) {
                slashSuspended[didHash] = false;
            }
        }

        id.status = newStatus;
        emit AgentStatusUpdated(didHash, newStatus);
    }

    /**
     * @notice Lift a staking-applied suspension without reinstating the agent.
     * @dev    For a dropped slash proposal against an agent that no longer holds the
     *         minimum bond. Reinstating it would return an unslashable agent to Active,
     *         and reverting would strand expireDispute, which anyone may call. The agent
     *         stays Suspended with the lock cleared, so its operator can re-bond and
     *         reactivate it through the normal path.
     */
    function clearSlashSuspension(bytes32 didHash) external onlyRole(STAKING_CORE_ROLE) {
        _requireRegistered(didHash);
        slashSuspended[didHash] = false;
    }

    // -------------------------------------------------------------------------
    // View functions
    // -------------------------------------------------------------------------

    /**
     * @notice Compute the canonical didHash for an agent address on this chain.
     * @dev    Reproduces the DID: did:sigvara:<chainId>:<agentAddress>
     *         Pure view — does not read contract state, so callers can compute
     *         before the agent is registered.
     */
    function computeDidHash(address agentAddress) public view returns (bytes32) {
        return keccak256(abi.encodePacked("did:sigvara:", block.chainid, ":", agentAddress));
    }

    function getIdentity(bytes32 didHash) external view returns (AgentIdentity memory) {
        return identities[didHash];
    }

    function isActive(bytes32 didHash) external view returns (bool) {
        AgentIdentity storage id = identities[didHash];
        return id.registeredAt != 0 && id.status == AgentStatus.Active;
    }

    function getOperatorAgents(address operator) external view returns (bytes32[] memory) {
        return operatorAgents[operator];
    }

    // -------------------------------------------------------------------------
    // Internal helpers
    // -------------------------------------------------------------------------

    function _requireRegistered(bytes32 didHash) internal view returns (AgentIdentity storage id) {
        id = identities[didHash];
        if (id.registeredAt == 0) revert NotRegistered(didHash);
    }

    function _requireOperator(AgentIdentity storage id, bytes32 didHash) internal view {
        if (id.operator != msg.sender) revert NotOperator(didHash, msg.sender);
    }

    // -------------------------------------------------------------------------
    // UUPS upgrade authorization
    // -------------------------------------------------------------------------

    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}
}
