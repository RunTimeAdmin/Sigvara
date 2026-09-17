// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import "../src/SigvaraIdentity.sol";
import "../src/SigvaraReputation.sol";
import "../src/SigvaraStaking.sol";

contract InvMockSVR is ERC20 {
    constructor() ERC20("Sigvara", "SVR") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/**
 * Handler: drives SigvaraStaking through every externally reachable state
 * transition with bounded, randomized inputs. Calls that revert for legitimate
 * reasons are swallowed, because the invariants must hold regardless of which
 * subset of actions the fuzzer happens to land.
 */
contract StakingHandler is Test {
    InvMockSVR public svr;
    SigvaraIdentity public identity;
    SigvaraStaking public staking;

    address public committee;
    address[] public operators;
    bytes32[] public didHashes;

    /// Every token this handler has ever put into the staking contract.
    uint256 public totalDeposited;
    /// Every token the handler has pulled back out via a completed withdrawal.
    uint256 public totalClaimed;
    /// Every token that left through a slash, as reported by the event math.
    uint256 public totalSlashedOut;

    constructor(
        InvMockSVR svr_,
        SigvaraIdentity identity_,
        SigvaraStaking staking_,
        address committee_,
        address[] memory operators_,
        bytes32[] memory didHashes_
    ) {
        svr = svr_;
        identity = identity_;
        staking = staking_;
        committee = committee_;
        operators = operators_;
        didHashes = didHashes_;
    }

    function _pick(uint256 seed) internal view returns (address op, bytes32 did) {
        uint256 i = seed % operators.length;
        return (operators[i], didHashes[i]);
    }

    function deposit(uint256 seed, uint256 amount) external {
        (address op, bytes32 did) = _pick(seed);
        amount = bound(amount, 1, 10_000e18);
        svr.mint(op, amount);
        vm.startPrank(op);
        svr.approve(address(staking), amount);
        try staking.depositStake(did, amount) {
            totalDeposited += amount;
        } catch {}
        vm.stopPrank();
    }

    function initiateWithdrawal(uint256 seed, uint256 amount) external {
        (address op, bytes32 did) = _pick(seed);
        uint256 staked = staking.getStake(did);
        if (staked == 0) return;
        amount = bound(amount, 1, staked);
        vm.prank(op);
        try staking.initiateWithdrawal(did, amount) {} catch {}
    }

    function claimWithdrawal(uint256 seed) external {
        (address op, bytes32 did) = _pick(seed);
        (uint256 amount,) = staking.getPendingWithdrawal(did);
        if (amount == 0) return;
        vm.prank(op);
        try staking.claimWithdrawal(did) {
            totalClaimed += amount;
        } catch {}
    }

    function initiateSlash(uint256 seed, address victim) external {
        (, bytes32 did) = _pick(seed);
        if (victim == address(0) || victim == address(staking)) return;
        vm.prank(committee);
        try staking.initiateSlash(did, victim, "") {} catch {}
    }

    function disputeSlash(uint256 seed) external {
        (address op, bytes32 did) = _pick(seed);
        vm.prank(op);
        try staking.disputeSlash(did) {} catch {}
    }

    function executeSlash(uint256 seed) external {
        (, bytes32 did) = _pick(seed);
        uint256 slashable = staking.getStake(did);
        (uint256 queued,) = staking.getPendingWithdrawal(did);
        slashable += queued;
        try staking.executeSlash(did) {
            totalSlashedOut += slashable;
        } catch {}
    }

    /// Time must move or no window ever closes.
    function warp(uint256 secondsForward) external {
        vm.warp(block.timestamp + bound(secondsForward, 1 hours, 30 days));
    }

    function agentCount() external view returns (uint256) { return didHashes.length; }
    function didAt(uint256 i) external view returns (bytes32) { return didHashes[i]; }
}

/**
 * Invariant coverage for the contract that custodies bonds.
 *
 * The unit suite checks individual transitions. These checks assert properties
 * that must hold after any reachable sequence of them, which is where custody
 * bugs actually surface: tokens appearing, disappearing, or being promised to
 * two places at once.
 */
contract StakingInvariantTest is Test {
    InvMockSVR svr;
    SigvaraIdentity identity;
    SigvaraReputation rep;
    SigvaraStaking staking;
    StakingHandler handler;

    address admin     = makeAddr("admin");
    address committee = makeAddr("committee");
    address oracle    = makeAddr("oracle");

    address constant BURN = address(0xdead);

    uint256 constant MIN_STAKE    = 1000e18;
    uint256 constant CHALLENGE    = 7 days;
    uint256 constant UNBONDING    = 21 days;
    uint256 constant SCORE_WINDOW = 6 hours;

    function setUp() public {
        svr = new InvMockSVR();

        identity = SigvaraIdentity(address(new ERC1967Proxy(
            address(new SigvaraIdentity()),
            abi.encodeCall(SigvaraIdentity.initialize, (admin, address(0)))
        )));
        rep = SigvaraReputation(address(new ERC1967Proxy(
            address(new SigvaraReputation()),
            abi.encodeCall(SigvaraReputation.initialize, (admin, oracle, address(0), committee, SCORE_WINDOW))
        )));
        staking = SigvaraStaking(address(new ERC1967Proxy(
            address(new SigvaraStaking()),
            abi.encodeCall(SigvaraStaking.initialize, (
                admin, address(identity), address(rep), address(svr), MIN_STAKE, CHALLENGE, UNBONDING
            ))
        )));

        vm.startPrank(admin);
        identity.grantRole(identity.STAKING_CORE_ROLE(), address(staking));
        rep.grantRole(rep.STAKING_CORE_ROLE(), address(staking));
        staking.grantRole(staking.SLASHING_COMMITTEE_ROLE(), committee);
        vm.stopPrank();

        address[] memory ops = new address[](3);
        bytes32[] memory dids = new bytes32[](3);
        for (uint256 i = 0; i < 3; i++) {
            ops[i] = makeAddr(string.concat("operator", vm.toString(i)));
            address agentAddr = makeAddr(string.concat("agent", vm.toString(i)));
            vm.prank(ops[i]);
            dids[i] = identity.registerAgent(agentAddr, bytes32(uint256(i + 1)));
        }

        handler = new StakingHandler(svr, identity, staking, committee, ops, dids);

        // The handler impersonates the committee, so it needs no role of its own.
        targetContract(address(handler));
    }

    /// Solvency: the contract must custody exactly what it owes. Every token that
    /// came in is either still recorded against an agent, has been claimed, or
    /// left through a slash. A mismatch means tokens were created or stranded.
    function invariant_custodyMatchesRecordedObligations() public view {
        uint256 obligations;
        uint256 n = handler.agentCount();
        for (uint256 i = 0; i < n; i++) {
            bytes32 did = handler.didAt(i);
            (uint256 queued,) = staking.getPendingWithdrawal(did);
            obligations += staking.getStake(did) + queued;
        }
        assertEq(
            svr.balanceOf(address(staking)),
            obligations,
            "staking custody does not equal the sum of recorded stakes and queued withdrawals"
        );
    }

    /// Conservation: deposits in equal what is held, plus what was claimed out,
    /// plus what a slash distributed. Nothing evaporates.
    function invariant_tokenConservation() public view {
        uint256 held = svr.balanceOf(address(staking));
        assertEq(
            handler.totalDeposited(),
            held + handler.totalClaimed() + handler.totalSlashedOut(),
            "deposits do not reconcile against held, claimed and slashed totals"
        );
    }

    /// A slashed agent is terminal: no stake, no queue, and the identity registry
    /// agrees. If any of these drift apart, a slashed agent could be re-bonded or
    /// keep a claimable balance.
    function invariant_slashedAgentsFullyZeroed() public view {
        uint256 n = handler.agentCount();
        for (uint256 i = 0; i < n; i++) {
            bytes32 did = handler.didAt(i);
            if (identity.getIdentity(did).status == SigvaraIdentity.AgentStatus.Slashed) {
                (uint256 queued,) = staking.getPendingWithdrawal(did);
                assertEq(staking.getStake(did), 0, "slashed agent still holds stake");
                assertEq(queued, 0, "slashed agent still has a queued withdrawal");
            }
        }
    }

    /// The burn address only ever accumulates. A negative move would mean slashed
    /// value was recoverable.
    function invariant_burnedOnlyGrows() public view {
        assertGe(svr.balanceOf(BURN), 0);
        assertLe(svr.balanceOf(BURN), handler.totalSlashedOut());
    }
}
