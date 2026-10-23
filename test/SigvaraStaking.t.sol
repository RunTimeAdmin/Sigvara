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

    /// Off-chain readers learn when an exit becomes claimable from this event, so the
    /// time it carries is part of the contract's interface.
    function test_initiateWithdrawal_emitsWhenItBecomesClaimable() public {
        _deposit();

        vm.expectEmit(address(staking));
        emit SigvaraStaking.WithdrawalInitiated(didHash, operator, MIN_STAKE, block.timestamp + UNBONDING);
        vm.prank(operator);
        staking.initiateWithdrawal(didHash, MIN_STAKE);
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

    /// The event is how anyone watching the chain learns the split without replaying the
    /// transfers, so the three amounts are part of the contract's interface.
    function test_executeSlash_emitsTheSplit() public {
        _setupPendingSlash();

        uint256 slashable        = MIN_STAKE * 2;
        uint256 expectedBurned   = slashable / 2;
        uint256 expectedVictim   = slashable / 4;
        uint256 expectedReporter = slashable - expectedBurned - expectedVictim;

        vm.expectEmit(address(staking));
        emit SigvaraStaking.SlashExecuted(didHash, expectedBurned, expectedVictim, expectedReporter);
        vm.prank(stranger);
        staking.executeSlash(didHash);
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
            feeScore: 20, successScore: 15, ageScore: 30,
            externalScore: 25, communityScore: 5, propagationScore: 5,
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

    /**
     * Pins every slot, not just the two mappings above.
     *
     * The append-only rule is stated in four comments in this contract and enforced by
     * none of them. The identical gap in SigvaraReputation let `evidenceRoots` be declared
     * above `operatorBond`, which on the live proxy moved operatorBond into an empty slot
     * where it read zero — the "bonded-operator check disabled" mode, reached silently by
     * an upgrade that reverted nothing. This contract holds the bond, so it gets the same
     * treatment.
     *
     * Adding a variable: append it, add a line here, never renumber. A failure here after
     * a deliberate append means the append was not at the end.
     */
    /// Asking for more than you hold is an ordinary mistake, and a bare arithmetic panic
    /// names neither number. The subtraction would have reverted either way; this says why.
    function test_initiateWithdrawal_moreThanHeld_revertsNamed() public {
        _deposit(); // 2 * MIN_STAKE
        uint256 held = MIN_STAKE * 2;

        vm.expectRevert(abi.encodeWithSelector(
            SigvaraStaking.InsufficientStake.selector, didHash, held, held + 1
        ));
        vm.prank(operator);
        staking.initiateWithdrawal(didHash, held + 1);
    }

    function test_storageLayout_allSlotsPinned() public {
        assertEq(address(uint160(uint256(vm.load(address(staking), bytes32(uint256(0)))))),
            address(svr), "slot 0 is svrToken");
        assertEq(address(uint160(uint256(vm.load(address(staking), bytes32(uint256(1)))))),
            address(identity), "slot 1 is identityRegistry");
        assertEq(address(uint160(uint256(vm.load(address(staking), bytes32(uint256(2)))))),
            address(rep), "slot 2 is reputationRegistry");
        assertEq(uint256(vm.load(address(staking), bytes32(uint256(3)))),
            staking.minimumStake(), "slot 3 is minimumStake");
        assertEq(uint256(vm.load(address(staking), bytes32(uint256(4)))),
            staking.challengePeriod(), "slot 4 is challengePeriod");
        // 5 = stakes, 6 = slashProposals, pinned by the two tests above.
        assertEq(uint256(vm.load(address(staking), bytes32(uint256(7)))),
            staking.unbondingPeriod(), "slot 7 is unbondingPeriod");

        // 8 = claimable. A mapping's declared slot is only a hashing seed, so probe a key
        // that has a balance rather than reading the slot itself.
        _deposit();
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "evidence");
        vm.warp(block.timestamp + CHALLENGE + 1);
        staking.executeSlash(didHash);
        assertGt(staking.claimable(victim), 0, "victim owed something to probe");
        assertEq(uint256(vm.load(address(staking), keccak256(abi.encode(victim, uint256(8))))),
            staking.claimable(victim), "slot 8 is claimable");
    }

    /// Appended after `claimable`. A mapping again, so the probe is a key that holds a value.
    function test_storageLayout_lastDroppedAtPinnedToSlot9() public {
        _deposit();
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "evidence");
        vm.prank(committee);
        staking.cancelSlash(didHash);
        assertGt(staking.lastDroppedAt(didHash), 0);
        assertEq(uint256(vm.load(address(staking), keccak256(abi.encode(didHash, uint256(9))))),
            staking.lastDroppedAt(didHash), "slot 9 is lastDroppedAt");
    }

    /// Appended after `lastDroppedAt`. A mapping again, so the probe is a key that holds a value.
    function test_storageLayout_unbondingClaimableAtPinnedToSlot10() public {
        _deposit(); // 2 * MIN_STAKE
        vm.prank(operator);
        staking.initiateWithdrawal(didHash, MIN_STAKE);
        assertGt(staking.unbondingClaimableAt(didHash), 0);
        assertEq(uint256(vm.load(address(staking), keccak256(abi.encode(didHash, uint256(10))))),
            staking.unbondingClaimableAt(didHash), "slot 10 is unbondingClaimableAt");
    }

    /**
     * SigvaraStaking inherits the NON-upgradeable ReentrancyGuard. That is safe only
     * because OpenZeppelin >= 5.1 keeps `_status` in a namespaced slot; the older version
     * used a plain `uint256 private _status`, which in this inheritance chain would claim
     * slot 0 and shift svrToken and everything after it — on the one contract holding the
     * bond, and without reverting anything.
     *
     * So the assumption gets a test rather than a comment. If an OZ bump ever reintroduces
     * sequential storage here, this fails in CI instead of on a proxy; the fix would be to
     * switch to ReentrancyGuardUpgradeable and add __ReentrancyGuard_init to a
     * reinitializer.
     */
    function test_reentrancyGuardConsumesNoSequentialSlot() public view {
        assertEq(
            address(uint160(uint256(vm.load(address(staking), bytes32(uint256(0)))))),
            address(svr),
            "ReentrancyGuard took slot 0 - every storage variable has shifted"
        );
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

    /// On a fresh deployment initializeV2 is still unconsumed after initialize, and it used to
    /// take any value: the admin could set a zero unbonding period once, around the one day
    /// floor that setUnbondingPeriod enforces.
    function test_initializeV2_reverts_belowTheUnbondingFloor() public {
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.PeriodTooShort.selector, 0, 1 days));
        vm.prank(admin);
        staking.initializeV2(0);

        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.PeriodTooShort.selector, 1 days - 1, 1 days));
        vm.prank(admin);
        staking.initializeV2(1 days - 1);
    }

    /// The floor itself is accepted, and a refused call did not use the version up.
    function test_initializeV2_acceptsTheFloor_afterARefusedCall() public {
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.PeriodTooShort.selector, 1 hours, 1 days));
        vm.prank(admin);
        staking.initializeV2(1 hours);

        vm.prank(admin);
        staking.initializeV2(1 days);
        assertEq(staking.unbondingPeriod(), 1 days);
    }

    // -------------------------------------------------------------------------
    // initialize and the setters hold the same floors
    // -------------------------------------------------------------------------

    function _expectStakingInit(uint256 minStake, uint256 challenge, uint256 unbonding, bytes memory err) internal {
        address impl = address(new SigvaraStaking());
        vm.expectRevert(err);
        new ERC1967Proxy(impl, abi.encodeCall(SigvaraStaking.initialize, (
            admin, address(identity), address(rep), address(svr), minStake, challenge, unbonding
        )));
    }

    /// The setters refuse a challenge period under three days, and initialize took any value, so
    /// a deployment that did not go through the script could start below the floor.
    function test_initialize_refusesAChallengePeriodUnderTheFloor() public {
        _expectStakingInit(
            MIN_STAKE, 3 days - 1, UNBONDING,
            abi.encodeWithSelector(SigvaraStaking.PeriodTooShort.selector, 3 days - 1, 3 days)
        );
        _expectStakingInit(
            MIN_STAKE, 0, UNBONDING,
            abi.encodeWithSelector(SigvaraStaking.PeriodTooShort.selector, 0, 3 days)
        );
    }

    function test_initialize_refusesAnUnbondingPeriodUnderTheFloor() public {
        _expectStakingInit(
            MIN_STAKE, CHALLENGE, 1 days - 1,
            abi.encodeWithSelector(SigvaraStaking.PeriodTooShort.selector, 1 days - 1, 1 days)
        );
        _expectStakingInit(
            MIN_STAKE, CHALLENGE, 0,
            abi.encodeWithSelector(SigvaraStaking.PeriodTooShort.selector, 0, 1 days)
        );
    }

    /// A minimum stake of zero is met by an agent with nothing staked: hasMinimumStake is true
    /// for everyone, so the bond that backs a score and a slash is not there.
    function test_initialize_refusesAZeroMinimumStake() public {
        _expectStakingInit(0, CHALLENGE, UNBONDING, abi.encodeWithSelector(SigvaraStaking.MinimumStakeZero.selector));
    }

    function test_initialize_acceptsTheFloors() public {
        SigvaraStaking s = SigvaraStaking(address(new ERC1967Proxy(
            address(new SigvaraStaking()),
            abi.encodeCall(SigvaraStaking.initialize, (
                admin, address(identity), address(rep), address(svr), 1, 3 days, 1 days
            ))
        )));
        assertEq(s.minimumStake(), 1);
        assertEq(s.challengePeriod(), 3 days);
        assertEq(s.unbondingPeriod(), 1 days);
    }

    // -------------------------------------------------------------------------
    // Ceilings: a period nobody meant
    // -------------------------------------------------------------------------

    /// The unbonding period is read when a withdrawal is claimed, so a value far above any sane one
    /// locks every queued withdrawal, and a challenge period far above one stops a slash from ever being
    /// executable. The ceilings keep both to a number of weeks, in every place they are set.
    function test_ceilings_arePinned() public view {
        assertEq(staking.MAX_CHALLENGE_PERIOD(), 30 days);
        assertEq(staking.MAX_UNBONDING_PERIOD(), 90 days);
    }

    function test_setChallengePeriod_ceiling() public {
        uint256 ceiling = staking.MAX_CHALLENGE_PERIOD();
        vm.prank(admin);
        staking.setChallengePeriod(ceiling);
        assertEq(staking.challengePeriod(), ceiling);

        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.PeriodTooLong.selector, ceiling + 1, ceiling));
        vm.prank(admin);
        staking.setChallengePeriod(ceiling + 1);
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.PeriodTooLong.selector, type(uint256).max, ceiling));
        vm.prank(admin);
        staking.setChallengePeriod(type(uint256).max);
        assertEq(staking.challengePeriod(), ceiling, "unchanged after the refusals");
    }

    function test_setUnbondingPeriod_ceiling() public {
        uint256 ceiling = staking.MAX_UNBONDING_PERIOD();
        vm.prank(admin);
        staking.setUnbondingPeriod(ceiling);
        assertEq(staking.unbondingPeriod(), ceiling);

        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.PeriodTooLong.selector, ceiling + 1, ceiling));
        vm.prank(admin);
        staking.setUnbondingPeriod(ceiling + 1);
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.PeriodTooLong.selector, type(uint256).max, ceiling));
        vm.prank(admin);
        staking.setUnbondingPeriod(type(uint256).max);
        assertEq(staking.unbondingPeriod(), ceiling, "unchanged after the refusals");
    }

    function test_initialize_refusesPeriodsAboveTheCeilings() public {
        uint256 maxChallenge = staking.MAX_CHALLENGE_PERIOD();
        uint256 maxUnbonding = staking.MAX_UNBONDING_PERIOD();
        _expectStakingInit(
            MIN_STAKE, maxChallenge + 1, UNBONDING,
            abi.encodeWithSelector(SigvaraStaking.PeriodTooLong.selector, maxChallenge + 1, maxChallenge)
        );
        _expectStakingInit(
            MIN_STAKE, type(uint256).max, UNBONDING,
            abi.encodeWithSelector(SigvaraStaking.PeriodTooLong.selector, type(uint256).max, maxChallenge)
        );
        _expectStakingInit(
            MIN_STAKE, CHALLENGE, maxUnbonding + 1,
            abi.encodeWithSelector(SigvaraStaking.PeriodTooLong.selector, maxUnbonding + 1, maxUnbonding)
        );
        _expectStakingInit(
            MIN_STAKE, CHALLENGE, type(uint256).max,
            abi.encodeWithSelector(SigvaraStaking.PeriodTooLong.selector, type(uint256).max, maxUnbonding)
        );
    }

    function test_initialize_acceptsTheCeilings() public {
        SigvaraStaking s = SigvaraStaking(address(new ERC1967Proxy(
            address(new SigvaraStaking()),
            abi.encodeCall(SigvaraStaking.initialize, (
                admin, address(identity), address(rep), address(svr), MIN_STAKE, 30 days, 90 days
            ))
        )));
        assertEq(s.challengePeriod(), 30 days);
        assertEq(s.unbondingPeriod(), 90 days);
    }

    function test_initializeV2_refusesAnUnbondingPeriodAboveTheCeiling() public {
        uint256 ceiling = staking.MAX_UNBONDING_PERIOD();
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.PeriodTooLong.selector, ceiling + 1, ceiling));
        vm.prank(admin);
        staking.initializeV2(ceiling + 1);

        // A refused call did not use the version up.
        vm.prank(admin);
        staking.initializeV2(ceiling);
        assertEq(staking.unbondingPeriod(), ceiling);
    }

    /// A withdrawal queued under the longest unbonding period the contract allows is still claimable once
    /// it has run: the ceiling does not make the arithmetic fail.
    function test_unbondingAtTheCeilingIsClaimableAfterIt() public {
        uint256 ceiling = staking.MAX_UNBONDING_PERIOD(); // read before the prank, which an external call would use up
        vm.prank(admin);
        staking.setUnbondingPeriod(ceiling);
        vm.prank(operator);
        staking.depositStake(didHash, MIN_STAKE * 2);
        vm.prank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Suspended);
        vm.prank(operator);
        staking.initiateWithdrawal(didHash, MIN_STAKE * 2);

        vm.warp(block.timestamp + 90 days);
        vm.prank(operator);
        staking.claimWithdrawal(didHash);
        assertEq(svr.balanceOf(operator), 10_000e18);
    }

    function test_setMinimumStake_refusesZero() public {
        vm.expectRevert(SigvaraStaking.MinimumStakeZero.selector);
        vm.prank(admin);
        staking.setMinimumStake(0);
        assertEq(staking.minimumStake(), MIN_STAKE, "unchanged after the refusal");
    }

    function test_setMinimumStake_stillAcceptsAnyPositiveValue() public {
        vm.prank(admin);
        staking.setMinimumStake(1);
        assertEq(staking.minimumStake(), 1);
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
    // initialize guards
    // -------------------------------------------------------------------------

    function _expectInitZeroAddress(address a, address idReg, address repReg, address token) internal {
        address impl = address(new SigvaraStaking());
        vm.expectRevert(SigvaraStaking.ZeroAddress.selector);
        new ERC1967Proxy(
            impl,
            abi.encodeCall(SigvaraStaking.initialize, (
                a, idReg, repReg, token, MIN_STAKE, CHALLENGE, UNBONDING
            ))
        );
    }

    function test_initialize_reverts_zeroAddresses() public {
        _expectInitZeroAddress(address(0), address(identity), address(rep), address(svr));
        _expectInitZeroAddress(admin, address(0), address(rep), address(svr));
        _expectInitZeroAddress(admin, address(identity), address(0), address(svr));
        _expectInitZeroAddress(admin, address(identity), address(rep), address(0));
    }

    function test_implementation_cannotBeInitialized() public {
        SigvaraStaking impl = new SigvaraStaking();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(admin, address(identity), address(rep), address(svr), MIN_STAKE, CHALLENGE, UNBONDING);
    }

    // -------------------------------------------------------------------------
    // Withdrawal guards
    // -------------------------------------------------------------------------

    function test_initiateWithdrawal_reverts_noStake() public {
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.NoStake.selector, didHash));
        vm.prank(operator);
        staking.initiateWithdrawal(didHash, 1);
    }

    function test_initiateWithdrawal_reverts_notOperator() public {
        _deposit();
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.NotOperator.selector, didHash, stranger));
        vm.prank(stranger);
        staking.initiateWithdrawal(didHash, MIN_STAKE);
    }

    function test_claimWithdrawal_reverts_notOperator() public {
        _deposit();
        vm.prank(operator);
        staking.initiateWithdrawal(didHash, MIN_STAKE);
        vm.warp(block.timestamp + UNBONDING + 1);

        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.NotOperator.selector, didHash, stranger));
        vm.prank(stranger);
        staking.claimWithdrawal(didHash);
    }

    function test_getPendingWithdrawal_zeroWhenNoneQueued() public {
        _deposit();
        (uint256 amount, uint256 claimableAt) = staking.getPendingWithdrawal(didHash);
        assertEq(amount, 0);
        assertEq(claimableAt, 0);
    }

    // -------------------------------------------------------------------------
    // Slash guards and settlement
    // -------------------------------------------------------------------------

    function test_initiateSlash_reverts_zeroVictim() public {
        _deposit();
        vm.expectRevert(SigvaraStaking.ZeroAddress.selector);
        vm.prank(committee);
        staking.initiateSlash(didHash, address(0), "");
    }

    function test_initiateSlash_recordsProposalAndSnapshotsDeadline() public {
        _deposit();
        uint256 t0 = vm.getBlockTimestamp();
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "evidence");

        SigvaraStaking.SlashProposal memory p = staking.getSlashProposal(didHash);
        assertEq(p.didHash, didHash);
        assertEq(p.reporter, committee);
        assertEq(p.victim, victim);
        assertEq(p.initiatedAt, t0);
        assertEq(p.challengeDeadline, t0 + CHALLENGE);
        assertEq(p.disputedAt, 0);
        assertEq(p.evidenceHash, bytes("evidence"));
        assertTrue(identity.slashSuspended(didHash));
    }

    function test_disputeSlash_reverts_noPendingProposal() public {
        _deposit();
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.NoActivePendingSlash.selector, didHash));
        vm.prank(operator);
        staking.disputeSlash(didHash);
    }

    function test_disputeSlash_allowedAtExactDeadline() public {
        _deposit();
        uint256 t0 = vm.getBlockTimestamp();
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "");

        vm.warp(t0 + CHALLENGE);
        vm.prank(operator);
        staking.disputeSlash(didHash);
        assertEq(uint8(staking.getSlashProposal(didHash).state), uint8(SigvaraStaking.SlashState.Disputed));
    }

    function test_executeSlash_reverts_atExactDeadline() public {
        _deposit();
        uint256 t0 = vm.getBlockTimestamp();
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "");

        vm.warp(t0 + CHALLENGE);
        vm.expectRevert(
            abi.encodeWithSelector(SigvaraStaking.ChallengePeriodActive.selector, didHash, t0 + CHALLENGE)
        );
        staking.executeSlash(didHash);
    }

    function test_executeSlash_reverts_onDisputedProposal() public {
        _deposit();
        uint256 t0 = vm.getBlockTimestamp();
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "");
        vm.prank(operator);
        staking.disputeSlash(didHash);

        vm.warp(t0 + CHALLENGE + 1);
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.NoActivePendingSlash.selector, didHash));
        staking.executeSlash(didHash);
    }

    function test_executeSlash_cannotRunTwice() public {
        _setupPendingSlash();
        staking.executeSlash(didHash);
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.NoActivePendingSlash.selector, didHash));
        staking.executeSlash(didHash);
    }

    function test_cancelSlash_reverts_noPendingProposal() public {
        _deposit();
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.NoActivePendingSlash.selector, didHash));
        vm.prank(committee);
        staking.cancelSlash(didHash);
    }

    function test_cancelSlash_reverts_notCommittee() public {
        _deposit();
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "");

        bytes32 role = staking.SLASHING_COMMITTEE_ROLE();
        vm.expectRevert(abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, operator, role
        ));
        vm.prank(operator);
        staking.cancelSlash(didHash);
    }

    function test_cancelSlash_reverts_onDisputedProposal() public {
        _deposit();
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "");
        vm.prank(operator);
        staking.disputeSlash(didHash);

        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.NoActivePendingSlash.selector, didHash));
        vm.prank(committee);
        staking.cancelSlash(didHash);
    }

    /// Dropping a proposal against an agent whose active stake is below the minimum
    /// lifts the slash lock but leaves the agent Suspended.
    function test_cancelSlash_belowMinimum_leavesSuspendedAndUnlocked() public {
        _deposit();
        vm.startPrank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Suspended);
        staking.initiateWithdrawal(didHash, MIN_STAKE * 2);
        vm.stopPrank();

        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "");
        assertTrue(identity.slashSuspended(didHash));

        vm.prank(committee);
        staking.cancelSlash(didHash);

        assertEq(uint8(staking.getSlashProposal(didHash).state), uint8(SigvaraStaking.SlashState.Cancelled));
        assertFalse(identity.slashSuspended(didHash), "slash lock lifted");
        assertEq(
            uint8(identity.getIdentity(didHash).status),
            uint8(SigvaraIdentity.AgentStatus.Suspended),
            "not reinstated without a bond"
        );
    }

    function test_cancelSlash_atMinimum_reinstatesActive() public {
        _deposit();
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "");
        vm.prank(committee);
        staking.cancelSlash(didHash);

        assertTrue(identity.isActive(didHash));
        assertFalse(identity.slashSuspended(didHash));
    }

    /// The loop: file, cancel, file again in the same block. The agent is Active for no time at
    /// all, so it can never queue a withdrawal, and its stake never unfreezes.
    function test_initiateSlash_cannotBeRefiledStraightAfterACancel() public {
        _deposit();
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "evidence");
        vm.prank(committee);
        staking.cancelSlash(didHash);

        vm.expectRevert(abi.encodeWithSelector(
            SigvaraStaking.SlashCooldownActive.selector, didHash, block.timestamp + CHALLENGE
        ));
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "again");
    }

    /// The cooldown is one challenge period, to the second, and then the committee may file again.
    function test_initiateSlash_refileIsOpenExactlyOneChallengePeriodAfterTheDrop() public {
        _deposit();
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "evidence");
        vm.prank(committee);
        staking.cancelSlash(didHash);
        uint256 droppedAt = block.timestamp;
        assertEq(staking.lastDroppedAt(didHash), droppedAt);

        vm.warp(droppedAt + CHALLENGE - 1);
        vm.expectRevert(abi.encodeWithSelector(
            SigvaraStaking.SlashCooldownActive.selector, didHash, droppedAt + CHALLENGE
        ));
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "too soon");

        vm.warp(droppedAt + CHALLENGE);
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "with stronger evidence");
        assertEq(uint8(staking.getSlashProposal(didHash).state), uint8(SigvaraStaking.SlashState.Pending));
    }

    /// What the cooldown is for: a window in which the operator can act. It can queue a withdrawal
    /// the moment a proposal is dropped, and the queued amount stays slashable.
    function test_initiateSlash_theCooldownLeavesTheOperatorAWindowToQueueAWithdrawal() public {
        _deposit();
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "evidence");
        vm.prank(committee);
        staking.cancelSlash(didHash);

        vm.startPrank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Suspended);
        staking.initiateWithdrawal(didHash, MIN_STAKE * 2);
        vm.stopPrank();

        vm.warp(block.timestamp + CHALLENGE);
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "with stronger evidence");
        vm.warp(block.timestamp + CHALLENGE + 1);
        staking.executeSlash(didHash);
        assertGt(staking.claimable(victim), 0, "the queued amount was still slashed");
    }

    /// Every way a proposal can be dropped starts the cooldown, not only the committee's cancel.
    function test_initiateSlash_aResolvedDisputeStartsTheCooldown() public {
        _deposit();
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "evidence");
        vm.prank(operator);
        staking.disputeSlash(didHash);
        vm.prank(admin);
        staking.resolveDispute(didHash, false);

        vm.expectRevert(abi.encodeWithSelector(
            SigvaraStaking.SlashCooldownActive.selector, didHash, block.timestamp + CHALLENGE
        ));
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "again");
    }

    function test_initiateSlash_anExpiredDisputeStartsTheCooldown() public {
        _deposit();
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "evidence");
        vm.prank(operator);
        staking.disputeSlash(didHash);
        vm.warp(block.timestamp + staking.DISPUTE_RESOLUTION_PERIOD() + 1);
        staking.expireDispute(didHash);

        vm.expectRevert(abi.encodeWithSelector(
            SigvaraStaking.SlashCooldownActive.selector, didHash, block.timestamp + CHALLENGE
        ));
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "again");
    }

    // -------------------------------------------------------------------------
    // The admin's veto
    // -------------------------------------------------------------------------

    function test_vetoSlash_dropsAPendingProposalAndReinstatesTheAgent() public {
        _deposit();
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "evidence");
        assertFalse(identity.isActive(didHash), "suspended while the proposal is open");

        vm.expectEmit(address(staking));
        emit SigvaraStaking.SlashCancelled(didHash, admin);
        vm.expectEmit(address(staking));
        emit SigvaraStaking.SlashVetoed(didHash, admin);
        vm.prank(admin);
        staking.vetoSlash(didHash);

        assertEq(uint8(staking.getSlashProposal(didHash).state), uint8(SigvaraStaking.SlashState.Cancelled));
        assertTrue(identity.isActive(didHash), "reinstated like any dropped proposal");
        assertFalse(identity.slashSuspended(didHash));
        assertEq(staking.lastDroppedAt(didHash), block.timestamp, "the committee waits before it files again");
    }

    function test_vetoSlash_dropsADisputedProposal() public {
        _deposit();
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "evidence");
        vm.prank(operator);
        staking.disputeSlash(didHash);

        vm.prank(admin);
        staking.vetoSlash(didHash);

        assertEq(uint8(staking.getSlashProposal(didHash).state), uint8(SigvaraStaking.SlashState.Cancelled));
        assertTrue(identity.isActive(didHash));
    }

    /// The deadline passing does not make a slash final. Until someone executes it the proposal is
    /// still Pending, and the veto still works.
    function test_vetoSlash_worksAfterTheChallengeDeadlineAndBeforeAnyoneExecutes() public {
        _setupPendingSlash(); // warps past the deadline

        vm.prank(admin);
        staking.vetoSlash(didHash);

        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.NoActivePendingSlash.selector, didHash));
        staking.executeSlash(didHash);
        assertEq(staking.getStake(didHash), MIN_STAKE * 2, "nothing was taken");
    }

    function test_vetoSlash_reverts_forTheCommitteeAndStrangers() public {
        _deposit();
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "evidence");

        bytes32 adminRole = staking.DEFAULT_ADMIN_ROLE();
        vm.expectRevert(abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, committee, adminRole
        ));
        vm.prank(committee);
        staking.vetoSlash(didHash);

        vm.expectRevert(abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, adminRole
        ));
        vm.prank(stranger);
        staking.vetoSlash(didHash);
    }

    function test_vetoSlash_reverts_whenNothingIsOpen() public {
        _deposit();
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.NoActivePendingSlash.selector, didHash));
        vm.prank(admin);
        staking.vetoSlash(didHash);

        // And not on a proposal that already ended.
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "evidence");
        vm.prank(committee);
        staking.cancelSlash(didHash);
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.NoActivePendingSlash.selector, didHash));
        vm.prank(admin);
        staking.vetoSlash(didHash);
    }

    function test_vetoSlash_cannotUndoAnExecutedSlash() public {
        _setupPendingSlash();
        staking.executeSlash(didHash);

        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.NoActivePendingSlash.selector, didHash));
        vm.prank(admin);
        staking.vetoSlash(didHash);
        assertEq(uint8(staking.getSlashProposal(didHash).state), uint8(SigvaraStaking.SlashState.Executed));
    }

    /// A veto unfreezes the bond as any drop does, and starts the same cooldown, so the committee
    /// cannot answer a veto by filing again in the same block.
    function test_vetoSlash_unfreezesTheBondAndStartsTheCooldown() public {
        _deposit();
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "evidence");
        vm.prank(admin);
        staking.vetoSlash(didHash);

        vm.startPrank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Suspended);
        staking.initiateWithdrawal(didHash, MIN_STAKE); // allowed: no proposal is open
        vm.stopPrank();

        vm.expectRevert(abi.encodeWithSelector(
            SigvaraStaking.SlashCooldownActive.selector, didHash, block.timestamp + CHALLENGE
        ));
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "again");
    }

    /// The same rule as cancelSlash when the agent no longer holds the minimum: the slash lock is
    /// lifted and the agent is left Suspended.
    function test_vetoSlash_belowMinimum_leavesSuspendedAndUnlocked() public {
        _deposit();
        vm.startPrank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Suspended);
        staking.initiateWithdrawal(didHash, MIN_STAKE * 2);
        vm.stopPrank();
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "");
        assertTrue(identity.slashSuspended(didHash));

        vm.prank(admin);
        staking.vetoSlash(didHash);

        assertFalse(identity.slashSuspended(didHash), "slash lock lifted");
        assertEq(
            uint8(identity.getIdentity(didHash).status),
            uint8(SigvaraIdentity.AgentStatus.Suspended),
            "not reinstated without a bond"
        );
    }

    function test_resolveDispute_reverts_notDisputed() public {
        _deposit();
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "");

        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.SlashNotDisputed.selector, didHash));
        vm.prank(admin);
        staking.resolveDispute(didHash, true);
    }

    /// The committee files a slash and may not also rule on it. A dispute is ruled by the admin, the
    /// same key that can veto, so nobody judges their own accusation.
    function test_resolveDispute_reverts_forTheCommitteeAndStrangers() public {
        _deposit();
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "");
        vm.prank(operator);
        staking.disputeSlash(didHash);

        bytes32 role = staking.DEFAULT_ADMIN_ROLE();
        vm.expectRevert(abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, committee, role
        ));
        vm.prank(committee);
        staking.resolveDispute(didHash, true);

        vm.expectRevert(abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role
        ));
        vm.prank(stranger);
        staking.resolveDispute(didHash, false);

        assertEq(uint8(staking.getSlashProposal(didHash).state), uint8(SigvaraStaking.SlashState.Disputed));
    }

    function test_resolveDispute_theAdminCanUpholdOrDrop() public {
        _deposit();
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "evidence");
        vm.prank(operator);
        staking.disputeSlash(didHash);
        vm.warp(block.timestamp + CHALLENGE + 1);
        vm.prank(admin);
        staking.resolveDispute(didHash, true);
        assertEq(uint8(staking.getSlashProposal(didHash).state), uint8(SigvaraStaking.SlashState.Executed));
        assertGt(staking.claimable(victim), 0);
    }

    // -------------------------------------------------------------------------
    // A dispute never hurries a slash
    // -------------------------------------------------------------------------

    /// File a slash, note its snapshotted deadline, and have the operator dispute it at once.
    function _filedAndDisputed() internal returns (uint256 deadline) {
        _deposit();
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "evidence");
        deadline = staking.getSlashProposal(didHash).challengeDeadline;
        vm.prank(operator);
        staking.disputeSlash(didHash);
    }

    /// A dispute used to be upheld in the block it was filed in, so disputing could bring a slash
    /// forward: an undisputed one waits out the whole challenge period. A ruling to uphold now waits
    /// for the same moment executeSlash does.
    function test_resolveDispute_upholdInTheBlockOfTheDisputeIsRefused() public {
        uint256 deadline = _filedAndDisputed();
        uint256 staked = staking.getStake(didHash);

        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.ChallengePeriodActive.selector, didHash, deadline));
        vm.prank(admin);
        staking.resolveDispute(didHash, true);

        assertEq(uint8(staking.getSlashProposal(didHash).state), uint8(SigvaraStaking.SlashState.Disputed));
        assertEq(staking.getStake(didHash), staked, "nothing was taken");
        assertEq(staking.claimable(victim), 0, "nobody was credited");
    }

    /// The same boundary as executeSlash: refused up to and including the deadline, open after it.
    function test_resolveDispute_upholdIsRefusedAtTheDeadlineAndOpenOneSecondAfter() public {
        uint256 deadline = _filedAndDisputed();

        vm.warp(deadline);
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.ChallengePeriodActive.selector, didHash, deadline));
        vm.prank(admin);
        staking.resolveDispute(didHash, true);

        vm.warp(deadline + 1);
        vm.prank(admin);
        staking.resolveDispute(didHash, true);
        assertEq(uint8(staking.getSlashProposal(didHash).state), uint8(SigvaraStaking.SlashState.Executed));
    }

    /// Dropping is never gated: the admin can end a dispute the moment it is filed.
    function test_resolveDispute_dropIsOpenInTheBlockOfTheDispute() public {
        _filedAndDisputed();

        vm.prank(admin);
        staking.resolveDispute(didHash, false);

        assertEq(uint8(staking.getSlashProposal(didHash).state), uint8(SigvaraStaking.SlashState.Cancelled));
        assertTrue(identity.isActive(didHash), "reinstated");
    }

    /// The gate is the deadline fixed at filing. Neither direction of the admin's period setter
    /// moves it, as for executeSlash.
    function test_resolveDispute_theGateIsTheSnapshotNotTheLivePeriod() public {
        uint256 deadline = _filedAndDisputed();

        // Shortening the live period does not open the gate early.
        uint256 shorter = staking.MIN_CHALLENGE_PERIOD();
        vm.prank(admin);
        staking.setChallengePeriod(shorter);
        vm.warp(deadline - 1 days); // past the shortened period, short of the original deadline
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.ChallengePeriodActive.selector, didHash, deadline));
        vm.prank(admin);
        staking.resolveDispute(didHash, true);

        // Lengthening it does not hold the gate shut.
        vm.prank(admin);
        staking.setChallengePeriod(20 days);
        vm.warp(deadline + 1);
        vm.prank(admin);
        staking.resolveDispute(didHash, true);
        assertEq(uint8(staking.getSlashProposal(didHash).state), uint8(SigvaraStaking.SlashState.Executed));
    }

    /// Whenever the operator disputes, and whenever the admin tries, an upheld ruling lands exactly
    /// when the deadline has passed and not before.
    function testFuzz_resolveDispute_upholdOpensOnlyAfterTheDeadline(uint256 disputeDelay, uint256 tryDelay) public {
        _deposit();
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "evidence");
        uint256 filedAt = block.timestamp;
        uint256 deadline = staking.getSlashProposal(didHash).challengeDeadline;

        // The operator may dispute up to and including the deadline.
        disputeDelay = bound(disputeDelay, 0, CHALLENGE);
        vm.warp(filedAt + disputeDelay);
        vm.prank(operator);
        staking.disputeSlash(didHash);

        tryDelay = bound(tryDelay, disputeDelay, CHALLENGE + 7 days);
        vm.warp(filedAt + tryDelay);
        if (block.timestamp <= deadline) {
            vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.ChallengePeriodActive.selector, didHash, deadline));
        }
        vm.prank(admin);
        staking.resolveDispute(didHash, true);

        SigvaraStaking.SlashState expected = block.timestamp <= deadline
            ? SigvaraStaking.SlashState.Disputed
            : SigvaraStaking.SlashState.Executed;
        assertEq(uint8(staking.getSlashProposal(didHash).state), uint8(expected));
    }

    function test_expireDispute_reverts_notDisputed() public {
        _deposit();
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.SlashNotDisputed.selector, didHash));
        staking.expireDispute(didHash);
    }

    function test_expireDispute_reverts_atExactExpiry() public {
        _deposit();
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "");
        uint256 disputedAt = vm.getBlockTimestamp();
        vm.prank(operator);
        staking.disputeSlash(didHash);

        uint256 expiresAt = disputedAt + staking.DISPUTE_RESOLUTION_PERIOD();
        vm.warp(expiresAt);
        vm.expectRevert(
            abi.encodeWithSelector(SigvaraStaking.DisputeResolutionActive.selector, didHash, expiresAt)
        );
        staking.expireDispute(didHash);
    }

    // -------------------------------------------------------------------------
    // A proposal nobody finishes
    // -------------------------------------------------------------------------

    /// The freeze nobody could lift: the committee files, the window passes, and nobody executes or
    /// cancels. Disputing is closed by then, so the proposal stayed Pending for good and a queued
    /// withdrawal could not be claimed. Only the admin's veto could end it.
    function test_expireSlash_liftsAFreezeNobodyFinished() public {
        _deposit();
        vm.startPrank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Suspended);
        staking.initiateWithdrawal(didHash, MIN_STAKE * 2);
        vm.stopPrank();
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "evidence");

        // The window passes, nobody executes it, and the unbonding period passes too.
        vm.warp(block.timestamp + UNBONDING + 1);
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.SlashAlreadyPending.selector, didHash));
        vm.prank(operator);
        staking.claimWithdrawal(didHash);

        vm.prank(stranger);
        staking.expireSlash(didHash);

        uint256 before = svr.balanceOf(operator);
        vm.prank(operator);
        staking.claimWithdrawal(didHash);
        assertEq(svr.balanceOf(operator), before + MIN_STAKE * 2, "the whole stake came back");
    }

    /// Anyone can expire it, but not before the executor has had its fortnight, to the second.
    function test_expireSlash_reverts_atExactExpiryAndOpensASecondLater() public {
        _deposit();
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "evidence");
        uint256 expiresAt = staking.getSlashProposal(didHash).challengeDeadline + staking.EXECUTION_PERIOD();

        vm.warp(expiresAt);
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.ExecutionPeriodActive.selector, didHash, expiresAt));
        staking.expireSlash(didHash);

        vm.warp(expiresAt + 1);
        staking.expireSlash(didHash);
        assertEq(uint8(staking.getSlashProposal(didHash).state), uint8(SigvaraStaking.SlashState.Cancelled));
    }

    /// An expired proposal is dropped like any other: the agent is reinstated and the committee waits
    /// a challenge period before it can file again.
    function test_expireSlash_dropsTheProposalReinstatesTheAgentAndStartsTheCooldown() public {
        _deposit();
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "evidence");
        vm.warp(block.timestamp + CHALLENGE + staking.EXECUTION_PERIOD() + 1);

        vm.expectEmit(address(staking));
        emit SigvaraStaking.SlashCancelled(didHash, stranger);
        vm.prank(stranger);
        staking.expireSlash(didHash);

        assertTrue(identity.isActive(didHash), "reinstated");
        assertFalse(identity.slashSuspended(didHash));
        assertEq(staking.lastDroppedAt(didHash), block.timestamp);
        vm.expectRevert(abi.encodeWithSelector(
            SigvaraStaking.SlashCooldownActive.selector, didHash, block.timestamp + CHALLENGE
        ));
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "again");
    }

    /// Only a Pending proposal can lapse. A disputed one has its own expiry, and an ended one nothing.
    function test_expireSlash_reverts_unlessAProposalIsPending() public {
        _deposit();
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.NoActivePendingSlash.selector, didHash));
        staking.expireSlash(didHash); // nothing filed

        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "evidence");
        vm.prank(operator);
        staking.disputeSlash(didHash);
        vm.warp(block.timestamp + CHALLENGE + staking.EXECUTION_PERIOD() + 1);
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.NoActivePendingSlash.selector, didHash));
        staking.expireSlash(didHash); // disputed

        vm.prank(admin);
        staking.vetoSlash(didHash);
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.NoActivePendingSlash.selector, didHash));
        staking.expireSlash(didHash); // cancelled
    }

    function test_expireSlash_cannotUndoAnExecutedSlash() public {
        _setupPendingSlash();
        staking.executeSlash(didHash);
        vm.warp(block.timestamp + staking.EXECUTION_PERIOD() + 1);
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.NoActivePendingSlash.selector, didHash));
        staking.expireSlash(didHash);
        assertEq(uint8(staking.getSlashProposal(didHash).state), uint8(SigvaraStaking.SlashState.Executed));
    }

    /// Nothing about expiry takes execution away: until someone expires it, a proposal past its
    /// fortnight can still be executed, as an undisputed slash always could.
    function test_executeSlash_stillWorksPastTheExecutionPeriodUntilSomeoneExpiresIt() public {
        _setupPendingSlash();
        vm.warp(block.timestamp + staking.EXECUTION_PERIOD() + 1);
        staking.executeSlash(didHash);
        assertEq(uint8(staking.getSlashProposal(didHash).state), uint8(SigvaraStaking.SlashState.Executed));
        assertGt(staking.claimable(victim), 0);
    }

    function test_executionPeriod_isAFortnight() public view {
        assertEq(staking.EXECUTION_PERIOD(), 14 days);
    }

    function test_claimSlashProceeds_paysVictimAndReporter_once() public {
        _setupPendingSlash();
        staking.executeSlash(didHash);

        uint256 total = MIN_STAKE * 2;
        assertEq(staking.claimable(victim), total / 4);
        assertEq(staking.claimable(committee), total - total / 2 - total / 4);

        vm.prank(victim);
        uint256 paid = staking.claimSlashProceeds();
        assertEq(paid, total / 4);
        assertEq(svr.balanceOf(victim), total / 4);
        assertEq(staking.claimable(victim), 0);

        vm.prank(committee);
        staking.claimSlashProceeds();
        assertEq(svr.balanceOf(committee), total - total / 2 - total / 4);

        // Everything the stake held has left the contract: burn plus both claims.
        assertEq(svr.balanceOf(address(staking)), 0);

        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.NothingClaimable.selector, victim));
        vm.prank(victim);
        staking.claimSlashProceeds();
    }

    function test_claimSlashProceeds_reverts_nothingClaimable() public {
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.NothingClaimable.selector, stranger));
        vm.prank(stranger);
        staking.claimSlashProceeds();
    }

    /// The three shares always add up to the whole slashed amount, with the reporter
    /// absorbing the rounding dust.
    function testFuzz_executeSlash_sharesSumToTotal(uint256 extra) public {
        extra = bound(extra, 0, 9_000e18);
        uint256 total = MIN_STAKE + extra;
        svr.mint(operator, total);
        vm.prank(operator);
        staking.depositStake(didHash, total);

        uint256 t0 = vm.getBlockTimestamp();
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "");
        vm.warp(t0 + CHALLENGE + 1);
        staking.executeSlash(didHash);

        uint256 burned = svr.balanceOf(address(0xdead));
        assertEq(burned, total / 2);
        assertEq(staking.claimable(victim), total / 4);
        assertEq(burned + staking.claimable(victim) + staking.claimable(committee), total);
        assertEq(svr.balanceOf(address(staking)), total - burned);
    }

    // -------------------------------------------------------------------------
    // setMinimumStake
    // -------------------------------------------------------------------------

    function test_setMinimumStake_updatesAndGatesHasMinimumStake() public {
        _deposit(); // 2 * MIN_STAKE
        assertTrue(staking.hasMinimumStake(didHash));

        vm.expectEmit(address(staking));
        emit SigvaraStaking.MinimumStakeUpdated(MIN_STAKE * 3);
        vm.prank(admin);
        staking.setMinimumStake(MIN_STAKE * 3);

        assertEq(staking.minimumStake(), MIN_STAKE * 3);
        assertFalse(staking.hasMinimumStake(didHash));
    }

    function test_setMinimumStake_reverts_notAdmin() public {
        bytes32 role = staking.DEFAULT_ADMIN_ROLE();
        vm.expectRevert(abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, role
        ));
        vm.prank(stranger);
        staking.setMinimumStake(1);
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
