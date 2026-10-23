// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "./helpers/RegistrationHelper.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import "../src/SigvaraIdentity.sol";
import "../src/SigvaraReputation.sol";
import "../src/SigvaraStaking.sol";

contract RAMock is ERC20 {
    constructor() ERC20("Sigvara", "SVR") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/**
 * Regression tests for executing a slash whose reporter has lost the committee role.
 *
 * Before the change, revoking a committee member stopped it filing new slashes and did nothing
 * about the ones it had already filed. Execution is permissionless, so a proposal filed by a key
 * that was later found to be compromised stayed Pending, and once its window closed anyone could
 * execute it and the revoked reporter was paid its quarter. The only remedy for filings already
 * made was an admin veto per agent, inside a window that can be as short as three days.
 *
 * SigvaraReputation already behaves the other way for scores: a proposal whose proposer has lost
 * its authority is not finalized. These tests hold staking to the same rule.
 */
contract ReporterAuthorityTest is Test, RegistrationHelper {
    RAMock svr;
    SigvaraIdentity identity;
    SigvaraReputation rep;
    SigvaraStaking staking;

    address admin      = makeAddr("admin");
    address committee  = makeAddr("committee");
    address committee2 = makeAddr("committee2");
    address oracle     = makeAddr("oracle");
    address operator   = makeAddr("operator");
    address operator2  = makeAddr("operator2");
    address victim     = makeAddr("victim");
    address stranger   = makeAddr("stranger");

    uint256 agentPk;
    uint256 agentPk2;

    uint256 constant STAKE     = 10_000e18;
    uint256 constant MIN_STAKE = 1000e18;
    uint256 constant CHALLENGE = 7 days;
    uint256 constant UNBONDING = 21 days;

    bytes32 didHash;
    bytes32 didHash2;
    bytes32 role;

    function setUp() public {
        (, agentPk) = makeAddrAndKey("agent");
        (, agentPk2) = makeAddrAndKey("agent2");
        svr = new RAMock();
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
        role = staking.SLASHING_COMMITTEE_ROLE();
        vm.startPrank(admin);
        identity.initializeV2(address(staking));
        identity.grantRole(identity.STAKING_CORE_ROLE(), address(staking));
        rep.grantRole(rep.STAKING_CORE_ROLE(), address(staking));
        staking.grantRole(role, committee);
        staking.grantRole(role, committee2);
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

    function _file(address reporter, bytes32 did) internal {
        vm.prank(reporter);
        staking.initiateSlash(did, victim, bytes("evidence"));
    }

    function _revoke(address member) internal {
        vm.prank(admin);
        staking.revokeRole(role, member);
        assertFalse(staking.hasRole(role, member), "member should be gone");
    }

    function _status(bytes32 did) internal view returns (SigvaraIdentity.AgentStatus) {
        return identity.getIdentity(did).status;
    }

    /// The headline case: the key is revoked after the window has closed, before anyone executed.
    function test_revokedReporter_slashCannotBeExecuted() public {
        _file(committee, didHash);
        vm.warp(block.timestamp + CHALLENGE + 1);
        _revoke(committee);

        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.ReporterNotAuthorized.selector, didHash, committee));
        vm.prank(stranger);
        staking.executeSlash(didHash);

        assertEq(staking.getStake(didHash), STAKE, "bond untouched");
        assertEq(staking.claimable(committee), 0, "revoked reporter was not paid");
        assertEq(staking.claimable(victim), 0, "victim was not paid");
        assertEq(uint8(staking.getSlashProposal(didHash).state), uint8(SigvaraStaking.SlashState.Pending));
    }

    /// Revoking while the window is still open blocks it just the same once the window closes.
    function test_revokedInsideTheWindow_blocksExecutionAfterIt() public {
        _file(committee, didHash);
        _revoke(committee);
        vm.warp(block.timestamp + CHALLENGE + 1);

        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.ReporterNotAuthorized.selector, didHash, committee));
        vm.prank(stranger);
        staking.executeSlash(didHash);
    }

    /// The window is checked first, so a keeper that polls early sees the same error as before.
    function test_executeChecksTheWindowBeforeTheRole() public {
        _file(committee, didHash);
        _revoke(committee);

        uint256 deadline = staking.getSlashProposal(didHash).challengeDeadline;
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.ChallengePeriodActive.selector, didHash, deadline));
        vm.prank(stranger);
        staking.executeSlash(didHash);
    }

    /// The ordinary case is unchanged: a reporter still on the committee is executed by anyone.
    function test_activeReporter_isStillExecutedByAnyone() public {
        _file(committee, didHash);
        vm.warp(block.timestamp + CHALLENGE + 1);

        vm.prank(stranger);
        staking.executeSlash(didHash);

        assertEq(staking.getStake(didHash), 0);
        assertEq(staking.claimable(committee), STAKE / 4);
        assertEq(staking.claimable(victim), STAKE / 4);
    }

    /// The check reads the role now, not the role at filing: a reporter put back is executable again.
    function test_regrantedReporter_canBeExecuted() public {
        _file(committee, didHash);
        vm.warp(block.timestamp + CHALLENGE + 1);
        _revoke(committee);

        vm.prank(admin);
        staking.grantRole(role, committee);

        vm.prank(stranger);
        staking.executeSlash(didHash);
        assertEq(staking.getStake(didHash), 0);
    }

    /// Revoking one member leaves the proposals of every other member alone.
    function test_revokingOneMember_leavesAnotherMembersSlashExecutable() public {
        _file(committee, didHash);
        _file(committee2, didHash2);
        vm.warp(block.timestamp + CHALLENGE + 1);
        _revoke(committee);

        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.ReporterNotAuthorized.selector, didHash, committee));
        vm.prank(stranger);
        staking.executeSlash(didHash);

        vm.prank(stranger);
        staking.executeSlash(didHash2);
        assertEq(staking.getStake(didHash2), 0, "the other member's slash landed");
        assertEq(staking.getStake(didHash), STAKE, "the revoked member's did not");
    }

    /// The revoked reporter's proposal is not stuck: any current member can withdraw it at once.
    function test_aCurrentMember_cancelsARevokedReportersProposal() public {
        _file(committee, didHash);
        vm.warp(block.timestamp + CHALLENGE + 1);
        _revoke(committee);

        vm.prank(committee2);
        staking.cancelSlash(didHash);

        assertEq(uint8(_status(didHash)), uint8(SigvaraIdentity.AgentStatus.Active), "agent reinstated");
        assertEq(staking.getStake(didHash), STAKE);
        assertGt(staking.lastDroppedAt(didHash), 0, "the drop starts the refile cooldown");
    }

    /// And if nobody cancels it, it lapses on the same terms as any proposal nobody executed.
    function test_aRevokedReportersProposal_lapsesThroughExpireSlash() public {
        _file(committee, didHash);
        _revoke(committee);
        uint256 filedAt = block.timestamp;

        vm.warp(filedAt + CHALLENGE + staking.EXECUTION_PERIOD() + 1);
        vm.prank(stranger);
        staking.expireSlash(didHash);

        assertEq(uint8(_status(didHash)), uint8(SigvaraIdentity.AgentStatus.Active));
        assertEq(staking.getStake(didHash), STAKE);
    }

    /// The admin's ruling on a dispute is a decision taken now by a key that is not the accuser,
    /// so it does not wait on the reporter's standing.
    function test_adminCanStillUpholdADisputedSlash_afterTheReporterWasRevoked() public {
        _file(committee, didHash);
        vm.prank(operator);
        staking.disputeSlash(didHash);
        _revoke(committee);

        vm.warp(block.timestamp + CHALLENGE + 1);
        vm.prank(admin);
        staking.resolveDispute(didHash, true);

        assertEq(staking.getStake(didHash), 0);
        assertEq(uint8(_status(didHash)), uint8(SigvaraIdentity.AgentStatus.Slashed));
        assertEq(staking.claimable(committee), STAKE / 4, "paid as the reporter of record");
    }
}
