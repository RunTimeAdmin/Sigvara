// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "./helpers/RegistrationHelper.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";

import "../src/SigvaraIdentity.sol";
import "../src/SigvaraReputation.sol";
import "../src/SigvaraStaking.sol";

/// Minimal ERC20 for testing only.
contract MockSVR is ERC20 {
    constructor() ERC20("Sigvara", "SVR") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract SigvaraStakingTest is Test, RegistrationHelper {
    MockSVR svr;
    SigvaraIdentity identity;
    SigvaraReputation rep;
    SigvaraStaking staking;

    address admin     = makeAddr("admin");
    address committee = makeAddr("committee");
    address operator  = makeAddr("operator");
    address agentAddr;
    uint256 agentPk;
    address victim    = makeAddr("victim");
    address stranger  = makeAddr("stranger");

    bytes32 constant PUB_KEY = bytes32(uint256(0xdeadbeef));

    uint256 constant MIN_STAKE     = 1000e18;
    uint256 constant CHALLENGE     = 7 days;
    uint256 constant UNBONDING     = 21 days;
    uint256 constant SCORE_WINDOW  = 1 hours;

    bytes32 didHash;

    function setUp() public {
        (agentAddr, agentPk) = makeAddrAndKey("agent");
        svr = new MockSVR();

        // Deploy implementations.
        SigvaraIdentity identityImpl = new SigvaraIdentity();
        SigvaraReputation repImpl    = new SigvaraReputation();
        SigvaraStaking stakingImpl   = new SigvaraStaking();

        // Deploy identity proxy (no staking address yet -- grant role after staking is deployed).
        identity = SigvaraIdentity(address(new ERC1967Proxy(
            address(identityImpl),
            abi.encodeCall(SigvaraIdentity.initialize, (admin, address(0)))
        )));

        // Deploy rep proxy (no staking address yet).
        rep = SigvaraReputation(address(new ERC1967Proxy(
            address(repImpl),
            abi.encodeCall(SigvaraReputation.initialize, (admin, address(0), address(0), committee, SCORE_WINDOW))
        )));
        vm.prank(admin);
        rep.initializeV3(address(identity));

        // Deploy staking proxy with identity + rep.
        staking = SigvaraStaking(address(new ERC1967Proxy(
            address(stakingImpl),
            abi.encodeCall(SigvaraStaking.initialize, (
                admin,
                address(identity),
                address(rep),
                address(svr),
                MIN_STAKE,
                CHALLENGE,
                UNBONDING
            ))
        )));

        // Wire up cross-contract roles.
        vm.startPrank(admin);
        identity.initializeV2(address(staking));
        identity.grantRole(identity.STAKING_CORE_ROLE(), address(staking));
        rep.grantRole(rep.STAKING_CORE_ROLE(), address(staking));
        staking.grantRole(staking.SLASHING_COMMITTEE_ROLE(), committee);
        vm.stopPrank();

        // Register an agent.
                didHash = registerSigned(identity, operator, agentPk, PUB_KEY);

        // Fund operator and approve staking.
        svr.mint(operator, 10_000e18);
        vm.prank(operator);
        svr.approve(address(staking), type(uint256).max);
    }

    // Propose + finalize a score via the optimistic flow, used by tests that just
    // need a live on-chain score without exercising the challenge window itself.
    function _finalizeScore(bytes32 did, SigvaraReputation.ReputationData memory data) internal {
        bytes32 oracleRole = rep.ORACLE_ROLE();
        vm.prank(admin);
        rep.grantRole(oracleRole, admin);
        vm.prank(admin);
        rep.proposeReputation(did, data, bytes32(0));
        vm.warp(block.timestamp + SCORE_WINDOW + 1);
        rep.finalizeReputation(did);
    }

    // -------------------------------------------------------------------------
    // depositStake
    // -------------------------------------------------------------------------

    function test_depositStake_success() public {
        vm.prank(operator);
        staking.depositStake(didHash, MIN_STAKE);

        assertEq(staking.getStake(didHash), MIN_STAKE);
        assertTrue(staking.hasMinimumStake(didHash));
    }

    function test_depositStake_accumulates() public {
        vm.startPrank(operator);
        staking.depositStake(didHash, MIN_STAKE / 2);
        staking.depositStake(didHash, MIN_STAKE / 2);
        vm.stopPrank();

        assertEq(staking.getStake(didHash), MIN_STAKE);
    }

    function test_depositStake_reverts_notOperator() public {
        vm.expectRevert(
            abi.encodeWithSelector(SigvaraStaking.NotOperator.selector, didHash, stranger)
        );
        vm.prank(stranger);
        staking.depositStake(didHash, MIN_STAKE);
    }

    function test_depositStake_reverts_unregistered() public {
        bytes32 ghost = keccak256("did:sigvara:5042002:0xnobody");
        vm.expectRevert(
            abi.encodeWithSelector(SigvaraStaking.AgentNotActive.selector, ghost)
        );
        vm.prank(operator);
        staking.depositStake(ghost, MIN_STAKE);
    }

    /// Suspended agents deposit so they can climb back over minimumStake. Identity
    /// refuses to reactivate an under-collateralised agent, so refusing the deposit
    /// too would make withdrawing the bond a one-way trip into a dead identity.
    /// The bond is what activates a new agent. Registration alone leaves it
    /// PendingBond, which is neither scoreable nor slashable, so nothing accrues to an
    /// identity that never put anything at risk.
    function test_depositStake_activatesAPendingBondAgent() public {
        address op2 = makeAddr("op2");
        (, uint256 a2) = makeAddrAndKey("agent2");
        bytes32 fresh = registerSigned(identity, op2, a2, bytes32(uint256(9)));
        assertEq(
            uint8(identity.getIdentity(fresh).status),
            uint8(SigvaraIdentity.AgentStatus.PendingBond)
        );
        assertFalse(identity.isActive(fresh));

        svr.mint(op2, MIN_STAKE);
        vm.startPrank(op2);
        svr.approve(address(staking), MIN_STAKE);
        staking.depositStake(fresh, MIN_STAKE);
        vm.stopPrank();

        assertTrue(identity.isActive(fresh), "the deposit activated it");
    }

    /// A deposit that does not clear the floor leaves the agent where it was.
    function test_depositStake_belowTheFloorDoesNotActivate() public {
        address op2 = makeAddr("op3");
        (, uint256 a3) = makeAddrAndKey("agent3");
        bytes32 fresh = registerSigned(identity, op2, a3, bytes32(uint256(10)));

        svr.mint(op2, MIN_STAKE);
        vm.startPrank(op2);
        svr.approve(address(staking), MIN_STAKE);
        staking.depositStake(fresh, MIN_STAKE - 1);
        vm.stopPrank();

        assertFalse(identity.isActive(fresh), "still short of the minimum");
        assertEq(
            uint8(identity.getIdentity(fresh).status),
            uint8(SigvaraIdentity.AgentStatus.PendingBond)
        );
    }

    /// Topping up must not drag a deliberately suspended agent back to Active. An
    /// operator that suspended itself to withdraw, or one the staking core suspended
    /// for a pending slash, stays where it is.
    function test_depositStake_doesNotReactivateASuspendedAgent() public {
        vm.prank(operator);
        staking.depositStake(didHash, MIN_STAKE);
        assertTrue(identity.isActive(didHash));

        vm.prank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Suspended);

        vm.prank(operator);
        staking.depositStake(didHash, MIN_STAKE);
        assertFalse(identity.isActive(didHash), "still suspended by its operator's choice");
    }

    function test_depositStake_allowedWhileSuspended() public {
        vm.prank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Suspended);

        uint256 before = staking.getStake(didHash);
        vm.prank(operator);
        staking.depositStake(didHash, MIN_STAKE);
        assertEq(staking.getStake(didHash), before + MIN_STAKE);
    }

    // -------------------------------------------------------------------------
    // initiateWithdrawal / claimWithdrawal
    // -------------------------------------------------------------------------

    function _deposit() internal {
        vm.prank(operator);
        staking.depositStake(didHash, MIN_STAKE * 2);
    }

    function test_initiateWithdrawal_queuesAmount() public {
        _deposit();

        vm.prank(operator);
        staking.initiateWithdrawal(didHash, MIN_STAKE);

        assertEq(staking.getStake(didHash), MIN_STAKE);
        (uint256 amount, uint256 claimableAt) = staking.getPendingWithdrawal(didHash);
        assertEq(amount, MIN_STAKE);
        assertEq(claimableAt, block.timestamp + UNBONDING);
    }

    function test_claimWithdrawal_afterUnbondingPeriod() public {
        _deposit();

        vm.prank(operator);
        staking.initiateWithdrawal(didHash, MIN_STAKE);

        vm.warp(block.timestamp + UNBONDING + 1);

        uint256 before = svr.balanceOf(operator);
        vm.prank(operator);
        staking.claimWithdrawal(didHash);

        assertEq(svr.balanceOf(operator), before + MIN_STAKE);
        (uint256 amount,) = staking.getPendingWithdrawal(didHash);
        assertEq(amount, 0);
    }

    function test_claimWithdrawal_reverts_beforeUnbondingElapsed() public {
        _deposit();

        uint256 initiatedAt = block.timestamp;
        vm.prank(operator);
        staking.initiateWithdrawal(didHash, MIN_STAKE);

        vm.expectRevert(
            abi.encodeWithSelector(
                SigvaraStaking.UnbondingPeriodActive.selector,
                didHash,
                initiatedAt + UNBONDING
            )
        );
        vm.prank(operator);
        staking.claimWithdrawal(didHash);
    }

    function test_claimWithdrawal_reverts_noneQueued() public {
        vm.expectRevert(
            abi.encodeWithSelector(SigvaraStaking.NoWithdrawalPending.selector, didHash)
        );
        vm.prank(operator);
        staking.claimWithdrawal(didHash);
    }

    function test_initiateWithdrawal_reverts_alreadyQueued() public {
        _deposit();

        vm.prank(operator);
        staking.initiateWithdrawal(didHash, MIN_STAKE / 2);

        vm.expectRevert(
            abi.encodeWithSelector(SigvaraStaking.WithdrawalAlreadyPending.selector, didHash)
        );
        vm.prank(operator);
        staking.initiateWithdrawal(didHash, MIN_STAKE / 2);
    }

    function test_initiateWithdrawal_reverts_belowMinWhileActive() public {
        _deposit();

        uint256 tooMuch = MIN_STAKE + 1;
        vm.expectRevert(
            abi.encodeWithSelector(
                SigvaraStaking.InsufficientStake.selector,
                didHash,
                MIN_STAKE * 2 - tooMuch,
                MIN_STAKE
            )
        );
        vm.prank(operator);
        staking.initiateWithdrawal(didHash, tooMuch);
    }

    function test_initiateWithdrawal_fullAllowedWhenSuspended() public {
        _deposit();

        vm.prank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Suspended);

        vm.prank(operator);
        staking.initiateWithdrawal(didHash, MIN_STAKE * 2);

        assertEq(staking.getStake(didHash), 0);

        vm.warp(block.timestamp + UNBONDING + 1);
        uint256 before = svr.balanceOf(operator);
        vm.prank(operator);
        staking.claimWithdrawal(didHash);
        assertEq(svr.balanceOf(operator), before + MIN_STAKE * 2);
    }

    // Regression: an operator must not be able to dodge a slash by draining the
    // entire stake into the unbonding queue. Before the fix, initiateSlash checked
    // only the active stake (s.amount) and reverted NoStake once everything was
    // queued, so the committee could never even start a slash.
    function test_exitDodge_slashStillInitiableWhenFullyQueued() public {
        _deposit(); // 2 * MIN_STAKE

        // Legitimate full-exit path: Suspend, then withdraw everything to the queue.
        vm.prank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Suspended);
        vm.prank(operator);
        staking.initiateWithdrawal(didHash, MIN_STAKE * 2);

        assertEq(staking.getStake(didHash), 0);
        (uint256 queued,) = staking.getPendingWithdrawal(didHash);
        assertEq(queued, MIN_STAKE * 2);

        // The committee can still initiate a slash against the queued funds.
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "evidence");

        // ... the operator cannot claim while the slash is pending ...
        vm.expectRevert(
            abi.encodeWithSelector(SigvaraStaking.SlashAlreadyPending.selector, didHash)
        );
        vm.prank(operator);
        staking.claimWithdrawal(didHash);

        // ... and after the challenge window the queued funds are swept and burned/distributed.
        vm.warp(block.timestamp + CHALLENGE + 1);
        staking.executeSlash(didHash);

        assertEq(svr.balanceOf(address(0xdead)), (MIN_STAKE * 2) / 2);
        (uint256 pendingAmount,) = staking.getPendingWithdrawal(didHash);
        assertEq(pendingAmount, 0);

        vm.expectRevert(
            abi.encodeWithSelector(SigvaraStaking.NoWithdrawalPending.selector, didHash)
        );
        vm.prank(operator);
        staking.claimWithdrawal(didHash);
    }

    // An Active agent must not be able to withdraw its entire backing stake in one
    // step; full exit requires suspending first.
    function test_initiateWithdrawal_reverts_toZeroWhileActive() public {
        _deposit(); // 2 * MIN_STAKE

        vm.expectRevert(
            abi.encodeWithSelector(
                SigvaraStaking.InsufficientStake.selector,
                didHash,
                0,          // remaining after draining everything
                MIN_STAKE
            )
        );
        vm.prank(operator);
        staking.initiateWithdrawal(didHash, MIN_STAKE * 2);
    }

    function test_initiateWithdrawal_reverts_pendingSlash() public {
        _deposit();

        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "");

        vm.expectRevert(
            abi.encodeWithSelector(SigvaraStaking.SlashAlreadyPending.selector, didHash)
        );
        vm.prank(operator);
        staking.initiateWithdrawal(didHash, MIN_STAKE);
    }

    function test_executeSlash_sweepsQueuedWithdrawal() public {
        _deposit(); // 2 * MIN_STAKE

        vm.prank(operator);
        staking.initiateWithdrawal(didHash, MIN_STAKE);
        // MIN_STAKE remains active, MIN_STAKE queued for withdrawal — both should be slashable.

        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "evidence");
        vm.warp(block.timestamp + CHALLENGE + 1);

        uint256 slashable = MIN_STAKE * 2; // active + queued combined
        staking.executeSlash(didHash);

        assertEq(svr.balanceOf(address(0xdead)), slashable / 2);
        assertEq(staking.getStake(didHash), 0);
        (uint256 pendingAmount,) = staking.getPendingWithdrawal(didHash);
        assertEq(pendingAmount, 0);

        // Nothing left to claim — the withdrawal was swept, not just the active stake.
        vm.expectRevert(
            abi.encodeWithSelector(SigvaraStaking.NoWithdrawalPending.selector, didHash)
        );
        vm.prank(operator);
        staking.claimWithdrawal(didHash);
    }

    // -------------------------------------------------------------------------
    // initiateSlash
    // -------------------------------------------------------------------------

    function test_initiateSlash_success() public {
        _deposit();

        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "evidence");

        SigvaraStaking.SlashProposal memory p = staking.getSlashProposal(didHash);
        assertEq(p.reporter, committee);
        assertEq(p.victim, victim);
        assertEq(uint8(p.state), uint8(SigvaraStaking.SlashState.Pending));

        // Agent should be suspended during challenge window.
        assertFalse(identity.isActive(didHash));
    }

    function test_initiateSlash_reverts_notCommittee() public {
        _deposit();

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                stranger,
                staking.SLASHING_COMMITTEE_ROLE()
            )
        );
        vm.prank(stranger);
        staking.initiateSlash(didHash, victim, "");
    }

    function test_initiateSlash_reverts_noStake() public {
        vm.expectRevert(
            abi.encodeWithSelector(SigvaraStaking.NoStake.selector, didHash)
        );
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "");
    }

    function test_initiateSlash_reverts_alreadyPending() public {
        _deposit();

        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "");

        vm.expectRevert(
            abi.encodeWithSelector(SigvaraStaking.SlashAlreadyPending.selector, didHash)
        );
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "");
    }

    // -------------------------------------------------------------------------
    // disputeSlash
    // -------------------------------------------------------------------------

    function test_disputeSlash_success() public {
        _deposit();

        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "");

        vm.prank(operator);
        staking.disputeSlash(didHash);

        // A dispute moves the proposal to committee resolution and keeps the bond
        // frozen. It does not cancel the slash and does not reinstate the agent:
        // doing either let an operator veto every proposal and withdraw the stake.
        SigvaraStaking.SlashProposal memory p = staking.getSlashProposal(didHash);
        assertEq(uint8(p.state), uint8(SigvaraStaking.SlashState.Disputed));
        assertFalse(identity.isActive(didHash), "agent stays suspended pending resolution");

        // The stake stays locked while the dispute is open.
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.SlashAlreadyPending.selector, didHash));
        vm.prank(operator);
        staking.initiateWithdrawal(didHash, MIN_STAKE);
    }

    function test_disputeSlash_reverts_afterChallengePeriod() public {
        _deposit();

        uint256 initiatedAt = block.timestamp;
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "");

        vm.warp(block.timestamp + CHALLENGE + 1);

        uint256 deadline = initiatedAt + CHALLENGE;
        vm.expectRevert(
            abi.encodeWithSelector(SigvaraStaking.ChallengePeriodExpired.selector, didHash, deadline)
        );
        vm.prank(operator);
        staking.disputeSlash(didHash);
    }

    function test_disputeSlash_reverts_notOperator() public {
        _deposit();

        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "");

        vm.expectRevert(
            abi.encodeWithSelector(SigvaraStaking.NotOperator.selector, didHash, stranger)
        );
        vm.prank(stranger);
        staking.disputeSlash(didHash);
    }

    // -------------------------------------------------------------------------
    // executeSlash
    // -------------------------------------------------------------------------

    function _setupPendingSlash() internal {
        _deposit(); // 2 * MIN_STAKE

        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "evidence");

        vm.warp(block.timestamp + CHALLENGE + 1);
    }

    function test_executeSlash_distributesCorrectly() public {
        _setupPendingSlash();

        uint256 slashable       = MIN_STAKE * 2;
        uint256 expectedBurned  = slashable / 2;
        uint256 expectedVictim  = slashable / 4;
        uint256 expectedReporter = slashable - expectedBurned - expectedVictim;

        vm.prank(stranger); // execution is permissionless
        staking.executeSlash(didHash);

        // The burn goes out immediately; victim and reporter shares are credited and
        // pulled, so a recipient that cannot receive the token cannot block settlement.
        assertEq(svr.balanceOf(address(0xdead)), expectedBurned);
        assertEq(staking.claimable(victim), expectedVictim);
        assertEq(staking.claimable(committee), expectedReporter);
        assertEq(staking.getStake(didHash), 0);

        vm.prank(victim);
        staking.claimSlashProceeds();
        assertEq(svr.balanceOf(victim), expectedVictim);
        assertEq(staking.claimable(victim), 0);
    }

    function test_executeSlash_marksAgentSlashed() public {
        _setupPendingSlash();

        staking.executeSlash(didHash);

        assertEq(
            uint8(identity.getIdentity(didHash).status),
            uint8(SigvaraIdentity.AgentStatus.Slashed)
        );
    }

    function test_executeSlash_zerosReputation() public {
        SigvaraReputation.ReputationData memory data = SigvaraReputation.ReputationData({
            feeScore: 30, successScore: 25, ageScore: 20,
            externalScore: 15, communityScore: 5, propagationScore: 5,
            lastUpdated: 0
        });
        // Scoring now requires a bond, so the agent has to be staked before it can
        // carry a score that the slash then zeroes.
        vm.prank(operator);
        staking.depositStake(didHash, MIN_STAKE);

        _finalizeScore(didHash, data);
        assertEq(rep.getTotalScore(didHash), 100);

        _setupPendingSlash();
        staking.executeSlash(didHash);

        assertEq(rep.getTotalScore(didHash), 0);
    }

    function test_executeSlash_reverts_duringChallengePeriod() public {
        _deposit();

        uint256 initiatedAt = block.timestamp;
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "");

        uint256 deadline = initiatedAt + CHALLENGE;
        vm.expectRevert(
            abi.encodeWithSelector(SigvaraStaking.ChallengePeriodActive.selector, didHash, deadline)
        );
        staking.executeSlash(didHash);
    }

    function test_executeSlash_reverts_noPendingProposal() public {
        vm.expectRevert(
            abi.encodeWithSelector(SigvaraStaking.NoActivePendingSlash.selector, didHash)
        );
        staking.executeSlash(didHash);
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    function test_setUnbondingPeriod_success() public {
        vm.prank(admin);
        staking.setUnbondingPeriod(30 days);
        assertEq(staking.unbondingPeriod(), 30 days);
    }

    function test_setUnbondingPeriod_reverts_notAdmin() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                stranger,
                bytes32(0) // DEFAULT_ADMIN_ROLE
            )
        );
        vm.prank(stranger);
        staking.setUnbondingPeriod(30 days);
    }

    // -------------------------------------------------------------------------
    // Upgrade safety
    // -------------------------------------------------------------------------

    // These two tests pin the mapping base slots the original proxy layout was deployed
    // with. If either fails, a storage variable was inserted above the mappings,
    // which shifts their base slots and makes every live stake/proposal
    // unreachable after a UUPS upgrade. New variables must be appended after
    // unbondingPeriod (slot 7), never inserted earlier.

    function test_storageLayout_stakesMappingPinnedToSlot5() public {
        _deposit(); // 2 * MIN_STAKE

        bytes32 stakeSlot = keccak256(abi.encode(didHash, uint256(5)));
        assertEq(uint256(vm.load(address(staking), stakeSlot)), MIN_STAKE * 2);
    }

    function test_storageLayout_slashProposalsMappingPinnedToSlot6() public {
        _deposit();
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "evidence");

        // First field of SlashProposal is the didHash itself.
        bytes32 proposalSlot = keccak256(abi.encode(didHash, uint256(6)));
        assertEq(vm.load(address(staking), proposalSlot), didHash);
    }

    function test_initializeV2_setsUnbondingPeriod_onceOnly() public {
        vm.prank(admin);
        staking.initializeV2(30 days);
        assertEq(staking.unbondingPeriod(), 30 days);

        vm.expectRevert(abi.encodeWithSignature("InvalidInitialization()"));
        vm.prank(admin);
        staking.initializeV2(10 days);
    }

    function test_initializeV2_reverts_notAdmin() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                stranger,
                bytes32(0) // DEFAULT_ADMIN_ROLE
            )
        );
        vm.prank(stranger);
        staking.initializeV2(30 days);
    }

    function test_claimWithdrawal_reverts_pendingSlash_evenAfterUnbondingElapsed() public {
        // Make unbonding shorter than the 7-day challenge period so the claim
        // window opens while the slash is still pending. Without the guard in
        // claimWithdrawal, the operator could pull the queued funds mid-slash.
        vm.prank(admin);
        staking.setUnbondingPeriod(1 days);

        _deposit();
        vm.prank(operator);
        staking.initiateWithdrawal(didHash, MIN_STAKE);

        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "evidence");

        vm.warp(block.timestamp + 2 days); // past unbonding, inside the challenge period

        vm.expectRevert(
            abi.encodeWithSelector(SigvaraStaking.SlashAlreadyPending.selector, didHash)
        );
        vm.prank(operator);
        staking.claimWithdrawal(didHash);
    }

    // -------------------------------------------------------------------------
    // Fuzz: stake roundtrip
    // -------------------------------------------------------------------------

    function testFuzz_stakeAndWithdraw(uint256 amount) public {
        amount = bound(amount, MIN_STAKE, 10_000e18);

        svr.mint(operator, amount);
        vm.prank(operator);
        svr.approve(address(staking), amount);

        vm.prank(operator);
        staking.depositStake(didHash, amount);

        // Suspend to allow full withdrawal below minimum.
        vm.prank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Suspended);

        vm.prank(operator);
        staking.initiateWithdrawal(didHash, amount);

        vm.warp(block.timestamp + UNBONDING + 1);

        uint256 before = svr.balanceOf(operator);
        vm.prank(operator);
        staking.claimWithdrawal(didHash);

        assertEq(svr.balanceOf(operator), before + amount);
        assertEq(staking.getStake(didHash), 0);
    }
}
