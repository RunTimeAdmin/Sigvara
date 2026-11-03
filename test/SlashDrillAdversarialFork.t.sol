// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "../src/SigvaraStaking.sol";
import "../src/SigvaraIdentity.sol";
import "../src/SVRToken.sol";

/**
 * The adversarial slash drill, rehearsed against the live Arc testnet deployment.
 *
 * The first drill (docs/slash-drill-log.md) took one slash down the happy path: filed, left
 * alone, executed. Every other way a proposal can end was tested only in a clean-room deploy.
 * This runs them on the live wiring, in the order the live drill does (docs/slash-drill.md,
 * "The adversarial drill"), against three agents set up the way the live drill sets them up:
 * a fresh operator, faucet SVR, an agent key that signs its own registration.
 *
 *   A  filed, disputed by its operator, dropped by the admin's ruling (resolveDispute false).
 *      Then the re-file cooldown, and after it the rejected evidence refused.
 *   B  filed and vetoed by the admin.
 *   C  filed and left alone until it lapses, then expired by anyone (expireSlash).
 *
 * Each step asserts the guard that should hold at that moment, then the step itself, so a
 * guard that never fires is visible here and not first on the live chain.
 *
 *   forge test --match-contract SlashDrillAdversarialFork -vv
 */
contract SlashDrillAdversarialForkTest is Test {
    SigvaraStaking  constant STAKING  = SigvaraStaking(0xA69d62B2a6774D21A2c15d5d83b27277eD31d35B);
    SigvaraIdentity constant IDENTITY = SigvaraIdentity(0x7e3aFC532eE5d922ab3cc3FFb510c7C8151477Dd);
    SVRToken        constant SVR      = SVRToken(0x41De2D6D55318e197a00E8f5B496eA2790e23E6c);

    address constant ADMIN     = 0x18CBcE50390f5f6ebe4E20Fc17833F25c8D94811; // DEFAULT_ADMIN_ROLE
    address constant COMMITTEE = 0x045D6C1d8404297F13596061388f6598fA94a5b7; // SLASHING_COMMITTEE_ROLE

    address operator = makeAddr("drill operator");
    address passerby = makeAddr("passerby");
    bytes32 a;
    bytes32 b;
    bytes32 c;
    uint256 bond;
    uint256 window;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("arc_testnet"));
        assertTrue(STAKING.hasRole(STAKING.SLASHING_COMMITTEE_ROLE(), COMMITTEE), "committee role moved");
        assertTrue(STAKING.hasRole(STAKING.DEFAULT_ADMIN_ROLE(), ADMIN), "admin role moved");

        bond = STAKING.minimumStake();
        window = STAKING.challengePeriod();

        // The faucet is how the live operator funds itself: one call, at most 10,000 SVR a day.
        vm.prank(operator);
        SVR.faucet(3 * bond);
        vm.prank(operator);
        SVR.approve(address(STAKING), 3 * bond);

        a = _registerAndBond("drill agent A");
        b = _registerAndBond("drill agent B");
        c = _registerAndBond("drill agent C");
    }

    function test_adversarialDrill_inLiveOrder() public {
        uint256 day0 = block.timestamp;

        // ---- Day 0: file all three. Each agent is suspended at once. ----
        _file(a, "drill A: dispute, then the admin rules for the agent");
        _file(b, "drill B: the admin vetoes");
        _file(c, "drill C: nobody acts, it lapses");
        _assertStatus(a, SigvaraIdentity.AgentStatus.Suspended);
        _assertStatus(b, SigvaraIdentity.AgentStatus.Suspended);
        _assertStatus(c, SigvaraIdentity.AgentStatus.Suspended);

        // The committee cannot name itself the victim, and cannot file twice on one agent.
        vm.prank(COMMITTEE);
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.VictimIsReporter.selector, COMMITTEE));
        STAKING.initiateSlash(a, COMMITTEE, bytes("x"));
        vm.prank(COMMITTEE);
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.SlashAlreadyPending.selector, a));
        STAKING.initiateSlash(a, operator, bytes("x"));

        // ---- A: dispute, then resolveDispute(false). ----
        // Only the agent's operator may dispute.
        vm.prank(passerby);
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.NotOperator.selector, a, passerby));
        STAKING.disputeSlash(a);
        vm.prank(operator);
        STAKING.disputeSlash(a);
        assertEq(uint8(STAKING.getSlashProposal(a).state), uint8(SigvaraStaking.SlashState.Disputed));

        // The committee files and does not rule, and the admin cannot uphold inside the window.
        vm.prank(COMMITTEE);
        vm.expectRevert();
        STAKING.resolveDispute(a, false);
        uint256 deadlineA = STAKING.getSlashProposal(a).challengeDeadline;
        vm.prank(ADMIN);
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.ChallengePeriodActive.selector, a, deadlineA));
        STAKING.resolveDispute(a, true);

        vm.prank(ADMIN);
        STAKING.resolveDispute(a, false);
        assertEq(uint8(STAKING.getSlashProposal(a).state), uint8(SigvaraStaking.SlashState.Cancelled));
        _assertStatus(a, SigvaraIdentity.AgentStatus.Active);
        assertEq(STAKING.getStake(a), bond, "A's bond moved");

        // The re-file cooldown: one challenge period from the drop.
        uint256 refileA = STAKING.lastDroppedAt(a) + window;
        vm.prank(COMMITTEE);
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.SlashCooldownActive.selector, a, refileA));
        STAKING.initiateSlash(a, operator, bytes("drill A, second filing"));

        // ---- B: veto. ----
        // Only the admin vetoes.
        vm.prank(COMMITTEE);
        vm.expectRevert();
        STAKING.vetoSlash(b);
        vm.prank(ADMIN);
        STAKING.vetoSlash(b);
        assertEq(uint8(STAKING.getSlashProposal(b).state), uint8(SigvaraStaking.SlashState.Cancelled));
        _assertStatus(b, SigvaraIdentity.AgentStatus.Active);
        assertEq(STAKING.getStake(b), bond, "B's bond moved");
        uint256 refileB = STAKING.lastDroppedAt(b) + window;
        vm.prank(COMMITTEE);
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.SlashCooldownActive.selector, b, refileB));
        STAKING.initiateSlash(b, operator, bytes("drill B, second filing"));

        // ---- C: nothing happens yet. Too early to execute, far too early to expire. ----
        SigvaraStaking.SlashProposal memory pc = STAKING.getSlashProposal(c);
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.ChallengePeriodActive.selector, c, pc.challengeDeadline));
        STAKING.executeSlash(c);
        uint256 lapseC = pc.challengeDeadline + STAKING.EXECUTION_PERIOD();
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.ExecutionPeriodActive.selector, c, lapseC));
        STAKING.expireSlash(c);

        // ---- Day 7: A's cooldown is over. ----
        vm.warp(refileA);
        // The evidence the admin ruled against is refused unchanged.
        vm.prank(COMMITTEE);
        vm.expectRevert(abi.encodeWithSelector(
            SigvaraStaking.EvidenceAlreadyRejected.selector, a, keccak256(bytes("drill A: dispute, then the admin rules for the agent"))
        ));
        STAKING.initiateSlash(a, operator, bytes("drill A: dispute, then the admin rules for the agent"));
        // New evidence is accepted, and the committee withdraws it, which starts another cooldown.
        _file(a, "drill A, day 7: new evidence, then withdrawn");
        vm.prank(COMMITTEE);
        STAKING.cancelSlash(a);
        _assertStatus(a, SigvaraIdentity.AgentStatus.Active);

        // C's window has closed: its operator can no longer dispute.
        vm.warp(pc.challengeDeadline + 1);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.ChallengePeriodExpired.selector, c, pc.challengeDeadline));
        STAKING.disputeSlash(c);
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.ExecutionPeriodActive.selector, c, lapseC));
        STAKING.expireSlash(c);

        // ---- Day 21: C lapses, and anyone may expire it. ----
        vm.warp(lapseC);
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.ExecutionPeriodActive.selector, c, lapseC));
        STAKING.expireSlash(c);
        vm.warp(lapseC + 1);
        vm.prank(passerby);
        STAKING.expireSlash(c);
        assertEq(uint8(STAKING.getSlashProposal(c).state), uint8(SigvaraStaking.SlashState.Cancelled));
        _assertStatus(c, SigvaraIdentity.AgentStatus.Active);
        assertEq(STAKING.getStake(c), bond, "C's bond moved");
        // Expired is dropped like any other: the cooldown applies, and the lapsed proposal is
        // no longer executable.
        vm.prank(COMMITTEE);
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.SlashCooldownActive.selector, c, lapseC + 1 + window));
        STAKING.initiateSlash(c, operator, bytes("drill C, second filing"));
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.NoActivePendingSlash.selector, c));
        STAKING.executeSlash(c);

        // Nothing was taken from anyone, in three weeks of trying.
        assertEq(STAKING.getStake(a) + STAKING.getStake(b) + STAKING.getStake(c), 3 * bond);
        emit log_named_uint("days the drill spans", (block.timestamp - day0) / 1 days);
    }

    /// The live drill's one exposure: between C's challenge deadline and its lapse, a proposal
    /// nobody disputed is executable by anyone, as the protocol intends. A passer-by who settles
    /// it burns three quarters of C's bond and ends the expire path early. Recorded here so the
    /// log can say whether it happened.
    function test_lapsingProposalIsExecutableUntilItLapses() public {
        _file(c, "drill C: nobody acts, it lapses");
        SigvaraStaking.SlashProposal memory pc = STAKING.getSlashProposal(c);
        vm.warp(pc.challengeDeadline + 1);
        vm.prank(passerby);
        STAKING.executeSlash(c);
        assertEq(STAKING.getStake(c), 0);
        assertEq(STAKING.claimable(operator), bond / 4, "the victim's quarter goes to the named victim");
    }

    // ---- helpers ----

    function _registerAndBond(string memory name) internal returns (bytes32 did) {
        (address agent, uint256 key) = makeAddrAndKey(name);
        bytes32 pubKey = keccak256(abi.encodePacked("ed25519 placeholder for ", name));
        bytes32 digest = IDENTITY.registrationDigest(agent, operator, pubKey);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, MessageHashUtils.toEthSignedMessageHash(digest));
        vm.prank(operator);
        did = IDENTITY.registerAgent(agent, pubKey, abi.encodePacked(r, s, v));
        _assertStatus(did, SigvaraIdentity.AgentStatus.PendingBond);
        vm.prank(operator);
        STAKING.depositStake(did, bond);
        _assertStatus(did, SigvaraIdentity.AgentStatus.Active);
    }

    function _file(bytes32 did, string memory evidence) internal {
        // The victim is the drill operator: never the committee, and the only one paid if a
        // proposal is ever executed.
        vm.prank(COMMITTEE);
        STAKING.initiateSlash(did, operator, bytes(evidence));
    }

    function _assertStatus(bytes32 did, SigvaraIdentity.AgentStatus want) internal view {
        (,,, SigvaraIdentity.AgentStatus got,) = IDENTITY.identities(did);
        assertEq(uint8(got), uint8(want), "agent status");
    }
}
