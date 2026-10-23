// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "./helpers/RegistrationHelper.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import "../src/SigvaraIdentity.sol";
import "../src/SigvaraReputation.sol";
import "../src/SigvaraStaking.sol";

contract REMock is ERC20 {
    constructor() ERC20("Sigvara", "SVR") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/**
 * Regression tests for refusing evidence the admin has already rejected.
 *
 * After a drop the committee waits one challenge period and may file again against the same
 * agent. Nothing remembered that the admin had already vetoed, or ruled against, the very same
 * evidence, so a proposal the admin rejected could be filed again unchanged every period, each
 * time suspending the agent and freezing its bond until the admin vetoed it once more.
 *
 * This is a speed bump and not a wall: the committee chooses the evidence bytes and can change
 * them. What it does is make filing the same accusation again a deliberate act that needs
 * something new to point at, which is what the contract's own comments already ask of a re-file.
 */
contract RejectedEvidenceTest is Test, RegistrationHelper {
    REMock svr;
    SigvaraIdentity identity;
    SigvaraReputation rep;
    SigvaraStaking staking;

    address admin     = makeAddr("admin");
    address committee = makeAddr("committee");
    address oracle    = makeAddr("oracle");
    address operator  = makeAddr("operator");
    address operator2 = makeAddr("operator2");
    address victim    = makeAddr("victim");

    uint256 agentPk;
    uint256 agentPk2;

    uint256 constant STAKE     = 10_000e18;
    uint256 constant MIN_STAKE = 1000e18;
    uint256 constant CHALLENGE = 7 days;
    uint256 constant UNBONDING = 21 days;

    bytes constant EVIDENCE  = "evidence-package-one";
    bytes constant EVIDENCE2 = "evidence-package-two";

    bytes32 didHash;
    bytes32 didHash2;

    function setUp() public {
        (, agentPk) = makeAddrAndKey("agent");
        (, agentPk2) = makeAddrAndKey("agent2");
        svr = new REMock();
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

        didHash  = _registerAndStake(operator, agentPk, bytes32(uint256(1)));
        didHash2 = _registerAndStake(operator2, agentPk2, bytes32(uint256(2)));
    }

    function _registerAndStake(address op, uint256 pk, bytes32 pubKey) internal returns (bytes32 did) {
        did = registerSigned(identity, op, pk, pubKey);
        svr.mint(op, STAKE);
        vm.startPrank(op);
        svr.approve(address(staking), STAKE);
        staking.depositStake(did, STAKE);
        vm.stopPrank();
    }

    function _file(bytes32 did, bytes memory evidence) internal {
        vm.prank(committee);
        staking.initiateSlash(did, victim, evidence);
    }

    function _veto(bytes32 did) internal {
        vm.prank(admin);
        staking.vetoSlash(did);
    }

    function _pastTheCooldown() internal {
        vm.warp(block.timestamp + CHALLENGE + 1);
    }

    function _refusedAs(bytes32 did, bytes memory evidence) internal {
        vm.expectRevert(abi.encodeWithSelector(
            SigvaraStaking.EvidenceAlreadyRejected.selector, did, keccak256(evidence)
        ));
        vm.prank(committee);
        staking.initiateSlash(did, victim, evidence);
    }

    /// The headline case: the admin vetoed it, the cooldown passed, the same package comes back.
    function test_vetoedEvidence_cannotBeFiledAgain() public {
        assertFalse(staking.evidenceRejected(didHash, keccak256(EVIDENCE)));
        _file(didHash, EVIDENCE);
        _veto(didHash);
        assertTrue(staking.evidenceRejected(didHash, keccak256(EVIDENCE)), "the veto is recorded");

        _pastTheCooldown();
        _refusedAs(didHash, EVIDENCE);
        assertEq(uint8(identity.getIdentity(didHash).status), uint8(SigvaraIdentity.AgentStatus.Active), "not suspended again");
    }

    /// New evidence is the way back in.
    function test_differentEvidence_canBeFiledAfterTheCooldown() public {
        _file(didHash, EVIDENCE);
        _veto(didHash);
        _pastTheCooldown();

        _file(didHash, EVIDENCE2);
        assertEq(uint8(staking.getSlashProposal(didHash).state), uint8(SigvaraStaking.SlashState.Pending));
    }

    /// An admin ruling in the agent's favour is a rejection too.
    function test_aRulingForTheAgent_rejectsTheEvidence() public {
        _file(didHash, EVIDENCE);
        vm.prank(operator);
        staking.disputeSlash(didHash);
        vm.prank(admin);
        staking.resolveDispute(didHash, false);
        assertTrue(staking.evidenceRejected(didHash, keccak256(EVIDENCE)));

        _pastTheCooldown();
        _refusedAs(didHash, EVIDENCE);
    }

    /// Upholding is not a rejection: the slash lands and the agent is gone.
    function test_anUpheldRuling_rejectsNothing() public {
        _file(didHash, EVIDENCE);
        vm.prank(operator);
        staking.disputeSlash(didHash);
        vm.warp(block.timestamp + CHALLENGE + 1);
        vm.prank(admin);
        staking.resolveDispute(didHash, true);

        assertFalse(staking.evidenceRejected(didHash, keccak256(EVIDENCE)));
    }

    /// The committee withdrawing its own proposal is not the admin ruling against it. It may be fixing
    /// a wrong victim address, which is a reason to file the same evidence again.
    function test_aCommitteeCancel_doesNotRejectTheEvidence() public {
        _file(didHash, EVIDENCE);
        vm.prank(committee);
        staking.cancelSlash(didHash);
        _pastTheCooldown();

        _file(didHash, EVIDENCE);
        assertEq(uint8(staking.getSlashProposal(didHash).state), uint8(SigvaraStaking.SlashState.Pending));
    }

    /// A proposal that lapsed because nobody executed it was never ruled on, and a keeper outage
    /// must not make a legitimate slash unfileable.
    function test_aLapsedProposal_doesNotRejectTheEvidence() public {
        _file(didHash, EVIDENCE);
        vm.warp(block.timestamp + CHALLENGE + staking.EXECUTION_PERIOD() + 1);
        staking.expireSlash(didHash);
        assertFalse(staking.evidenceRejected(didHash, keccak256(EVIDENCE)));

        _pastTheCooldown();
        _file(didHash, EVIDENCE);
        assertEq(uint8(staking.getSlashProposal(didHash).state), uint8(SigvaraStaking.SlashState.Pending));
    }

    /// Nor does a dispute the admin never ruled on: that is silence, not a ruling.
    function test_anExpiredDispute_doesNotRejectTheEvidence() public {
        _file(didHash, EVIDENCE);
        vm.prank(operator);
        staking.disputeSlash(didHash);
        vm.warp(block.timestamp + staking.DISPUTE_RESOLUTION_PERIOD() + 1);
        staking.expireDispute(didHash);
        assertFalse(staking.evidenceRejected(didHash, keccak256(EVIDENCE)));

        _pastTheCooldown();
        _file(didHash, EVIDENCE);
    }

    /// A rejection belongs to one agent. The same bytes against another are a different accusation.
    function test_rejectedEvidence_isPerAgent() public {
        _file(didHash, EVIDENCE);
        _veto(didHash);
        _pastTheCooldown();

        _file(didHash2, EVIDENCE);
        assertEq(uint8(staking.getSlashProposal(didHash2).state), uint8(SigvaraStaking.SlashState.Pending));
    }

    /// The cooldown is still the first thing a re-file meets, so a keeper sees the error it always did.
    function test_theCooldownIsCheckedBeforeTheEvidence() public {
        _file(didHash, EVIDENCE);
        _veto(didHash);

        vm.expectRevert(abi.encodeWithSelector(
            SigvaraStaking.SlashCooldownActive.selector, didHash, staking.lastDroppedAt(didHash) + CHALLENGE
        ));
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, EVIDENCE);
    }
}
