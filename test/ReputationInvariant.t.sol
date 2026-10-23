// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "./helpers/StackFixture.sol";

import "../src/interfaces/IOperatorSet.sol";

/// Stands in for SigvaraOracleBond. The handler flips who is active in it while the campaign runs.
contract ReputationInvOperatorSet is IOperatorSet {
    mapping(address => bool) public active;
    function set(address who, bool v) external { active[who] = v; }
    function isActiveOperator(address who) external view returns (bool) { return active[who]; }
}

/**
 * Drives SigvaraReputation, with the identity registry and the staking contract it reads, through
 * every externally reachable transition with bounded, random inputs: proposals from oracles and from
 * strangers (some above their caps), finalizing and rejecting, slashes, bonds drained and restored,
 * operator handovers, the admin setters, a pause, and time moving between them. Calls the contracts
 * refuse are swallowed: the refusals are the behaviour under test, and the invariants say what must
 * hold whatever was accepted.
 *
 * The handler keeps a model of what the contract should hold: the proposal each agent has pending, the
 * score it last finalized, and the spendable score it anchored from. The invariants compare the
 * contract's books against it. Rules that can only be judged at the moment of a call (who was
 * allowed, what the state was just before) are checked there and recorded in a flag, and an invariant
 * asserts that no flag was ever set. A flag is set in the same frame as the call, never after a
 * revert, so none of them can be lost to a failed assertion.
 */
contract ReputationHandler is Test {
    struct Wiring {
        SigvaraReputation rep;
        SigvaraIdentity identity;
        SigvaraStaking staking;
        FixtureToken svr;
        ReputationInvOperatorSet opSet;
        address admin;
        address committee;
        address guardian;
        address victim;
        address[] proposers; // 0 and 1 hold ORACLE_ROLE to begin with, 2 does not
        address[] buyers;
        bytes32[] dids;
    }

    /// What the handler believes an agent has pending. Mirrors SigvaraReputation.PendingScore.
    struct Pend {
        bool exists;
        SigvaraReputation.ReputationData data;
        bytes32 root;
        address proposer;
        uint256 at;
        uint256 finalizableAt;
    }

    SigvaraReputation public rep;
    SigvaraIdentity public identity;
    SigvaraStaking public staking;
    FixtureToken public svr;
    ReputationInvOperatorSet public opSet;
    address public admin;
    address public committee;
    address public guardian;
    address public victim;
    address[] public proposers;
    address[] public buyers;
    bytes32[] public dids;
    /// A hash nobody registered. Proposals for it must always be refused.
    bytes32 public immutable UNREGISTERED = keccak256("reputation.invariant.unregistered");

    uint256 public constant MIN_STAKE = 1000e18;

    // The caps the contract documents, restated here and not read back from it.
    uint8 internal constant CAP_FEE = 20;
    uint8 internal constant CAP_SUCCESS = 15;
    uint8 internal constant CAP_AGE = 30;
    uint8 internal constant CAP_EXTERNAL = 25;
    uint8 internal constant CAP_COMMUNITY = 5;
    uint8 internal constant CAP_PROPAGATION = 5;

    // The model.
    mapping(bytes32 => Pend) internal pend;
    mapping(bytes32 => SigvaraReputation.ReputationData) internal finalized;
    mapping(bytes32 => bytes32) public finalizedRoot;
    mapping(bytes32 => uint8) public anchorOf;
    mapping(bytes32 => uint256) public anchoredAt;
    /// The fastest the maturity rate has ever been, in points a day. The rate is applied to the whole
    /// time since the anchor when a score is read, so a raised rate lifts scores already maturing.
    uint256 public fastestRate;

    // Rules judged at the call. See the contract comment.
    bool public aBadProposalWasAccepted;
    bool public aBadFinalizeWasAccepted;
    bool public aBadRejectWasAccepted;
    bool public aRiseWasNotHeldAtTheAnchor;
    bool public spendableFellWithTime;
    bool public aLimitOutOfBoundsWasAccepted;
    // The other direction: a call the model says must succeed, refused. This is how a score gets stuck.
    bool public aValidProposalWasRefused;
    bool public aValidFinalizeWasRefused;
    bool public aValidRejectWasRefused;
    bool public aValidLimitWasRefused;

    // How often each action got through, so a campaign that never reached one cannot pass for one that did.
    uint256 public okPropose;
    uint256 public okProposeIfEmpty;
    uint256 public okFinalize;
    uint256 public okFinalizeRise;
    uint256 public okReject;
    uint256 public okSlash;
    uint256 public okHandover;
    uint256 public okReplaced;

    constructor(Wiring memory w, uint256 initialRate) {
        rep = w.rep;
        identity = w.identity;
        staking = w.staking;
        svr = w.svr;
        opSet = w.opSet;
        admin = w.admin;
        committee = w.committee;
        guardian = w.guardian;
        victim = w.victim;
        proposers = w.proposers;
        buyers = w.buyers;
        dids = w.dids;
        fastestRate = initialRate;
    }

    function agentCount() external view returns (uint256) { return dids.length; }
    /// Whether the factors a seed produces are all within their caps, for a test that needs a proposal to go through.
    function inRange(uint256 factorSeed) external pure returns (bool) { return _inRange(_factors(factorSeed)); }
    function pendingOf(bytes32 did) external view returns (Pend memory) { return pend[did]; }
    function finalizedOf(bytes32 did) external view returns (SigvaraReputation.ReputationData memory) {
        return finalized[did];
    }

    // -------------------------------------------------------------------------
    // The rules, restated independently of the contract
    // -------------------------------------------------------------------------

    function _inRange(SigvaraReputation.ReputationData memory d) internal pure returns (bool) {
        return d.feeScore <= CAP_FEE && d.successScore <= CAP_SUCCESS && d.ageScore <= CAP_AGE
            && d.externalScore <= CAP_EXTERNAL && d.communityScore <= CAP_COMMUNITY
            && d.propagationScore <= CAP_PROPAGATION;
    }

    /// An agent can be scored only if it exists, is not slashed and holds the minimum bond.
    function _scorable(bytes32 did) internal view returns (bool) {
        SigvaraIdentity.AgentIdentity memory id = identity.getIdentity(did);
        return id.registeredAt != 0 && id.status != SigvaraIdentity.AgentStatus.Slashed
            && staking.hasMinimumStake(did);
    }

    /// Holds ORACLE_ROLE and, when a bonded-operator set is configured, is active in it.
    function _mayPropose(address who) internal view returns (bool) {
        if (!rep.hasRole(rep.ORACLE_ROLE(), who)) return false;
        return address(rep.operatorBond()) == address(0) || opSet.active(who);
    }

    function _factors(uint256 seed) internal pure returns (SigvaraReputation.ReputationData memory d) {
        uint256 r = uint256(keccak256(abi.encode(seed)));
        d.feeScore = _factor(r, 0, CAP_FEE);
        d.successScore = _factor(r, 1, CAP_SUCCESS);
        d.ageScore = _factor(r, 2, CAP_AGE);
        d.externalScore = _factor(r, 3, CAP_EXTERNAL);
        d.communityScore = _factor(r, 4, CAP_COMMUNITY);
        d.propagationScore = _factor(r, 5, CAP_PROPAGATION);
        // The contract stamps lastUpdated itself at finalize, so whatever the proposer sends is not kept.
        d.lastUpdated = (r >> 200) % 1_000_000;
        // One in eight carries a factor above its cap, most of them by exactly one: the boundary is where a
        // cap that is enforced a point late hides, and uniform values almost never land on it.
        if ((r >> 48) % 8 == 0) {
            uint256 w = uint256(keccak256(abi.encode(r, "over")));
            uint8 over = (w >> 8) % 4 == 0 ? uint8(1 + (w >> 16) % 50) : 1;
            uint256 which = w % 6;
            if (which == 0) d.feeScore = CAP_FEE + over;
            else if (which == 1) d.successScore = CAP_SUCCESS + over;
            else if (which == 2) d.ageScore = CAP_AGE + over;
            else if (which == 3) d.externalScore = CAP_EXTERNAL + over;
            else if (which == 4) d.communityScore = CAP_COMMUNITY + over;
            else d.propagationScore = CAP_PROPAGATION + over;
        }
    }

    /// A factor for one slot: its cap one time in four, so the top of the range is not left to chance, and
    /// otherwise anywhere in range.
    function _factor(uint256 r, uint256 slot, uint8 cap) internal pure returns (uint8) {
        uint256 x = uint256(keccak256(abi.encode(r, slot)));
        if (x % 4 == 0) return cap;
        return uint8((x >> 8) % (uint256(cap) + 1));
    }

    function _earned(SigvaraReputation.ReputationData memory d) internal pure returns (uint256) {
        return uint256(d.feeScore) + d.successScore + d.ageScore + d.externalScore + d.communityScore
            + d.propagationScore;
    }

    // -------------------------------------------------------------------------
    // Proposing
    // -------------------------------------------------------------------------

    function propose(uint256 callerSeed, uint256 didSeed, uint256 factorSeed) external {
        _propose(proposers[callerSeed % proposers.length], _didOrUnregistered(didSeed), factorSeed, false);
    }

    function proposeIfEmpty(uint256 callerSeed, uint256 didSeed, uint256 factorSeed) external {
        _propose(proposers[callerSeed % proposers.length], _didOrUnregistered(didSeed), factorSeed, true);
    }

    function _didOrUnregistered(uint256 seed) internal view returns (bytes32) {
        uint256 pick = seed % (dids.length + 1);
        return pick == dids.length ? UNREGISTERED : dids[pick];
    }

    function _propose(address caller, bytes32 did, uint256 factorSeed, bool onlyIfEmpty) internal {
        SigvaraReputation.ReputationData memory d = _factors(factorSeed);
        bytes32 root = keccak256(abi.encode("root", factorSeed));
        Pend memory before_ = pend[did];

        // Judged against the state just before the call.
        bool refuse = rep.inflowsPaused() || !_scorable(did) || !_inRange(d) || !_mayPropose(caller)
            || (onlyIfEmpty && before_.exists && _mayPropose(before_.proposer));

        bool ok;
        vm.prank(caller);
        if (onlyIfEmpty) {
            try rep.proposeIfEmpty(did, d, root) { ok = true; } catch {}
        } else {
            try rep.proposeReputation(did, d, root) { ok = true; } catch {}
        }
        if (!ok) {
            if (!refuse) aValidProposalWasRefused = true;
            return;
        }

        if (refuse) aBadProposalWasAccepted = true;
        if (before_.exists) okReplaced++;
        pend[did] = Pend({
            exists: true,
            data: d,
            root: root,
            proposer: caller,
            at: block.timestamp,
            finalizableAt: block.timestamp + rep.challengeWindow()
        });
        if (onlyIfEmpty) okProposeIfEmpty++;
        else okPropose++;
    }

    // -------------------------------------------------------------------------
    // Finalizing and rejecting
    // -------------------------------------------------------------------------

    function finalize(uint256 didSeed) external {
        bytes32 did = dids[didSeed % dids.length];
        Pend memory p = pend[did];
        bool refuse = !p.exists || block.timestamp < p.finalizableAt || !_scorable(did) || !_mayPropose(p.proposer);
        uint8 anchor = rep.getTotalScore(did);

        try rep.finalizeReputation(did) {
            if (refuse) aBadFinalizeWasAccepted = true;

            SigvaraReputation.ReputationData memory d = p.data;
            d.lastUpdated = block.timestamp;
            finalized[did] = d;
            finalizedRoot[did] = p.root;
            anchorOf[did] = anchor;
            anchoredAt[did] = block.timestamp;
            delete pend[did];

            // A jump in the earned score is released from where the agent stood, and a fall applies at once.
            // Checked in the block of the finalize, when no time has passed to release anything. A handover
            // in this very second restarts maturity from zero, so that case is left to the other invariants.
            uint256 earned = _earned(d);
            uint256 expected = earned < anchor ? earned : anchor;
            if (identity.operatorChangedAt(did) < block.timestamp && rep.getTotalScore(did) != expected) {
                aRiseWasNotHeldAtTheAnchor = true;
            }
            if (earned > anchor) okFinalizeRise++;
            okFinalize++;
        } catch {
            if (!refuse) aValidFinalizeWasRefused = true;
        }
    }

    function reject(uint256 callerSeed, uint256 didSeed) external {
        address caller = callerSeed % 4 == 0 ? proposers[2] : committee;
        bytes32 did = dids[didSeed % dids.length];
        Pend memory p = pend[did];
        bool refuse = caller != committee || !p.exists || block.timestamp >= p.finalizableAt;

        vm.prank(caller);
        try rep.rejectReputation(did) {
            if (refuse) aBadRejectWasAccepted = true;
            delete pend[did];
            okReject++;
        } catch {
            if (!refuse) aValidRejectWasRefused = true;
        }
    }

    // -------------------------------------------------------------------------
    // The actions below are grouped behind one selector each, with the seed choosing among them. The fuzzer
    // picks selectors evenly, so grouping is what keeps the calls that disable the contract (a pause, a
    // revoked role, a drained bond) from outnumbering the ones that use it.
    // -------------------------------------------------------------------------

    /// Slashing. Only the last agent can be slashed, so the others stay alive for the whole campaign.
    function slash(uint256 seed) external {
        bytes32 did = dids[dids.length - 1];
        uint256 pick = seed % 5;
        if (pick < 2) {
            vm.prank(committee);
            try staking.initiateSlash(did, victim, "") {} catch {}
        } else if (pick < 4) {
            try staking.executeSlash(did) {
                // The registry now says Slashed, and the score was zeroed at this moment.
                delete finalized[did];
                finalized[did].lastUpdated = block.timestamp;
                finalizedRoot[did] = bytes32(0);
                anchorOf[did] = 0;
                anchoredAt[did] = block.timestamp;
                delete pend[did];
                okSlash++;
            } catch {}
        } else {
            vm.prank(committee);
            try staking.cancelSlash(did) {} catch {}
        }
    }

    /// Bonds: suspend, drain, restore, reactivate. A drained agent is unscorable until it is topped up.
    function bond(uint256 seed, uint256 amount) external {
        bytes32 did = dids[seed % dids.length];
        address op = identity.getIdentity(did).operator;
        uint256 pick = (seed / dids.length) % 4;
        if (pick == 0) {
            vm.prank(op);
            try identity.updateStatus(did, SigvaraIdentity.AgentStatus.Suspended) {} catch {}
        } else if (pick == 1) {
            uint256 staked = staking.getStake(did);
            if (staked == 0) return;
            vm.prank(op);
            try staking.initiateWithdrawal(did, bound(amount, 1, staked)) {} catch {}
        } else if (pick == 2) {
            uint256 staked = staking.getStake(did);
            uint256 top = (staked >= MIN_STAKE ? 0 : MIN_STAKE - staked) + bound(amount, 0, MIN_STAKE / 2);
            if (top == 0) return;
            svr.mint(op, top);
            vm.startPrank(op);
            svr.approve(address(staking), top);
            try staking.depositStake(did, top) {} catch {}
            vm.stopPrank();
        } else {
            vm.prank(op);
            try identity.updateStatus(did, SigvaraIdentity.AgentStatus.Active) {} catch {}
        }
    }

    /// Handovers: offer the agent to a new operator, or have whoever was offered it accept.
    function handover(uint256 seed) external {
        bytes32 did = dids[seed % dids.length];
        address offered = identity.pendingOperator(did);
        if (offered != address(0) && (seed / dids.length) % 2 == 0) {
            vm.prank(offered);
            try identity.acceptOperatorTransfer(did) { okHandover++; } catch {}
        } else {
            vm.prank(identity.getIdentity(did).operator);
            try identity.offerOperatorTransfer(did, buyers[(seed / 8) % buyers.length]) {} catch {}
        }
    }

    /// Admin, roles, the bonded-operator set and the pause.
    function adminAction(uint256 seed, uint256 value) external {
        uint256 pick = seed % 16;
        bytes32 oracleRole = rep.ORACLE_ROLE();
        if (pick < 3) {
            uint256 window = bound(value, 0, 8 days);
            vm.prank(admin);
            bool inBounds = window >= 1 hours && window <= 7 days;
            try rep.setChallengeWindow(window) {
                if (!inBounds) aLimitOutOfBoundsWasAccepted = true;
            } catch {
                if (inBounds) aValidLimitWasRefused = true;
            }
        } else if (pick < 5) {
            uint256 rate = bound(value, 0, 110);
            vm.prank(admin);
            bool inBounds = rate >= 1 && rate <= 100;
            try rep.setMaturityRate(rate) {
                if (!inBounds) aLimitOutOfBoundsWasAccepted = true;
                if (rate > fastestRate) fastestRate = rate;
            } catch {
                if (inBounds) aValidLimitWasRefused = true;
            }
        } else if (pick == 5) {
            vm.prank(admin);
            rep.setOperatorBond(value % 2 == 0 ? address(opSet) : address(0));
        } else if (pick < 9) {
            opSet.set(proposers[value % proposers.length], (value / 4) % 4 != 0);
        } else if (pick < 12) {
            vm.prank(admin);
            rep.grantRole(oracleRole, proposers[value % 2]);
        } else if (pick == 12) {
            vm.prank(admin);
            rep.revokeRole(oracleRole, proposers[value % 2]);
        } else if (pick == 13) {
            vm.prank(guardian);
            try rep.pauseInflows() {} catch {}
        } else {
            vm.prank(guardian);
            try rep.resumeInflows() {} catch {}
        }
    }

    /// Time has to move or no window closes and nothing matures. With the rate held where it is, letting
    /// time pass can only release more of an earned score, never take any back.
    function warp(uint256 secondsForward) external {
        uint256 n = dids.length;
        uint8[] memory before_ = new uint8[](n);
        for (uint256 i = 0; i < n; i++) before_[i] = rep.getTotalScore(dids[i]);
        vm.warp(block.timestamp + bound(secondsForward, 1 minutes, 10 days));
        for (uint256 i = 0; i < n; i++) {
            if (rep.getTotalScore(dids[i]) < before_[i]) spendableFellWithTime = true;
        }
    }
}

/**
 * Invariant coverage for the contract that stores scores.
 *
 * The unit suite checks single transitions. These assert what must hold after any reachable sequence of
 * them, which is where a score store goes wrong: a score above its caps, a proposal that moves after it
 * was made, a rise released faster than the rate allows, a slashed agent that keeps a score.
 */
/// forge-config: default.invariant.runs = 128
/// forge-config: default.invariant.depth = 300
contract ReputationInvariantTest is StackFixture {
    ReputationHandler handler;
    ReputationInvOperatorSet opSet;

    address oracle2 = makeAddr("oracle2");
    address stranger = makeAddr("stranger");
    address guardian = makeAddr("guardian");

    uint256 constant INITIAL_RATE = 10;

    function setUp() public {
        _deployStack();
        opSet = new ReputationInvOperatorSet();

        vm.startPrank(admin);
        reputation.setMaturityRate(INITIAL_RATE);
        reputation.grantRole(reputation.ORACLE_ROLE(), oracle2);
        reputation.grantRole(reputation.GUARDIAN_ROLE(), guardian);
        vm.stopPrank();

        // Three agents that are never slashed and a fourth that can be. Each is registered under its own
        // operator and bonded, so it is scorable from the first call.
        bytes32[] memory dids = new bytes32[](4);
        for (uint256 i = 0; i < 4; i++) {
            address op = makeAddr(string.concat("operator", vm.toString(i)));
            (, uint256 agentPk) = makeAddrAndKey(string.concat("agent", vm.toString(i)));
            dids[i] = registerSigned(identity, op, agentPk, bytes32(uint256(i + 1)));
            svr.mint(op, MIN_STAKE);
            vm.startPrank(op);
            svr.approve(address(staking), type(uint256).max);
            staking.depositStake(dids[i], MIN_STAKE);
            vm.stopPrank();
        }

        address[] memory proposers = new address[](3);
        proposers[0] = oracle;
        proposers[1] = oracle2;
        proposers[2] = stranger;
        address[] memory buyers = new address[](2);
        buyers[0] = makeAddr("buyer0");
        buyers[1] = makeAddr("buyer1");

        handler = new ReputationHandler(
            ReputationHandler.Wiring({
                rep: reputation,
                identity: identity,
                staking: staking,
                svr: svr,
                opSet: opSet,
                admin: admin,
                committee: committee,
                guardian: guardian,
                victim: victim,
                proposers: proposers,
                buyers: buyers,
                dids: dids
            }),
            INITIAL_RATE
        );
        targetContract(address(handler));
    }

    /// The plumbing works: the handler can have an agent scored, let a rise mature, slash the agent
    /// that can be slashed, and move an agent to a new operator. This is here because an invariant
    /// campaign whose handler never gets a call through passes every invariant and says nothing.
    function test_theHandlerActuallyReachesEveryAction() public {
        // Seeds whose factors are all within their caps. One seed in eight is not, on purpose.
        uint256 s1 = _validSeed(11);
        uint256 s2 = _validSeed(s1 + 1);
        uint256 s3 = _validSeed(s2 + 1);

        handler.propose(0, 0, s1);
        assertEq(handler.okPropose(), 1, "propose");
        handler.proposeIfEmpty(1, 1, s2);
        assertEq(handler.okProposeIfEmpty(), 1, "proposeIfEmpty");
        handler.propose(0, 0, s3); // replaces the first
        assertEq(handler.okReplaced(), 1, "replace");

        handler.reject(1, 1);
        assertEq(handler.okReject(), 1, "reject");

        handler.warp(2 hours);
        handler.finalize(0);
        assertEq(handler.okFinalize(), 1, "finalize");
        assertEq(handler.okFinalizeRise(), 1, "finalize with a rise");

        handler.handover(0); // offer (nothing is pending yet)
        handler.handover(0); // accept
        assertEq(handler.okHandover(), 1, "handover");

        handler.slash(0); // initiate
        handler.warp(8 days);
        handler.slash(2); // execute
        assertEq(handler.okSlash(), 1, "slash");

        assertFalse(handler.aBadProposalWasAccepted());
        assertFalse(handler.aBadFinalizeWasAccepted());
        assertFalse(handler.aBadRejectWasAccepted());
        assertFalse(handler.aRiseWasNotHeldAtTheAnchor());
        assertFalse(handler.spendableFellWithTime());
    }

    function _validSeed(uint256 from) internal view returns (uint256 seed) {
        seed = from;
        while (!handler.inRange(seed)) seed++;
    }

    /// The contract's books match the history the handler kept, agent by agent.
    ///
    /// The stored score, its evidence root and its maturity anchor are only ever what a finalize or a slash
    /// left there; a rejected or replaced proposal touches none of them. A pending proposal is exactly the
    /// one that was made: its factors, its root, its proposer, the moment it was made and the end of its
    /// review window as the window stood then, which an admin changing the window afterwards does not move.
    /// A slashed agent has no score, no evidence and nothing pending, and reads zero.
    function invariant_theBooksMatchTheHistory() public view {
        for (uint256 i = 0; i < handler.agentCount(); i++) {
            bytes32 did = handler.dids(i);
            assertEq(
                keccak256(abi.encode(reputation.getReputation(did))),
                keccak256(abi.encode(handler.finalizedOf(did))),
                "the stored score differs from the last finalized one"
            );
            assertEq(reputation.evidenceRoots(did), handler.finalizedRoot(did), "the evidence root differs");
            assertEq(reputation.maturedScore(did), handler.anchorOf(did), "the maturity anchor differs");
            assertEq(reputation.maturedAt(did), handler.anchoredAt(did), "the anchor date differs");

            ReputationHandler.Pend memory p = handler.pendingOf(did);
            SigvaraReputation.PendingScore memory want = SigvaraReputation.PendingScore({
                data: p.data,
                proposedAt: p.at,
                exists: p.exists,
                evidenceRoot: p.root,
                proposer: p.proposer,
                finalizableAt: p.finalizableAt
            });
            assertEq(
                keccak256(abi.encode(reputation.getPendingScore(did))),
                keccak256(abi.encode(want)),
                "a pending proposal differs from the one that was made"
            );

            if (identity.getIdentity(did).status == SigvaraIdentity.AgentStatus.Slashed) {
                assertEq(reputation.getEarnedScore(did), 0, "a slashed agent kept an earned score");
                assertEq(reputation.getTotalScore(did), 0, "a slashed agent kept a spendable score");
                assertFalse(reputation.getPendingScore(did).exists, "a slashed agent has a proposal pending");
                assertEq(reputation.evidenceRoots(did), bytes32(0), "a slashed agent kept its evidence root");
            }
        }
    }

    /// No factor of a stored or pending score is above its cap, so no total is above 100; what an agent can
    /// spend is never more than it has earned; and a rise is released no faster than the fastest maturity
    /// rate there has ever been, counted from the anchor, and from zero after a handover.
    function invariant_scoresStayWithinTheirCapsAndMaturityIsBounded() public view {
        for (uint256 i = 0; i < handler.agentCount(); i++) {
            bytes32 did = handler.dids(i);
            assertTrue(_withinCaps(reputation.getReputation(did)), "a stored factor is above its cap");
            assertTrue(_withinCaps(reputation.getPendingScore(did).data), "a pending factor is above its cap");

            uint256 earned = reputation.getEarnedScore(did);
            uint256 spendable = reputation.getTotalScore(did);
            assertLe(earned, 100, "an earned score is above 100");
            assertLe(spendable, earned, "spendable exceeds earned");

            uint256 since = reputation.maturedAt(did);
            uint256 anchor = reputation.maturedScore(did);
            uint256 changed = identity.operatorChangedAt(did);
            if (changed != 0 && changed >= since) {
                since = changed;
                anchor = 0;
            }
            if (since == 0) {
                assertEq(earned, 0, "a score was earned without ever being finalized");
                continue;
            }
            uint256 ceiling = anchor + (block.timestamp - since) * handler.fastestRate() / 1 days;
            if (earned < ceiling) ceiling = earned;
            // A fall is immediate: when the earned score is at or below the anchor, it is the earned score.
            if (earned <= anchor) ceiling = earned;
            assertLe(spendable, ceiling, "spendable rose faster than the maturity rate allows");
        }
    }

    function _withinCaps(SigvaraReputation.ReputationData memory d) internal pure returns (bool) {
        return d.feeScore <= 20 && d.successScore <= 15 && d.ageScore <= 30 && d.externalScore <= 25
            && d.communityScore <= 5 && d.propagationScore <= 5;
    }

    /// Rules that are decided at the moment of a call, each checked by the handler as it happened.
    function invariant_noCallBrokeARule() public view {
        assertFalse(handler.aBadProposalWasAccepted(), "a proposal was accepted that should have been refused");
        assertFalse(handler.aBadFinalizeWasAccepted(), "a finalize went through that should have been refused");
        assertFalse(handler.aBadRejectWasAccepted(), "a rejection went through that should have been refused");
        assertFalse(handler.aRiseWasNotHeldAtTheAnchor(), "a finalize released a rise at once, or held a fall");
        assertFalse(handler.spendableFellWithTime(), "time passing took spendable score away");
        assertFalse(handler.aLimitOutOfBoundsWasAccepted(), "a window or rate outside its bounds was accepted");
        assertFalse(handler.aValidProposalWasRefused(), "a proposal that was allowed was refused");
        assertFalse(handler.aValidFinalizeWasRefused(), "a proposal past its window, with an authorized proposer, would not finalize");
        assertFalse(handler.aValidRejectWasRefused(), "the committee could not reject a proposal inside its window");
        assertFalse(handler.aValidLimitWasRefused(), "a window or rate inside its bounds was refused");
    }
}
