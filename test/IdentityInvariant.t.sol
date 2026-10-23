// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import "../src/SigvaraIdentity.sol";

/// Stands in for SigvaraStaking. The handler decides who is bonded, and can swap between two of these.
contract IdentityInvStakeView is IStakeView {
    mapping(bytes32 => bool) public bonded;
    function set(bytes32 didHash, bool v) external { bonded[didHash] = v; }
    function hasMinimumStake(bytes32 didHash) external view returns (bool) { return bonded[didHash]; }
}

/**
 * Drives SigvaraIdentity through every externally reachable transition with bounded, random inputs:
 * registrations with good and bad signatures (wrong signer, wrong operator, wrong key, another chain,
 * another registry, a zero key), key rotations, every status change from the operator, the staking
 * core and strangers, bonds switching on and off, the two-step handover, suspensions lifted, the
 * collateral oracle swapped, a pause, and time moving between them. Calls the contract refuses are
 * swallowed: the refusals are the behaviour under test, and the invariants say what must hold
 * whatever was accepted.
 *
 * The handler keeps a model of what each agent should look like, and a decision function for each
 * call that says whether a correct contract would accept it. The invariants compare the contract's
 * books against the model. The decision is checked at the moment of the call: a call it refuses that
 * went through, and a call it allows that was refused, each record a violation, and an invariant
 * asserts that none was recorded. A violation is recorded in the same frame as the call, never after
 * a revert, so none can be lost to a failed assertion.
 */
contract IdentityHandler is Test {
    struct Wiring {
        SigvaraIdentity identity;
        SigvaraIdentity other;
        IdentityInvStakeView viewA;
        IdentityInvStakeView viewB;
        address admin;
        address core;
        address guardian;
        address stranger;
        address[] actors;   // everyone who can be an operator: the first three register, the rest receive
        uint256[] keys;     // private keys of the agent addresses that can be registered
    }

    /// What the handler believes the registry holds for one agent.
    struct Model {
        bool registered;
        address operator;
        address agentAddress;
        bytes32 pubKey;
        SigvaraIdentity.AgentStatus status;
        uint256 registeredAt;
        bool slashSuspended;
        address pending;
        uint256 changedAt;
        uint32 transfers;
    }

    SigvaraIdentity public identity;
    SigvaraIdentity public other;
    IdentityInvStakeView public viewA;
    IdentityInvStakeView public viewB;
    address public admin;
    address public core;
    address public guardian;
    address public stranger;
    address[] public actors;
    uint256[] internal keys;
    address[] public agents;
    bytes32[] public dids;

    mapping(bytes32 => Model) internal m;
    uint256 public registeredCount;

    /// The first rule a call broke, in words. Empty while none has.
    string public violation;

    // How often each action got through, so a campaign that never reached one cannot pass for one that did.
    uint256 public okRegister;
    uint256 public okRotate;
    uint256 public okStatus;
    uint256 public okSlash;
    uint256 public okOffer;
    uint256 public okCancel;
    uint256 public okAccept;
    uint256 public okClear;
    uint256 public okRefusedLock;
    /// Handovers that took an agent out of the middle of a list of two or more, which is the case swap-and-pop exists for.
    uint256 public okSwapAccept;

    constructor(Wiring memory w) {
        identity = w.identity;
        other = w.other;
        viewA = w.viewA;
        viewB = w.viewB;
        admin = w.admin;
        core = w.core;
        guardian = w.guardian;
        stranger = w.stranger;
        actors = w.actors;
        keys = w.keys;
        for (uint256 i = 0; i < keys.length; i++) {
            address a = vm.addr(keys[i]);
            agents.push(a);
            // The DID, restated here and not read back from the contract.
            dids.push(keccak256(abi.encodePacked("did:sigvara:", block.chainid, ":", a)));
        }
    }

    function agentCount() external view returns (uint256) { return dids.length; }
    function actorCount() external view returns (uint256) { return actors.length; }
    function modelOf(bytes32 did) external view returns (Model memory) { return m[did]; }

    /// How many registered agents the model says `operator` holds.
    function countHeldBy(address operator) external view returns (uint256 n) {
        for (uint256 i = 0; i < dids.length; i++) {
            if (m[dids[i]].registered && m[dids[i]].operator == operator) n++;
        }
    }

    function _flag(string memory what) internal {
        if (bytes(violation).length == 0) violation = what;
    }

    function _bonded(bytes32 did) internal view returns (bool) {
        address v = address(identity.stakeView());
        return v != address(0) && IdentityInvStakeView(v).bonded(did);
    }

    function _holderOf(Model memory x) internal view returns (address) {
        return x.registered ? x.operator : actors[0];
    }

    // -------------------------------------------------------------------------
    // Registering
    // -------------------------------------------------------------------------

    function register(uint256 keySeed, uint256 opSeed, uint256 variant) external {
        uint256 k = keySeed % keys.length;
        bytes32 did = dids[k];
        uint256 opIdx = opSeed % 3; // only the first three actors register
        address op = actors[opIdx];
        uint256 kind = variant % 12;
        bytes32 pub = keccak256(abi.encode("pub", keySeed, opSeed));
        if (kind == 10) pub = bytes32(0); // a valid signature over a zero key

        bytes memory sig = _registrationSignature(k, opIdx, pub, kind);
        bool sigValid = kind <= 4 || kind == 10 || kind == 11;
        bool expectOk = sigValid && pub != bytes32(0) && !m[did].registered && !identity.inflowsPaused();

        vm.prank(op);
        try identity.registerAgent(agents[k], pub, sig) returns (bytes32 returned) {
            if (!expectOk) _flag("a registration was accepted that should have been refused");
            else {
                if (returned != did) _flag("registerAgent returned a didHash that is not the DID of the address");
                m[did] = Model({
                    registered: true,
                    operator: op,
                    agentAddress: agents[k],
                    pubKey: pub,
                    status: SigvaraIdentity.AgentStatus.PendingBond,
                    registeredAt: block.timestamp,
                    slashSuspended: false,
                    pending: address(0),
                    changedAt: 0,
                    transfers: 0
                });
                registeredCount++;
                okRegister++;
            }
        } catch {
            if (expectOk) _flag("a registration with a valid signature for a new agent was refused");
        }
    }

    /// The signature for one kind of attempt: 0 to 4 and 11 are right, 10 is right but over a zero key, and
    /// the rest are each wrong in one way an attacker could try.
    function _registrationSignature(uint256 k, uint256 opIdx, bytes32 pub, uint256 kind)
        internal
        returns (bytes memory)
    {
        uint256 pk = keys[k];
        address op = actors[opIdx];
        SigvaraIdentity reg = identity;
        if (kind == 5) pk = keys[(k + 1) % keys.length];                // signed by somebody else
        else if (kind == 6) op = actors[(opIdx + 1) % 3];                // signed for another operator
        else if (kind == 7) pub = pub ^ bytes32(uint256(1));             // signed over another key
        else if (kind == 9) reg = other;                                  // signed for another registry

        uint256 chain = block.chainid;
        if (kind == 8) vm.chainId(chain + 1);                             // signed on another chain
        bytes32 digest = reg.registrationDigest(agents[k], op, pub);
        if (kind == 8) vm.chainId(chain);

        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, MessageHashUtils.toEthSignedMessageHash(digest));
        return abi.encodePacked(r, s, v);
    }

    // -------------------------------------------------------------------------
    // Keys and status
    // -------------------------------------------------------------------------

    function rotate(uint256 didSeed, uint256 who, uint256 keySeed) external {
        bytes32 did = dids[didSeed % dids.length];
        Model memory x = m[did];
        address caller = who % 4 == 0 ? stranger : _holderOf(x);
        bytes32 key = keySeed % 9 == 0 ? bytes32(0) : keccak256(abi.encode("rotated", keySeed));
        bool expectOk = x.registered && caller == x.operator
            && x.status != SigvaraIdentity.AgentStatus.Slashed && key != bytes32(0);

        vm.prank(caller);
        try identity.rotatePublicKey(did, key) {
            if (!expectOk) _flag("a key rotation was accepted that should have been refused");
            else {
                m[did].pubKey = key;
                okRotate++;
            }
        } catch {
            if (expectOk) _flag("a key rotation by the operator was refused");
        }
    }

    function setStatus(uint256 didSeed, uint256 who, uint256 target) external {
        bytes32 did = dids[didSeed % dids.length];
        Model memory x = m[did];
        uint256 pick = who % 6;
        address caller = pick < 3 ? _holderOf(x) : (pick < 5 ? core : stranger);
        SigvaraIdentity.AgentStatus t = SigvaraIdentity.AgentStatus(target % 4);
        bool isCore = identity.hasRole(identity.STAKING_CORE_ROLE(), caller);
        bool expectOk = _mayUpdateStatus(did, x, caller, isCore, t);
        bool lockedOut = x.registered && x.slashSuspended && !isCore && caller == x.operator;

        vm.prank(caller);
        try identity.updateStatus(did, t) {
            if (!expectOk) _flag("a status change was accepted that should have been refused");
            else {
                m[did].status = t;
                if (isCore && t == SigvaraIdentity.AgentStatus.Suspended) m[did].slashSuspended = true;
                else if (isCore && t == SigvaraIdentity.AgentStatus.Active) m[did].slashSuspended = false;
                okStatus++;
                if (t == SigvaraIdentity.AgentStatus.Slashed) okSlash++;
            }
        } catch {
            if (expectOk) _flag("a status change that was allowed was refused");
            else if (lockedOut) okRefusedLock++;
        }
    }

    /// The rules for a status change. An agent that is not registered, or is Slashed, cannot change; nothing
    /// goes back to PendingBond; Slashed is the staking core's alone; otherwise the operator may change it
    /// unless the staking core suspended it for a slash, and the staking core may change it freely; and a
    /// return to Active needs the bond, whoever asks.
    function _mayUpdateStatus(
        bytes32 did,
        Model memory x,
        address caller,
        bool isCore,
        SigvaraIdentity.AgentStatus t
    ) internal view returns (bool) {
        if (!x.registered || x.status == SigvaraIdentity.AgentStatus.Slashed) return false;
        if (t == SigvaraIdentity.AgentStatus.PendingBond) return false;
        if (t == SigvaraIdentity.AgentStatus.Slashed) return isCore;
        if (!isCore && (caller != x.operator || x.slashSuspended)) return false;
        if (t == SigvaraIdentity.AgentStatus.Active && !_bonded(did)) return false;
        return true;
    }

    /// Whether the registry is told an agent is bonded. Mostly yes, so activations can go through.
    function bond(uint256 didSeed, uint256 value) external {
        bytes32 did = dids[didSeed % dids.length];
        bool on = value % 4 != 0;
        uint256 which = (value / 4) % 3;
        if (which != 1) viewA.set(did, on);
        if (which != 0) viewB.set(did, on);
    }

    function clearSuspension(uint256 didSeed, uint256 who) external {
        bytes32 did = dids[didSeed % dids.length];
        Model memory x = m[did];
        address caller = who % 4 == 0 ? stranger : core;
        bool expectOk = x.registered && identity.hasRole(identity.STAKING_CORE_ROLE(), caller);

        vm.prank(caller);
        try identity.clearSlashSuspension(did) {
            if (!expectOk) _flag("a slash suspension was cleared by somebody who may not, or on an unknown agent");
            else {
                m[did].slashSuspended = false;
                okClear++;
            }
        } catch {
            if (expectOk) _flag("the staking core was refused when lifting a slash suspension");
        }
    }

    // -------------------------------------------------------------------------
    // Handover
    // -------------------------------------------------------------------------

    function offer(uint256 didSeed, uint256 who, uint256 toSeed) external {
        bytes32 did = dids[didSeed % dids.length];
        Model memory x = m[did];
        uint256 pick = who % 6;
        address caller = pick < 4 ? _holderOf(x) : (pick == 4 ? stranger : actors[(who / 6) % actors.length]);
        address to = toSeed % 9 == 0 ? address(0) : actors[toSeed % actors.length];
        bool expectOk = x.registered && caller == x.operator && x.status != SigvaraIdentity.AgentStatus.Slashed
            && !x.slashSuspended && to != address(0) && to != x.operator;

        vm.prank(caller);
        try identity.offerOperatorTransfer(did, to) {
            if (!expectOk) _flag("a handover offer was accepted that should have been refused");
            else {
                m[did].pending = to;
                okOffer++;
            }
        } catch {
            if (expectOk) _flag("a handover offer by the operator was refused");
        }
    }

    function cancel(uint256 didSeed, uint256 who) external {
        bytes32 did = dids[didSeed % dids.length];
        Model memory x = m[did];
        uint256 pick = who % 6;
        address caller = pick < 2 ? _holderOf(x) : (pick < 4 && x.pending != address(0) ? x.pending : stranger);
        bool expectOk = x.registered && x.pending != address(0) && (caller == x.operator || caller == x.pending);

        vm.prank(caller);
        try identity.cancelOperatorTransfer(did) {
            if (!expectOk) _flag("a handover offer was cancelled by somebody who may not, or with none outstanding");
            else {
                m[did].pending = address(0);
                okCancel++;
            }
        } catch {
            if (expectOk) _flag("the operator or the offered operator was refused when cancelling an offer");
        }
    }

    function accept(uint256 didSeed, uint256 who) external {
        bytes32 did = dids[didSeed % dids.length];
        Model memory x = m[did];
        uint256 pick = who % 6;
        address caller = pick < 4 ? (x.pending != address(0) ? x.pending : actors[(who / 6) % actors.length])
            : (pick == 4 ? stranger : _holderOf(x));
        bool expectOk = x.registered && x.pending != address(0) && caller == x.pending
            && x.status != SigvaraIdentity.AgentStatus.Slashed && !x.slashSuspended && _bonded(did);
        bool fromTheMiddle = false;
        if (x.registered) {
            bytes32[] memory held = identity.getOperatorAgents(x.operator);
            fromTheMiddle = held.length >= 2 && held[held.length - 1] != did;
        }

        vm.prank(caller);
        try identity.acceptOperatorTransfer(did) {
            if (!expectOk) _flag("a handover was accepted that should have been refused");
            else {
                if (fromTheMiddle) okSwapAccept++;
                m[did].operator = caller;
                m[did].pending = address(0);
                m[did].changedAt = block.timestamp;
                m[did].transfers += 1;
                okAccept++;
            }
        } catch {
            if (expectOk) _flag("the offered operator was refused a handover that was allowed");
        }
    }

    // -------------------------------------------------------------------------
    // Admin, the pause and time
    // -------------------------------------------------------------------------

    function adminAction(uint256 seed, uint256 value) external {
        uint256 pick = seed % 10;
        bytes32 coreRole = identity.STAKING_CORE_ROLE();
        if (pick < 2) {
            vm.prank(guardian);
            try identity.pauseInflows() {} catch {}
        } else if (pick < 5) {
            vm.prank(guardian);
            try identity.resumeInflows() {} catch {}
        } else if (pick < 8) {
            uint256 v = value % 3;
            address target = v == 0 ? address(viewA) : (v == 1 ? address(viewB) : address(0));
            address caller = (value / 3) % 4 == 0 ? stranger : admin;
            bool expectOk = caller == admin && target != address(0);
            vm.prank(caller);
            try identity.setStakeView(target) {
                if (!expectOk) _flag("the collateral oracle was repointed by somebody who may not, or to zero");
            } catch {
                if (expectOk) _flag("the collateral oracle could not be repointed by the upgrader");
            }
        } else if (pick == 8) {
            vm.prank(admin);
            identity.revokeRole(coreRole, core);
        } else {
            vm.prank(admin);
            identity.grantRole(coreRole, core);
        }
    }

    /// Time has to move or no pause ever ends. Steps are long next to the pause, so it lapses.
    function warp(uint256 secondsForward) external {
        vm.warp(block.timestamp + bound(secondsForward, 1 minutes, 5 days));
    }
}

/**
 * Invariant coverage for the identity registry.
 *
 * The unit suite checks single transitions. These assert what must hold after any reachable sequence of
 * them, which is where bookkeeping goes wrong: an agent listed under an operator that no longer holds
 * it, a status that moved when it was meant to be final, a handover that left an offer behind.
 */
/// forge-config: default.invariant.runs = 128
/// forge-config: default.invariant.depth = 300
contract IdentityInvariantTest is Test {
    SigvaraIdentity identity;
    SigvaraIdentity other;
    IdentityInvStakeView viewA;
    IdentityInvStakeView viewB;
    IdentityHandler handler;

    address admin = makeAddr("admin");
    address core = makeAddr("core");
    address guardian = makeAddr("guardian");
    address stranger = makeAddr("stranger");

    function _registry() internal returns (SigvaraIdentity) {
        return SigvaraIdentity(address(new ERC1967Proxy(
            address(new SigvaraIdentity()),
            abi.encodeCall(SigvaraIdentity.initialize, (admin, core))
        )));
    }

    function setUp() public {
        identity = _registry();
        other = _registry();
        viewA = new IdentityInvStakeView();
        viewB = new IdentityInvStakeView();
        vm.startPrank(admin);
        identity.initializeV2(address(viewA));
        identity.grantRole(identity.GUARDIAN_ROLE(), guardian);
        vm.stopPrank();

        // Three operators that register and two that only ever receive an agent.
        address[] memory actors = new address[](5);
        for (uint256 i = 0; i < 5; i++) actors[i] = makeAddr(string.concat("actor", vm.toString(i)));
        uint256[] memory keys = new uint256[](8);
        for (uint256 i = 0; i < 8; i++) (, keys[i]) = makeAddrAndKey(string.concat("agent", vm.toString(i)));

        handler = new IdentityHandler(
            IdentityHandler.Wiring({
                identity: identity,
                other: other,
                viewA: viewA,
                viewB: viewB,
                admin: admin,
                core: core,
                guardian: guardian,
                stranger: stranger,
                actors: actors,
                keys: keys
            })
        );
        targetContract(address(handler));
    }

    /// The plumbing works: the handler can register an agent, bond and activate it, have the staking core
    /// suspend it and refuse the operator's way out, clear the suspension, hand the agent to a new operator,
    /// rotate its key, slash it and find it frozen, and see a pause stop registrations. This is here because
    /// an invariant campaign whose handler never gets a call through passes every invariant and says nothing.
    function test_theHandlerActuallyReachesEveryAction() public {
        handler.register(1, 0, 0);
        assertEq(handler.okRegister(), 1, "register");
        bytes32 did = handler.dids(1);

        handler.bond(1, 1); // bonded on the view in use
        handler.setStatus(1, 0, 0); // the operator activates it
        assertEq(handler.okStatus(), 1, "activate");

        handler.setStatus(1, 3, 1); // the staking core suspends it for a slash
        assertEq(handler.okStatus(), 2, "suspend by the core");
        handler.setStatus(1, 0, 0); // the operator may not lift that
        assertEq(handler.okRefusedLock(), 1, "the lock holds against the operator");
        handler.clearSuspension(1, 1);
        assertEq(handler.okClear(), 1, "clear");

        handler.setStatus(1, 0, 0); // and now it may
        assertEq(handler.okStatus(), 3, "reactivate");

        handler.offer(1, 0, 3); // to actor 3
        assertEq(handler.okOffer(), 1, "offer");
        handler.accept(1, 0);
        assertEq(handler.okAccept(), 1, "accept");
        assertEq(identity.getIdentity(did).operator, handler.actors(3), "the agent changed hands");
        assertEq(identity.operatorAgentCount(handler.actors(3)), 1, "and is listed under its new operator");

        handler.rotate(1, 1, 5);
        assertEq(handler.okRotate(), 1, "rotate");

        handler.setStatus(1, 3, 2); // the staking core slashes it
        assertEq(handler.okSlash(), 1, "slash");
        handler.rotate(1, 1, 6); // a slashed agent cannot rotate
        assertEq(handler.okRotate(), 1, "slashed agents are frozen");

        handler.adminAction(0, 0); // pause
        handler.register(2, 0, 0);
        assertEq(handler.okRegister(), 1, "a pause stops registrations");

        assertEq(bytes(handler.violation()).length, 0, handler.violation());
    }

    /// The contract's books match the history the handler kept, agent by agent.
    ///
    /// Every field of every identity is what registration and the transitions since left there, and an
    /// agent nobody registered has nothing. The DID is the one its address derives, the active flag agrees
    /// with the status, the handover bookkeeping agrees with the handovers that happened, a slash lock
    /// exists only on a Suspended or Slashed agent, and an offer is never to the operator already holding
    /// the agent.
    function invariant_theBooksMatchTheHistory() public view {
        for (uint256 i = 0; i < handler.agentCount(); i++) {
            bytes32 did = handler.dids(i);
            SigvaraIdentity.AgentIdentity memory got = identity.getIdentity(did);
            IdentityHandler.Model memory want = handler.modelOf(did);

            assertEq(identity.slashSuspended(did), want.slashSuspended, "the slash lock differs");
            assertEq(identity.pendingOperator(did), want.pending, "the outstanding offer differs");
            assertEq(identity.operatorChangedAt(did), want.changedAt, "the last handover date differs");
            assertEq(identity.operatorTransferCount(did), want.transfers, "the handover count differs");
            assertEq(got.registeredAt, want.registeredAt, "the registration date differs");
            assertEq(got.operator, want.operator, "the operator differs");
            assertEq(got.agentAddress, want.agentAddress, "the agent address differs");
            assertEq(got.ed25519PubKey, want.pubKey, "the public key differs");
            assertEq(uint8(got.status), uint8(want.status), "the status differs");
            assertEq(identity.isActive(did), want.registered && want.status == SigvaraIdentity.AgentStatus.Active, "isActive disagrees with the status");

            if (!want.registered) continue;
            assertEq(identity.computeDidHash(got.agentAddress), did, "the DID is not the one the address derives");
            if (want.slashSuspended) {
                assertTrue(
                    want.status == SigvaraIdentity.AgentStatus.Suspended || want.status == SigvaraIdentity.AgentStatus.Slashed,
                    "a slash lock sits on an agent that is neither Suspended nor Slashed"
                );
            }
            if (want.pending != address(0)) assertTrue(want.pending != want.operator, "an offer to the operator already holding the agent");
            assertEq(want.changedAt == 0, want.transfers == 0, "handover date and count disagree");
            assertLe(want.changedAt, block.timestamp, "a handover is dated in the future");
        }
    }

    /// Each operator's list holds exactly the agents that operator holds: every entry points back to that
    /// operator, none appears twice, the lengths agree with the identities, the counts and the pages agree
    /// with the list, and no agent is missing from every list.
    function invariant_theOperatorIndexMirrorsTheIdentities() public view {
        uint256 total;
        for (uint256 a = 0; a < handler.actorCount(); a++) {
            address op = handler.actors(a);
            bytes32[] memory list = identity.getOperatorAgents(op);
            total += list.length;

            assertEq(list.length, identity.operatorAgentCount(op), "the count differs from the list");
            assertEq(list.length, handler.countHeldBy(op), "the list differs in length from the agents the operator holds");
            for (uint256 i = 0; i < list.length; i++) {
                assertEq(identity.getIdentity(list[i]).operator, op, "an agent is listed under an operator that does not hold it");
                for (uint256 j = 0; j < i; j++) assertTrue(list[j] != list[i], "an agent is listed twice");
            }

            bytes32[] memory all = identity.getOperatorAgentsPaged(op, 0, type(uint256).max);
            assertEq(keccak256(abi.encode(all)), keccak256(abi.encode(list)), "paging from the start differs from the list");
            assertEq(identity.getOperatorAgentsPaged(op, list.length, 1).length, 0, "a page past the end is not empty");
            if (list.length > 0) {
                bytes32[] memory last = identity.getOperatorAgentsPaged(op, list.length - 1, 5);
                assertEq(last.length, 1, "the last page is not one entry");
                assertEq(last[0], list[list.length - 1], "the last page holds the wrong entry");
            }
        }
        assertEq(total, handler.registeredCount(), "the lists together do not hold every registered agent once");
    }

    /// Rules that are decided at the moment of a call, each checked by the handler as it happened: who may
    /// register and with what signature, who may rotate, change status, lift a slash lock and hand an agent
    /// over, that a slash is final, and that the pause and the collateral oracle behave. A call the rules
    /// allow and the contract refused counts too.
    function invariant_noCallBrokeARule() public view {
        assertEq(bytes(handler.violation()).length, 0, handler.violation());
    }
}
