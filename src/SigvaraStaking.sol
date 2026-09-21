// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "./SigvaraIdentity.sol";

/**
 * @notice The slice of SigvaraReputation this contract needs.
 * @dev    One function, no shared types, so the whole contract need not be imported to
 *         call it. That import pulled SigvaraReputation (and transitively SigvaraIdentity
 *         again) into this compile graph for a single `zeroReputation(bytes32)`.
 *
 *         SigvaraIdentity is deliberately NOT narrowed the same way. This contract reads
 *         `AgentIdentity` and compares `AgentStatus` in sixteen places, so an interface
 *         would have to redeclare both. A redeclared enum that drifted from the real one
 *         would not fail to compile; it would silently reinterpret the status of every
 *         live agent, which is the failure this codebase keeps appending storage to avoid.
 *         Sharing one definition is worth the import.
 */
interface IReputationZero {
    function zeroReputation(bytes32 didHash) external;
}

/**
 * @title SigvaraStaking
 * @notice Manages stake-token bonds for registered agents and enforces the slashing model.
 *
 * Slashing model (testnet: multisig committee):
 *   - A SLASHING_COMMITTEE member initiates a slash, supplying evidence and a victim address.
 *   - A CHALLENGE_PERIOD_SECONDS timelock begins. The agent operator may dispute.
 *   - If undisputed after the challenge period, anyone can call executeSlash.
 *   - On execution: 50% burned, 25% to victim, 25% to the initiating reporter.
 *   - The Identity registry marks the agent Slashed; Reputation zeroes out.
 *
 * Mainnet path: replace SLASHING_COMMITTEE_ROLE with UMA OptimisticOracleV3 or Kleros.
 * The slash initiation/dispute interface is isolated to allow this without touching storage.
 */
contract SigvaraStaking is
    Initializable,
    AccessControlUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuard
{
    using SafeERC20 for IERC20;

    // -------------------------------------------------------------------------
    // Roles
    // -------------------------------------------------------------------------

    /// @dev A single EOA on Arc testnet today, not a multisig: verified on chain, and the
    ///      readiness review lists it as a mainnet blocker. The 3-of-5 multisig, and then
    ///      on-chain arbitration (UMA or Kleros), are the path rather than the present
    ///      state. Saying otherwise here made the weakest link read as the strongest.
    bytes32 public constant SLASHING_COMMITTEE_ROLE = keccak256("SLASHING_COMMITTEE_ROLE");

    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    /// @dev Disputed is appended, never inserted: these values are persisted in
    ///      `slashProposals` on a live proxy and renumbering them would reinterpret
    ///      every stored proposal after a UUPS upgrade.
    enum SlashState { None, Pending, Executed, Cancelled, Disputed }

    struct Stake {
        uint256 amount;
        uint256 lockedAt;        // timestamp of the last deposit; recorded for off-chain
                                 // reporting. Retained (not removed) because this struct
                                 // backs the deployed `stakes` mapping — dropping a field
                                 // would shift the slots of unbondingAmount/unbondingAt and
                                 // corrupt every live stake after a UUPS upgrade.
        uint256 unbondingAmount; // queued for withdrawal, still slashable until claimed
        uint256 unbondingAt;     // when unbonding was initiated
    }

    struct SlashProposal {
        bytes32 didHash;
        address reporter;   // initiating committee member
        address victim;     // receives 25% of slashed stake
        uint256 initiatedAt;
        SlashState state;
        bytes evidenceHash; // keccak256 of off-chain evidence blob (stored for auditability)
        // Appended for the dispute-freeze change. New fields go at the end of the
        // struct for the same reason new storage goes at the end of the contract.
        uint256 challengeDeadline; // snapshot at initiation, so later admin changes
                                   // to challengePeriod cannot move an in-flight window
        uint256 disputedAt;        // when the operator disputed; 0 if never disputed
    }

    // -------------------------------------------------------------------------
    // Storage
    // -------------------------------------------------------------------------

    /// @dev Assumed to move exactly `amount` on transfer: no fee on transfer, no rebasing.
    ///      depositStake credits the requested amount rather than the observed balance
    ///      delta, so a token that deducts on transfer would over-credit every deposit and
    ///      leave the last withdrawer unable to claim. SVR is a plain fixed-supply ERC-20,
    ///      but this contract accepts any IERC20 at deploy and the README says as much, so
    ///      the requirement belongs where the assumption is made rather than in prose.
    /**
     * @notice The bond token. Set once at initialize and treated as a plain ERC20.
     * @dev    Deposits credit the measured balance delta, so a fee-on-transfer token
     *         is accounted correctly rather than over-credited. Two caveats remain for
     *         anyone deploying with an unusual token:
     *
     *         - **Rebasing tokens are not supported.** Stake is stored as a fixed
     *           amount, so a balance that changes on its own desynchronises from the
     *           accounting in either direction and this contract cannot detect it.
     *         - **Outbound transfers send the recorded amount.** With a fee-on-transfer
     *           token a withdrawal or slash payout arrives smaller than the number in
     *           the event. That shortfall lands on the recipient and does not affect
     *           this contract's solvency, which is why it is documented rather than
     *           compensated: paying out more than was debited would.
     */
    IERC20 public svrToken;
    SigvaraIdentity public identityRegistry;
    IReputationZero public reputationRegistry;

    uint256 public minimumStake;
    uint256 public challengePeriod; // seconds

    mapping(bytes32 => Stake) public stakes;           // didHash => stake
    mapping(bytes32 => SlashProposal) public slashProposals; // didHash => active proposal

    // Appended for the unbonding upgrade. New storage variables must always be
    // declared AFTER all existing ones: inserting above the mappings shifts their
    // base slots, and every live stake/proposal on the already-deployed proxy
    // would become unreachable after a UUPS upgrade.
    // Seconds a withdrawal sits queued (and still slashable) before it can be claimed.
    uint256 public unbondingPeriod;

    /// @notice Slash proceeds owed to victims and reporters, withdrawn by them.
    /// @dev    Pull rather than push. Paying out inline meant the one function that
    ///         resolves a proposal was also the only function that could unlock the
    ///         stake, so a recipient that cannot receive the token (a blocklisting
    ///         token, or a contract that reverts) froze the entire bond permanently.
    mapping(address => uint256) public claimable;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event StakeDeposited(bytes32 indexed didHash, address indexed operator, uint256 amount);
    event WithdrawalInitiated(bytes32 indexed didHash, address indexed operator, uint256 amount, uint256 claimableAt);
    event WithdrawalClaimed(bytes32 indexed didHash, address indexed operator, uint256 amount);
    event SlashInitiated(bytes32 indexed didHash, address indexed reporter, address indexed victim, uint256 initiatedAt);
    event SlashDisputed(bytes32 indexed didHash, address indexed operator);
    event SlashExecuted(bytes32 indexed didHash, uint256 burned, uint256 toVictim, uint256 toReporter);
    event SlashCancelled(bytes32 indexed didHash, address indexed by);
    event SlashProceedsClaimed(address indexed account, uint256 amount);
    event MinimumStakeUpdated(uint256 newMinimum);
    event ChallengePeriodUpdated(uint256 newPeriod);
    event UnbondingPeriodUpdated(uint256 newPeriod);

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error InsufficientStake(bytes32 didHash, uint256 provided, uint256 required);
    error NoStake(bytes32 didHash);
    error AgentNotActive(bytes32 didHash);
    error SlashAlreadyPending(bytes32 didHash);
    error NoActivePendingSlash(bytes32 didHash);
    error ChallengePeriodActive(bytes32 didHash, uint256 unlocksAt);
    error ChallengePeriodExpired(bytes32 didHash, uint256 expiredAt);
    error NotOperator(bytes32 didHash, address caller);
    error ZeroAddress();
    error NoWithdrawalPending(bytes32 didHash);
    error WithdrawalAlreadyPending(bytes32 didHash);
    error UnbondingPeriodActive(bytes32 didHash, uint256 claimableAt);
    error VictimIsReporter(address victim);
    error PeriodTooShort(uint256 provided, uint256 minimum);
    error SlashNotDisputed(bytes32 didHash);
    error DisputeResolutionActive(bytes32 didHash, uint256 expiresAt);
    error NothingClaimable(address account);

    // -------------------------------------------------------------------------
    // Constructor / Initializer
    // -------------------------------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @param admin              DEFAULT_ADMIN_ROLE + UPGRADER_ROLE.
     * @param identityRegistry_  SigvaraIdentity proxy address.
     * @param reputationRegistry_ SigvaraReputation proxy address.
     * @param svrToken_         stake-token ERC20 token address.
     * @param minimumStake_      Minimum stake-token (in wei) required to register an agent.
     * @param challengePeriod_   Seconds the operator has to dispute a slash (e.g. 7 days = 604800).
     * @param unbondingPeriod_   Seconds a withdrawal sits queued (and still slashable) before it can be claimed.
     */
    function initialize(
        address admin,
        address identityRegistry_,
        address reputationRegistry_,
        address svrToken_,
        uint256 minimumStake_,
        uint256 challengePeriod_,
        uint256 unbondingPeriod_
    ) external initializer {
        if (admin == address(0) || svrToken_ == address(0)) revert ZeroAddress();
        if (identityRegistry_ == address(0) || reputationRegistry_ == address(0)) revert ZeroAddress();

        __AccessControl_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);

        identityRegistry = SigvaraIdentity(identityRegistry_);
        reputationRegistry = IReputationZero(reputationRegistry_);
        svrToken = IERC20(svrToken_);
        minimumStake = minimumStake_;
        challengePeriod = challengePeriod_;
        unbondingPeriod = unbondingPeriod_;
    }

    /**
     * @notice Upgrade initializer for proxies deployed before the unbonding feature.
     * @dev    The live proxy already consumed initializer version 1, so the new
     *         initialize() can never run there — without this, unbondingPeriod would
     *         silently stay 0 after the upgrade and withdrawals would be instantly
     *         claimable. Call via upgradeToAndCall so upgrade + config are atomic.
     *         Admin-gated because on FRESH deployments version 2 is still unconsumed
     *         after initialize(), and this must not be callable by a stranger.
     */
    function initializeV2(uint256 unbondingPeriod_)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        reinitializer(2)
    {
        unbondingPeriod = unbondingPeriod_;
        emit UnbondingPeriodUpdated(unbondingPeriod_);
    }

    // -------------------------------------------------------------------------
    // Staking
    // -------------------------------------------------------------------------

    /**
     * @notice Deposit stake-token to back an agent identity.
     * @dev    Caller must have approved this contract for `amount` before calling.
     *         The agent must already be registered in SigvaraIdentity. Additional
     *         deposits accumulate on existing stakes.
     *
     *         Suspended agents may deposit. SigvaraIdentity refuses to move an agent
     *         back to Active while it is below minimumStake, so an operator that
     *         withdrew its bond down to nothing has to be able to top it back up.
     *         Requiring Active here would make that a one-way trip and strand the
     *         identity permanently. Slashed agents are terminal and still rejected.
     */
    function depositStake(bytes32 didHash, uint256 amount) external nonReentrant {
        SigvaraIdentity.AgentIdentity memory id = identityRegistry.getIdentity(didHash);
        if (id.registeredAt == 0 || id.status == SigvaraIdentity.AgentStatus.Slashed) {
            revert AgentNotActive(didHash);
        }
        if (id.operator != msg.sender) revert NotOperator(didHash, msg.sender);

        // Credit what arrived, not what was asked for.
        //
        // A fee-on-transfer token delivers less than `amount`, and crediting `amount`
        // would book stake this contract does not hold. Every deposit would widen the
        // gap between `stakes[].amount` and the real balance until the last operators
        // to withdraw found nothing there, and an agent could cross `minimumStake` on
        // tokens it never actually transferred, which is the bond behind a slashable
        // claim.
        //
        // `svrToken` is a plain `IERC20` set at initialize, so which token this is
        // depends on the deployment. The token used on Arc testnet and the one planned
        // for mainnet both transfer exactly, meaning this changes nothing for them.
        // That is the argument for measuring rather than documenting a constraint: a
        // requirement written in a README does not bind whoever deploys this next, and
        // the failure it prevents is silent and unrecoverable.
        //
        // Two extra `balanceOf` calls. Cheap against the alternative of the accounting
        // and the balance disagreeing.
        uint256 balanceBefore = svrToken.balanceOf(address(this));
        svrToken.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = svrToken.balanceOf(address(this)) - balanceBefore;

        stakes[didHash].amount += received;
        stakes[didHash].lockedAt = block.timestamp;

        // The bond is what activates a new agent. Only from PendingBond: an agent that
        // suspended itself to withdraw, or that the staking core suspended for a
        // pending slash, must not be dragged back to Active by topping up.
        if (id.status == SigvaraIdentity.AgentStatus.PendingBond
            && stakes[didHash].amount >= minimumStake) {
            identityRegistry.updateStatus(didHash, SigvaraIdentity.AgentStatus.Active);
        }

        // The credited amount, which is what the stake actually grew by. For an exact
        // token this is the amount requested.
        emit StakeDeposited(didHash, msg.sender, received);
    }

    /**
     * @notice Queue a withdrawal. Only permitted if agent is Active and no slash is pending.
     * @dev    Moves `amount` from the active stake into an unbonding queue for
     *         unbondingPeriod seconds. The queued amount is still subject to slashing
     *         during that window (see executeSlash) — queuing a withdrawal does not let
     *         an operator escape accountability for behavior discovered before it clears.
     *         Only one withdrawal may be queued at a time per agent; claim it before
     *         queuing another. Operators must keep the remaining active stake above
     *         minimumStake unless withdrawing to zero (which requires the agent to be
     *         Suspended first via SigvaraIdentity.updateStatus).
     */
    function initiateWithdrawal(bytes32 didHash, uint256 amount) external nonReentrant {
        Stake storage s = stakes[didHash];
        if (s.amount == 0) revert NoStake(didHash);
        if (s.unbondingAmount != 0) revert WithdrawalAlreadyPending(didHash);

        SigvaraIdentity.AgentIdentity memory id = identityRegistry.getIdentity(didHash);
        if (id.operator != msg.sender) revert NotOperator(didHash, msg.sender);

        // A Pending or Disputed proposal freezes the bond. Disputing must not
        // release it: that is what let an operator cancel every proposal for free
        // and walk away with the whole stake once unbonding elapsed.
        SlashState st = slashProposals[didHash].state;
        if (st == SlashState.Pending || st == SlashState.Disputed) {
            revert SlashAlreadyPending(didHash);
        }

        // Named, rather than letting the subtraction below panic. Asking to withdraw more
        // than you hold is an ordinary mistake, and a bare arithmetic panic tells the
        // caller nothing about which number was wrong.
        if (amount > s.amount) revert InsufficientStake(didHash, s.amount, amount);

        uint256 remaining = s.amount - amount;
        // While Active, the remaining active stake must stay at or above minimumStake —
        // withdrawing to zero (fully exiting) requires the operator to Suspend first (see
        // SigvaraIdentity.updateStatus). Previously a `remaining != 0` carve-out let an
        // active agent drain its entire backing stake in one step, which the total-balance
        // check in initiateSlash also now guards, but an active agent should never be
        // unbacked to begin with.
        bool active = id.registeredAt != 0 && id.status == SigvaraIdentity.AgentStatus.Active;
        if (active && remaining < minimumStake) {
            revert InsufficientStake(didHash, remaining, minimumStake);
        }

        s.amount = remaining;
        s.unbondingAmount = amount;
        s.unbondingAt = block.timestamp;

        emit WithdrawalInitiated(didHash, msg.sender, amount, block.timestamp + unbondingPeriod);
    }

    /**
     * @notice Claim a queued withdrawal once the unbonding period has elapsed.
     * @dev    Reverts if a slash was executed during the window — executeSlash sweeps
     *         and zeroes the unbonding queue along with the active stake, so there is
     *         nothing left to claim.
     */
    function claimWithdrawal(bytes32 didHash) external nonReentrant {
        Stake storage s = stakes[didHash];
        if (s.unbondingAmount == 0) revert NoWithdrawalPending(didHash);

        SigvaraIdentity.AgentIdentity memory id = identityRegistry.getIdentity(didHash);
        if (id.operator != msg.sender) revert NotOperator(didHash, msg.sender);

        // A queued withdrawal is still slashable. Without this check, safety would
        // depend on unbondingPeriod staying longer than challengePeriod (both are
        // admin-tunable): if it were ever shorter, an operator could claim mid-slash
        // and dodge the queued portion.
        // A Pending or Disputed proposal freezes the bond. Disputing must not
        // release it: that is what let an operator cancel every proposal for free
        // and walk away with the whole stake once unbonding elapsed.
        SlashState st = slashProposals[didHash].state;
        if (st == SlashState.Pending || st == SlashState.Disputed) {
            revert SlashAlreadyPending(didHash);
        }

        uint256 claimableAt = s.unbondingAt + unbondingPeriod;
        if (block.timestamp < claimableAt) revert UnbondingPeriodActive(didHash, claimableAt);

        uint256 amount = s.unbondingAmount;
        s.unbondingAmount = 0;
        s.unbondingAt = 0;

        svrToken.safeTransfer(msg.sender, amount);

        emit WithdrawalClaimed(didHash, msg.sender, amount);
    }

    // -------------------------------------------------------------------------
    // Slashing
    // -------------------------------------------------------------------------

    /**
     * @notice Committee member initiates a slash proposal.
     * @dev    Suspends the agent immediately to halt activity during the challenge window.
     *         Evidence hash is the keccak256 of the off-chain evidence package (stored
     *         for auditability; the package itself lives off-chain).
     */
    function initiateSlash(
        bytes32 didHash,
        address victim,
        bytes calldata evidenceHash
    ) external nonReentrant onlyRole(SLASHING_COMMITTEE_ROLE) {
        if (victim == address(0)) revert ZeroAddress();
        // The caller is recorded as the reporter and takes 25% of the bond. Letting
        // it also name itself as the victim turns one committee signature into a 50%
        // self-payment out of the accused party's stake.
        if (victim == msg.sender) revert VictimIsReporter(victim);
        // Slashable balance is the active stake PLUS anything queued for withdrawal.
        // Checking only the active stake let an operator drain everything into the
        // unbonding queue (which executeSlash still sweeps) and thereby block the slash
        // from ever being initiated — nullifying accountability. Gate on the total.
        if (stakes[didHash].amount + stakes[didHash].unbondingAmount == 0) revert NoStake(didHash);
        SlashState existing = slashProposals[didHash].state;
        if (existing == SlashState.Pending || existing == SlashState.Disputed) {
            revert SlashAlreadyPending(didHash);
        }

        // Write state before the external call (CEI pattern).
        slashProposals[didHash] = SlashProposal({
            didHash: didHash,
            reporter: msg.sender,
            victim: victim,
            initiatedAt: block.timestamp,
            state: SlashState.Pending,
            evidenceHash: evidenceHash,
            // Snapshot the window. Reading the live challengePeriod at execute time
            // let an admin shorten an in-flight dispute window to nothing.
            challengeDeadline: block.timestamp + challengePeriod,
            disputedAt: 0
        });

        // Suspend immediately to halt the agent during the dispute window.
        identityRegistry.updateStatus(didHash, SigvaraIdentity.AgentStatus.Suspended);

        emit SlashInitiated(didHash, msg.sender, victim, block.timestamp);
    }

    /**
     * @notice Operator disputes a pending slash, moving it to committee resolution.
     * @dev    A dispute FREEZES the stake; it does not cancel the proposal and does
     *         not reinstate the agent. Disputing used to set Cancelled, which released
     *         the bond: an operator could queue the whole stake, cancel every proposal
     *         the committee filed at no cost, and claim once unbonding elapsed.
     *         The committee then calls resolveDispute. If it never does, anyone may
     *         call expireDispute after DISPUTE_RESOLUTION_PERIOD so the freeze is
     *         bounded in the other direction too.
     */
    function disputeSlash(bytes32 didHash) external nonReentrant {
        SlashProposal storage proposal = slashProposals[didHash];
        if (proposal.state != SlashState.Pending) revert NoActivePendingSlash(didHash);

        uint256 deadline = proposal.challengeDeadline;
        if (block.timestamp > deadline) {
            revert ChallengePeriodExpired(didHash, deadline);
        }

        SigvaraIdentity.AgentIdentity memory id = identityRegistry.getIdentity(didHash);
        if (id.operator != msg.sender) revert NotOperator(didHash, msg.sender);

        proposal.state = SlashState.Disputed;
        proposal.disputedAt = block.timestamp;

        emit SlashDisputed(didHash, msg.sender);
    }

    /**
     * @notice Committee resolves a disputed slash: uphold it or drop it.
     * @param  uphold True to slash, false to cancel and reinstate the agent.
     */
    function resolveDispute(bytes32 didHash, bool uphold)
        external
        nonReentrant
        onlyRole(SLASHING_COMMITTEE_ROLE)
    {
        SlashProposal storage proposal = slashProposals[didHash];
        if (proposal.state != SlashState.Disputed) revert SlashNotDisputed(didHash);

        if (uphold) {
            _settleSlash(didHash, proposal);
        } else {
            _dropProposal(didHash, proposal);
        }
    }

    /**
     * @notice Release a dispute the committee never resolved.
     * @dev    Permissionless, so an operator is never dependent on committee liveness
     *         to get an unresolved freeze lifted. The committee may re-file with
     *         stronger evidence; it simply cannot sit on a frozen bond forever.
     */
    function expireDispute(bytes32 didHash) external nonReentrant {
        SlashProposal storage proposal = slashProposals[didHash];
        if (proposal.state != SlashState.Disputed) revert SlashNotDisputed(didHash);

        uint256 expiresAt = proposal.disputedAt + DISPUTE_RESOLUTION_PERIOD;
        if (block.timestamp <= expiresAt) revert DisputeResolutionActive(didHash, expiresAt);

        _dropProposal(didHash, proposal);
    }

    /**
     * @notice Committee withdraws a pending proposal before the window closes.
     * @dev    Without this, a proposal filed and then abandoned left the agent
     *         Suspended and its stake frozen permanently: after the window, dispute
     *         reverts and nothing else could clear the state.
     */
    function cancelSlash(bytes32 didHash) external nonReentrant onlyRole(SLASHING_COMMITTEE_ROLE) {
        SlashProposal storage proposal = slashProposals[didHash];
        if (proposal.state != SlashState.Pending) revert NoActivePendingSlash(didHash);
        _dropProposal(didHash, proposal);
    }

    /// @dev Cancel a proposal and return the agent to Active. Reinstating to Active
    ///      (rather than the pre-slash status) is deliberate: it is what clears the
    ///      staking-core suspension lock in SigvaraIdentity. An operator who wants to
    ///      stay suspended can self-suspend again.
    function _dropProposal(bytes32 didHash, SlashProposal storage proposal) internal {
        proposal.state = SlashState.Cancelled;
        // Only reinstate an agent that is still bonded. An operator can queue a
        // withdrawal while Suspended, so by the time a proposal is dropped the active
        // stake may sit below minimumStake, and reinstating would hand back Active
        // status with nothing slashable behind it. Leaving it Suspended keeps the
        // operator in control: deposit back over the minimum and reactivate.
        if (stakes[didHash].amount >= minimumStake) {
            identityRegistry.updateStatus(didHash, SigvaraIdentity.AgentStatus.Active);
        } else {
            identityRegistry.clearSlashSuspension(didHash);
        }
        emit SlashCancelled(didHash, msg.sender);
    }

    /**
     * @notice Execute a slash after the challenge period has elapsed without dispute.
     * @dev    Anyone may call this once the window has closed — execution is permissionless
     *         to avoid committee liveness dependence. The distribution is fixed at init:
     *         50% burned (sent to 0xdead), 25% to victim, 25% to reporter.
     */
    function executeSlash(bytes32 didHash) external nonReentrant {
        SlashProposal storage proposal = slashProposals[didHash];
        if (proposal.state != SlashState.Pending) revert NoActivePendingSlash(didHash);

        uint256 deadline = proposal.challengeDeadline;
        if (block.timestamp <= deadline) {
            revert ChallengePeriodActive(didHash, deadline);
        }

        _settleSlash(didHash, proposal);
    }

    /// @dev Shared settlement for an undisputed slash and for a dispute the committee
    ///      upheld. Proceeds are credited, not sent: a recipient that cannot receive
    ///      the token must not be able to make settlement revert, because this is the
    ///      only path that clears the proposal and unfreezes the bond.
    function _settleSlash(bytes32 didHash, SlashProposal storage proposal) internal {
        Stake storage s = stakes[didHash];
        // Sweep both the active stake and any queued withdrawal — an unbonding
        // request in flight must not let an operator dodge a slash discovered
        // before the withdrawal actually clears.
        uint256 totalSlashed = s.amount + s.unbondingAmount;
        s.amount = 0;
        s.unbondingAmount = 0;
        s.unbondingAt = 0;

        proposal.state = SlashState.Executed;

        // Distribution: 50% burn, 25% victim, 25% reporter.
        uint256 burned = totalSlashed / 2;
        uint256 toVictim = totalSlashed / 4;
        uint256 toReporter = totalSlashed - burned - toVictim; // absorbs any rounding dust

        claimable[proposal.victim] += toVictim;
        claimable[proposal.reporter] += toReporter;

        // Mark identity as permanently slashed and zero reputation.
        identityRegistry.updateStatus(didHash, SigvaraIdentity.AgentStatus.Slashed);
        reputationRegistry.zeroReputation(didHash);

        // The burn is the one transfer kept inline. 0xdead is an unowned address that
        // cannot refuse a standard transfer, and crediting it instead would leave the
        // tokens in this contract, which is not a burn.
        svrToken.safeTransfer(address(0xdead), burned);

        emit SlashExecuted(didHash, burned, toVictim, toReporter);
    }

    /**
     * @notice Withdraw slash proceeds credited to the caller.
     */
    function claimSlashProceeds() external nonReentrant returns (uint256 amount) {
        amount = claimable[msg.sender];
        if (amount == 0) revert NothingClaimable(msg.sender);
        claimable[msg.sender] = 0;
        svrToken.safeTransfer(msg.sender, amount);
        emit SlashProceedsClaimed(msg.sender, amount);
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    function setMinimumStake(uint256 newMinimum) external onlyRole(DEFAULT_ADMIN_ROLE) {
        minimumStake = newMinimum;
        emit MinimumStakeUpdated(newMinimum);
    }

    /// @notice Lower bound on the dispute window. Without it, an admin who also holds
    ///         the committee role can set the period to zero and execute a slash in
    ///         the same block, leaving the operator no chance to dispute.
    uint256 public constant MIN_CHALLENGE_PERIOD = 3 days;
    /// @notice Lower bound on unbonding, so queued withdrawals cannot be made
    ///         instantly claimable while a slash is being prepared.
    uint256 public constant MIN_UNBONDING_PERIOD = 1 days;

    /// @notice How long the committee has to resolve a dispute before anyone may
    ///         expire it. A dispute freezes the stake, so without this cap the
    ///         committee could freeze an operator's bond indefinitely by filing
    ///         once and never resolving.
    uint256 public constant DISPUTE_RESOLUTION_PERIOD = 14 days;

    function setChallengePeriod(uint256 newPeriod) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newPeriod < MIN_CHALLENGE_PERIOD) revert PeriodTooShort(newPeriod, MIN_CHALLENGE_PERIOD);
        challengePeriod = newPeriod;
        emit ChallengePeriodUpdated(newPeriod);
    }

    function setUnbondingPeriod(uint256 newPeriod) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newPeriod < MIN_UNBONDING_PERIOD) revert PeriodTooShort(newPeriod, MIN_UNBONDING_PERIOD);
        unbondingPeriod = newPeriod;
        emit UnbondingPeriodUpdated(newPeriod);
    }

    // -------------------------------------------------------------------------
    // View functions
    // -------------------------------------------------------------------------

    function getStake(bytes32 didHash) external view returns (uint256) {
        return stakes[didHash].amount;
    }

    function hasMinimumStake(bytes32 didHash) external view returns (bool) {
        return stakes[didHash].amount >= minimumStake;
    }

    function getPendingWithdrawal(bytes32 didHash) external view returns (uint256 amount, uint256 claimableAt) {
        Stake storage s = stakes[didHash];
        return (s.unbondingAmount, s.unbondingAmount == 0 ? 0 : s.unbondingAt + unbondingPeriod);
    }

    function getSlashProposal(bytes32 didHash) external view returns (SlashProposal memory) {
        return slashProposals[didHash];
    }

    // -------------------------------------------------------------------------
    // UUPS upgrade authorization
    // -------------------------------------------------------------------------

    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}
}
