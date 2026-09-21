// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title SigvaraOracleBond
 * @notice Performance-bond registry for the oracle operator set (tokenomics v0.3
 *         §8). This is a SEPARATE accounting + slashing path from SigvaraStaking
 *         (which bonds agents, not operators).
 *
 *         Lifecycle:
 *           depositBond()  — an applicant posts >= bondAmount stake-token  -> Bonded
 *           admit()        — governance admits a bonded applicant     -> Active
 *           initiateUnbond / removeOperator                            -> Exiting
 *           withdrawBond() — after the unbonding cooldown              -> None
 *
 *         Slashing (§8): a SLASHER (governance/committee) partially slashes an
 *         operator's bond for provably-incorrect reputation data or >24h downtime.
 *         Slashed stake-token goes to `slashBeneficiary`. If a slash drops an Active
 *         operator below bondAmount, it is demoted out of the active set. A bond in
 *         the unbonding cooldown is still slashable, so an operator cannot exit to
 *         dodge accountability for behavior discovered before withdrawal clears.
 *
 *         This contract tracks bonds and active status only. Granting the actual
 *         ORACLE_ROLE on SigvaraReputation / SigvaraEpochFees stays a
 *         governance action, gated off `isActiveOperator()`.
 */
contract SigvaraOracleBond is
    Initializable,
    AccessControlUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuard
{
    using SafeERC20 for IERC20;

    // -------------------------------------------------------------------------
    // Roles
    // -------------------------------------------------------------------------

    /// Slashes operator bonds. On mainnet: governance multisig / committee.
    bytes32 public constant SLASHER_ROLE = keccak256("SLASHER_ROLE");
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    enum Status { None, Bonded, Active, Exiting }

    struct Operator {
        uint256 bond;
        Status status;
        uint256 unbondingAt; // timestamp initiateUnbond/removeOperator was called
    }

    // -------------------------------------------------------------------------
    // Storage — append-only (see storage-layout test).
    // -------------------------------------------------------------------------

    IERC20 public svr;                 // slot 0
    uint256 public bondAmount;          // slot 1 — minimum bond to be admitted
    uint256 public unbondingPeriod;     // slot 2 — cooldown before withdrawal
    address public slashBeneficiary;    // slot 3 — destination for slashed bond
    uint256 public activeCount;         // slot 4 — number of Active operators
    mapping(address => Operator) public operators; // slot 5

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event BondDeposited(address indexed operator, uint256 amount, uint256 newBond);
    event OperatorAdmitted(address indexed operator);
    event OperatorSlashed(address indexed operator, uint256 amount, uint256 remaining, bool demoted);
    event UnbondInitiated(address indexed operator, uint256 claimableAt);
    event BondWithdrawn(address indexed operator, uint256 amount);
    event OperatorRemoved(address indexed operator);
    event BondAmountUpdated(uint256 newBondAmount);
    event UnbondingPeriodUpdated(uint256 newPeriod);
    event SlashBeneficiaryUpdated(address newBeneficiary);

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error ZeroAddress();
    error ZeroAmount();
    error WrongStatus(address operator, Status current);
    error InsufficientBond(address operator, uint256 have, uint256 required);
    error SlashExceedsBond(address operator, uint256 amount, uint256 bond);
    error UnbondingActive(address operator, uint256 claimableAt);
    error NoBond(address operator);

    // -------------------------------------------------------------------------
    // Constructor / Initializer
    // -------------------------------------------------------------------------

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address admin,
        address slasher,
        address svrToken,
        uint256 bondAmount_,
        uint256 unbondingPeriod_,
        address slashBeneficiary_
    ) external initializer {
        if (admin == address(0) || svrToken == address(0) || slashBeneficiary_ == address(0)) {
            revert ZeroAddress();
        }

        __AccessControl_init();

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(UPGRADER_ROLE, admin);
        if (slasher != address(0)) _grantRole(SLASHER_ROLE, slasher);

        svr = IERC20(svrToken);
        bondAmount = bondAmount_;
        unbondingPeriod = unbondingPeriod_;
        slashBeneficiary = slashBeneficiary_;
    }

    // -------------------------------------------------------------------------
    // Operator actions
    // -------------------------------------------------------------------------

    /**
     * @notice Post or top up a performance bond. A fresh applicant becomes Bonded
     *         (pending governance admission). Not allowed while Exiting — claim the
     *         withdrawal first. Caller must approve this contract for `amount`.
     */
    function depositBond(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Operator storage op = operators[msg.sender];
        if (op.status == Status.Exiting) revert WrongStatus(msg.sender, op.status);

        // Credit what arrived. See the same guard in SigvaraStaking.depositStake: a
        // fee-on-transfer token delivers less than `amount`, and crediting `amount`
        // books a bond this contract does not hold. Here that is worse than in staking,
        // because this bond is what an operator loses for misbehaving, and slash() can
        // take the whole of it. An over-credited bond is a deterrent that cannot be
        // collected: the accounting says the operator has it and the balance does not.
        //
        // `svr` is a plain IERC20 chosen at initialize, so which token this is depends
        // on the deployment. Neither deployed token takes a fee, which is exactly why
        // this was easy to miss twice.
        uint256 balanceBefore = svr.balanceOf(address(this));
        svr.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = svr.balanceOf(address(this)) - balanceBefore;

        op.bond += received;
        if (op.status == Status.None) op.status = Status.Bonded;

        emit BondDeposited(msg.sender, received, op.bond);
    }

    /**
     * @notice Signal exit from the operator set. Bonded/Active -> Exiting and starts
     *         the unbonding cooldown. The bond stays slashable during the cooldown.
     */
    function initiateUnbond() external nonReentrant {
        Operator storage op = operators[msg.sender];
        if (op.status != Status.Bonded && op.status != Status.Active) {
            revert WrongStatus(msg.sender, op.status);
        }
        if (op.status == Status.Active) activeCount -= 1;

        op.status = Status.Exiting;
        op.unbondingAt = block.timestamp;

        emit UnbondInitiated(msg.sender, block.timestamp + unbondingPeriod);
    }

    /// @notice Withdraw the remaining bond once the unbonding cooldown has elapsed.
    function withdrawBond() external nonReentrant {
        Operator storage op = operators[msg.sender];
        if (op.status != Status.Exiting) revert WrongStatus(msg.sender, op.status);

        uint256 claimableAt = op.unbondingAt + unbondingPeriod;
        if (block.timestamp < claimableAt) revert UnbondingActive(msg.sender, claimableAt);

        uint256 amount = op.bond;
        if (amount == 0) revert NoBond(msg.sender);

        op.bond = 0;
        op.status = Status.None;
        op.unbondingAt = 0;

        svr.safeTransfer(msg.sender, amount);
        emit BondWithdrawn(msg.sender, amount);
    }

    // -------------------------------------------------------------------------
    // Governance
    // -------------------------------------------------------------------------

    /// @notice Admit a bonded applicant into the active operator set (§8 "join via governance vote").
    function admit(address operator) external onlyRole(DEFAULT_ADMIN_ROLE) {
        Operator storage op = operators[operator];
        if (op.status != Status.Bonded) revert WrongStatus(operator, op.status);
        if (op.bond < bondAmount) revert InsufficientBond(operator, op.bond, bondAmount);

        op.status = Status.Active;
        activeCount += 1;
        emit OperatorAdmitted(operator);
    }

    /// @notice Force an operator out of the set into unbonding (e.g. after misbehavior).
    function removeOperator(address operator) external onlyRole(DEFAULT_ADMIN_ROLE) {
        Operator storage op = operators[operator];
        if (op.status != Status.Active && op.status != Status.Bonded) {
            revert WrongStatus(operator, op.status);
        }
        if (op.status == Status.Active) activeCount -= 1;

        op.status = Status.Exiting;
        op.unbondingAt = block.timestamp;
        emit OperatorRemoved(operator);
    }

    /**
     * @notice Partially slash an operator's bond (§8). Slashed stake-token goes to
     *         slashBeneficiary. An Active operator whose bond drops below bondAmount
     *         is demoted out of the active set (must top up + be re-admitted).
     */
    function slash(address operator, uint256 amount) external nonReentrant onlyRole(SLASHER_ROLE) {
        Operator storage op = operators[operator];
        if (op.bond == 0) revert NoBond(operator);
        if (amount == 0) revert ZeroAmount();
        if (amount > op.bond) revert SlashExceedsBond(operator, amount, op.bond);

        op.bond -= amount;

        bool demoted = false;
        if (op.status == Status.Active && op.bond < bondAmount) {
            op.status = Status.Bonded;
            activeCount -= 1;
            demoted = true;
        }

        // A bond slashed to exactly zero must clear the record. Leaving a
        // zero-bond operator in Bonded or Exiting bricks the address: depositBond,
        // admit and removeOperator all revert on status, and withdrawBond reverts
        // on NoBond, so nothing short of an upgrade could ever move it again.
        if (op.bond == 0) {
            op.status = Status.None;
            op.unbondingAt = 0;
        }

        svr.safeTransfer(slashBeneficiary, amount);
        emit OperatorSlashed(operator, amount, op.bond, demoted);
    }

    // -------------------------------------------------------------------------
    // Admin params
    // -------------------------------------------------------------------------

    /**
     * @notice Set the bond required of an operator.
     * @dev    Zero is refused. An operator set with no bond requirement admits anyone the
     *         admin admits and puts nothing at risk, which is indistinguishable from having
     *         no operator set at all — and that mode already exists, by leaving
     *         SigvaraReputation.operatorBond unset. Reaching it by passing an empty
     *         argument to a setter is how a guarantee disappears without anyone noticing.
     *         Same reasoning as SigvaraIdentity.setStakeView.
     *
     *         Raising this does not walk the operator set; status is only recomputed on
     *         deposit, slash and admission. isActiveOperator re-reads the bond instead, so
     *         a raise binds immediately on the check that actually gates proposing, without
     *         an unbounded loop here.
     */
    function setBondAmount(uint256 newBondAmount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newBondAmount == 0) revert ZeroAmount();
        bondAmount = newBondAmount;
        emit BondAmountUpdated(newBondAmount);
    }

    function setUnbondingPeriod(uint256 newPeriod) external onlyRole(DEFAULT_ADMIN_ROLE) {
        unbondingPeriod = newPeriod;
        emit UnbondingPeriodUpdated(newPeriod);
    }

    function setSlashBeneficiary(address newBeneficiary) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newBeneficiary == address(0)) revert ZeroAddress();
        slashBeneficiary = newBeneficiary;
        emit SlashBeneficiaryUpdated(newBeneficiary);
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    /**
     * @dev Status AND bond, deliberately. Reading status alone made admission permanent:
     *      `admit` tests the bond once, at admission, so an operator let in under a lower
     *      requirement kept proposing after the bar was raised, and governance had no way
     *      to tighten the rule for incumbents short of removing each one by hand. The bond
     *      is the thing being relied on, so the bond is what gets read.
     *
     *      Belt and braces with the demotion in `slash`, which keeps activeCount honest.
     *      This one keeps the answer honest even when nothing has called in to recompute.
     */
    function isActiveOperator(address operator) external view returns (bool) {
        Operator storage op = operators[operator];
        return op.status == Status.Active && op.bond >= bondAmount;
    }

    function bondOf(address operator) external view returns (uint256) {
        return operators[operator].bond;
    }

    // -------------------------------------------------------------------------
    // UUPS upgrade authorization
    // -------------------------------------------------------------------------

    function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}
}
