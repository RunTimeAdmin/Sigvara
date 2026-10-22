// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "./helpers/RegistrationHelper.sol";
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

/// Accepts any signature its owner produced. Enough to exercise the ERC-1271 path.
contract ERC1271Agent {
    address public owner;
    constructor(address owner_) { owner = owner_; }
    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        return SignatureChecker.isValidSignatureNow(owner, hash, sig) ? bytes4(0x1626ba7e) : bytes4(0);
    }
}

contract SigvaraIdentityTest is Test, RegistrationHelper {
    SigvaraIdentity identity;
    StakeViewMock stakeView;

    address admin    = makeAddr("admin");
    address staking  = makeAddr("staking");
    address operator = makeAddr("operator");
    address agent;
    uint256 agentPk;
    address stranger = makeAddr("stranger");

    bytes32 constant PUB_KEY   = bytes32(uint256(0xdeadbeef));
    bytes32 constant PUB_KEY_2 = bytes32(uint256(0xcafebabe));

    function setUp() public {
        (agent, agentPk) = makeAddrAndKey("agent");
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

    // -------------------------------------------------------------------------
    // operator transfer
    // -------------------------------------------------------------------------

    function test_transfer_movesTheAgentAndRecordsIt() public {
        bytes32 didHash = _register();
        address buyer = makeAddr("buyer");

        vm.prank(operator);
        identity.offerOperatorTransfer(didHash, buyer);
        assertEq(identity.pendingOperator(didHash), buyer);
        assertEq(identity.getIdentity(didHash).operator, operator, "nothing moves on the offer");

        vm.prank(buyer);
        identity.acceptOperatorTransfer(didHash);

        assertEq(identity.getIdentity(didHash).operator, buyer);
        assertEq(identity.pendingOperator(didHash), address(0), "offer consumed");
        assertEq(identity.operatorChangedAt(didHash), block.timestamp);
        assertEq(identity.operatorTransferCount(didHash), 1);
    }

    /**
     * Removal is swap-and-pop, and the element that gets swapped in must have its recorded
     * position updated. If it does not, nothing looks broken — the fallback scan still
     * finds it — so the only visible symptom is that removal quietly costs O(n) again,
     * which is exactly the property this index exists to provide. Hence reading the slot.
     */
    function test_transfer_swapUpdatesTheMovedAgentsRecordedPosition() public {
        bytes32 didA = _register();
        (, uint256 pkB) = makeAddrAndKey("agentB");
        bytes32 didB = registerSigned(identity, operator, pkB, PUB_KEY_2);
        address buyer = makeAddr("buyer");

        // operatorAgentIndex is private and lives at slot 7; index + 1, so these read 1 and 2.
        assertEq(uint256(vm.load(address(identity), keccak256(abi.encode(didA, uint256(7))))), 1);
        assertEq(uint256(vm.load(address(identity), keccak256(abi.encode(didB, uint256(7))))), 2);

        // Remove the FIRST one, so the last is swapped into its place.
        vm.prank(operator);
        identity.offerOperatorTransfer(didA, buyer);
        vm.prank(buyer);
        identity.acceptOperatorTransfer(didA);

        bytes32[] memory left = identity.getOperatorAgents(operator);
        assertEq(left.length, 1);
        assertEq(left[0], didB, "B was swapped down into A's place");
        assertEq(uint256(vm.load(address(identity), keccak256(abi.encode(didB, uint256(7))))), 1,
            "B's recorded position followed it");
        // A didHash belongs to exactly one operator at a time, so one global position map is
        // unambiguous. The accept clears A's old position and immediately records its new
        // one in the buyer's list, in the same transaction, so this reads 1 rather than 0.
        assertEq(uint256(vm.load(address(identity), keccak256(abi.encode(didA, uint256(7))))), 1,
            "A re-recorded at the head of the buyer's list");

        // And B is still removable afterwards, which is what a stale position would break.
        vm.prank(operator);
        identity.offerOperatorTransfer(didB, buyer);
        vm.prank(buyer);
        identity.acceptOperatorTransfer(didB);
        assertEq(identity.getOperatorAgents(operator).length, 0, "seller holds nothing");
        assertEq(identity.getOperatorAgents(buyer).length, 2, "buyer holds both");
    }

    /// Removing the only element: `moved` is the removed agent itself, so the write and the
    /// delete touch the same key and the delete must win.
    function test_transfer_removingTheOnlyAgentClearsItsPosition() public {
        bytes32 didHash = _register();
        address buyer = makeAddr("buyer");

        vm.prank(operator);
        identity.offerOperatorTransfer(didHash, buyer);
        vm.prank(buyer);
        identity.acceptOperatorTransfer(didHash);

        // Cleared for the seller, then re-recorded as position 1 under the buyer.
        assertEq(uint256(vm.load(address(identity), keccak256(abi.encode(didHash, uint256(7))))), 1,
            "re-recorded for the new operator");
        assertEq(identity.getOperatorAgents(operator).length, 0);
    }

    function test_operatorAgentsPaged_boundaries() public {
        bytes32 didA = _register();
        (, uint256 pkB) = makeAddrAndKey("agentPageB");
        bytes32 didB = registerSigned(identity, operator, pkB, PUB_KEY_2);

        assertEq(identity.operatorAgentCount(operator), 2);

        bytes32[] memory first = identity.getOperatorAgentsPaged(operator, 0, 1);
        assertEq(first.length, 1);
        assertEq(first[0], didA);

        // A limit past the end truncates rather than reverting: paging to the end is
        // ordinary use.
        bytes32[] memory rest = identity.getOperatorAgentsPaged(operator, 1, 99);
        assertEq(rest.length, 1);
        assertEq(rest[0], didB);

        // An offset past the end is empty, not a revert.
        assertEq(identity.getOperatorAgentsPaged(operator, 2, 10).length, 0);
        assertEq(identity.getOperatorAgentsPaged(operator, 0, 0).length, 0);
    }

    /// "Everything from here" is a natural way to ask for the rest, and `offset + limit` overflowed for it:
    /// the call panicked where the NatSpec promises a short page.
    function test_operatorAgentsPaged_aLimitOfTheMaximumReturnsTheRest() public {
        bytes32 didA = _register();
        (, uint256 pkB) = makeAddrAndKey("agentPageB");
        bytes32 didB = registerSigned(identity, operator, pkB, PUB_KEY_2);

        bytes32[] memory all = identity.getOperatorAgentsPaged(operator, 0, type(uint256).max);
        assertEq(all.length, 2);
        assertEq(all[0], didA);
        assertEq(all[1], didB);

        bytes32[] memory rest = identity.getOperatorAgentsPaged(operator, 1, type(uint256).max);
        assertEq(rest.length, 1);
        assertEq(rest[0], didB);

        // An offset at the maximum is past the end: empty, not a panic.
        assertEq(identity.getOperatorAgentsPaged(operator, type(uint256).max, type(uint256).max).length, 0);
    }

    /// Whatever the offset and the limit, a page is the slice of the list they name, cut short at the end.
    function testFuzz_operatorAgentsPaged_isTheSliceCutAtTheEnd(uint256 offset, uint256 limit) public {
        bytes32 didA = _register();
        (, uint256 pkB) = makeAddrAndKey("agentPageB");
        bytes32 didB = registerSigned(identity, operator, pkB, PUB_KEY_2);
        bytes32[2] memory list = [didA, didB];

        bytes32[] memory page = identity.getOperatorAgentsPaged(operator, offset, limit);

        uint256 expected = offset >= 2 ? 0 : (limit < 2 - offset ? limit : 2 - offset);
        assertEq(page.length, expected);
        for (uint256 i = 0; i < page.length; i++) assertEq(page[i], list[offset + i]);
    }

    /// The index has to follow the agent, or the seller keeps listing something it no
    /// longer controls and the buyer cannot find what it bought.
    function test_transfer_movesTheAgentBetweenOperatorIndexes() public {
        bytes32 didHash = _register();
        address buyer = makeAddr("buyer");

        vm.prank(operator);
        identity.offerOperatorTransfer(didHash, buyer);
        vm.prank(buyer);
        identity.acceptOperatorTransfer(didHash);

        assertEq(identity.getOperatorAgents(operator).length, 0, "gone from the seller");
        bytes32[] memory bought = identity.getOperatorAgents(buyer);
        assertEq(bought.length, 1);
        assertEq(bought[0], didHash);
    }

    /// Only the named recipient can accept. Otherwise an offer would be a race that
    /// anyone watching the mempool could win.
    function test_transfer_onlyTheOfferedAddressCanAccept() public {
        bytes32 didHash = _register();
        address buyer = makeAddr("buyer");

        vm.prank(operator);
        identity.offerOperatorTransfer(didHash, buyer);

        vm.expectRevert(
            abi.encodeWithSelector(SigvaraIdentity.NotOfferedOperator.selector, didHash, stranger)
        );
        vm.prank(stranger);
        identity.acceptOperatorTransfer(didHash);
    }

    function test_transfer_reverts_acceptWithNoOffer() public {
        bytes32 didHash = _register();
        vm.expectRevert(
            abi.encodeWithSelector(SigvaraIdentity.NoTransferOffered.selector, didHash)
        );
        vm.prank(stranger);
        identity.acceptOperatorTransfer(didHash);
    }

    /// Handing off an accused agent would leave the liability with a buyer who had no
    /// part in what it did.
    function test_transfer_reverts_whileASlashIsPending() public {
        bytes32 didHash = _register();
        address buyer = makeAddr("buyer");

        vm.prank(staking);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Suspended);
        assertTrue(identity.slashSuspended(didHash));

        vm.expectRevert(
            abi.encodeWithSelector(SigvaraIdentity.TransferWhileSlashPending.selector, didHash)
        );
        vm.prank(operator);
        identity.offerOperatorTransfer(didHash, buyer);
    }

    /// An offer can be made while the agent is clean and a slash can start afterwards, so
    /// the accept has to look again. Otherwise an offer made before the accusation hands the
    /// accused agent, and its liability, to a buyer who accepts during the challenge window.
    function test_transfer_reverts_acceptDuringASlashThatStartedAfterTheOffer() public {
        bytes32 didHash = _register();
        address buyer = makeAddr("buyer");

        vm.prank(operator);
        identity.offerOperatorTransfer(didHash, buyer);

        vm.prank(staking);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Suspended);

        vm.expectRevert(
            abi.encodeWithSelector(SigvaraIdentity.TransferWhileSlashPending.selector, didHash)
        );
        vm.prank(buyer);
        identity.acceptOperatorTransfer(didHash);

        assertEq(identity.getIdentity(didHash).operator, operator, "the agent stays with the accused");
    }

    /// Slashed is terminal. A slashed identity cannot be put up for sale.
    function test_transfer_reverts_offerOnASlashedAgent() public {
        bytes32 didHash = _register();

        vm.prank(staking);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Slashed);

        vm.expectRevert(
            abi.encodeWithSelector(SigvaraIdentity.SlashedAgentImmutable.selector, didHash)
        );
        vm.prank(operator);
        identity.offerOperatorTransfer(didHash, makeAddr("buyer"));
    }

    /// Nor can an offer made before the slash be accepted after it.
    function test_transfer_reverts_acceptOnAnAgentSlashedAfterTheOffer() public {
        bytes32 didHash = _register();
        address buyer = makeAddr("buyer");

        vm.prank(operator);
        identity.offerOperatorTransfer(didHash, buyer);

        vm.prank(staking);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Slashed);

        vm.expectRevert(
            abi.encodeWithSelector(SigvaraIdentity.SlashedAgentImmutable.selector, didHash)
        );
        vm.prank(buyer);
        identity.acceptOperatorTransfer(didHash);

        assertEq(identity.getIdentity(didHash).operator, operator);
    }

    /// What changes hands must carry collateral, not just a reputation.
    function test_transfer_reverts_whenTheAgentIsNotBonded() public {
        bytes32 didHash = _register();
        address buyer = makeAddr("buyer");

        vm.prank(operator);
        identity.offerOperatorTransfer(didHash, buyer);

        stakeView.set(false);
        vm.expectRevert(
            abi.encodeWithSelector(SigvaraIdentity.InsufficientCollateral.selector, didHash)
        );
        vm.prank(buyer);
        identity.acceptOperatorTransfer(didHash);
    }

    function test_transfer_eitherSideCanCancel() public {
        bytes32 didHash = _register();
        address buyer = makeAddr("buyer");

        vm.prank(operator);
        identity.offerOperatorTransfer(didHash, buyer);
        vm.prank(buyer);
        identity.cancelOperatorTransfer(didHash);
        assertEq(identity.pendingOperator(didHash), address(0));

        vm.prank(operator);
        identity.offerOperatorTransfer(didHash, buyer);
        vm.prank(operator);
        identity.cancelOperatorTransfer(didHash);
        assertEq(identity.pendingOperator(didHash), address(0));

        // With an offer outstanding, a third party still cannot touch it.
        vm.prank(operator);
        identity.offerOperatorTransfer(didHash, buyer);
        vm.expectRevert(
            abi.encodeWithSelector(SigvaraIdentity.NotOperator.selector, didHash, stranger)
        );
        vm.prank(stranger);
        identity.cancelOperatorTransfer(didHash);
        assertEq(identity.pendingOperator(didHash), buyer, "offer untouched");
    }

    function test_transfer_reverts_onZeroOrSameOperator() public {
        bytes32 didHash = _register();
        vm.expectRevert(SigvaraIdentity.ZeroAgentAddress.selector);
        vm.prank(operator);
        identity.offerOperatorTransfer(didHash, address(0));

        vm.expectRevert(abi.encodeWithSelector(SigvaraIdentity.SameOperator.selector, didHash));
        vm.prank(operator);
        identity.offerOperatorTransfer(didHash, operator);
    }

    /// The new operator gets the controls, and the old one loses them.
    function test_transfer_handsOverControl() public {
        bytes32 didHash = _register();
        address buyer = makeAddr("buyer");

        vm.prank(operator);
        identity.offerOperatorTransfer(didHash, buyer);
        vm.prank(buyer);
        identity.acceptOperatorTransfer(didHash);

        vm.expectRevert(
            abi.encodeWithSelector(SigvaraIdentity.NotOperator.selector, didHash, operator)
        );
        vm.prank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Suspended);

        vm.prank(buyer);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Suspended);
        assertFalse(identity.isActive(didHash));
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
        bytes32 didHash = registerSigned(identity, operator, agentPk, PUB_KEY);

        assertEq(didHash, identity.computeDidHash(agent));

        SigvaraIdentity.AgentIdentity memory id = identity.getIdentity(didHash);
        assertEq(id.operator, operator);
        assertEq(id.agentAddress, agent);
        assertEq(id.ed25519PubKey, PUB_KEY);
        // Registration costs only gas, so it must not mint an Active identity. An
        // unbonded Active agent cannot be slashed, which made bulk registration free.
        assertEq(uint8(id.status), uint8(SigvaraIdentity.AgentStatus.PendingBond));
        assertGt(id.registeredAt, 0);
    }

    function test_registerAgent_emitsEvent() public {
        bytes32 expectedHash = identity.computeDidHash(agent);
        vm.expectEmit(true, true, true, true);
        emit SigvaraIdentity.AgentRegistered(expectedHash, operator, agent, PUB_KEY);

        registerSigned(identity, operator, agentPk, PUB_KEY);
    }

    // -------------------------------------------------------------------------
    // proof of control
    // -------------------------------------------------------------------------

    /// The hole this closes: without a signature anyone could claim an address they
    /// did not control, choose the Ed25519 key verifiers would check against it, and
    /// lock the rightful owner out for good, since a didHash can never be reissued.
    function test_registerAgent_reverts_withoutASignature() public {
        vm.expectRevert(
            abi.encodeWithSelector(SigvaraIdentity.BadRegistrationSignature.selector, agent)
        );
        vm.prank(operator);
        identity.registerAgent(agent, PUB_KEY, hex"");
    }

    /// A signature from the wrong key is no better than none.
    function test_registerAgent_reverts_onSomeoneElsesSignature() public {
        (, uint256 otherPk) = makeAddrAndKey("someoneElse");
        bytes memory sig = signRegistration(identity, otherPk, operator, PUB_KEY);

        vm.expectRevert(
            abi.encodeWithSelector(SigvaraIdentity.BadRegistrationSignature.selector, agent)
        );
        vm.prank(operator);
        identity.registerAgent(agent, PUB_KEY, sig);
    }

    /// The operator is in the digest, so a signature cannot be lifted from the mempool
    /// and used by someone else to claim the agent first.
    function test_registerAgent_reverts_whenAnotherOperatorUsesTheSignature() public {
        bytes memory sig = signRegistration(identity, agentPk, operator, PUB_KEY);

        vm.expectRevert(
            abi.encodeWithSelector(SigvaraIdentity.BadRegistrationSignature.selector, agent)
        );
        vm.prank(stranger);
        identity.registerAgent(agent, PUB_KEY, sig);
    }

    /// The Ed25519 key is in the digest, so an interceptor cannot swap in a key that
    /// verifiers would then trust for this agent.
    function test_registerAgent_reverts_whenThePubKeyIsSwapped() public {
        bytes memory sig = signRegistration(identity, agentPk, operator, PUB_KEY);

        vm.expectRevert(
            abi.encodeWithSelector(SigvaraIdentity.BadRegistrationSignature.selector, agent)
        );
        vm.prank(operator);
        identity.registerAgent(agent, PUB_KEY_2, sig);
    }

    /// The registry address is in the digest, so a signature made for one deployment
    /// cannot be replayed against another on the same chain.
    function test_registerAgent_reverts_whenReplayedOnAnotherRegistry() public {
        SigvaraIdentity other = SigvaraIdentity(address(new ERC1967Proxy(
            address(new SigvaraIdentity()),
            abi.encodeCall(SigvaraIdentity.initialize, (admin, staking))
        )));
        bytes memory sigForOther = signRegistration(other, agentPk, operator, PUB_KEY);

        vm.expectRevert(
            abi.encodeWithSelector(SigvaraIdentity.BadRegistrationSignature.selector, agent)
        );
        vm.prank(operator);
        identity.registerAgent(agent, PUB_KEY, sigForOther);
    }

    /// An agent may be a contract. SignatureChecker falls through to ERC-1271, so a
    /// Safe or a custom agent contract can register without holding an EOA key.
    function test_registerAgent_acceptsAnErc1271Agent() public {
        ERC1271Agent contractAgent = new ERC1271Agent(agent);

        // Signed for the contract's own address: the digest binds whichever address is
        // being claimed, so the owner's signature over its own would not do.
        bytes32 digest = identity.registrationDigest(address(contractAgent), operator, PUB_KEY);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentPk, MessageHashUtils.toEthSignedMessageHash(digest));

        vm.prank(operator);
        bytes32 didHash = identity.registerAgent(
            address(contractAgent), PUB_KEY, abi.encodePacked(r, s, v)
        );
        assertEq(identity.getIdentity(didHash).agentAddress, address(contractAgent));
    }

    function test_registrationDigest_isDeterministicAndBinds() public view {
        bytes32 a = identity.registrationDigest(agent, operator, PUB_KEY);
        assertEq(a, identity.registrationDigest(agent, operator, PUB_KEY), "stable");
        assertTrue(a != identity.registrationDigest(agent, stranger, PUB_KEY), "binds the operator");
        assertTrue(a != identity.registrationDigest(agent, operator, PUB_KEY_2), "binds the key");
        assertTrue(a != identity.registrationDigest(stranger, operator, PUB_KEY), "binds the agent");
    }

    function test_registerAgent_reverts_zeroPubKey() public {
        vm.expectRevert(SigvaraIdentity.ZeroPubKey.selector);
        vm.prank(operator);
        identity.registerAgent(agent, bytes32(0), hex"");
    }

    function test_registerAgent_reverts_zeroAgentAddress() public {
        vm.expectRevert(SigvaraIdentity.ZeroAgentAddress.selector);
        vm.prank(operator);
        identity.registerAgent(address(0), PUB_KEY, hex"");
    }

    function test_registerAgent_reverts_duplicate() public {
        registerSigned(identity, operator, agentPk, PUB_KEY);

        bytes32 didHash = identity.computeDidHash(agent);
        bytes memory sig = signRegistration(identity, agentPk, operator, PUB_KEY_2);
        vm.expectRevert(abi.encodeWithSelector(SigvaraIdentity.AlreadyRegistered.selector, didHash));
        vm.prank(operator);
        identity.registerAgent(agent, PUB_KEY_2, sig);
    }

    function test_registerAgent_tracksOperatorAgents() public {
        (address agent2, uint256 agent2Pk) = makeAddrAndKey("agent2");
        bytes32 h1 = registerSigned(identity, operator, agentPk, PUB_KEY);
        bytes32 h2 = registerSigned(identity, operator, agent2Pk, PUB_KEY_2);

        bytes32[] memory agents = identity.getOperatorAgents(operator);
        assertEq(agents.length, 2);
        assertEq(agents[0], h1);
        assertEq(agents[1], h2);
    }

    // -------------------------------------------------------------------------
    // rotatePublicKey
    // -------------------------------------------------------------------------

    function _register() internal returns (bytes32 didHash) {
        didHash = registerSigned(identity, operator, agentPk, PUB_KEY);
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

    /// A zero key would leave the identity with nothing for verifiers to check a
    /// signature against, and registration already refuses one for the same reason.
    function test_rotatePublicKey_reverts_zeroKey() public {
        bytes32 didHash = _register();

        vm.expectRevert(SigvaraIdentity.ZeroPubKey.selector);
        vm.prank(operator);
        identity.rotatePublicKey(didHash, bytes32(0));

        assertEq(identity.getIdentity(didHash).ed25519PubKey, PUB_KEY, "the existing key stays");
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

    /// Verifiers and watchers learn that an agent was suspended or reinstated from this
    /// event, so it has to fire on every change and carry the new status.
    function test_updateStatus_emitsTheNewStatus() public {
        bytes32 didHash = _register();

        vm.expectEmit(address(identity));
        emit SigvaraIdentity.AgentStatusUpdated(didHash, SigvaraIdentity.AgentStatus.Suspended);
        vm.prank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Suspended);

        vm.expectEmit(address(identity));
        emit SigvaraIdentity.AgentStatusUpdated(didHash, SigvaraIdentity.AgentStatus.Active);
        vm.prank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Active);
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

    function test_isActive_falseUntilBonded() public {
        bytes32 didHash = _register();
        assertFalse(identity.isActive(didHash), "registration alone is not activation");

        // The collateral gate is what lets it through, and only once the bond is real.
        vm.prank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Active);
        assertTrue(identity.isActive(didHash));
    }

    /// PendingBond describes an identity that has never been bonded. An agent cannot
    /// become un-bonded, so nothing returns to it: it suspends and exits instead.
    function test_updateStatus_cannotReturnToPendingBond() public {
        bytes32 didHash = _register();
        vm.prank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Active);

        vm.expectRevert(
            abi.encodeWithSelector(SigvaraIdentity.CannotReturnToPendingBond.selector, didHash)
        );
        vm.prank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.PendingBond);
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

    /**
     * Pins the slots appended after slashSuspended, which nothing covered.
     *
     * The three tests above stop a variable being inserted above the original mappings.
     * They say nothing about the four appended since, and the same blind spot in
     * SigvaraReputation is what let `evidenceRoots` land above `operatorBond` and move it
     * into a slot reading zero — which is that contract's "check disabled" mode, reached by
     * an upgrade that reverted nothing.
     *
     * Adding a variable: append it, add a line here, never renumber.
     */
    function test_storageLayout_appendedSlotsPinned() public {
        bytes32 didHash = _register();
        address buyer = makeAddr("buyer");

        // 3 = stakeView, a plain address rather than a mapping.
        assertEq(address(uint160(uint256(vm.load(address(identity), bytes32(uint256(3)))))),
            address(stakeView), "slot 3 is stakeView");

        // 4 = pendingOperator. Probe with a live offer rather than reading the seed slot.
        vm.prank(operator);
        identity.offerOperatorTransfer(didHash, buyer);
        assertEq(
            address(uint160(uint256(vm.load(address(identity), keccak256(abi.encode(didHash, uint256(4))))))),
            buyer, "slot 4 is pendingOperator"
        );

        vm.prank(buyer);
        identity.acceptOperatorTransfer(didHash);

        // 5 = operatorChangedAt, 6 = operatorTransferCount, both written by the accept.
        assertEq(uint256(vm.load(address(identity), keccak256(abi.encode(didHash, uint256(5))))),
            identity.operatorChangedAt(didHash), "slot 5 is operatorChangedAt");
        assertEq(uint256(vm.load(address(identity), keccak256(abi.encode(didHash, uint256(6))))),
            identity.operatorTransferCount(didHash), "slot 6 is operatorTransferCount");

        // 7 = operatorAgentIndex. Private, so there is no getter to compare against: the
        // agent is the buyer's only one, so its recorded position is index 0 + 1.
        assertEq(uint256(vm.load(address(identity), keccak256(abi.encode(didHash, uint256(7))))),
            1, "slot 7 is operatorAgentIndex");
    }

    function test_storageLayout_slashSuspendedPinnedToSlot2() public {
        bytes32 didHash = _register();
        vm.prank(staking);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Suspended);

        bytes32 slot = keccak256(abi.encode(didHash, uint256(2)));
        assertEq(uint256(vm.load(address(identity), slot)), 1);
    }

    // -------------------------------------------------------------------------
    // setStakeView is held behind the timelock
    // -------------------------------------------------------------------------

    /// Repointing the collateral view decides who counts as bonded, and a contract of the
    /// caller's choosing can answer yes for everyone. That is about as consequential as an
    /// upgrade, so it takes the same key: UPGRADER_ROLE, which the timelock holds. Holding the
    /// admin role alone is not enough.
    function test_setStakeView_needsTheUpgraderRoleNotJustAdmin() public {
        address adminOnly = makeAddr("adminOnly");
        bytes32 adminRole = identity.DEFAULT_ADMIN_ROLE();
        vm.prank(admin);
        identity.grantRole(adminRole, adminOnly);
        assertFalse(identity.hasRole(identity.UPGRADER_ROLE(), adminOnly));

        StakeViewMock other = new StakeViewMock();
        bytes32 upgraderRole = identity.UPGRADER_ROLE();
        vm.expectRevert(abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, adminOnly, upgraderRole
        ));
        vm.prank(adminOnly);
        identity.setStakeView(address(other));

        assertEq(address(identity.stakeView()), address(stakeView), "unchanged after the refusal");
    }

    function test_setStakeView_worksForAnUpgrader() public {
        address upgrader = makeAddr("upgraderOnly");
        bytes32 upgraderRole = identity.UPGRADER_ROLE();
        vm.prank(admin);
        identity.grantRole(upgraderRole, upgrader);

        StakeViewMock other = new StakeViewMock();
        vm.expectEmit(address(identity));
        emit SigvaraIdentity.StakeViewSet(address(other));
        vm.prank(upgrader);
        identity.setStakeView(address(other));

        assertEq(address(identity.stakeView()), address(other));
    }

    function test_setStakeView_stillRefusesZero() public {
        vm.expectRevert(SigvaraIdentity.StakeViewNotSet.selector);
        vm.prank(admin);
        identity.setStakeView(address(0));
    }

    function test_setStakeView_strangersAreRefused() public {
        StakeViewMock other = new StakeViewMock();
        bytes32 upgraderRole = identity.UPGRADER_ROLE();
        vm.expectRevert(abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, upgraderRole
        ));
        vm.prank(stranger);
        identity.setStakeView(address(other));
    }
}
