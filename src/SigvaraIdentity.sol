// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

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

    /// @dev PendingBond is APPENDED, never inserted. These values are persisted in
    ///      `identities` on a live proxy, and renumbering them would reinterpret every
    ///      stored identity after a UUPS upgrade.
    ///
    ///      A new agent starts here rather than Active. Registration costs only gas, so
    ///      minting an Active identity meant an unbonded, unslashable agent existed the
    ///      moment anyone paid for a transaction. It becomes Active when a deposit
    ///      first carries it over minimumStake, which is what "bond before trust"
    ///      should mean rather than merely describe.
    enum AgentStatus { Active, Suspended, Slashed, PendingBond }

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
    // A mapping has no initial value to assign; it is populated at runtime by
    // _pushToOperatorIndex. Slither does not trace the write because that helper is
    // private. Suppressed on this declaration only, so the detector stays live for
    // every other storage variable.
    // slither-disable-next-line uninitialized-state
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

    /// Outstanding transfer offer: didHash => the address that may accept it.
    mapping(bytes32 => address) public pendingOperator;

    /// When the operator last changed. Read by SigvaraReputation, which restarts a
    /// score's maturity from a handover so an identity cannot be sold with its
    /// reputation immediately spendable.
    mapping(bytes32 => uint256) public operatorChangedAt;

    /// How many times the agent has changed hands. Reported, not scored: a consumer
    /// can decide for itself what a frequently traded identity is worth.
    mapping(bytes32 => uint32) public operatorTransferCount;

    /**
     * Position of a didHash inside its operator's list, stored as index + 1 so that an
     * unset entry reads 0 rather than pointing at the first element.
     *
     * `_removeFromOperatorIndex` used to scan the list linearly, justified by a comment
     * saying an operator's list is short. Nothing enforced that, and registration became
     * free when agents started at PendingBond: an operator who registers enough of them
     * makes the scan exceed the block gas limit, at which point acceptOperatorTransfer
     * reverts for every agent they hold, permanently. Self-inflicted, but a stated
     * invariant the code did not keep.
     *
     * Appended last, like everything else. Agents registered before this existed have no
     * position recorded, so removal falls back to the scan for them; the fallback is the
     * old behaviour, and it disappears as those agents are transferred or never runs again.
     */
    mapping(bytes32 => uint256) private operatorAgentIndex;

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
    event OperatorTransferOffered(bytes32 indexed didHash, address indexed from, address indexed to);
    event OperatorTransferCancelled(bytes32 indexed didHash, address indexed by);
    event OperatorTransferred(bytes32 indexed didHash, address indexed from, address indexed to);
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
    error NoTransferOffered(bytes32 didHash);
    error NotOfferedOperator(bytes32 didHash, address caller);
    error TransferWhileSlashPending(bytes32 didHash);
    error SameOperator(bytes32 didHash);
    error CannotReturnToPendingBond(bytes32 didHash);
    error BadRegistrationSignature(address agentAddress);

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
     * @notice The message an agent address must sign to be registered.
     * @dev    Returned UNPREFIXED, so a client signs it with a plain personal_sign and
     *         the EIP-191 prefix is applied once, by the wallet. Returning it already
     *         prefixed reads as a convenience and is a trap: every standard signer
     *         prefixes what it is given, so the signature would cover a double-prefixed
     *         hash and never recover to the agent. verifyRegistration applies the prefix
     *         on this side.
     *
     *         Public so a client can obtain the digest without reimplementing it, and so
     *         the binding is auditable rather than folklore.
     *
     *         Every field is load-bearing. The chain id and this contract's address stop
     *         a signature being replayed onto another deployment. The operator stops it
     *         being lifted by somebody else and used to claim the agent. The Ed25519 key
     *         stops an interceptor substituting a key that verifiers would then check
     *         against, which is the whole point of the exercise.
     */
    function registrationDigest(
        address agentAddress,
        address operator,
        bytes32 ed25519PubKey
    ) public view returns (bytes32) {
        return keccak256(abi.encode(
            keccak256("SigvaraRegistration(uint256 chainId,address registry,address agentAddress,address operator,bytes32 ed25519PubKey)"),
            block.chainid,
            address(this),
            agentAddress,
            operator,
            ed25519PubKey
        ));
    }

    /// @notice Whether `signature` proves `agentAddress` agreed to this registration.
    /// @dev    Exposed so a client can check a signature before spending gas on a
    ///         transaction that would revert.
    function verifyRegistration(
        address agentAddress,
        address operator,
        bytes32 ed25519PubKey,
        bytes calldata signature
    ) public view returns (bool) {
        return SignatureChecker.isValidSignatureNow(
            agentAddress,
            MessageHashUtils.toEthSignedMessageHash(
                registrationDigest(agentAddress, operator, ed25519PubKey)
            ),
            signature
        );
    }

    /**
     * @notice Register a new agent identity. The caller becomes the operator.
     * @dev    didHash is derived on-chain for trustless determinism. Any party can
     *         reproduce it without querying storage:
     *         keccak256(abi.encodePacked("did:sigvara:", block.chainid, ":", agentAddress))
     *
     *         The agent address must sign registrationDigest(). Without that, registration
     *         proved no control of the address being claimed: anyone could register an
     *         address they did not own, choose the Ed25519 key verifiers would check, and
     *         lock the rightful owner out permanently, since a didHash can never be
     *         re-registered. Signatures are checked through SignatureChecker, so an agent
     *         may be an EOA or a contract implementing ERC-1271.
     *
     *         No nonce is needed: a didHash can only be registered once, so a signature
     *         cannot be replayed against this registry, and the digest is bound to this
     *         registry and chain so it cannot be replayed elsewhere.
     *
     * @param agentAddress  The agent's Ethereum address. Forms the identity component of the DID.
     * @param ed25519PubKey Raw 32-byte Ed25519 public key (no multibase prefix).
     * @param signature     agentAddress's signature over registrationDigest().
     * @return didHash      The computed DID hash, emitted in the event and returned for convenience.
     */
    function registerAgent(address agentAddress, bytes32 ed25519PubKey, bytes calldata signature)
        external
        returns (bytes32 didHash)
    {
        if (agentAddress == address(0)) revert ZeroAgentAddress();
        if (ed25519PubKey == bytes32(0)) revert ZeroPubKey();

        if (!verifyRegistration(agentAddress, msg.sender, ed25519PubKey, signature)) {
            revert BadRegistrationSignature(agentAddress);
        }

        didHash = computeDidHash(agentAddress);
        if (identities[didHash].registeredAt != 0) revert AlreadyRegistered(didHash);

        identities[didHash] = AgentIdentity({
            operator: msg.sender,
            agentAddress: agentAddress,
            ed25519PubKey: ed25519PubKey,
            status: AgentStatus.PendingBond,
            registeredAt: block.timestamp
        });

        _pushToOperatorIndex(msg.sender, didHash);

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
        // Nothing moves back to PendingBond. It describes an identity that has never
        // been bonded, and an agent cannot become un-bonded: it suspends and exits.
        if (newStatus == AgentStatus.PendingBond) revert CannotReturnToPendingBond(didHash);

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
     * @notice Offer this agent to a new operator. Nothing moves until they accept.
     * @dev    Two steps on purpose. A one-shot transfer to a mistyped or uncontrolled
     *         address would strand the identity and its bond permanently, with no way
     *         back, because only the operator can act and nobody holds that key.
     *         Requiring the recipient to accept proves they can transact from it.
     *
     *         Refused while a slash is pending. Otherwise an operator could hand off an
     *         agent the moment it was accused and leave the liability with a buyer who
     *         had no part in what it did.
     */
    function offerOperatorTransfer(bytes32 didHash, address newOperator) external {
        AgentIdentity storage id = _requireRegistered(didHash);
        _requireOperator(id, didHash);
        if (id.status == AgentStatus.Slashed) revert SlashedAgentImmutable(didHash);
        if (slashSuspended[didHash]) revert TransferWhileSlashPending(didHash);
        if (newOperator == address(0)) revert ZeroAgentAddress();
        if (newOperator == id.operator) revert SameOperator(didHash);

        pendingOperator[didHash] = newOperator;
        emit OperatorTransferOffered(didHash, id.operator, newOperator);
    }

    /// @notice Withdraw an outstanding offer. Either side may walk away before it lands.
    function cancelOperatorTransfer(bytes32 didHash) external {
        AgentIdentity storage id = _requireRegistered(didHash);
        address offered = pendingOperator[didHash];
        if (offered == address(0)) revert NoTransferOffered(didHash);
        if (msg.sender != id.operator && msg.sender != offered) {
            revert NotOperator(didHash, msg.sender);
        }

        delete pendingOperator[didHash];
        emit OperatorTransferCancelled(didHash, msg.sender);
    }

    /**
     * @notice Accept an offered agent and become its operator.
     * @dev    The bond stays with the agent, not the operator, so the incoming operator
     *         inherits it along with everything it is answerable for. The agent must be
     *         bonded at handover, or what changes hands is a hollow identity carrying a
     *         reputation and no collateral behind it.
     *
     *         A queued withdrawal is not blocked here and is claimable by the new
     *         operator afterwards, which favours them; a buyer should still look before
     *         accepting.
     */
    function acceptOperatorTransfer(bytes32 didHash) external {
        AgentIdentity storage id = _requireRegistered(didHash);
        address offered = pendingOperator[didHash];
        if (offered == address(0)) revert NoTransferOffered(didHash);
        if (msg.sender != offered) revert NotOfferedOperator(didHash, msg.sender);
        if (id.status == AgentStatus.Slashed) revert SlashedAgentImmutable(didHash);
        if (slashSuspended[didHash]) revert TransferWhileSlashPending(didHash);

        if (address(stakeView) == address(0)) revert StakeViewNotSet();
        if (!stakeView.hasMinimumStake(didHash)) revert InsufficientCollateral(didHash);

        address previous = id.operator;
        id.operator = msg.sender;
        delete pendingOperator[didHash];

        _removeFromOperatorIndex(previous, didHash);
        _pushToOperatorIndex(msg.sender, didHash);

        operatorChangedAt[didHash] = block.timestamp;
        operatorTransferCount[didHash] += 1;

        emit OperatorTransferred(didHash, previous, msg.sender);
    }

    /// @dev Appends and records the position, so removal never has to search for it.
    function _pushToOperatorIndex(address operator, bytes32 didHash) private {
        bytes32[] storage list = operatorAgents[operator];
        list.push(didHash);
        operatorAgentIndex[didHash] = list.length; // index + 1
    }

    /**
     * @dev Swap-and-pop in constant time, using the recorded position.
     *
     *      Previously a linear scan. The index is a convenience view rather than consensus
     *      state, but the scan sat on the transfer path, so an operator with a long enough
     *      list could no longer transfer any agent at all: the removal alone exceeded the
     *      block gas limit and there was no way back.
     *
     *      The fallback scan remains for agents registered before positions were recorded.
     *      It is the old cost for the old rows only, and it also covers the case where a
     *      recorded position no longer matches, which should not happen and is cheaper to
     *      absorb than to trust.
     */
    function _removeFromOperatorIndex(address operator, bytes32 didHash) private {
        bytes32[] storage list = operatorAgents[operator];
        uint256 n = list.length;
        if (n == 0) return;

        uint256 pos = operatorAgentIndex[didHash];
        if (pos == 0 || pos > n || list[pos - 1] != didHash) {
            pos = 0;
            for (uint256 i = 0; i < n; i++) {
                if (list[i] == didHash) {
                    pos = i + 1;
                    break;
                }
            }
            if (pos == 0) return; // not in this operator's list
        }

        uint256 target = pos - 1;
        bytes32 moved = list[n - 1];
        list[target] = moved;
        // Record the moved element's new home before popping. When the removed item WAS
        // the last one, moved == didHash and this write is undone by the delete below,
        // which is the correct end state.
        operatorAgentIndex[moved] = target + 1;
        list.pop();
        delete operatorAgentIndex[didHash];
    }

    /**
     * @notice Repoint the collateral oracle.
     * @dev    initializeV2 can only ever run once, so without this a redeployed staking
     *         contract would leave identity checking bonds against a dead one forever.
     *         Zero is refused: an unset stake view fails every activation closed, which
     *         is safe, but silently disabling the collateral gate is not something an
     *         admin should be able to do by passing an empty argument.
     */
    function setStakeView(address stakeView_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (stakeView_ == address(0)) revert StakeViewNotSet();
        stakeView = IStakeView(stakeView_);
        emit StakeViewSet(stakeView_);
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

    /**
     * @notice Every agent an operator controls.
     * @dev    Unbounded: the list has no cap, so an operator with enough agents makes this
     *         exceed the gas an on-chain caller can spend. Fine off-chain, where eth_call
     *         has no such limit, and kept unchanged because consumers already use it. A
     *         contract reading this should page through it instead.
     */
    function getOperatorAgents(address operator) external view returns (bytes32[] memory) {
        return operatorAgents[operator];
    }

    /// @notice How many agents an operator controls. Read this before paging.
    function operatorAgentCount(address operator) external view returns (uint256) {
        return operatorAgents[operator].length;
    }

    /**
     * @notice A slice of an operator's agents, for callers that cannot afford the whole list.
     * @dev    Returns fewer than `limit` entries at the end of the list, and an empty array
     *         when `offset` is past it, rather than reverting: paging to the end is ordinary
     *         use, not an error.
     *
     *         The order is not stable. Removal is swap-and-pop, so an entry can move while a
     *         caller pages. Read `operatorAgentCount` first and treat a page as a snapshot.
     */
    function getOperatorAgentsPaged(address operator, uint256 offset, uint256 limit)
        external
        view
        returns (bytes32[] memory page)
    {
        bytes32[] storage list = operatorAgents[operator];
        uint256 n = list.length;
        if (offset >= n) return new bytes32[](0);

        uint256 end = offset + limit;
        if (end > n) end = n;

        page = new bytes32[](end - offset);
        for (uint256 i = offset; i < end; i++) {
            page[i - offset] = list[i];
        }
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
