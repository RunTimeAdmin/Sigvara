// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";
import "../src/SigvaraIdentity.sol";

/// Stands in for SigvaraStaking. These are identity unit tests, so the collateral
/// answer is set directly rather than built up through a real bond.
contract StakeViewMock is IStakeView {
    bool public bonded = true;
    function set(bool v) external { bonded = v; }
    function hasMinimumStake(bytes32) external view returns (bool) { return bonded; }
}

contract SigvaraIdentityTest is Test {
    SigvaraIdentity identity;
    StakeViewMock stakeView;

    address admin    = makeAddr("admin");
    address staking  = makeAddr("staking");
    address operator = makeAddr("operator");
    address agent    = makeAddr("agent");
    address stranger = makeAddr("stranger");

    bytes32 constant PUB_KEY   = bytes32(uint256(0xdeadbeef));
    bytes32 constant PUB_KEY_2 = bytes32(uint256(0xcafebabe));

    function setUp() public {
        SigvaraIdentity impl = new SigvaraIdentity();
        bytes memory init = abi.encodeCall(SigvaraIdentity.initialize, (admin, staking));
        identity = SigvaraIdentity(address(new ERC1967Proxy(address(impl), init)));

        stakeView = new StakeViewMock();
        vm.prank(admin);
        identity.initializeV2(address(stakeView));
    }

    /// The escape this gate closes: self-suspend, drain the bond, then walk back to
    /// Active carrying the old reputation with nothing behind it. In that state the
    /// agent cannot be slashed at all, because there is no stake to take.
    function test_updateStatus_reverts_returningToActiveWithoutCollateral() public {
        bytes32 didHash = _register();

        vm.prank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Suspended);

        stakeView.set(false); // the operator has withdrawn and claimed the whole bond

        vm.expectRevert(
            abi.encodeWithSelector(SigvaraIdentity.InsufficientCollateral.selector, didHash)
        );
        vm.prank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Active);

        assertFalse(identity.isActive(didHash), "stays suspended");
    }

    /// Topping the bond back up must reopen the door, or the identity is bricked.
    function test_updateStatus_reactivatesOnceCollateralIsRestored() public {
        bytes32 didHash = _register();

        vm.prank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Suspended);
        stakeView.set(false);

        vm.expectRevert(
            abi.encodeWithSelector(SigvaraIdentity.InsufficientCollateral.selector, didHash)
        );
        vm.prank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Active);

        stakeView.set(true); // re-deposited
        vm.prank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Active);
        assertTrue(identity.isActive(didHash));
    }

    /// The staking core gets no exemption. Granting it one reopened the same escape
    /// one step further round: queue a withdrawal while Suspended, draw a slash,
    /// dispute it, and the reinstatement that follows a dropped proposal handed back
    /// Active status with the bond already on its way out. An invariant run found it.
    function test_updateStatus_stakingCoreCannotReinstateWithoutCollateral() public {
        bytes32 didHash = _register();

        vm.prank(staking);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Suspended);

        stakeView.set(false);
        vm.expectRevert(
            abi.encodeWithSelector(SigvaraIdentity.InsufficientCollateral.selector, didHash)
        );
        vm.prank(staking);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Active);
    }

    /// SigvaraStaking uses this instead of reinstating an under-collateralised agent,
    /// so a permissionless call like expireDispute still completes. The agent stays
    /// Suspended, but the slash lock is gone and its operator can re-bond.
    function test_clearSlashSuspension_liftsLockWithoutReinstating() public {
        bytes32 didHash = _register();

        vm.prank(staking);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Suspended);
        assertTrue(identity.slashSuspended(didHash));

        stakeView.set(false);
        vm.prank(staking);
        identity.clearSlashSuspension(didHash);

        assertFalse(identity.slashSuspended(didHash), "lock lifted");
        assertFalse(identity.isActive(didHash), "still suspended");

        // Operator is unblocked once the bond is back.
        stakeView.set(true);
        vm.prank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Active);
        assertTrue(identity.isActive(didHash));
    }

    function test_clearSlashSuspension_reverts_notStakingCore() public {
        bytes32 didHash = _register();
        vm.expectRevert();
        vm.prank(operator);
        identity.clearSlashSuspension(didHash);
    }

    /// Suspending never needs collateral: that is the exit path.
    function test_updateStatus_suspendWorksWithoutCollateral() public {
        bytes32 didHash = _register();
        stakeView.set(false);

        vm.prank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Suspended);
        assertFalse(identity.isActive(didHash));
    }

    // -------------------------------------------------------------------------
    // computeDidHash
    // -------------------------------------------------------------------------

    function test_computeDidHash_isDeterministic() public view {
        assertEq(identity.computeDidHash(agent), identity.computeDidHash(agent));
    }

    function test_computeDidHash_differsAcrossAddresses() public view {
        assertNotEq(identity.computeDidHash(agent), identity.computeDidHash(stranger));
    }

    function testFuzz_computeDidHash_unique(address a, address b) public view {
        vm.assume(a != b);
        assertNotEq(identity.computeDidHash(a), identity.computeDidHash(b));
    }

    // -------------------------------------------------------------------------
    // registerAgent
    // -------------------------------------------------------------------------

    function test_registerAgent_success() public {
        vm.prank(operator);
        bytes32 didHash = identity.registerAgent(agent, PUB_KEY);

        assertEq(didHash, identity.computeDidHash(agent));

        SigvaraIdentity.AgentIdentity memory id = identity.getIdentity(didHash);
        assertEq(id.operator, operator);
        assertEq(id.agentAddress, agent);
        assertEq(id.ed25519PubKey, PUB_KEY);
        assertEq(uint8(id.status), uint8(SigvaraIdentity.AgentStatus.Active));
        assertGt(id.registeredAt, 0);
    }

    function test_registerAgent_emitsEvent() public {
        bytes32 expectedHash = identity.computeDidHash(agent);
        vm.expectEmit(true, true, true, true);
        emit SigvaraIdentity.AgentRegistered(expectedHash, operator, agent, PUB_KEY);

        vm.prank(operator);
        identity.registerAgent(agent, PUB_KEY);
    }

    function test_registerAgent_reverts_zeroPubKey() public {
        vm.expectRevert(SigvaraIdentity.ZeroPubKey.selector);
        vm.prank(operator);
        identity.registerAgent(agent, bytes32(0));
    }

    function test_registerAgent_reverts_zeroAgentAddress() public {
        vm.expectRevert(SigvaraIdentity.ZeroAgentAddress.selector);
        vm.prank(operator);
        identity.registerAgent(address(0), PUB_KEY);
    }

    function test_registerAgent_reverts_duplicate() public {
        vm.prank(operator);
        identity.registerAgent(agent, PUB_KEY);

        bytes32 didHash = identity.computeDidHash(agent);
        vm.expectRevert(abi.encodeWithSelector(SigvaraIdentity.AlreadyRegistered.selector, didHash));
        vm.prank(operator);
        identity.registerAgent(agent, PUB_KEY_2);
    }

    function test_registerAgent_tracksOperatorAgents() public {
        address agent2 = makeAddr("agent2");
        vm.startPrank(operator);
        bytes32 h1 = identity.registerAgent(agent, PUB_KEY);
        bytes32 h2 = identity.registerAgent(agent2, PUB_KEY_2);
        vm.stopPrank();

        bytes32[] memory agents = identity.getOperatorAgents(operator);
        assertEq(agents.length, 2);
        assertEq(agents[0], h1);
        assertEq(agents[1], h2);
    }

    // -------------------------------------------------------------------------
    // rotatePublicKey
    // -------------------------------------------------------------------------

    function _register() internal returns (bytes32 didHash) {
        vm.prank(operator);
        didHash = identity.registerAgent(agent, PUB_KEY);
    }

    function test_rotatePublicKey_success() public {
        bytes32 didHash = _register();

        vm.prank(operator);
        identity.rotatePublicKey(didHash, PUB_KEY_2);

        assertEq(identity.getIdentity(didHash).ed25519PubKey, PUB_KEY_2);
    }

    function test_rotatePublicKey_reverts_notOperator() public {
        bytes32 didHash = _register();

        vm.expectRevert(
            abi.encodeWithSelector(SigvaraIdentity.NotOperator.selector, didHash, stranger)
        );
        vm.prank(stranger);
        identity.rotatePublicKey(didHash, PUB_KEY_2);
    }

    function test_rotatePublicKey_reverts_onSlashed() public {
        bytes32 didHash = _register();

        vm.prank(staking);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Slashed);

        vm.expectRevert(
            abi.encodeWithSelector(SigvaraIdentity.SlashedAgentImmutable.selector, didHash)
        );
        vm.prank(operator);
        identity.rotatePublicKey(didHash, PUB_KEY_2);
    }

    function test_rotatePublicKey_allowedWhileSuspended() public {
        bytes32 didHash = _register();

        vm.prank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Suspended);

        vm.prank(operator);
        identity.rotatePublicKey(didHash, PUB_KEY_2);

        assertEq(identity.getIdentity(didHash).ed25519PubKey, PUB_KEY_2);
    }

    // -------------------------------------------------------------------------
    // updateStatus
    // -------------------------------------------------------------------------

    function test_updateStatus_operatorCanSuspend() public {
        bytes32 didHash = _register();

        vm.prank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Suspended);

        assertEq(uint8(identity.getIdentity(didHash).status), uint8(SigvaraIdentity.AgentStatus.Suspended));
        assertFalse(identity.isActive(didHash));
    }

    function test_updateStatus_operatorCanReinstate() public {
        bytes32 didHash = _register();

        vm.startPrank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Suspended);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Active);
        vm.stopPrank();

        assertTrue(identity.isActive(didHash));
    }

    function test_updateStatus_stakingCanSlash() public {
        bytes32 didHash = _register();

        vm.prank(staking);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Slashed);

        assertEq(uint8(identity.getIdentity(didHash).status), uint8(SigvaraIdentity.AgentStatus.Slashed));
        assertFalse(identity.isActive(didHash));
    }

    function test_updateStatus_strangerCannotSlash() public {
        bytes32 didHash = _register();

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                stranger,
                identity.STAKING_CORE_ROLE()
            )
        );
        vm.prank(stranger);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Slashed);
    }

    function test_updateStatus_operatorCannotSlash() public {
        bytes32 didHash = _register();

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                operator,
                identity.STAKING_CORE_ROLE()
            )
        );
        vm.prank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Slashed);
    }

    function test_updateStatus_slashedIsTerminal() public {
        bytes32 didHash = _register();

        vm.prank(staking);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Slashed);

        vm.expectRevert(
            abi.encodeWithSelector(SigvaraIdentity.SlashedAgentImmutable.selector, didHash)
        );
        vm.prank(staking);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Active);
    }

    function test_updateStatus_operatorCannotLiftStakingSuspension() public {
        bytes32 didHash = _register();

        // Staking core suspends the agent (as initiateSlash does).
        vm.prank(staking);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Suspended);
        assertTrue(identity.slashSuspended(didHash));

        // Operator must not be able to reactivate mid-slash.
        vm.expectRevert(
            abi.encodeWithSelector(SigvaraIdentity.SlashSuspensionLocked.selector, didHash)
        );
        vm.prank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Active);
    }

    function test_updateStatus_stakingReinstateClearsLock() public {
        bytes32 didHash = _register();

        vm.prank(staking);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Suspended);

        // Staking reinstates (as disputeSlash does) — lock clears.
        vm.prank(staking);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Active);
        assertFalse(identity.slashSuspended(didHash));
        assertTrue(identity.isActive(didHash));

        // Operator regains normal control afterward.
        vm.prank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Suspended);
        vm.prank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Active);
        assertTrue(identity.isActive(didHash));
    }

    function test_updateStatus_operatorSelfSuspendStaysReversible() public {
        bytes32 didHash = _register();

        // A self-suspend by the operator is not a slash lock.
        vm.prank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Suspended);
        assertFalse(identity.slashSuspended(didHash));

        vm.prank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Active);
        assertTrue(identity.isActive(didHash));
    }

    function test_updateStatus_reverts_notRegistered() public {
        bytes32 fakeHash = keccak256("nonexistent");
        vm.expectRevert(
            abi.encodeWithSelector(SigvaraIdentity.NotRegistered.selector, fakeHash)
        );
        vm.prank(operator);
        identity.updateStatus(fakeHash, SigvaraIdentity.AgentStatus.Suspended);
    }

    // -------------------------------------------------------------------------
    // isActive
    // -------------------------------------------------------------------------

    function test_isActive_falseBeforeRegistration() public view {
        assertFalse(identity.isActive(identity.computeDidHash(agent)));
    }

    function test_isActive_trueAfterRegistration() public {
        bytes32 didHash = _register();
        assertTrue(identity.isActive(didHash));
    }

    // -------------------------------------------------------------------------
    // Storage layout
    // -------------------------------------------------------------------------
    // Pins the base slots the original proxy layout was deployed with. slashSuspended was
    // APPENDED at slot 2; if any of these fail, a variable was inserted above the
    // existing mappings, which shifts their base slots and makes every live
    // identity/operator index unreachable after the UUPS upgrade.

    function test_storageLayout_identitiesMappingPinnedToSlot0() public {
        bytes32 didHash = _register();
        // First field of AgentIdentity is `operator`.
        bytes32 slot = keccak256(abi.encode(didHash, uint256(0)));
        assertEq(address(uint160(uint256(vm.load(address(identity), slot)))), operator);
    }

    function test_storageLayout_operatorAgentsPinnedToSlot1() public {
        _register();
        // The dynamic array's length lives at the mapping value slot.
        bytes32 slot = keccak256(abi.encode(operator, uint256(1)));
        assertEq(uint256(vm.load(address(identity), slot)), 1);
    }

    function test_storageLayout_slashSuspendedPinnedToSlot2() public {
        bytes32 didHash = _register();
        vm.prank(staking);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Suspended);

        bytes32 slot = keccak256(abi.encode(didHash, uint256(2)));
        assertEq(uint256(vm.load(address(identity), slot)), 1);
    }
}
