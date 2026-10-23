// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "./helpers/RegistrationHelper.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import "../src/SigvaraEpochFees.sol";
import "../src/SigvaraIdentity.sol";
import "../src/interfaces/IOperatorSet.sol";

contract EpochFeesInvToken is ERC20 {
    constructor() ERC20("Sigvara", "SVR") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// Stands in for SigvaraOracleBond. The handler flips who is active in it while the campaign runs.
contract EpochFeesInvOperatorSet is IOperatorSet {
    mapping(address => bool) public active;
    function set(address who, bool v) external { active[who] = v; }
    function isActiveOperator(address who) external view returns (bool) { return active[who]; }
}

/**
 * Drives SigvaraEpochFees through every externally reachable transition with bounded, random
 * inputs: funding (including an unregistered hash), withdrawing (including by strangers),
 * charging (by an oracle, by a second oracle, by a stranger, with the bonded-operator check on and
 * off), distributing under every stage, and the admin setters, with time moving between them.
 * Calls the contract refuses are swallowed: the refusals are the behaviour under test, and the
 * invariants say what must hold whatever was accepted.
 *
 * Two kinds of evidence come out of it. Ghost totals are what the handler put in and took out, which
 * the invariants reconcile against the contract's own books. Flags are rules that can only be
 * judged at the moment of a call (who was allowed, what the state was just before), so the handler
 * checks them there and an invariant asserts that none was ever broken. A flag is set in the same
 * frame as the call, never after a revert, so none of them can be lost to a failed assertion.
 */
contract EpochFeesHandler is Test {
    SigvaraEpochFees public fees;
    SigvaraIdentity public identity;
    EpochFeesInvToken public svr;
    EpochFeesInvOperatorSet public operatorSet;
    address public admin;

    address public constant BURN = address(0xdead);
    /// The shortest epoch the contract documents, restated here and not read back from it.
    uint256 public constant EPOCH_LENGTH_FLOOR = 1 hours;

    address[] public operators;  // operators[i] is the operator of dids[i]
    bytes32[] public dids;
    address[] public funders;
    address[] public callers;    // 0 and 1 hold ORACLE_ROLE, 2 does not
    address[] public pools;
    bytes32 public immutable UNREGISTERED = keccak256("epochfees.invariant.unregistered");

    // What went in and what came out, in the units of the stake token.
    uint256 public totalDeposited;
    uint256 public totalDonated;
    uint256 public totalWithdrawn;
    uint256 public totalCharged;
    uint256 public totalDistributed;
    mapping(bytes32 => uint256) public expectedBalance;
    mapping(bytes32 => mapping(bytes32 => bool)) private chargedIn;

    // Rules judged at the call. See the contract comment.
    bool public fundedAnUnregisteredAgent;
    bool public aStrangerWithdrew;
    bool public anUnauthorizedCallerCharged;
    bool public chargedTwiceInOneEpoch;
    bool public aChargeWasNotExactlyTheFee;
    bool public distributionMissedItsSplit;
    bool public epochLengthBelowFloorAccepted;
    // The other direction: a call the model says must succeed, refused. This is how funds get stuck.
    bool public aValidDepositWasRefused;
    bool public aValidWithdrawWasRefused;
    bool public aValidChargeWasRefused;
    bool public aValidDistributionWasRefused;

    // How often each action got through, so a campaign that never reached one cannot pass for one that did.
    uint256 public okDeposit;
    uint256 public okWithdraw;
    uint256 public okCharge;
    uint256 public okChargeWithFee;
    uint256 public okDistribute;

    constructor(
        SigvaraEpochFees fees_,
        SigvaraIdentity identity_,
        EpochFeesInvToken svr_,
        EpochFeesInvOperatorSet operatorSet_,
        address admin_,
        address[] memory operators_,
        bytes32[] memory dids_,
        address[] memory callers_
    ) {
        fees = fees_;
        identity = identity_;
        svr = svr_;
        operatorSet = operatorSet_;
        admin = admin_;
        operators = operators_;
        dids = dids_;
        callers = callers_;
        for (uint256 i = 0; i < 2; i++) funders.push(makeAddr(string.concat("funder", vm.toString(i))));
        for (uint256 i = 0; i < 3; i++) pools.push(makeAddr(string.concat("pool", vm.toString(i))));
    }

    function agentCount() external view returns (uint256) { return dids.length; }
    function poolCount() external view returns (uint256) { return pools.length; }

    function _sub(uint256 a, uint256 b) internal pure returns (uint256) { return a > b ? a - b : 0; }

    /// The burn share the spec gives each stage, in basis points: restated here, not read back from the contract.
    function _burnBps(SigvaraEpochFees.Stage s) internal pure returns (uint256) {
        if (s == SigvaraEpochFees.Stage.Transition) return 2_000;
        if (s == SigvaraEpochFees.Stage.Mature) return 5_000;
        return 0;
    }

    // -------------------------------------------------------------------------
    // Funding
    // -------------------------------------------------------------------------

    function deposit(uint256 funderSeed, uint256 didSeed, uint256 amount) external {
        address funder = funders[funderSeed % funders.length];
        uint256 pick = didSeed % (dids.length + 1);
        bytes32 did = pick == dids.length ? UNREGISTERED : dids[pick];
        amount = bound(amount, 1, 5_000e18);
        svr.mint(funder, amount);
        vm.startPrank(funder);
        svr.approve(address(fees), amount);
        try fees.depositFor(did, amount) {
            if (did == UNREGISTERED) fundedAnUnregisteredAgent = true;
            expectedBalance[did] += amount;
            totalDeposited += amount;
            okDeposit++;
        } catch {
            if (did != UNREGISTERED) aValidDepositWasRefused = true;
        }
        vm.stopPrank();
    }

    /// Tokens sent to the contract outside depositFor. They are nobody's balance, so they must not
    /// move any ledger, and they are accounted for separately.
    function donate(uint256 amount) external {
        amount = bound(amount, 1, 1_000e18);
        svr.mint(address(this), amount);
        require(svr.transfer(address(fees), amount), "the donation failed");
        totalDonated += amount;
    }

    function withdraw(uint256 actorSeed, uint256 didSeed, uint256 amount) external {
        uint256 i = didSeed % dids.length;
        bytes32 did = dids[i];
        // Mostly the agent's own operator, so the call can succeed; sometimes a funder or another agent's operator.
        address actor = actorSeed % 3 == 0
            ? (actorSeed % 2 == 0 ? funders[(actorSeed / 6) % funders.length] : operators[(i + 1) % operators.length])
            : operators[i];
        uint256 bal = fees.balance(did);
        amount = bound(amount, 1, bal + 1e18);
        vm.prank(actor);
        try fees.withdraw(did, amount) {
            if (actor != identity.getIdentity(did).operator) aStrangerWithdrew = true;
            expectedBalance[did] = _sub(expectedBalance[did], amount);
            totalWithdrawn += amount;
            okWithdraw++;
        } catch {
            if (actor == operators[i] && amount <= bal) aValidWithdrawWasRefused = true;
        }
    }

    // -------------------------------------------------------------------------
    // Charging
    // -------------------------------------------------------------------------

    function charge(uint256 callerSeed, uint256 didSeed) external {
        address caller = callers[callerSeed % callers.length];
        bytes32 did = dids[didSeed % dids.length];

        uint256 fee = fees.epochFee();
        uint256 length = fees.epochLength();
        uint256 balBefore = fees.balance(did);
        uint256 lastBefore = fees.lastChargedAt(did);
        uint256 collectedBefore = fees.collected();
        bool hasRole_ = fees.hasRole(fees.ORACLE_ROLE(), caller);
        bool bonded = address(fees.operatorBond()) == address(0) || operatorSet.active(caller);

        vm.prank(caller);
        try fees.chargeEpoch(did) returns (bool charged) {
            if (!hasRole_) anUnauthorizedCallerCharged = true;
            if (!charged) aChargeWasNotExactlyTheFee = true;
            if (fee == 0) {
                // Gating is off: it reports covered and moves nothing.
                if (
                    fees.balance(did) != balBefore || fees.collected() != collectedBefore
                        || fees.lastChargedAt(did) != lastBefore
                ) aChargeWasNotExactlyTheFee = true;
            } else {
                if (!bonded) anUnauthorizedCallerCharged = true;
                if (
                    balBefore < fee || fees.balance(did) != balBefore - fee
                        || fees.collected() != collectedBefore + fee || fees.lastChargedAt(did) != block.timestamp
                ) aChargeWasNotExactlyTheFee = true;
                // One charge per agent per epoch: two in the same epoch of the same length is a double charge.
                bytes32 key = keccak256(abi.encode(length, length == 0 ? 0 : block.timestamp / length));
                if (chargedIn[did][key]) chargedTwiceInOneEpoch = true;
                chargedIn[did][key] = true;
                expectedBalance[did] = _sub(expectedBalance[did], fee);
                totalCharged += fee;
                okChargeWithFee++;
            }
            okCharge++;
        } catch {
            // Allowed to charge, covered, and not yet charged in this epoch: it must have gone through.
            bool fresh = lastBefore == 0 || (length != 0 && lastBefore / length < block.timestamp / length);
            if (hasRole_ && (fee == 0 || (bonded && length != 0 && balBefore >= fee && fresh))) {
                aValidChargeWasRefused = true;
            }
        }
    }

    // -------------------------------------------------------------------------
    // Distribution
    // -------------------------------------------------------------------------

    function distribute() external {
        uint256 collected = fees.collected();
        SigvaraEpochFees.Stage st = fees.stage();
        address pool = fees.rewardPool();
        uint256 poolBefore = svr.balanceOf(pool);
        uint256 burnBefore = svr.balanceOf(BURN);
        try fees.distributeFees() {
            uint256 burned = collected * _burnBps(st) / 10_000;
            if (
                collected == 0 || fees.collected() != 0 || svr.balanceOf(pool) - poolBefore != collected - burned
                    || svr.balanceOf(BURN) - burnBefore != burned
            ) distributionMissedItsSplit = true;
            totalDistributed += collected;
            okDistribute++;
        } catch {
            if (collected > 0) aValidDistributionWasRefused = true;
        }
    }

    // -------------------------------------------------------------------------
    // Admin and time
    // -------------------------------------------------------------------------

    function setFee(uint256 seed) external {
        // A quarter of the time off, which is the gating-disabled mode every deployment starts in.
        uint256 fee = seed % 4 == 0 ? 0 : bound(seed / 4, 1e18, 25e18);
        vm.prank(admin);
        fees.setEpochFee(fee);
    }

    function setStage(uint256 seed) external {
        vm.prank(admin);
        fees.setStage(SigvaraEpochFees.Stage(bound(seed, 0, 2)));
    }

    function setRewardPool(uint256 seed) external {
        vm.prank(admin);
        fees.setRewardPool(pools[seed % pools.length]);
    }

    function setEpochLength(uint256 seed) external {
        uint256 value = bound(seed, 0, 3 days);
        vm.prank(admin);
        try fees.setEpochLength(value) {
            if (value < EPOCH_LENGTH_FLOOR) epochLengthBelowFloorAccepted = true;
        } catch {}
    }

    function setOperatorBond(bool on) external {
        vm.prank(admin);
        fees.setOperatorBond(on ? address(operatorSet) : address(0));
    }

    function setOperatorActive(uint256 seed, bool active) external {
        operatorSet.set(callers[seed % callers.length], active);
    }

    /// Time has to move or no epoch ever turns over. Steps are short next to the epoch length on purpose,
    /// so that two charges inside one epoch are as common as two in different ones.
    function warp(uint256 secondsForward) external {
        vm.warp(block.timestamp + bound(secondsForward, 1 minutes, 2 days));
    }
}

/**
 * Invariant coverage for the contract that holds prepaid fees.
 *
 * The unit suite checks single transitions. These assert what must hold after any reachable sequence
 * of them, which is where accounting bugs surface: a balance that bleeds into another agent's, a fee
 * taken twice, a split that does not add up, tokens held that nobody is owed.
 */
/// forge-config: default.invariant.runs = 128
/// forge-config: default.invariant.depth = 300
contract EpochFeesInvariantTest is Test, RegistrationHelper {
    SigvaraEpochFees fees;
    SigvaraIdentity identity;
    EpochFeesInvToken svr;
    EpochFeesInvOperatorSet operatorSet;
    EpochFeesHandler handler;

    address admin = makeAddr("admin");
    address oracle = makeAddr("oracle");
    address oracle2 = makeAddr("oracle2");
    address stranger = makeAddr("stranger");

    address constant BURN = address(0xdead);
    uint256 constant EPOCH_FEE = 10e18;
    uint256 constant EPOCH_LENGTH = 1 days;

    function setUp() public {
        svr = new EpochFeesInvToken();
        operatorSet = new EpochFeesInvOperatorSet();

        identity = SigvaraIdentity(address(new ERC1967Proxy(
            address(new SigvaraIdentity()),
            abi.encodeCall(SigvaraIdentity.initialize, (admin, address(0)))
        )));

        address[] memory ops = new address[](3);
        bytes32[] memory dids = new bytes32[](3);
        for (uint256 i = 0; i < 3; i++) {
            ops[i] = makeAddr(string.concat("operator", vm.toString(i)));
            (, uint256 agentPk) = makeAddrAndKey(string.concat("agent", vm.toString(i)));
            dids[i] = registerSigned(identity, ops[i], agentPk, bytes32(uint256(i + 1)));
        }

        fees = SigvaraEpochFees(address(new ERC1967Proxy(
            address(new SigvaraEpochFees()),
            abi.encodeCall(
                SigvaraEpochFees.initialize,
                (admin, oracle, address(svr), address(identity), makeAddr("pool0"), EPOCH_FEE)
            )
        )));
        vm.startPrank(admin);
        fees.initializeV2(EPOCH_LENGTH, address(0));
        fees.grantRole(fees.ORACLE_ROLE(), oracle2);
        vm.stopPrank();

        address[] memory callers = new address[](3);
        callers[0] = oracle;
        callers[1] = oracle2;
        callers[2] = stranger;
        operatorSet.set(oracle, true);

        handler = new EpochFeesHandler(fees, identity, svr, operatorSet, admin, ops, dids, callers);
        targetContract(address(handler));
    }

    /// The plumbing works: the handler can fund an agent, charge it, move to the next epoch, charge again,
    /// sweep the fees and let the operator take the rest out. This is here because an invariant campaign
    /// whose handler never gets a call through passes every invariant and says nothing.
    function test_theHandlerActuallyReachesEveryAction() public {
        handler.deposit(0, 0, 1_000e18);
        assertEq(handler.okDeposit(), 1, "deposit");

        handler.charge(0, 0);
        assertEq(handler.okChargeWithFee(), 1, "charge");

        handler.charge(0, 0); // the same epoch: refused, and not counted
        assertEq(handler.okChargeWithFee(), 1, "a second charge in the epoch");

        handler.warp(1 days);
        handler.charge(0, 0);
        assertEq(handler.okChargeWithFee(), 2, "charge in the next epoch");

        handler.setStage(1);
        handler.distribute();
        assertEq(handler.okDistribute(), 1, "distribute");

        handler.withdraw(1, 0, 100e18);
        assertEq(handler.okWithdraw(), 1, "withdraw");

        assertFalse(handler.fundedAnUnregisteredAgent());
        assertEq(svr.balanceOf(address(fees)), fees.balance(handler.dids(0)) + fees.collected());
    }

    /// The contract's books add up, and match the history the handler kept.
    ///
    /// Solvency: it holds exactly the prepaid balances, the fees awaiting distribution and anything sent to
    /// it directly. A shortfall means a balance is promised that cannot be paid; a surplus means tokens are
    /// held that nobody is owed. Each agent's balance is what was paid in for it, less what its operator took
    /// out and what the oracle charged it, and nothing else, so a bug that moves value between agents, or
    /// takes a fee from the wrong one, leaves custody intact and fails there. Every fee charged is collected
    /// once, and every fee collected is swept once to the pools and the burn address, in full.
    function invariant_theBooksAddUp() public view {
        uint256 owed = fees.collected() + handler.totalDonated() + fees.balance(handler.UNREGISTERED());
        for (uint256 i = 0; i < handler.agentCount(); i++) {
            bytes32 did = handler.dids(i);
            owed += fees.balance(did);
            assertEq(fees.balance(did), handler.expectedBalance(did), "an agent's balance differs from its history");
        }
        assertEq(svr.balanceOf(address(fees)), owed, "custody differs from balances plus collected plus donations");
        assertEq(fees.balance(handler.UNREGISTERED()), 0, "an unregistered hash holds a balance");

        assertEq(
            fees.collected(),
            handler.totalCharged() - handler.totalDistributed(),
            "collected differs from charged minus distributed"
        );
        uint256 landed = svr.balanceOf(BURN);
        for (uint256 i = 0; i < handler.poolCount(); i++) landed += svr.balanceOf(handler.pools(i));
        assertEq(landed, handler.totalDistributed(), "what was distributed is not what the pools and the burn address hold");
    }

    /// Rules that are decided at the moment of a call, each checked by the handler as it happened.
    function invariant_noCallBrokeARule() public view {
        assertFalse(handler.fundedAnUnregisteredAgent(), "a hash with no agent was funded");
        assertFalse(handler.aStrangerWithdrew(), "someone other than the operator withdrew");
        assertFalse(handler.anUnauthorizedCallerCharged(), "a caller without the role, or not bonded, charged an epoch");
        assertFalse(handler.chargedTwiceInOneEpoch(), "an agent was charged twice in one epoch");
        assertFalse(handler.aChargeWasNotExactlyTheFee(), "a charge was not exactly the fee from a funded balance");
        assertFalse(handler.distributionMissedItsSplit(), "a distribution did not split by its stage");
        assertFalse(handler.epochLengthBelowFloorAccepted(), "an epoch length below the floor was accepted");
        assertFalse(handler.aValidDepositWasRefused(), "a deposit for a registered agent was refused");
        assertFalse(handler.aValidWithdrawWasRefused(), "an operator was refused its own balance");
        assertFalse(handler.aValidChargeWasRefused(), "a charge that was allowed and covered was refused");
        assertFalse(handler.aValidDistributionWasRefused(), "collected fees could not be distributed");

        // The epoch length never falls below its floor once set, and no charge claims a time that has not come.
        assertGe(fees.epochLength(), handler.EPOCH_LENGTH_FLOOR(), "the epoch length is below its floor");
        for (uint256 i = 0; i < handler.agentCount(); i++) {
            assertLe(fees.lastChargedAt(handler.dids(i)), block.timestamp, "a charge is dated in the future");
        }
    }
}
