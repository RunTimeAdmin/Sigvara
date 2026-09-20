// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/SigvaraStaking.sol";
import "../src/SigvaraIdentity.sol";
import "../src/SigvaraReputation.sol";

/**
 * Slash drill, rehearsed against the live Arc testnet deployment.
 *
 * A slash on the real chain is a seven-day commitment against a real bond, taken with a
 * committee key, on contracts whose wiring was configured months ago and never exercised
 * end to end in production. Improvising that is how you discover at day seven that the
 * staking contract cannot update identity status, or that the proceeds split does not do
 * what the comment says.
 *
 * So this forks the live deployment rather than deploying fresh. A fresh deploy would
 * test the code; the fork tests the code AND the live wiring: the roles actually granted
 * on Arc, the real challengePeriod, the real agent with a real bond. Everything the live
 * drill will touch, except that it costs nothing and reverts when the fork is dropped.
 *
 *   forge test --match-contract SlashDrillFork -vv
 *
 * The one thing it cannot rehearse is who signs. SLASHING_COMMITTEE_ROLE on Arc is held
 * by an address set at deployment, and none of the wallets in this repository hold it.
 * Here the role is granted on the fork from DEFAULT_ADMIN_ROLE. Before the live drill,
 * find that address and confirm you hold its key.
 */
contract SlashDrillForkTest is Test {
    // Live Arc testnet, from deployments/5042002.json
    SigvaraStaking    constant STAKING  = SigvaraStaking(0xA69d62B2a6774D21A2c15d5d83b27277eD31d35B);
    SigvaraIdentity   constant IDENTITY = SigvaraIdentity(0x7e3aFC532eE5d922ab3cc3FFb510c7C8151477Dd);
    SigvaraReputation constant REP      = SigvaraReputation(0x6603C96275e85F724Cdf74666b399365e4cA29ed);
    IERC20            constant SVR      = IERC20(0x41De2D6D55318e197a00E8f5B496eA2790e23E6c);

    address constant ADMIN = 0x18CBcE50390f5f6ebe4E20Fc17833F25c8D94811; // DEFAULT_ADMIN_ROLE
    address constant BURN  = address(0xdead);

    // The live bonded agent. Targeting the real one is the point: it has a real stake,
    // a real status and a real score, so the assertions below are about production state.
    bytes32 constant DID = 0x8414ce0bf4f1e1695193623e0a656a9439e356f8bed0b8bf249b179fe77c7e19;

    address committee = makeAddr("committee");
    address victim    = makeAddr("victim");

    uint256 stakeBefore;
    uint256 challengePeriod;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("arc_testnet"));

        // The committee address on Arc is not one this repo holds a key for, so the role
        // is granted here. On the live drill this step does not exist: you sign with the
        // wallet that already has it.
        // Read the role BEFORE pranking: vm.prank applies to the next call only, and a
        // view call in the same statement consumes it.
        bytes32 role = STAKING.SLASHING_COMMITTEE_ROLE();
        vm.prank(ADMIN);
        STAKING.grantRole(role, committee);

        stakeBefore = STAKING.getStake(DID);
        challengePeriod = STAKING.challengePeriod();

        // If this fails the drill has no target and the rest is meaningless.
        assertGt(stakeBefore, 0, "target agent has no stake on the fork");
    }

    /// The whole path, in the order the live drill runs it.
    function test_drill_fullPath() public {
        // 1. Before. The agent is live and scored.
        (,,, SigvaraIdentity.AgentStatus statusBefore,) = IDENTITY.identities(DID);
        assertEq(uint8(statusBefore), uint8(SigvaraIdentity.AgentStatus.Active), "not Active to begin with");
        emit log_named_uint("stake before        ", stakeBefore);
        emit log_named_uint("score before        ", REP.getTotalScore(DID));

        // 2. Committee files. The agent is suspended immediately, before any window runs.
        vm.prank(committee);
        STAKING.initiateSlash(DID, victim, bytes("drill: rehearsal, not a real finding"));

        SigvaraStaking.SlashProposal memory p = STAKING.getSlashProposal(DID);
        assertEq(uint8(p.state), uint8(SigvaraStaking.SlashState.Pending), "not Pending after initiate");
        assertEq(p.reporter, committee);
        assertEq(p.victim, victim);
        assertEq(p.challengeDeadline, block.timestamp + challengePeriod, "deadline not snapshotted");

        (,,, SigvaraIdentity.AgentStatus statusPending,) = IDENTITY.identities(DID);
        assertEq(uint8(statusPending), uint8(SigvaraIdentity.AgentStatus.Suspended), "not suspended on initiate");

        // 3. Too early. This is the guard that makes the window mean anything.
        vm.expectRevert(
            abi.encodeWithSelector(SigvaraStaking.ChallengePeriodActive.selector, DID, p.challengeDeadline)
        );
        STAKING.executeSlash(DID);

        // Still too early one second before it opens.
        vm.warp(p.challengeDeadline);
        vm.expectRevert();
        STAKING.executeSlash(DID);

        // 4. Window elapsed. Execution is permissionless: the committee files, anyone settles.
        vm.warp(p.challengeDeadline + 1);
        uint256 burnBefore   = SVR.balanceOf(BURN);
        uint256 stakingBefore = SVR.balanceOf(address(STAKING));

        vm.prank(makeAddr("some passerby"));
        STAKING.executeSlash(DID);

        // 5. After. Nothing left staked, agent terminal, score gone.
        assertEq(STAKING.getStake(DID), 0, "stake not cleared");
        (,,, SigvaraIdentity.AgentStatus statusAfter,) = IDENTITY.identities(DID);
        assertEq(uint8(statusAfter), uint8(SigvaraIdentity.AgentStatus.Slashed), "agent not Slashed");
        assertEq(REP.getTotalScore(DID), 0, "reputation not zeroed");

        // 6. The split the docs promise: 50% burned, 25% victim, 25% reporter.
        uint256 burned     = stakeBefore / 2;
        uint256 toVictim   = stakeBefore / 4;
        uint256 toReporter = stakeBefore - burned - toVictim;

        assertEq(SVR.balanceOf(BURN) - burnBefore, burned, "burn share wrong");
        assertEq(STAKING.claimable(victim), toVictim, "victim share wrong");
        assertEq(STAKING.claimable(committee), toReporter, "reporter share wrong");
        assertEq(burned + toVictim + toReporter, stakeBefore, "split does not conserve the stake");

        // 7. Proceeds are credited, not pushed. They have to be claimable.
        uint256 victimBefore = SVR.balanceOf(victim);
        vm.prank(victim);
        STAKING.claimSlashProceeds();
        assertEq(SVR.balanceOf(victim) - victimBefore, toVictim, "victim could not claim");

        // The contract should be left holding only what it did not just distribute.
        assertEq(
            SVR.balanceOf(address(STAKING)),
            stakingBefore - burned - toVictim,
            "staking contract balance does not reconcile"
        );

        emit log_named_uint("burned              ", burned);
        emit log_named_uint("to victim           ", toVictim);
        emit log_named_uint("to reporter         ", toReporter);
    }

    /// Disputing freezes the bond. It does not release it, and it does not un-suspend.
    function test_drill_disputeFreezesRatherThanCancels() public {
        vm.prank(committee);
        STAKING.initiateSlash(DID, victim, bytes("drill"));

        address operator = _operatorOf(DID);
        vm.prank(operator);
        STAKING.disputeSlash(DID);

        SigvaraStaking.SlashProposal memory p = STAKING.getSlashProposal(DID);
        assertEq(uint8(p.state), uint8(SigvaraStaking.SlashState.Disputed), "not Disputed");

        // The bond stays put. This is the property that stopped an operator cancelling
        // every proposal for free and walking away once unbonding elapsed.
        assertEq(STAKING.getStake(DID), stakeBefore, "stake moved on dispute");
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.SlashAlreadyPending.selector, DID));
        STAKING.initiateWithdrawal(DID, 1);
    }

    /// Committee upholds the dispute: it settles exactly as an unchallenged slash would.
    function test_drill_disputeUpheld() public {
        vm.prank(committee);
        STAKING.initiateSlash(DID, victim, bytes("drill"));
        vm.prank(_operatorOf(DID));
        STAKING.disputeSlash(DID);

        vm.prank(committee);
        STAKING.resolveDispute(DID, true);

        assertEq(STAKING.getStake(DID), 0, "stake not taken when dispute upheld");
        assertEq(STAKING.claimable(victim), stakeBefore / 4, "victim share wrong");
    }

    /// Committee rejects its own proposal: the agent gets its stake and standing back.
    function test_drill_disputeRejectedRestoresTheAgent() public {
        vm.prank(committee);
        STAKING.initiateSlash(DID, victim, bytes("drill"));
        vm.prank(_operatorOf(DID));
        STAKING.disputeSlash(DID);

        vm.prank(committee);
        STAKING.resolveDispute(DID, false);

        assertEq(STAKING.getStake(DID), stakeBefore, "stake not returned");
        (,,, SigvaraIdentity.AgentStatus s,) = IDENTITY.identities(DID);
        assertTrue(
            s == SigvaraIdentity.AgentStatus.Active || s == SigvaraIdentity.AgentStatus.PendingBond,
            "agent left suspended after a rejected slash"
        );
    }

    /// Queuing a withdrawal must not shelter the stake. This was a real escape hatch.
    ///
    /// An Active agent cannot queue everything: initiateWithdrawal keeps the active stake
    /// at or above minimumStake, and a full exit requires suspending first. So the most an
    /// operator can move out of reach in one step is the excess above the minimum. It does
    /// not help them, because executeSlash sweeps active AND queued.
    function test_drill_unbondingAmountIsAlsoSlashed() public {
        uint256 minStake = STAKING.minimumStake();
        uint256 queued = stakeBefore - minStake;

        address operator = _operatorOf(DID);
        vm.prank(operator);
        STAKING.initiateWithdrawal(DID, queued);

        // Active stake is down to the floor; the rest is queued and looks like it is leaving.
        assertEq(STAKING.getStake(DID), minStake, "active stake should sit at the minimum");

        vm.prank(committee);
        STAKING.initiateSlash(DID, victim, bytes("drill"));

        SigvaraStaking.SlashProposal memory p = STAKING.getSlashProposal(DID);
        vm.warp(p.challengeDeadline + 1);
        STAKING.executeSlash(DID);

        // The victim's quarter is a quarter of EVERYTHING, not of what was left active.
        assertEq(STAKING.claimable(victim), stakeBefore / 4, "queued stake escaped the slash");

        // And the queued withdrawal is gone rather than still claimable.
        (uint256 pendingAmt,) = STAKING.getPendingWithdrawal(DID);
        assertEq(pendingAmt, 0, "queued withdrawal survived the slash");
    }

    /// The committee cannot pay itself both halves with one signature.
    function test_drill_reporterCannotBeVictim() public {
        vm.prank(committee);
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.VictimIsReporter.selector, committee));
        STAKING.initiateSlash(DID, committee, bytes("drill"));
    }

    function _operatorOf(bytes32 didHash) internal view returns (address op) {
        (op,,,,) = IDENTITY.identities(didHash);
    }
}
