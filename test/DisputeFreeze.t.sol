// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import "../src/SigvaraIdentity.sol";
import "../src/SigvaraReputation.sol";
import "../src/SigvaraStaking.sol";

contract DFMock is ERC20 {
    constructor() ERC20("Sigvara", "SVR") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// ERC-20 that refuses transfers to blocked addresses, like several real tokens.
contract DFBlocklist is ERC20 {
    mapping(address => bool) public blocked;
    constructor() ERC20("Blocklist", "BLK") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function block_(address a) external { blocked[a] = true; }
    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[to], "BLOCKED_RECIPIENT");
        super._update(from, to, value);
    }
}

/**
 * Regression tests for the dispute-freeze change.
 *
 * Before it, disputing a slash set the proposal to Cancelled, which released the
 * bond. An operator could queue the entire stake, cancel every proposal the
 * committee filed at no cost, and claim the lot once unbonding elapsed. Payouts
 * were also pushed inline, so a recipient that could not receive the token froze
 * the stake permanently, since settlement was the only path that cleared a
 * proposal.
 *
 * Each test here is the inverse of an exploit that was demonstrated against the
 * previous code.
 */
contract DisputeFreezeTest is Test {
    DFMock svr;
    SigvaraIdentity identity;
    SigvaraReputation rep;
    SigvaraStaking staking;

    address admin     = makeAddr("admin");
    address committee = makeAddr("committee");
    address oracle    = makeAddr("oracle");
    address operator  = makeAddr("operator");
    address agentAddr = makeAddr("agent");
    address victim    = makeAddr("victim");

    uint256 constant STAKE     = 10_000e18;
    uint256 constant MIN_STAKE = 1000e18;
    uint256 constant CHALLENGE = 7 days;
    uint256 constant UNBONDING = 21 days;

    bytes32 didHash;

    function setUp() public {
        svr = new DFMock();
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

        vm.prank(operator);
        didHash = identity.registerAgent(agentAddr, bytes32(uint256(1)));

        svr.mint(operator, STAKE);
        vm.startPrank(operator);
        svr.approve(address(staking), STAKE);
        staking.depositStake(didHash, STAKE);
        vm.stopPrank();
    }

    /// The headline escape: dispute, wait out unbonding, claim. The bond must stay
    /// frozen for as long as the dispute is open.
    function test_disputeCannotReleaseTheBond() public {
        vm.prank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Suspended);
        vm.prank(operator);
        staking.initiateWithdrawal(didHash, STAKE);

        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "");
        vm.prank(operator);
        staking.disputeSlash(didHash);

        // Unbonding elapses while the dispute is unresolved.
        vm.warp(block.timestamp + UNBONDING + 1);

        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.SlashAlreadyPending.selector, didHash));
        vm.prank(operator);
        staking.claimWithdrawal(didHash);

        assertEq(svr.balanceOf(operator), 0, "operator recovered nothing while disputed");
    }

    /// Disputing must not let the operator shake off proposals one after another.
    function test_cannotReInitiateOverAnOpenDispute() public {
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "");
        vm.prank(operator);
        staking.disputeSlash(didHash);

        // The proposal is with the committee now; filing again would reset the clock.
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.SlashAlreadyPending.selector, didHash));
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "");
    }

    /// The committee upholds: the slash lands even though it was disputed.
    function test_resolveDispute_upheld_slashes() public {
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "");
        vm.prank(operator);
        staking.disputeSlash(didHash);

        vm.prank(committee);
        staking.resolveDispute(didHash, true);

        assertEq(staking.getStake(didHash), 0, "stake slashed");
        assertEq(svr.balanceOf(address(0xdead)), STAKE / 2, "half burned");
        assertEq(staking.claimable(victim), STAKE / 4, "victim credited");
        assertEq(
            uint8(identity.getIdentity(didHash).status),
            uint8(SigvaraIdentity.AgentStatus.Slashed),
            "agent slashed"
        );
    }

    /// The committee rules for the operator: proposal dropped, stake released.
    function test_resolveDispute_rejected_releasesStake() public {
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "");
        vm.prank(operator);
        staking.disputeSlash(didHash);

        vm.prank(committee);
        staking.resolveDispute(didHash, false);

        assertTrue(identity.isActive(didHash), "agent reinstated");
        assertEq(staking.getStake(didHash), STAKE, "stake intact");

        vm.prank(operator);
        staking.initiateWithdrawal(didHash, STAKE - MIN_STAKE); // withdrawals work again
    }

    /// A freeze the committee never resolves must not be permanent.
    function test_expireDispute_releasesAfterTheResolutionWindow() public {
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "");
        vm.prank(operator);
        staking.disputeSlash(didHash);

        uint256 period = staking.DISPUTE_RESOLUTION_PERIOD();

        vm.expectRevert();
        staking.expireDispute(didHash); // too early

        vm.warp(block.timestamp + period + 1);
        staking.expireDispute(didHash); // permissionless

        assertTrue(identity.isActive(didHash), "agent reinstated once the dispute expired");
        assertEq(staking.getStake(didHash), STAKE, "stake released");
    }

    /// A proposal filed and then abandoned used to strand the agent Suspended with
    /// its stake frozen and no way out.
    function test_cancelSlash_clearsAnAbandonedProposal() public {
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "");
        assertFalse(identity.isActive(didHash));

        vm.prank(committee);
        staking.cancelSlash(didHash);

        assertTrue(identity.isActive(didHash), "agent reinstated");
        assertEq(staking.getStake(didHash), STAKE);
    }

    /// Settlement must not depend on the recipients being able to receive tokens.
    function test_unreceivableVictimCannotBlockSettlement() public {
        DFBlocklist token = new DFBlocklist();
        SigvaraStaking s2 = SigvaraStaking(address(new ERC1967Proxy(
            address(new SigvaraStaking()),
            abi.encodeCall(SigvaraStaking.initialize, (
                admin, address(identity), address(rep), address(token), MIN_STAKE, CHALLENGE, UNBONDING
            ))
        )));
        vm.startPrank(admin);
        identity.grantRole(identity.STAKING_CORE_ROLE(), address(s2));
        rep.grantRole(rep.STAKING_CORE_ROLE(), address(s2));
        s2.grantRole(s2.SLASHING_COMMITTEE_ROLE(), committee);
        vm.stopPrank();

        address op2 = makeAddr("op2");
        vm.prank(op2);
        bytes32 did2 = identity.registerAgent(makeAddr("agent2"), bytes32(uint256(2)));
        token.mint(op2, STAKE);
        vm.startPrank(op2);
        token.approve(address(s2), STAKE);
        s2.depositStake(did2, STAKE);
        vm.stopPrank();

        vm.prank(committee);
        s2.initiateSlash(did2, victim, "");
        token.block_(victim);
        vm.warp(block.timestamp + CHALLENGE + 1);

        // Settlement succeeds: the victim's share is credited, not pushed.
        s2.executeSlash(did2);
        assertEq(s2.claimable(victim), STAKE / 4, "victim credited despite being unreceivable");
        assertEq(token.balanceOf(address(0xdead)), STAKE / 2, "burn still went out");

        // Only the victim's own claim fails, and only for the victim.
        vm.prank(victim);
        vm.expectRevert();
        s2.claimSlashProceeds();

        vm.prank(committee);
        s2.claimSlashProceeds();
        assertEq(token.balanceOf(committee), STAKE - STAKE / 2 - STAKE / 4, "reporter paid out");
    }

    /// An admin must not be able to shorten a dispute window that is already running.
    function test_challengeDeadlineIsSnapshotAtInitiation() public {
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "");
        uint256 deadline = staking.getSlashProposal(didHash).challengeDeadline;

        // Read before the prank: an external call in the argument list consumes it.
        uint256 shorter = staking.MIN_CHALLENGE_PERIOD(); // 3 days, shorter than the 7 in force
        vm.prank(admin);
        staking.setChallengePeriod(shorter);

        assertEq(
            staking.getSlashProposal(didHash).challengeDeadline,
            deadline,
            "in-flight window moved when the global period changed"
        );

        // The original window is still in force.
        vm.warp(deadline);
        vm.expectRevert(
            abi.encodeWithSelector(SigvaraStaking.ChallengePeriodActive.selector, didHash, deadline)
        );
        staking.executeSlash(didHash);
    }
}
