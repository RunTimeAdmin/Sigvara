// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "./SigvaraReputation.sol";
import "./SigvaraOracleBond.sol";

/**
 * @title SigvaraRewardDistributor
 * @notice Pays oracle operators for the scores they put on chain, from whatever this
 *         contract holds. SigvaraEpochFees.distributeFees() sends the non-burned fee share
 *         to `rewardPool`, which used to be a plain address whose onward spend was manual.
 *         Pointed at this contract, that share, and any treasury SVR sent here for operator
 *         incentives (docs/token.md), is split by a rule no one applies by hand.
 *
 *         The unit of work is a score that went live. Finalizing is permissionless, and
 *         `finalize` below finalizes through SigvaraReputation and credits one point to the
 *         operator behind the proposal: the bond owner in SigvaraOracleBond, not the signer
 *         key that sent it, so a stolen hot key cannot redirect what its operator earned. A
 *         proposal the committee rejected never finalizes and earns nothing. A score
 *         finalized directly on SigvaraReputation earns no point either, which is why the
 *         oracle finalizes through this contract.
 *
 *         Time is cut into periods of `periodLength` seconds from deployment. Once a period
 *         has ended anyone may close it, oldest first, which allots it every token here not
 *         already allotted to an earlier period. A period in which no point was earned is
 *         allotted nothing, and the tokens wait for the next one that has points. An
 *         operator claims `allotted * its points / all points` of a closed period while it
 *         is an active operator in SigvaraOracleBond. What is not claimed within
 *         `claimPeriods` periods of the close, including rounding, can be released back to
 *         the pool for a later period.
 *
 *         There is no owner, no admin, no pause and no upgrade. The rules are the
 *         constructor's. To change them, governance deploys another distributor and repoints
 *         the fee registry (SigvaraEpochFees.setRewardPool); claims on this one stay open.
 */
contract SigvaraRewardDistributor is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// The shortest period the constructor accepts. A period of minutes would make closing
    /// and claiming the bulk of what operators spend gas on.
    uint256 public constant MIN_PERIOD_LENGTH = 1 days;

    IERC20 public immutable token;
    SigvaraReputation public immutable reputation;
    SigvaraOracleBond public immutable operatorBond;
    uint256 public immutable start;
    uint256 public immutable periodLength;
    uint256 public immutable claimPeriods;

    /// Points earned in each period, in total and by operator.
    mapping(uint256 => uint256) public totalPoints;
    mapping(uint256 => mapping(address => uint256)) public pointsOf;

    /// What each closed period was allotted, when it was closed, and how much of it has left.
    mapping(uint256 => uint256) public allotted;
    mapping(uint256 => uint256) public closedAt;
    mapping(uint256 => uint256) public paid;
    mapping(uint256 => mapping(address => bool)) public claimed;
    mapping(uint256 => bool) public released;

    /// The oldest period not yet closed.
    uint256 public nextToClose;
    /// Tokens allotted to closed periods and neither claimed nor released.
    uint256 public reserved;

    event Served(uint256 indexed period, address indexed operator, bytes32 indexed didHash);
    event PeriodClosed(uint256 indexed period, uint256 amount, uint256 points);
    event Claimed(uint256 indexed period, address indexed operator, uint256 amount);
    event Released(uint256 indexed period, uint256 amount);

    error ZeroAddress();
    error PeriodTooShort(uint256 periodLength, uint256 minimum);
    error ZeroClaimPeriods();
    error NothingToClose(uint256 period);
    error PeriodNotClosed(uint256 period);
    error AlreadyClaimed(uint256 period, address operator);
    error NothingToClaim(uint256 period, address operator);
    error NotActiveOperator(address operator);
    error AlreadyReleased(uint256 period);
    error ClaimWindowOpen(uint256 period, uint256 until);

    constructor(
        address token_,
        address reputation_,
        address operatorBond_,
        uint256 periodLength_,
        uint256 claimPeriods_
    ) {
        if (token_ == address(0) || reputation_ == address(0) || operatorBond_ == address(0)) {
            revert ZeroAddress();
        }
        if (periodLength_ < MIN_PERIOD_LENGTH) revert PeriodTooShort(periodLength_, MIN_PERIOD_LENGTH);
        if (claimPeriods_ == 0) revert ZeroClaimPeriods();
        token = IERC20(token_);
        reputation = SigvaraReputation(reputation_);
        operatorBond = SigvaraOracleBond(operatorBond_);
        start = block.timestamp;
        periodLength = periodLength_;
        claimPeriods = claimPeriods_;
    }

    function currentPeriod() public view returns (uint256) {
        return (block.timestamp - start) / periodLength;
    }

    // -------------------------------------------------------------------------
    // Earning
    // -------------------------------------------------------------------------

    /**
     * @notice Finalize `didHash`'s pending score and credit a point to the operator that
     *         proposed it. Reverts exactly when SigvaraReputation.finalizeReputation does,
     *         with its error, so a caller handles it the same way.
     */
    function finalize(bytes32 didHash) external nonReentrant {
        address proposer = reputation.getPendingScore(didHash).proposer;
        reputation.finalizeReputation(didHash);

        // A proposal made before SigvaraReputation recorded proposers names nobody.
        if (proposer == address(0)) return;
        address named = operatorBond.operatorOfSigner(proposer);
        address operator = named == address(0) ? proposer : named;

        uint256 period = currentPeriod();
        pointsOf[period][operator] += 1;
        totalPoints[period] += 1;
        emit Served(period, operator, didHash);
    }

    // -------------------------------------------------------------------------
    // Closing and claiming
    // -------------------------------------------------------------------------

    /**
     * @notice Close the oldest period that has ended. Permissionless; call it again for each
     *         further period that has ended.
     */
    function close() external {
        uint256 period = nextToClose;
        if (period >= currentPeriod()) revert NothingToClose(period);

        uint256 points = totalPoints[period];
        uint256 amount = points == 0 ? 0 : token.balanceOf(address(this)) - reserved;
        nextToClose = period + 1;
        allotted[period] = amount;
        closedAt[period] = block.timestamp;
        reserved += amount;
        emit PeriodClosed(period, amount, points);
    }

    /// @notice What `operator` may claim from `period` now, before the active-operator check.
    function claimable(uint256 period, address operator) public view returns (uint256) {
        if (period >= nextToClose || released[period] || claimed[period][operator]) return 0;
        uint256 points = totalPoints[period];
        if (points == 0) return 0;
        return (allotted[period] * pointsOf[period][operator]) / points;
    }

    /**
     * @notice Claim the caller's share of a closed period. The caller must be the operator,
     *         the bond owner, and an active operator at the time of the claim: one removed,
     *         exiting, or slashed below the bond has its share returned to the pool when the
     *         claim window ends.
     */
    function claim(uint256 period) external nonReentrant {
        if (period >= nextToClose) revert PeriodNotClosed(period);
        if (released[period]) revert AlreadyReleased(period);
        if (claimed[period][msg.sender]) revert AlreadyClaimed(period, msg.sender);
        if (!operatorBond.isActiveOperator(msg.sender)) revert NotActiveOperator(msg.sender);
        uint256 amount = claimable(period, msg.sender);
        if (amount == 0) revert NothingToClaim(period, msg.sender);

        claimed[period][msg.sender] = true;
        paid[period] += amount;
        reserved -= amount;
        token.safeTransfer(msg.sender, amount);
        emit Claimed(period, msg.sender, amount);
    }

    /**
     * @notice Return what a closed period still holds to the pool once its claim window,
     *         `claimPeriods` periods from its close, has ended. Permissionless. After this the
     *         period can no longer be claimed.
     */
    function release(uint256 period) external {
        if (period >= nextToClose) revert PeriodNotClosed(period);
        if (released[period]) revert AlreadyReleased(period);
        uint256 until = closedAt[period] + claimPeriods * periodLength;
        if (block.timestamp < until) revert ClaimWindowOpen(period, until);

        released[period] = true;
        uint256 left = allotted[period] - paid[period];
        reserved -= left;
        emit Released(period, left);
    }
}
