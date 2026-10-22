// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "./SigvaraIdentity.sol";
import "./interfaces/IOperatorSet.sol";

/**
 * @title SigvaraEpochFees
 * @notice On-chain fee registry that gates inclusion in the oracle's reputation
 *         scoring epoch (tokenomics v0.3 §4 "Oracle Epoch Prioritization" + §6
 *         three-stage fee routing).
 *
 *         Operators or querying applications prepay stake-token toward an agent's epoch
 *         coverage. Each epoch, the oracle charges one `epochFee` per agent it
 *         scores. Agents without coverage fall out of the active scoring run
 *         (best-effort); the free `meetsThreshold()` read on SigvaraReputation
 *         is unaffected — the fee gates the *write*, not the read.
 *
 *         Charged fees accumulate in `collected` and are swept by distributeFees()
 *         per the current governance stage:
 *           Bootstrap  -> 100% reward pool,  0% burn
 *           Transition ->  80% reward pool, 20% burn
 *           Mature     ->  50% reward pool, 50% burn
 *
 *         `epochFee` is USD-targeted and governance-tunable (§5); setting it to 0
 *         disables gating entirely (useful on testnet), so chargeEpoch is a no-op
 *         that always reports "covered."
 *
 *         One charge per agent per epoch. The contract defines an epoch as a period of
 *         `epochLength` seconds, numbered by block.timestamp / epochLength, and refuses a
 *         second charge for the same agent inside one. chargeEpoch used to have no memory
 *         at all, so a restart that re-ran an epoch charged every agent twice, and a stolen
 *         oracle key could empty every prepaid balance in a loop. Now the most it can take
 *         is what the agent would have paid anyway. A caller that is told an agent was
 *         already charged this epoch should treat it as paid and carry on.
 *
 *         With an operator set configured, the caller must also be an active operator in it,
 *         or the signer of one, as SigvaraReputation requires to propose. Removing an
 *         operator then ends its right to charge in the same transaction that ends its right
 *         to propose, so the second contract's role is not the one to forget.
 */
contract SigvaraEpochFees is
    Initializable,
    AccessControlUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuard
{
    using SafeERC20 for IERC20;

    // -------------------------------------------------------------------------
    // Roles
    // -------------------------------------------------------------------------

    /// Granted to the oracle wallet(s) authorized to charge epochs.
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    enum Stage { Bootstrap, Transition, Mature }

    // -------------------------------------------------------------------------
    // Storage — append-only. New variables must be declared AFTER all existing
    // ones so a UUPS upgrade never shifts the base slot of the `balance` mapping
    // (see the storage-layout test).
    // -------------------------------------------------------------------------

    IERC20 public svr;                          // slot 0
    SigvaraIdentity public identityRegistry;  // slot 1
    address public rewardPool;                   // slot 2 — validator/oracle reward destination
    uint256 public epochFee;                     // slot 3 — stake-token charged per epoch inclusion
    Stage public stage;                          // slot 4
    uint256 public collected;                    // slot 5 — charged fees awaiting distribution
    mapping(bytes32 => uint256) public balance;  // slot 6 — didHash => prepaid stake-token

    /// The bonded operator registry, or address(0) for the role alone. Same meaning as
    /// SigvaraReputation.operatorBond, and meant to be the same registry.
    IOperatorSet public operatorBond;            // slot 7

    /// Seconds in one epoch. Zero until set, and chargeEpoch refuses to charge while it is:
    /// a fee registry that charges with no per-epoch limit is the behaviour this replaces.
    uint256 public epochLength;                  // slot 8

    /// When each agent was last charged, in block.timestamp. Zero means never.
    mapping(bytes32 => uint256) public lastChargedAt; // slot 9

    /// The shortest epoch the setters accept. A typo of seconds for hours would otherwise
    /// make the limit meaningless while looking configured.
    uint256 public constant MIN_EPOCH_LENGTH = 1 hours;

    address internal constant BURN_ADDRESS = address(0xdead);

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event FeesDeposited(bytes32 indexed didHash, address indexed from, uint256 amount, uint256 newBalance);
    event FeesWithdrawn(bytes32 indexed didHash, address indexed operator, uint256 amount);
    event EpochCharged(bytes32 indexed didHash, uint256 amount, uint256 remaining);
    event FeesDistributed(uint256 toRewardPool, uint256 burned, Stage stage);
    event EpochFeeUpdated(uint256 newFee);
    event StageUpdated(Stage newStage);
    event RewardPoolUpdated(address newRewardPool);
    event OperatorBondSet(address indexed operatorBond);
    event EpochLengthUpdated(uint256 newLength);

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error ZeroAddress();
    error ZeroAmount();
    error NotOperator(bytes32 didHash, address caller);
    error InsufficientBalance(bytes32 didHash, uint256 requested, uint256 available);
    error NothingToDistribute();
    error AgentNotRegistered(bytes32 didHash);
    error OracleNotBonded(address oracle);
    /// chargeEpoch was called with a fee set and no epoch length. Set one with initializeV2
    /// or setEpochLength.
    error EpochLengthNotSet();
    error EpochLengthBelowFloor(uint256 value, uint256 floor);
    /// The agent was already charged in this epoch. Carries the epoch so the caller can say
    /// which. Not a failure to pay: the agent is covered for it.
    error AlreadyCharged(bytes32 didHash, uint256 epoch);

    // -------------------------------------------------------------------------
    // Constructor / Initializer
    // -------------------------------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @param admin             DEFAULT_ADMIN_ROLE + UPGRADER_ROLE (governance timelock on mainnet).
     * @param oracle            Initial ORACLE_ROLE holder. Pass address(0) to grant later.
     * @param svrToken         stake-token ERC20.
     * @param identityRegistry_ SigvaraIdentity proxy (for operator checks on withdraw).
     * @param rewardPool_       Destination for the validator/oracle share of fees.
     * @param epochFee_         Initial stake-token charged per epoch inclusion (0 = gating disabled).
     */
    function initialize(
        address admin,
        address oracle,
        address svrToken,
        address identityRegistry_,
        address rewardPool_,
        uint256 epochFee_
    ) external initializer {
        if (
            admin == address(0) || svrToken == address(0)
                || identityRegistry_ == address(0) || rewardPool_ == address(0)
        ) revert ZeroAddress();

        __AccessControl_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);
        // Upgrading is administered by upgraders, not by DEFAULT_ADMIN_ROLE. Otherwise the admin
        // Safe could grant itself the role and upgrade in the next transaction, which makes the
        // timelock that holds UPGRADER_ROLE a delay on the honest path and nothing on a
        // compromised admin.
        _setRoleAdmin(UPGRADER_ROLE, UPGRADER_ROLE);
        if (oracle != address(0)) _grantRole(ORACLE_ROLE, oracle);

        svr = IERC20(svrToken);
        identityRegistry = SigvaraIdentity(identityRegistry_);
        rewardPool = rewardPool_;
        epochFee = epochFee_;
        stage = Stage.Bootstrap;
    }

    /**
     * @notice Sets the epoch length and the operator registry. Run it straight after
     *         initialize(), or through upgradeToAndCall on a proxy that predates both.
     * @dev    Separate from initialize() so its signature, which every deploy script and
     *         test calls, does not change. Admin-gated because on a fresh deployment version
     *         2 is still unconsumed after initialize(), and a stranger must not be able to
     *         take it. Until it runs chargeEpoch refuses to charge, deliberately: the
     *         alternative is a fee registry with no per-epoch limit that looks configured.
     *         That costs nothing while epochFee is 0, which is the state every deployment
     *         starts in.
     *
     * @param epochLength_  Seconds in one epoch, at least MIN_EPOCH_LENGTH. Match it to the
     *                      oracle's cadence: the charge for a run is refused if the agent was
     *                      already charged in the same epoch, so an epoch longer than the
     *                      cadence skips charges and one much shorter weakens the limit.
     * @param operatorBond_ SigvaraOracleBond, or address(0) to leave the role alone governing.
     */
    function initializeV2(uint256 epochLength_, address operatorBond_)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        reinitializer(2)
    {
        _setEpochLength(epochLength_);
        operatorBond = IOperatorSet(operatorBond_);
        emit OperatorBondSet(operatorBond_);
    }

    // -------------------------------------------------------------------------
    // Funding
    // -------------------------------------------------------------------------

    /**
     * @notice Prepay epoch fees toward an agent's coverage.
     * @dev    Permissionless funder — operators or querying applications may top up
     *         any agent (§4). Caller must approve this contract for `amount` first.
     */
    function depositFor(bytes32 didHash, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        // Only fund identities that exist. withdraw() resolves the owner lazily from
        // the registry, and the didHash is publicly computable before registration,
        // so funding an unregistered hash hands the balance to whoever registers that
        // address next -- or strands it forever if nobody does.
        if (identityRegistry.getIdentity(didHash).registeredAt == 0) revert AgentNotRegistered(didHash);
        // Credit what arrived, as SigvaraStaking.depositStake does. A fee-on-transfer
        // token delivers less than `amount`, and crediting `amount` would let prepaid
        // balances across all agents sum to more than the contract holds. The shortfall
        // surfaces at withdraw(), on whoever is last, and until then isCovered() reports
        // an agent as funded for epochs it cannot actually pay for.
        uint256 balanceBefore = svr.balanceOf(address(this));
        svr.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = svr.balanceOf(address(this)) - balanceBefore;

        balance[didHash] += received;
        emit FeesDeposited(didHash, msg.sender, received, balance[didHash]);
    }

    /**
     * @notice Withdraw unspent prepaid fees. Only the agent's operator may withdraw.
     * @dev    Anyone can fund, but only the operator can pull — a stranger's deposit
     *         cannot be siphoned back out by that stranger.
     */
    function withdraw(bytes32 didHash, uint256 amount) external nonReentrant {
        SigvaraIdentity.AgentIdentity memory id = identityRegistry.getIdentity(didHash);
        if (id.operator != msg.sender) revert NotOperator(didHash, msg.sender);
        if (amount == 0) revert ZeroAmount();

        uint256 bal = balance[didHash];
        if (amount > bal) revert InsufficientBalance(didHash, amount, bal);

        balance[didHash] = bal - amount;
        svr.safeTransfer(msg.sender, amount);
        emit FeesWithdrawn(didHash, msg.sender, amount);
    }

    // -------------------------------------------------------------------------
    // Oracle charging
    // -------------------------------------------------------------------------

    /// @notice True if the agent has enough prepaid balance to cover one epoch.
    function isCovered(bytes32 didHash) public view returns (bool) {
        return epochFee == 0 || balance[didHash] >= epochFee;
    }

    /**
     * @notice Charge one epochFee for including the agent in the scoring run.
     * @dev    Oracle-only. Reverts InsufficientBalance when the agent is uncovered;
     *         see the comment in the body for why it no longer returns false. When
     *         epochFee == 0 gating is disabled: always returns true, charges nothing.
     *
     *         At most once per agent per epoch: a second call inside the same epoch reverts
     *         AlreadyCharged. The agent is covered for that epoch, so a caller treats that
     *         as paid. With an operator set configured the caller must be an active operator
     *         in it, or its signer.
     * @return charged Always true; an uncovered agent reverts instead.
     */
    function chargeEpoch(bytes32 didHash) external onlyRole(ORACLE_ROLE) returns (bool charged) {
        uint256 fee = epochFee;
        if (fee == 0) return true;

        _requireBondedOracle();

        uint256 length = epochLength;
        if (length == 0) revert EpochLengthNotSet();
        uint256 epoch = block.timestamp / length;
        uint256 last = lastChargedAt[didHash];
        // `last != 0` because zero means never charged, which would otherwise read as
        // epoch 0 and refuse a first charge in an epoch that small.
        if (last != 0 && last / length >= epoch) revert AlreadyCharged(didHash, epoch);

        uint256 bal = balance[didHash];
        // Revert rather than reporting failure in a return value. The only caller is
        // the oracle, and a bool it forgets to inspect turns a missed payment into a
        // free scoring run with no error anywhere. A revert cannot be ignored.
        if (bal < fee) revert InsufficientBalance(didHash, fee, bal);

        balance[didHash] = bal - fee;
        lastChargedAt[didHash] = block.timestamp;
        collected += fee;
        emit EpochCharged(didHash, fee, balance[didHash]);
        return true;
    }

    /// @dev The same check SigvaraReputation makes before it accepts a proposal, against the
    ///      same registry. Optional for the same reason: unset means the role alone governs.
    function _requireBondedOracle() internal view {
        IOperatorSet set = operatorBond;
        if (address(set) == address(0)) return;
        if (!set.isActiveOperator(msg.sender)) revert OracleNotBonded(msg.sender);
    }

    // -------------------------------------------------------------------------
    // Distribution
    // -------------------------------------------------------------------------

    /**
     * @notice Sweep collected fees: the reward-pool share to `rewardPool`, the
     *         burn share to 0xdead, split per the current stage. Permissionless —
     *         destinations are fixed, so no liveness dependence on any one party.
     */
    function distributeFees() external nonReentrant {
        uint256 amount = collected;
        if (amount == 0) revert NothingToDistribute();
        collected = 0;

        uint256 burnAmt = (amount * _burnBps(stage)) / 10_000;
        uint256 poolAmt = amount - burnAmt;

        if (poolAmt > 0) svr.safeTransfer(rewardPool, poolAmt);
        if (burnAmt > 0) svr.safeTransfer(BURN_ADDRESS, burnAmt);

        emit FeesDistributed(poolAmt, burnAmt, stage);
    }

    /// @dev Burn share in basis points for each governance stage (§6).
    function _burnBps(Stage s) internal pure returns (uint256) {
        if (s == Stage.Transition) return 2_000; // 20%
        if (s == Stage.Mature) return 5_000;      // 50%
        return 0;                                 // Bootstrap
    }

    // -------------------------------------------------------------------------
    // Admin (governance timelock on mainnet)
    // -------------------------------------------------------------------------

    function setEpochFee(uint256 newFee) external onlyRole(DEFAULT_ADMIN_ROLE) {
        epochFee = newFee;
        emit EpochFeeUpdated(newFee);
    }

    function setStage(Stage newStage) external onlyRole(DEFAULT_ADMIN_ROLE) {
        stage = newStage;
        emit StageUpdated(newStage);
    }

    function setRewardPool(address newRewardPool) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newRewardPool == address(0)) revert ZeroAddress();
        rewardPool = newRewardPool;
        emit RewardPoolUpdated(newRewardPool);
    }

    /// @notice Change the epoch length. Takes effect for the next charge: an agent already
    ///         charged is judged against the new length, which can make "this epoch" larger
    ///         or smaller than it was when the charge was made. Zero is refused; a registry
    ///         with no epoch length is the unset state, and is reached only by never setting it.
    function setEpochLength(uint256 newLength) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setEpochLength(newLength);
    }

    /// @notice Point at the bonded operator registry, or pass address(0) to leave the role
    ///         alone governing. Turning it on stops every oracle that has not bonded and been
    ///         admitted, so set it after the operators are in the registry.
    function setOperatorBond(address operatorBond_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        operatorBond = IOperatorSet(operatorBond_);
        emit OperatorBondSet(operatorBond_);
    }

    function _setEpochLength(uint256 newLength) internal {
        if (newLength < MIN_EPOCH_LENGTH) revert EpochLengthBelowFloor(newLength, MIN_EPOCH_LENGTH);
        epochLength = newLength;
        emit EpochLengthUpdated(newLength);
    }

    // -------------------------------------------------------------------------
    // UUPS upgrade authorization
    // -------------------------------------------------------------------------

    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}
}
