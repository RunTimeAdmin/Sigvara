// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./helpers/StackFixture.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";
import "../src/SigvaraOracleBond.sol";
import "../src/InflowGuard.sol";

interface IInflowGuardLike {
    function pauseInflows() external;
    function resumeInflows() external;
    function inflowsPaused() external view returns (bool);
    function inflowsPausedUntil() external view returns (uint256);
    function lastInflowPauseAt() external view returns (uint256);
    function GUARDIAN_ROLE() external view returns (bytes32);
}

/**
 * The guardian's pause, on the four registries that take things in. What is under test is what a
 * pause covers and, as much, what it never touches: exits, accountability and finalization have to
 * keep working, or a pause becomes a way to hold funds.
 */
contract InflowGuardTest is StackFixture {
    SigvaraOracleBond bond;

    address guardian = makeAddr("guardian");
    address slasher = makeAddr("slasher");
    address stranger = makeAddr("stranger");
    address op1 = makeAddr("op1");
    address op2 = makeAddr("op2");
    address buyer = makeAddr("buyer");

    uint256 agentPk;
    address agent;
    uint256 constant BOND_AMOUNT = 1000e18;
    bytes32 constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    function setUp() public {
        _deployStack();
        (agent, agentPk) = makeAddrAndKey("agent");

        bond = SigvaraOracleBond(address(new ERC1967Proxy(
            address(new SigvaraOracleBond()),
            abi.encodeCall(
                SigvaraOracleBond.initialize,
                (admin, slasher, address(svr), BOND_AMOUNT, 7 days, makeAddr("beneficiary"))
            )
        )));

        vm.startPrank(admin);
        identity.grantRole(GUARDIAN_ROLE, guardian);
        reputation.grantRole(GUARDIAN_ROLE, guardian);
        staking.grantRole(GUARDIAN_ROLE, guardian);
        bond.grantRole(GUARDIAN_ROLE, guardian);
        vm.stopPrank();

        address[2] memory ops = [op1, op2];
        for (uint256 i = 0; i < 2; i++) {
            svr.mint(ops[i], 10_000e18);
            vm.prank(ops[i]);
            svr.approve(address(bond), type(uint256).max);
        }
    }

    function _all() internal view returns (address[4] memory a) {
        a = [address(identity), address(reputation), address(staking), address(bond)];
    }

    function _pause(address target) internal {
        vm.prank(guardian);
        IInflowGuardLike(target).pauseInflows();
    }

    // -------------------------------------------------------------------------
    // The pause itself, the same on all four
    // -------------------------------------------------------------------------

    function test_theRoleIsTheSameOnEveryRegistry() public view {
        address[4] memory all = _all();
        for (uint256 i = 0; i < 4; i++) {
            assertEq(IInflowGuardLike(all[i]).GUARDIAN_ROLE(), GUARDIAN_ROLE);
        }
    }

    function test_pause_closesTheRegistryForThreeDaysAndSaysSo() public {
        address[4] memory all = _all();
        for (uint256 i = 0; i < 4; i++) {
            IInflowGuardLike t = IInflowGuardLike(all[i]);
            assertFalse(t.inflowsPaused());

            vm.expectEmit(true, false, false, true, all[i]);
            emit InflowGuard.InflowsPaused(guardian, block.timestamp + 3 days);
            vm.prank(guardian);
            t.pauseInflows();

            assertTrue(t.inflowsPaused());
            assertEq(t.inflowsPausedUntil(), block.timestamp + 3 days);
            assertEq(t.lastInflowPauseAt(), block.timestamp);
        }
    }

    /// Only the guardian pauses. The admin does not, which keeps the key that can stop the registry
    /// separate from the key that holds its roles, even though the admin can grant itself the role.
    function test_pause_isRefusedForEveryoneWhoIsNotAGuardian() public {
        address[4] memory all = _all();
        for (uint256 i = 0; i < 4; i++) {
            vm.expectRevert(abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, GUARDIAN_ROLE
            ));
            vm.prank(stranger);
            IInflowGuardLike(all[i]).pauseInflows();

            vm.expectRevert(abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, admin, GUARDIAN_ROLE
            ));
            vm.prank(admin);
            IInflowGuardLike(all[i]).pauseInflows();

            assertFalse(IInflowGuardLike(all[i]).inflowsPaused());
        }
    }

    function test_pause_cannotBeExtendedWhileItRuns() public {
        address[4] memory all = _all();
        for (uint256 i = 0; i < 4; i++) {
            _pause(all[i]);
            uint256 until = IInflowGuardLike(all[i]).inflowsPausedUntil();
            vm.warp(block.timestamp + 1 days);
            vm.expectRevert(abi.encodeWithSelector(InflowGuard.InflowsAlreadyPaused.selector, until));
            vm.prank(guardian);
            IInflowGuardLike(all[i]).pauseInflows();
            vm.warp(block.timestamp - 1 days);
        }
    }

    /// A pause ends by itself, and the next cannot begin until a day after the last one would have
    /// ended, so a guardian cannot hold the registry shut for good.
    function test_pause_endsAloneAndTheNextWaitsForTheCooldown() public {
        address[4] memory all = _all();
        uint256 started = block.timestamp;
        for (uint256 i = 0; i < 4; i++) _pause(all[i]);

        vm.warp(started + 3 days - 1);
        for (uint256 i = 0; i < 4; i++) assertTrue(IInflowGuardLike(all[i]).inflowsPaused(), "still paused");

        vm.warp(started + 3 days);
        for (uint256 i = 0; i < 4; i++) assertFalse(IInflowGuardLike(all[i]).inflowsPaused(), "ended by itself");

        vm.warp(started + 4 days - 1);
        for (uint256 i = 0; i < 4; i++) {
            vm.expectRevert(abi.encodeWithSelector(InflowGuard.PauseCooldownActive.selector, started + 4 days));
            vm.prank(guardian);
            IInflowGuardLike(all[i]).pauseInflows();
        }

        vm.warp(started + 4 days);
        for (uint256 i = 0; i < 4; i++) {
            _pause(all[i]);
            assertTrue(IInflowGuardLike(all[i]).inflowsPaused());
        }
    }

    function test_resume_theGuardianOrTheAdminCanLiftItEarly() public {
        address[4] memory all = _all();
        for (uint256 i = 0; i < 4; i++) {
            IInflowGuardLike t = IInflowGuardLike(all[i]);
            _pause(all[i]);

            vm.expectEmit(true, false, false, false, all[i]);
            emit InflowGuard.InflowsResumed(guardian);
            vm.prank(guardian);
            t.resumeInflows();
            assertFalse(t.inflowsPaused(), "the guardian lifted it");
        }

        // The cooldown still runs from the start of the pause, and the admin can lift one too.
        vm.warp(block.timestamp + 4 days);
        for (uint256 i = 0; i < 4; i++) {
            _pause(all[i]);
            vm.prank(admin);
            IInflowGuardLike(all[i]).resumeInflows();
            assertFalse(IInflowGuardLike(all[i]).inflowsPaused(), "the admin lifted it");
        }
    }

    function test_resume_refusesStrangersAndAPauseThatIsNotRunning() public {
        address[4] memory all = _all();
        for (uint256 i = 0; i < 4; i++) {
            vm.expectRevert(InflowGuard.InflowsNotPaused.selector);
            vm.prank(guardian);
            IInflowGuardLike(all[i]).resumeInflows();

            _pause(all[i]);
            vm.expectRevert(abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, bytes32(0)
            ));
            vm.prank(stranger);
            IInflowGuardLike(all[i]).resumeInflows();
        }
    }

    /// Lifting a pause early does not shorten the wait for the next one: counted from the start.
    function test_resume_doesNotShortenTheCooldown() public {
        _pause(address(staking));
        uint256 started = block.timestamp;
        vm.warp(started + 1 hours);
        vm.prank(guardian);
        staking.resumeInflows();

        vm.expectRevert(abi.encodeWithSelector(InflowGuard.PauseCooldownActive.selector, started + 4 days));
        vm.prank(guardian);
        staking.pauseInflows();
    }

    function test_revokingTheGuardianTakesTheRightAwayAtOnce() public {
        address[4] memory all = _all();
        vm.startPrank(admin);
        identity.revokeRole(GUARDIAN_ROLE, guardian);
        reputation.revokeRole(GUARDIAN_ROLE, guardian);
        staking.revokeRole(GUARDIAN_ROLE, guardian);
        bond.revokeRole(GUARDIAN_ROLE, guardian);
        vm.stopPrank();

        for (uint256 i = 0; i < 4; i++) {
            vm.expectRevert(abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, guardian, GUARDIAN_ROLE
            ));
            vm.prank(guardian);
            IInflowGuardLike(all[i]).pauseInflows();
        }
    }

    // -------------------------------------------------------------------------
    // Storage: a namespaced slot, so a live proxy's layout does not move
    // -------------------------------------------------------------------------

    function test_theStateLivesInTheNamespacedSlot() public {
        bytes32 slot = keccak256(abi.encode(uint256(keccak256("sigvara.storage.InflowGuard")) - 1))
            & ~bytes32(uint256(0xff));
        assertEq(slot, 0x287c8fb15631f80ef6f31f6f05488520b9eeb2c6cd268d791bdb00597a165800, "the constant matches the formula");

        address[4] memory all = _all();
        for (uint256 i = 0; i < 4; i++) {
            assertEq(uint256(vm.load(all[i], slot)), 0, "nothing before a pause");
            _pause(all[i]);
            uint256 packed = uint256(vm.load(all[i], slot));
            assertEq(packed & type(uint64).max, block.timestamp + 3 days, "pausedUntil is the low 64 bits");
            assertEq(packed >> 64, block.timestamp, "lastPausedAt is the next 64");
        }
    }

    // -------------------------------------------------------------------------
    // What a pause closes
    // -------------------------------------------------------------------------

    function test_identity_registerAgentIsClosedWhilePausedAndOpenAfter() public {
        bytes memory sig = signRegistration(identity, agentPk, operator, PUB_KEY);
        _pause(address(identity));
        uint256 until = identity.inflowsPausedUntil();

        vm.expectRevert(abi.encodeWithSelector(InflowGuard.InflowsPausedUntil.selector, until));
        vm.prank(operator);
        identity.registerAgent(agent, PUB_KEY, sig);

        vm.warp(until);
        vm.prank(operator);
        identity.registerAgent(agent, PUB_KEY, sig);
        assertTrue(identity.getIdentity(identity.computeDidHash(agent)).registeredAt != 0);
    }

    function test_staking_depositStakeIsClosedWhilePaused() public {
        bytes32 didHash = registerSigned(identity, operator, agentPk, PUB_KEY);
        _pause(address(staking));
        uint256 until = staking.inflowsPausedUntil();

        vm.expectRevert(abi.encodeWithSelector(InflowGuard.InflowsPausedUntil.selector, until));
        vm.prank(operator);
        staking.depositStake(didHash, MIN_STAKE);

        vm.warp(until);
        vm.prank(operator);
        staking.depositStake(didHash, MIN_STAKE);
        assertEq(staking.getStake(didHash), MIN_STAKE);
    }

    function test_reputation_bothProposalPathsAreClosedWhilePaused() public {
        bytes32 didHash = _registerAndBond(agentPk, MIN_STAKE);
        _pause(address(reputation));
        uint256 until = reputation.inflowsPausedUntil();

        vm.expectRevert(abi.encodeWithSelector(InflowGuard.InflowsPausedUntil.selector, until));
        vm.prank(oracle);
        reputation.proposeReputation(didHash, _score40(), bytes32(0));

        vm.expectRevert(abi.encodeWithSelector(InflowGuard.InflowsPausedUntil.selector, until));
        vm.prank(oracle);
        reputation.proposeIfEmpty(didHash, _score40(), bytes32(0));

        vm.warp(until);
        vm.prank(oracle);
        reputation.proposeReputation(didHash, _score40(), bytes32(0));
        assertTrue(reputation.getPendingScore(didHash).exists);
    }

    function test_oracleBond_depositBondIsClosedWhilePaused() public {
        _pause(address(bond));
        uint256 until = bond.inflowsPausedUntil();

        vm.expectRevert(abi.encodeWithSelector(InflowGuard.InflowsPausedUntil.selector, until));
        vm.prank(op1);
        bond.depositBond(BOND_AMOUNT);

        vm.warp(until);
        vm.prank(op1);
        bond.depositBond(BOND_AMOUNT);
        assertEq(bond.bondOf(op1), BOND_AMOUNT);
    }

    // -------------------------------------------------------------------------
    // What a pause never closes
    // -------------------------------------------------------------------------

    /// Identity: operator transfers, key rotation and status changes all keep working.
    function test_identity_everythingButRegistrationKeepsWorkingWhilePaused() public {
        bytes32 didHash = _registerAndBond(agentPk, MIN_STAKE);
        _pause(address(identity));

        vm.prank(operator);
        identity.rotatePublicKey(didHash, bytes32(uint256(0xfeed)));
        vm.prank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Suspended);
        vm.prank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Active);

        vm.prank(operator);
        identity.offerOperatorTransfer(didHash, buyer);
        vm.prank(buyer);
        identity.acceptOperatorTransfer(didHash);
        assertEq(identity.getIdentity(didHash).operator, buyer);
    }

    /// Staking: the whole slash lifecycle and the whole exit keep working, and so does collecting
    /// proceeds. A pause that blocked these would let a guardian shield an agent from a slash or
    /// hold an operator's bond.
    function test_staking_slashingAndWithdrawingKeepWorkingWhilePaused() public {
        bytes32 didHash = _registerAndBond(agentPk, 2 * MIN_STAKE);
        _pause(address(staking));

        // A slash the committee files and the admin drops, under a pause.
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "evidence");
        vm.prank(admin);
        staking.vetoSlash(didHash);

        // After the committee's cooldown it files again, under a second pause, and the whole
        // lifecycle runs to a settlement.
        vm.warp(block.timestamp + SLASH_WINDOW);
        _pause(address(staking));
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "stronger evidence");
        vm.prank(operator);
        staking.disputeSlash(didHash);
        vm.prank(committee);
        staking.resolveDispute(didHash, true); // upheld: executes
        assertEq(uint8(staking.getSlashProposal(didHash).state), uint8(SigvaraStaking.SlashState.Executed));

        vm.prank(victim);
        staking.claimSlashProceeds();
        assertGt(svr.balanceOf(victim), 0, "proceeds are collectable under a pause");
    }

    /// The two ways a slash nobody disputed can end: the committee withdraws it, or anyone settles
    /// it once its window has closed. A pause that blocked either would let a guardian shield an
    /// agent from a slash it never contested, or leave one hanging over it.
    function test_staking_cancellingAndExecutingASlashKeepWorkingWhilePaused() public {
        bytes32 didHash = _registerAndBond(agentPk, 2 * MIN_STAKE);
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "evidence");
        _pause(address(staking));
        vm.prank(committee);
        staking.cancelSlash(didHash);
        assertEq(uint8(staking.getSlashProposal(didHash).state), uint8(SigvaraStaking.SlashState.Cancelled));

        // The committee's cooldown has passed, and so has the first pause.
        vm.warp(block.timestamp + SLASH_WINDOW);
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "stronger evidence");
        vm.warp(block.timestamp + SLASH_WINDOW + 1);
        _pause(address(staking));
        staking.executeSlash(didHash);
        assertEq(uint8(staking.getSlashProposal(didHash).state), uint8(SigvaraStaking.SlashState.Executed));
    }

    function test_staking_withdrawingKeepsWorkingWhilePaused() public {
        bytes32 didHash = _registerAndBond(agentPk, 2 * MIN_STAKE);
        vm.startPrank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Suspended);
        vm.stopPrank();
        _pause(address(staking));

        vm.prank(operator);
        staking.initiateWithdrawal(didHash, 2 * MIN_STAKE);
        vm.warp(block.timestamp + UNBONDING);
        _pause(address(staking)); // the first has ended; a second
        uint256 before = svr.balanceOf(operator);
        vm.prank(operator);
        staking.claimWithdrawal(didHash);
        assertEq(svr.balanceOf(operator), before + 2 * MIN_STAKE, "the bond came back under a pause");
    }

    /// Reputation: a score already proposed can still be rejected by the committee or finalized by
    /// anyone, so a pause neither buries a bad proposal nor strands a good one.
    function test_reputation_finalizingAndRejectingKeepWorkingWhilePaused() public {
        bytes32 didHash = _registerAndBond(agentPk, MIN_STAKE);
        vm.prank(oracle);
        reputation.proposeReputation(didHash, _score40(), bytes32(0));
        _pause(address(reputation));

        vm.prank(committee);
        reputation.rejectReputation(didHash);
        assertFalse(reputation.getPendingScore(didHash).exists);

        vm.warp(block.timestamp + 4 days); // the pause has ended and its cooldown has passed
        vm.prank(oracle);
        reputation.proposeReputation(didHash, _score40(), bytes32(0));
        _pause(address(reputation));
        vm.warp(block.timestamp + SCORE_WINDOW + 1);
        reputation.finalizeReputation(didHash);
        assertEq(reputation.getEarnedScore(didHash), 40);
    }

    /// Bond registry: leaving, withdrawing, slashing and removing an operator all keep working.
    function test_oracleBond_leavingWithdrawingAndSlashingKeepWorkingWhilePaused() public {
        vm.prank(op1);
        bond.depositBond(BOND_AMOUNT);
        vm.prank(op2);
        bond.depositBond(BOND_AMOUNT);
        vm.startPrank(admin);
        bond.admit(op1);
        bond.admit(op2);
        vm.stopPrank();
        _pause(address(bond));

        vm.prank(slasher);
        bond.slash(op2, 1e18);
        vm.prank(admin);
        bond.removeOperator(op2);

        vm.prank(op1);
        bond.initiateUnbond();
        vm.warp(block.timestamp + 7 days);
        _pause(address(bond)); // the first has ended; a second
        uint256 before = svr.balanceOf(op1);
        vm.prank(op1);
        bond.withdrawBond();
        assertEq(svr.balanceOf(op1), before + BOND_AMOUNT, "the bond came back under a pause");
    }
}
