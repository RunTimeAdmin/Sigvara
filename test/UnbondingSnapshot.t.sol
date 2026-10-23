// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "./helpers/RegistrationHelper.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import "../src/SigvaraIdentity.sol";
import "../src/SigvaraReputation.sol";
import "../src/SigvaraStaking.sol";

contract USMock is ERC20 {
    constructor() ERC20("Sigvara", "SVR") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/**
 * Regression tests for fixing a withdrawal's claim time when it is queued.
 *
 * Before the change `claimWithdrawal` read `unbondingPeriod` at claim time, so an admin change
 * moved the exit of every withdrawal already waiting: lowering the period to its one day floor
 * made a withdrawal queued for 21 days claimable after one, and raising it locked exits that had
 * been promised a shorter wait. The challenge deadline of a slash and the review window of a score
 * are already fixed when they start. This holds the unbonding period to the same rule.
 */
contract UnbondingSnapshotTest is Test, RegistrationHelper {
    USMock svr;
    SigvaraIdentity identity;
    SigvaraReputation rep;
    SigvaraStaking staking;

    address admin     = makeAddr("admin");
    address committee = makeAddr("committee");
    address oracle    = makeAddr("oracle");
    address operator  = makeAddr("operator");
    address victim    = makeAddr("victim");

    uint256 agentPk;

    uint256 constant STAKE     = 10_000e18;
    uint256 constant MIN_STAKE = 1000e18;
    uint256 constant QUEUED    = STAKE - MIN_STAKE; // leaves an Active agent at its minimum
    uint256 constant CHALLENGE = 7 days;
    uint256 constant UNBONDING = 21 days;

    bytes32 didHash;

    function setUp() public {
        (, agentPk) = makeAddrAndKey("agent");
        svr = new USMock();
        identity = SigvaraIdentity(address(new ERC1967Proxy(
            address(new SigvaraIdentity()),
            abi.encodeCall(SigvaraIdentity.initialize, (admin, address(0)))
        )));
        rep = SigvaraReputation(address(new ERC1967Proxy(
            address(new SigvaraReputation()),
            abi.encodeCall(SigvaraReputation.initialize, (admin, oracle, address(0), committee, 6 hours))
        )));
        staking = SigvaraStaking(address(new ERC1967Proxy(
            address(new SigvaraStaking()),
            abi.encodeCall(SigvaraStaking.initialize, (
                admin, address(identity), address(rep), address(svr), MIN_STAKE, CHALLENGE, UNBONDING
            ))
        )));
        vm.startPrank(admin);
        identity.initializeV2(address(staking));
        identity.grantRole(identity.STAKING_CORE_ROLE(), address(staking));
        rep.grantRole(rep.STAKING_CORE_ROLE(), address(staking));
        staking.grantRole(staking.SLASHING_COMMITTEE_ROLE(), committee);
        vm.stopPrank();

        didHash = registerSigned(identity, operator, agentPk, bytes32(uint256(1)));
        svr.mint(operator, STAKE);
        vm.startPrank(operator);
        svr.approve(address(staking), STAKE);
        staking.depositStake(didHash, STAKE);
        vm.stopPrank();
    }

    function _queue() internal returns (uint256 queuedAt) {
        vm.prank(operator);
        staking.initiateWithdrawal(didHash, QUEUED);
        return block.timestamp;
    }

    function _setPeriod(uint256 period) internal {
        vm.prank(admin);
        staking.setUnbondingPeriod(period);
    }

    function _claimRevertsUntil(uint256 claimableAt) internal {
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.UnbondingPeriodActive.selector, didHash, claimableAt));
        vm.prank(operator);
        staking.claimWithdrawal(didHash);
    }

    /// The admin cannot shorten an exit that is already waiting.
    function test_loweringThePeriod_doesNotShortenAQueuedExit() public {
        uint256 queuedAt = _queue();
        _setPeriod(1 days);

        (, uint256 claimableAt) = staking.getPendingWithdrawal(didHash);
        assertEq(claimableAt, queuedAt + UNBONDING, "the view reports the time fixed at queueing");

        vm.warp(queuedAt + 1 days + 1);
        _claimRevertsUntil(queuedAt + UNBONDING);

        vm.warp(queuedAt + UNBONDING);
        vm.prank(operator);
        staking.claimWithdrawal(didHash);
        assertEq(svr.balanceOf(operator), QUEUED, "claimed on the promised day");
    }

    /// Nor can the admin lengthen it.
    function test_raisingThePeriod_doesNotLengthenAQueuedExit() public {
        uint256 queuedAt = _queue();
        _setPeriod(90 days);

        vm.warp(queuedAt + UNBONDING);
        vm.prank(operator);
        staking.claimWithdrawal(didHash);
        assertEq(svr.balanceOf(operator), QUEUED);
    }

    /// A withdrawal queued after a change takes the period then in force.
    function test_aNewWithdrawal_usesThePeriodInForceWhenItIsQueued() public {
        uint256 first = _queue();
        vm.warp(first + UNBONDING);
        vm.prank(operator);
        staking.claimWithdrawal(didHash);

        // Top up so the agent can queue again without dropping below its minimum.
        svr.mint(operator, 1e18);
        vm.startPrank(operator);
        svr.approve(address(staking), 1e18);
        staking.depositStake(didHash, 1e18);
        vm.stopPrank();

        _setPeriod(3 days);
        vm.prank(operator);
        staking.initiateWithdrawal(didHash, 1e18);
        (, uint256 claimableAt) = staking.getPendingWithdrawal(didHash);
        assertEq(claimableAt, block.timestamp + 3 days);
    }

    function test_theQueueingEvent_carriesTheFixedTime() public {
        vm.expectEmit(true, true, false, true, address(staking));
        emit SigvaraStaking.WithdrawalInitiated(didHash, operator, QUEUED, block.timestamp + UNBONDING);
        _queue();
    }

    /// Claiming spends the snapshot, so the next withdrawal starts clean.
    function test_claim_clearsTheSnapshot() public {
        uint256 queuedAt = _queue();
        assertEq(staking.unbondingClaimableAt(didHash), queuedAt + UNBONDING);

        vm.warp(queuedAt + UNBONDING);
        vm.prank(operator);
        staking.claimWithdrawal(didHash);

        assertEq(staking.unbondingClaimableAt(didHash), 0);
        (uint256 amount, uint256 claimableAt) = staking.getPendingWithdrawal(didHash);
        assertEq(amount, 0);
        assertEq(claimableAt, 0);
    }

    /// A slash sweeps the queue, and takes the snapshot with it.
    function test_slash_clearsTheSnapshot() public {
        _queue();
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, bytes("evidence"));
        vm.warp(block.timestamp + CHALLENGE + 1);
        staking.executeSlash(didHash);

        assertEq(staking.unbondingClaimableAt(didHash), 0);
        (uint256 amount, uint256 claimableAt) = staking.getPendingWithdrawal(didHash);
        assertEq(amount, 0);
        assertEq(claimableAt, 0);
    }

    /// A withdrawal queued before the field existed has no snapshot and keeps the rule it was
    /// queued under: the time it was queued plus the period in force when it is claimed.
    function test_aWithdrawalQueuedBeforeTheFieldExisted_keepsTheOldRule() public {
        uint256 queuedAt = _queue();
        // What an upgraded proxy holds for a withdrawal that predates the field: nothing.
        vm.store(address(staking), keccak256(abi.encode(didHash, uint256(10))), bytes32(0));
        assertEq(staking.unbondingClaimableAt(didHash), 0);

        _setPeriod(5 days);
        (, uint256 claimableAt) = staking.getPendingWithdrawal(didHash);
        assertEq(claimableAt, queuedAt + 5 days, "the live period still governs a legacy entry");

        vm.warp(queuedAt + 5 days);
        vm.prank(operator);
        staking.claimWithdrawal(didHash);
        assertEq(svr.balanceOf(operator), QUEUED);
    }

    /// Whatever the admin does between queueing and claiming, the exit is the day it was promised.
    function testFuzz_claimTimeIsFixedWhenQueued(uint256 newPeriod, uint256 wait) public {
        newPeriod = bound(newPeriod, 1 days, 90 days);
        wait = bound(wait, 0, 120 days);

        uint256 queuedAt = _queue();
        _setPeriod(newPeriod);
        vm.warp(queuedAt + wait);

        if (wait >= UNBONDING) {
            vm.prank(operator);
            staking.claimWithdrawal(didHash);
            assertEq(svr.balanceOf(operator), QUEUED);
        } else {
            _claimRevertsUntil(queuedAt + UNBONDING);
        }
    }
}
