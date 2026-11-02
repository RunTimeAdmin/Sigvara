// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import "../src/SigvaraStaking.sol";
// Named, because the script declares its own file-level ISafe and IAccessControl, which would clash with these.
import {SplitAuthority} from "../script/SplitAuthority.s.sol";

/// What phase 5 asks before it believes a Safe, callable from a test.
contract SplitAuthority_SafeProbe is SplitAuthority {
    function version(address safe) external view returns (string memory proxy, string memory implementation) {
        return _safeVersion(safe);
    }
    function requireKnown(address safe, address deployer, address factory, bytes memory creation) external view {
        _requireKnownSafe(safe, deployer, factory, creation);
    }
}

/// Something a Safe's setup could delegate to, which then runs as the Safe.
contract SetupHelper {
    function noop() external {}
}

/// Not Safe's code, with a setup that leaves storage the way Safe 1.4.1's would, owners, threshold and module list
/// included, plus one module that is not in the list, and then points the proxy at Safe's own SafeL2. From then on
/// the proxy runs Safe's code against that storage, and every getter answers as if nothing had happened.
contract RiggedSingleton {
    address internal constant SENTINEL = address(0x1);
    address internal constant SAFE_L2 = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address internal constant HIDDEN_MODULE = address(0xBAD);

    // Safe 1.4.1's first five slots: singleton, modules, owners, ownerCount, threshold.
    address internal singleton;
    mapping(address => address) internal modules;
    mapping(address => address) internal owners;
    uint256 internal ownerCount;
    uint256 internal threshold;

    function setup(
        address[] calldata newOwners,
        uint256 newThreshold,
        address,
        bytes calldata,
        address,
        address,
        uint256,
        address payable
    ) external {
        address previous = SENTINEL;
        for (uint256 i = 0; i < newOwners.length; i++) {
            owners[previous] = newOwners[i];
            previous = newOwners[i];
        }
        owners[previous] = SENTINEL;
        ownerCount = newOwners.length;
        threshold = newThreshold;
        modules[SENTINEL] = SENTINEL;
        modules[HIDDEN_MODULE] = SENTINEL;
        singleton = SAFE_L2;
    }
}

/**
 * Rehearsal for script/SplitAuthority.s.sol, against a fork of the live Arc testnet
 * deployment with its real roles and real bonds, and the slash drill's final state in it.
 *
 * The migration it rehearses ends with the deployer renouncing UPGRADER_ROLE, which
 * cannot be undone. If the replacement authority does not work, the proxies are frozen
 * for good. So the questions worth answering before broadcasting are not "does
 * the script run" but:
 *
 *   - can the deployer still do the two things it should no longer be able to do
 *   - can the Safe still administer, using a Safe deployed through Arc's own factory
 *     and driven by a real owner signature, rather than a stand-in with a call method
 *   - does the timelock actually impose the delay, and does anyone-can-execute work
 *   - did any of this disturb the oracle, committee or cross-contract roles
 *   - does a slash that is in flight when the migration runs still settle
 *
 * That last one is the reason this is a fork test rather than a unit test. A slash in
 * its challenge window reaches across three contracts, and a migration that stranded it
 * would not show up anywhere else. The test was written for the drill filed on 20 September
 * 2026, which settled on 3 October without the migration having run. It is tied to that one
 * proposal (DRILL_DID and DRILL_DEADLINE), now Executed, so on today's chain it finds no
 * Pending proposal and returns early. To exercise the case again, point those two constants
 * at a slash that is in flight.
 *
 *   forge test --match-path test/SplitAuthorityFork.t.sol \
 *     --fork-url https://rpc.testnet.arc.io -vv
 */
contract SplitAuthorityForkTest is Test {
    uint256 constant ARC_TESTNET = 5042002;

    address constant IDENTITY = 0x7e3aFC532eE5d922ab3cc3FFb510c7C8151477Dd;
    address constant REPUTATION = 0x6603C96275e85F724Cdf74666b399365e4cA29ed;
    address constant STAKING = 0xA69d62B2a6774D21A2c15d5d83b27277eD31d35B;
    address constant ORACLE_BOND = 0x3c9c12F27DDCa7048840eE3fbF0CAa1C547D8171;
    address constant SVR = 0x41De2D6D55318e197a00E8f5B496eA2790e23E6c;

    address constant DEPLOYER = 0x18CBcE50390f5f6ebe4E20Fc17833F25c8D94811;
    address constant ORACLE_KEY = 0x989aabd69631f81A6B2c8Ce508C32aa219EC172D;
    address constant COMMITTEE_KEY = 0x045D6C1d8404297F13596061388f6598fA94a5b7;

    /// Canonical Safe 1.4.1, confirmed deployed at these addresses on Arc testnet.
    address constant SAFE_SINGLETON = 0x41675C099F32341bf84BFc5382aF534df5C7461a;
    address constant SAFE_FACTORY = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;
    /// The other Safes Arc testnet has, at Safe's canonical addresses: the L2 implementations and the 1.3.0 and
    /// 1.5.0 factories, so each proxy code hash and implementation the script lists is made here by Safe's own.
    address constant SAFE_L2_SINGLETON = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address constant SAFE_FACTORY_1_3_0 = 0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2;
    address constant SAFE_L2_SINGLETON_1_3_0 = 0x3E5c63644E683549055b9Be8653de26E0B4CD36E;
    address constant SAFE_FACTORY_1_5_0 = 0x14F2982D601c9458F93bd70B218933A6f8165e7b;
    address constant SAFE_SINGLETON_1_5_0 = 0xFf51A5898e281Db6DfC7855790607438dF2ca44b;
    address constant SAFE_SINGLETON_1_3_0 = 0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552;
    address constant SAFE_L2_SINGLETON_1_5_0 = 0xEdd160fEBBD92E350D4D398fb636302fccd67C7e;
    /// What app.safe.global has a Safe made for an L2 delegate to in its setup, to switch to the L2 implementation.
    address constant SAFE_TO_L2_SETUP = 0xBD89A1CE4DDe368FFAB0eC35506eEcE0b1fFdc54;

    bytes32 constant ADMIN_ROLE = 0x00;
    bytes32 constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 constant COMMITTEE_ROLE = keccak256("SLASHING_COMMITTEE_ROLE");
    bytes32 constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    bytes32 constant SLASHER_ROLE = keccak256("SLASHER_ROLE");
    bytes32 constant STAKING_CORE_ROLE = keccak256("STAKING_CORE_ROLE");

    bytes32 constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    /// The slash filed on 20 September 2026 and executed on 3 October 2026.
    bytes32 constant DRILL_DID = 0x59d75ab4a3af114de90c4f6640f4dc47cee83d0895f3f8c4eb9b012dc5f6e153;
    uint256 constant DRILL_DEADLINE = 1790537284; // 2026-09-27T19:28:04Z

    uint256 constant MIN_DELAY = 48 hours;

    address[4] internal targets = [IDENTITY, REPUTATION, STAKING, ORACLE_BOND];
    string[4] internal names = ["identity", "reputation", "staking", "oracleBond"];

    uint256 internal ownerPk = 0xA11CE;
    address internal safeOwner;
    address internal safe;
    TimelockController internal timelock;

    modifier onlyArcFork() {
        if (block.chainid != ARC_TESTNET) {
            emit log("SKIP: needs --fork-url https://rpc.testnet.arc.io");
            vm.skip(true);
        }
        _;
    }

    function setUp() public {
        if (block.chainid != ARC_TESTNET) return;

        safeOwner = vm.addr(ownerPk);
        safe = _deployRealSafe(safeOwner);

        address[] memory proposers = new address[](1);
        proposers[0] = safe;
        address[] memory executors = new address[](1);
        executors[0] = address(0); // open execution, as the script deploys it
        timelock = new TimelockController(MIN_DELAY, proposers, executors, address(0));
    }

    // -------------------------------------------------------------------------
    // What the deployment looks like today
    // -------------------------------------------------------------------------

    /**
     * Baseline. Not a test of the migration: a record of what the migration is for,
     * run against the live chain so it cannot quietly stop being true.
     */
    function test_today_theDeployerCanUpgradeAndSelfDeal() public onlyArcFork {
        address fresh = address(new SigvaraStaking());

        vm.prank(DEPLOYER);
        IUUPS(STAKING).upgradeToAndCall(fresh, "");
        assertEq(_implOf(STAKING), fresh, "deployer could not upgrade");

        // The specific path that makes the slash drill weaker than it looks: admin can
        // put itself on the committee, and the committee can cancel a slash.
        assertFalse(IAccessControl(STAKING).hasRole(COMMITTEE_ROLE, DEPLOYER), "already on committee");
        vm.prank(DEPLOYER);
        IAccessControl(STAKING).grantRole(COMMITTEE_ROLE, DEPLOYER);
        assertTrue(IAccessControl(STAKING).hasRole(COMMITTEE_ROLE, DEPLOYER), "deployer could not self-deal");

        emit log("today: one key can upgrade any contract and appoint itself to the committee");
    }

    // -------------------------------------------------------------------------
    // After the migration
    // -------------------------------------------------------------------------

    function test_afterSplit_theDeployerCanDoNeither() public onlyArcFork {
        _migrate();

        address fresh = address(new SigvaraStaking());
        for (uint256 i = 0; i < targets.length; i++) {
            vm.prank(DEPLOYER);
            vm.expectRevert(
                abi.encodeWithSelector(
                    IAccessControl.AccessControlUnauthorizedAccount.selector, DEPLOYER, UPGRADER_ROLE
                )
            );
            IUUPS(targets[i]).upgradeToAndCall(fresh, "");

            vm.prank(DEPLOYER);
            vm.expectRevert(
                abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, DEPLOYER, ADMIN_ROLE)
            );
            IAccessControl(targets[i]).grantRole(COMMITTEE_ROLE, DEPLOYER);

            assertFalse(IAccessControl(targets[i]).hasRole(ADMIN_ROLE, DEPLOYER), names[i]);
            assertFalse(IAccessControl(targets[i]).hasRole(UPGRADER_ROLE, DEPLOYER), names[i]);
        }
    }

    /**
     * The Safe here is a real Safe: deployed through Arc's own SafeProxyFactory onto
     * the canonical 1.4.1 singleton, and driven by a real owner signature through
     * execTransaction. A stub with a `call` passthrough would pass this test while
     * telling us nothing about whether Safe works on this chain, which is the one
     * question that has to be settled before the renounce.
     */
    function test_afterSplit_theSafeCanStillAdminister() public onlyArcFork {
        _migrate();

        address probe = address(0xBEEF);
        for (uint256 i = 0; i < targets.length; i++) {
            _execFromSafe(targets[i], abi.encodeCall(IAccessControl.grantRole, (COMMITTEE_ROLE, probe)));
            assertTrue(IAccessControl(targets[i]).hasRole(COMMITTEE_ROLE, probe), names[i]);

            _execFromSafe(targets[i], abi.encodeCall(IAccessControl.revokeRole, (COMMITTEE_ROLE, probe)));
            assertFalse(IAccessControl(targets[i]).hasRole(COMMITTEE_ROLE, probe), names[i]);
        }
    }

    /**
     * The live proxies were deployed before UPGRADER_ROLE administered itself, so on them the
     * Safe, which holds DEFAULT_ADMIN_ROLE, can still give itself upgrade rights and skip the
     * timelock. This pins that as the state of the deployed testnet contracts. It is the case
     * the registries initialize to avoid, and test/SplitAuthority.t.sol shows the Safe refused.
     */
    function test_afterSplit_onTheLegacyProxiesTheSafeCanStillSkipTheTimelock() public onlyArcFork {
        _migrate();
        for (uint256 i = 0; i < targets.length; i++) {
            assertEq(IAccessControl(targets[i]).getRoleAdmin(UPGRADER_ROLE), ADMIN_ROLE, names[i]);
            _execFromSafe(targets[i], abi.encodeCall(IAccessControl.grantRole, (UPGRADER_ROLE, safe)));
            assertTrue(IAccessControl(targets[i]).hasRole(UPGRADER_ROLE, safe), names[i]);
        }
    }

    function test_afterSplit_upgradingRequiresTheDelay() public onlyArcFork {
        _migrate();

        address fresh = address(new SigvaraStaking());
        address before_ = _implOf(STAKING);
        bytes memory upgradeCall = abi.encodeCall(IUUPS.upgradeToAndCall, (fresh, ""));
        bytes32 salt = keccak256("rehearsal");

        // A shorter delay than the timelock allows is refused at scheduling time, so a
        // proposer cannot simply ask for zero notice.
        _execFromSafeExpectingRevert(
            address(timelock),
            abi.encodeCall(TimelockController.schedule, (STAKING, 0, upgradeCall, bytes32(0), salt, 1 hours))
        );

        _execFromSafe(
            address(timelock),
            abi.encodeCall(TimelockController.schedule, (STAKING, 0, upgradeCall, bytes32(0), salt, MIN_DELAY))
        );
        assertEq(_implOf(STAKING), before_, "scheduling alone changed the implementation");

        // One second short of the delay is still too early.
        vm.warp(block.timestamp + MIN_DELAY - 1);
        vm.expectRevert();
        timelock.execute(STAKING, 0, upgradeCall, bytes32(0), salt);
        assertEq(_implOf(STAKING), before_, "upgraded before the delay ran");

        // Executors are open, so this lands from an address holding nothing at all.
        vm.warp(block.timestamp + 2);
        vm.prank(address(0xD00D));
        timelock.execute(STAKING, 0, upgradeCall, bytes32(0), salt);
        assertEq(_implOf(STAKING), fresh, "upgrade did not land after the delay");
    }

    /// The migration touches two roles. Everything the running system depends on is
    /// one of the others, so the check that matters is that none of them moved.
    function test_afterSplit_everyOtherRoleIsUntouched() public onlyArcFork {
        _migrate();

        assertTrue(IAccessControl(REPUTATION).hasRole(ORACLE_ROLE, ORACLE_KEY), "oracle lost ORACLE_ROLE");
        assertTrue(IAccessControl(REPUTATION).hasRole(COMMITTEE_ROLE, COMMITTEE_KEY), "committee lost reputation");
        assertTrue(IAccessControl(STAKING).hasRole(COMMITTEE_ROLE, COMMITTEE_KEY), "committee lost staking");
        assertTrue(IAccessControl(ORACLE_BOND).hasRole(SLASHER_ROLE, COMMITTEE_KEY), "committee lost slasher");

        // Settlement reaches from staking into the other two registries. If this wiring
        // were disturbed, executeSlash would revert halfway through.
        assertTrue(IAccessControl(IDENTITY).hasRole(STAKING_CORE_ROLE, STAKING), "identity lost staking core");
        assertTrue(IAccessControl(REPUTATION).hasRole(STAKING_CORE_ROLE, STAKING), "reputation lost staking core");

        // And the deployer picked up none of them on the way out.
        assertFalse(IAccessControl(REPUTATION).hasRole(ORACLE_ROLE, DEPLOYER), "deployer holds ORACLE_ROLE");
        assertFalse(IAccessControl(STAKING).hasRole(COMMITTEE_ROLE, DEPLOYER), "deployer holds COMMITTEE");
    }

    /**
     * Written while the slash drill was mid-window on the live chain. Settlement moves the
     * agent to Slashed in the identity registry and zeroes its reputation, both through
     * roles the migration does not touch, but that is an argument rather than evidence.
     * While the proposal is Pending this warps past the real deadline and settles it. The
     * drill was executed on 3 October 2026, so on today's chain the test skips itself.
     */
    function test_afterSplit_theSlashDrillStillSettles() public onlyArcFork {
        _migrate();

        (,, address victim,, uint8 state,,,) = IStakingView(STAKING).slashProposals(DRILL_DID);
        if (state != 1) {
            emit log("SKIP: the drill proposal is no longer Pending on chain");
            return;
        }

        uint256 staked = IStakingView(STAKING).getStake(DRILL_DID);
        assertGt(staked, 0, "nothing staked to slash");
        uint256 victimBefore = IStakingView(STAKING).claimable(victim);
        uint256 reporterBefore = IStakingView(STAKING).claimable(COMMITTEE_KEY);
        uint256 burnedBefore = IERC20(SVR).balanceOf(address(0xdead));

        vm.warp(DRILL_DEADLINE + 1);
        vm.prank(address(0xD00D)); // executeSlash is permissionless, by design
        IStakingView(STAKING).executeSlash(DRILL_DID);

        (,,,, uint8 stateAfter,,,) = IStakingView(STAKING).slashProposals(DRILL_DID);
        assertEq(stateAfter, 2, "proposal did not reach Executed");
        assertEq(IStakingView(STAKING).getStake(DRILL_DID), 0, "stake not swept");

        // 50 burn / 25 victim / 25 reporter, on the real 1,000 SVR bond.
        assertEq(IERC20(SVR).balanceOf(address(0xdead)) - burnedBefore, staked / 2, "burn");
        assertEq(IStakingView(STAKING).claimable(victim) - victimBefore, staked / 4, "victim share");
        assertEq(
            IStakingView(STAKING).claimable(COMMITTEE_KEY) - reporterBefore,
            staked - (staked / 2) - (staked / 4),
            "reporter share"
        );
    }

    // -------------------------------------------------------------------------
    // What phase 5 takes for a Safe
    // -------------------------------------------------------------------------

    /**
     * Phase 5 believes a Safe's owners and threshold only from a proxy and an implementation whose code hashes
     * the script lists, created by a factory it knows from the call that created it. These are Safes made by
     * Safe's own factories on Arc, every version with both kinds of implementation, so a wrong hash in the script,
     * or a wrong reading of how a factory picks the address, fails here.
     */
    function test_theScriptKnowsASafeFromEachOfArcsFactories() public onlyArcFork {
        SplitAuthority_SafeProbe probe = new SplitAuthority_SafeProbe();
        address[6] memory factories =
            [SAFE_FACTORY, SAFE_FACTORY, SAFE_FACTORY_1_3_0, SAFE_FACTORY_1_3_0, SAFE_FACTORY_1_5_0, SAFE_FACTORY_1_5_0];
        address[6] memory singletons = [
            SAFE_SINGLETON, SAFE_L2_SINGLETON, SAFE_SINGLETON_1_3_0, SAFE_L2_SINGLETON_1_3_0,
            SAFE_SINGLETON_1_5_0, SAFE_L2_SINGLETON_1_5_0
        ];
        string[6] memory proxies = ["1.4.1", "1.4.1", "1.3.0", "1.3.0", "1.5.0", "1.5.0"];
        string[6] memory implementations =
            ["Safe 1.4.1", "SafeL2 1.4.1", "Safe 1.3.0", "SafeL2 1.3.0", "Safe 1.5.0", "SafeL2 1.5.0"];
        for (uint256 i = 0; i < factories.length; i++) {
            (address made, bytes memory creation) = _makeSafe(factories[i], singletons[i], _plainSetup(), i + 1);
            (string memory proxy, string memory implementation) = probe.version(made);
            assertEq(proxy, proxies[i], implementations[i]);
            assertEq(implementation, implementations[i], implementations[i]);
            probe.requireKnown(made, DEPLOYER, factories[i], creation);
        }

        // The way app.safe.global makes a Safe on an L2: the 1.4.1 implementation, with a setup that delegates to
        // Safe's SafeToL2Setup, which switches the proxy to SafeL2. That delegatecall is the one the script allows.
        bytes memory toL2 = _setup(SAFE_TO_L2_SETUP, abi.encodeWithSignature("setupToL2(address)", SAFE_L2_SINGLETON));
        (address viaL2Setup, bytes memory itsCreation) = _makeSafe(SAFE_FACTORY, SAFE_SINGLETON, toL2, 7);
        (, string memory became) = probe.version(viaL2Setup);
        assertEq(became, "SafeL2 1.4.1", "SafeToL2Setup did not switch the implementation");
        probe.requireKnown(viaL2Setup, DEPLOYER, SAFE_FACTORY, itsCreation);
    }

    /**
     * Safe's code decides who may act from storage, and its getters list only what is linked into their lists, so
     * the storage has to be what the factory and a plain setup made. Refused: a creation call that does not give
     * this address, a factory that is not Safe's, no creation shown at all, the same code and storage copied to
     * another address, and a setup that delegated to a contract of anyone's choosing.
     */
    function test_theScriptRefusesASafeWhoseCreationItCannotShow() public onlyArcFork {
        SplitAuthority_SafeProbe probe = new SplitAuthority_SafeProbe();
        bytes memory creation = _creation(SAFE_SINGLETON, _plainSetup(), 0);
        probe.requireKnown(safe, DEPLOYER, SAFE_FACTORY, creation);

        bytes memory otherSalt = _creation(SAFE_SINGLETON, _plainSetup(), 1);
        address otherAddress = vm.computeCreate2Address(
            keccak256(abi.encodePacked(keccak256(_plainSetup()), uint256(1))),
            keccak256(abi.encodePacked(ISafeProxyFactory(SAFE_FACTORY).proxyCreationCode(), uint256(uint160(SAFE_SINGLETON)))),
            SAFE_FACTORY
        );
        vm.expectRevert(abi.encodeWithSelector(SplitAuthority.SafeNotCreatedAsShown.selector, safe, otherAddress));
        probe.requireKnown(safe, DEPLOYER, SAFE_FACTORY, otherSalt);

        vm.expectRevert(
            abi.encodeWithSelector(SplitAuthority.SafeFactoryNotRecognized.selector, IDENTITY, IDENTITY.codehash)
        );
        probe.requireKnown(safe, DEPLOYER, IDENTITY, creation);

        vm.expectRevert(abi.encodeWithSelector(SplitAuthority.SafeCreationNotShown.selector, safe));
        probe.requireKnown(safe, DEPLOYER, address(0), "");

        // Safe's proxy code with the same storage, at an address no factory made: what a constructor that writes
        // storage and then leaves the proxy's code behind would give.
        address copy = address(0xC0FFEE);
        vm.etch(copy, safe.code);
        for (uint256 slot = 0; slot < 8; slot++) {
            vm.store(copy, bytes32(slot), vm.load(safe, bytes32(slot)));
        }
        (, string memory copied) = probe.version(copy);
        assertEq(copied, "Safe 1.4.1", "the copy runs Safe's code");
        vm.expectRevert(abi.encodeWithSelector(SplitAuthority.SafeNotCreatedAsShown.selector, copy, safe));
        probe.requireKnown(copy, DEPLOYER, SAFE_FACTORY, creation);

        // A setup that delegated: whatever it ran, it ran as the Safe, with the run of its storage.
        address helper = address(new SetupHelper());
        bytes memory delegating = _setup(helper, abi.encodeCall(SetupHelper.noop, ()));
        (address made, bytes memory itsCreation) = _makeSafe(SAFE_FACTORY, SAFE_SINGLETON, delegating, 9);
        vm.expectRevert(abi.encodeWithSelector(SplitAuthority.SafeSetupDelegatedTo.selector, made, helper));
        probe.requireKnown(made, DEPLOYER, SAFE_FACTORY, itsCreation);

        // Safe's own SafeToL2Setup, told to point the proxy at something that is not Safe's: that code would run as
        // the Safe on the next call, and could put Safe's code back when it was done.
        bytes memory toElsewhere = _setup(SAFE_TO_L2_SETUP, abi.encodeWithSignature("setupToL2(address)", helper));
        bytes memory pointedCreation = _creation(SAFE_SINGLETON, toElsewhere, 10);
        address pointed = ISafeProxyFactory(SAFE_FACTORY).createProxyWithNonce(SAFE_SINGLETON, toElsewhere, 10);
        assertEq(address(uint160(uint256(vm.load(pointed, bytes32(0))))), helper, "the proxy now runs the helper");
        vm.store(pointed, bytes32(0), bytes32(uint256(uint160(SAFE_L2_SINGLETON)))); // what it would put back
        vm.expectRevert(abi.encodeWithSelector(SplitAuthority.SafeSetupRanOtherCode.selector, pointed, helper));
        probe.requireKnown(pointed, DEPLOYER, SAFE_FACTORY, pointedCreation);
    }

    /**
     * Safe's code counts only at Safe's own addresses. A hash says what code is at an address now, and a contract
     * that can be destroyed and redeployed may have run other code when the Safe was made, so a copy of Safe's
     * implementation or factory elsewhere is refused, as the code a creation ran and as the proxy's implementation.
     */
    function test_theScriptKnowsSafesCodeOnlyAtSafesAddresses() public onlyArcFork {
        SplitAuthority_SafeProbe probe = new SplitAuthority_SafeProbe();
        bytes memory creation = _creation(SAFE_SINGLETON, _plainSetup(), 0);
        address elsewhere = address(0x5AFE);
        vm.etch(elsewhere, SAFE_SINGLETON.code);
        assertEq(elsewhere.codehash, SAFE_SINGLETON.codehash, "the same code");
        (address fromCopy, bytes memory fromCopyCreation) = _makeSafe(SAFE_FACTORY, elsewhere, _plainSetup(), 12);
        // As the proxy's implementation it is not taken for Safe's code.
        (, string memory elsewhereName) = probe.version(fromCopy);
        assertEq(elsewhereName, "", "Safe's code at another address");
        // Nor as the code that ran the setup, once the proxy points at Safe's own, as a redeployed copy could leave it.
        vm.store(fromCopy, bytes32(0), bytes32(uint256(uint160(SAFE_SINGLETON))));
        vm.expectRevert(abi.encodeWithSelector(SplitAuthority.SafeSetupRanOtherCode.selector, fromCopy, elsewhere));
        probe.requireKnown(fromCopy, DEPLOYER, SAFE_FACTORY, fromCopyCreation);

        // The same for the factory: a copy of Safe's at another address could have called the proxy with anything.
        address factoryCopy = address(0xFAC7);
        vm.etch(factoryCopy, SAFE_FACTORY.code);
        vm.expectRevert(
            abi.encodeWithSelector(SplitAuthority.SafeFactoryNotRecognized.selector, factoryCopy, factoryCopy.codehash)
        );
        probe.requireKnown(safe, DEPLOYER, factoryCopy, creation);
    }

    /**
     * Safe's own factory, Safe's own code in the proxy afterwards, a plain setup, an empty module list and no guard,
     * and still a module that acts: the setup ran as code that is not Safe's, which wrote one around the list and
     * then pointed the proxy at Safe's SafeL2. Only the code the creation call names gives it away.
     */
    function test_theScriptRefusesASafeWhoseSetupRanOtherCode() public onlyArcFork {
        SplitAuthority_SafeProbe probe = new SplitAuthority_SafeProbe();
        address rigged = address(new RiggedSingleton());
        (address made, bytes memory creation) = _makeSafe(SAFE_FACTORY, rigged, _plainSetup(), 11);

        (string memory proxy, string memory implementation) = probe.version(made);
        assertEq(proxy, "1.4.1", "Safe's own proxy");
        assertEq(implementation, "SafeL2 1.4.1", "Safe's own code from now on");
        (address[] memory listed,) = IModuleList(made).getModulesPaginated(address(0x1), 10);
        assertEq(listed.length, 0, "no module in the list");
        assertTrue(IModuleList(made).isModuleEnabled(address(0xBAD)), "and yet one acts");

        vm.expectRevert(abi.encodeWithSelector(SplitAuthority.SafeSetupRanOtherCode.selector, made, rigged));
        probe.requireKnown(made, DEPLOYER, SAFE_FACTORY, creation);
    }

    /**
     * A module runs any call as the Safe without the owners, so a real Safe that has enabled one is refused, and
     * the refusal names the module. Enabled the only way a Safe allows, by its owners through execTransaction.
     */
    function test_theScriptRefusesARealSafeWithAModule() public onlyArcFork {
        SplitAuthority_SafeProbe probe = new SplitAuthority_SafeProbe();
        bytes memory creation = _creation(SAFE_SINGLETON, _plainSetup(), 0);
        probe.requireKnown(safe, DEPLOYER, SAFE_FACTORY, creation);

        address module = address(0x0D01E);
        _execFromSafe(safe, abi.encodeWithSignature("enableModule(address)", module));
        vm.expectRevert(abi.encodeWithSelector(SplitAuthority.SafeHasModules.selector, safe, module));
        probe.requireKnown(safe, DEPLOYER, SAFE_FACTORY, creation);
    }

    // -------------------------------------------------------------------------
    // The migration itself, in the order the script performs it
    // -------------------------------------------------------------------------

    function _migrate() internal {
        // Phase 3: the deployer grants admin to the Safe and upgrader to the timelock.
        for (uint256 i = 0; i < targets.length; i++) {
            vm.startPrank(DEPLOYER);
            IAccessControl(targets[i]).grantRole(ADMIN_ROLE, safe);
            IAccessControl(targets[i]).grantRole(UPGRADER_ROLE, address(timelock));
            vm.stopPrank();
        }

        // Phase 4, from the Safe exactly as the script prints it: remove the deployer's
        // admin. Running these as the deployer would reach the same state and prove nothing.
        for (uint256 i = 0; i < targets.length; i++) {
            _execFromSafe(targets[i], abi.encodeCall(IAccessControl.revokeRole, (ADMIN_ROLE, DEPLOYER)));
        }

        // Phase 5: the deployer drops the one role it still holds.
        for (uint256 i = 0; i < targets.length; i++) {
            vm.prank(DEPLOYER);
            IAccessControl(targets[i]).renounceRole(UPGRADER_ROLE, DEPLOYER);
        }
    }

    // -------------------------------------------------------------------------
    // Safe plumbing
    // -------------------------------------------------------------------------

    function _deployRealSafe(address owner) internal returns (address proxy) {
        assertEq(owner, safeOwner, "every Safe here has the one owner");
        (proxy,) = _makeSafe(SAFE_FACTORY, SAFE_SINGLETON, _plainSetup(), 0);
    }

    /// @dev A Safe from `factory`, and the call that made it, which is what an operator copies from the creation
    ///      transaction for SAFE_CREATION_CALL.
    function _makeSafe(address factory, address singleton, bytes memory initializer, uint256 saltNonce)
        internal
        returns (address proxy, bytes memory creation)
    {
        creation = _creation(singleton, initializer, saltNonce);
        proxy = ISafeProxyFactory(factory).createProxyWithNonce(singleton, initializer, saltNonce);
        assertGt(proxy.code.length, 0, "Safe factory produced no code");
        assertEq(ISafe(proxy).getThreshold(), 1, "unexpected threshold");
    }

    function _creation(address singleton, bytes memory initializer, uint256 saltNonce)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeCall(ISafeProxyFactory.createProxyWithNonce, (singleton, initializer, saltNonce));
    }

    function _plainSetup() internal view returns (bytes memory) {
        return _setup(address(0), "");
    }

    function _setup(address to, bytes memory data) internal view returns (bytes memory) {
        address[] memory owners = new address[](1);
        owners[0] = safeOwner;
        return abi.encodeCall(ISafe.setup, (owners, 1, to, data, address(0), address(0), 0, payable(address(0))));
    }

    /// @dev With safeTxGas and gasPrice both zero, Safe reverts the whole transaction
    ///      when the inner call fails, so a silent failure is not possible here.
    function _execFromSafe(address to, bytes memory data) internal {
        bytes memory sig = _safeSignature(to, data);
        bool ok = ISafe(safe).execTransaction(
            to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), sig
        );
        assertTrue(ok, "safe execTransaction returned false");
    }

    /**
     * @dev Safe reports an inner revert as GS013 rather than bubbling the reason up.
     *
     *      The signature is built before `expectRevert` is armed on purpose. It takes
     *      two calls into the Safe to produce, and an `expectRevert` set any earlier
     *      binds to `nonce()` instead of to `execTransaction`, which passes whatever
     *      the inner call does.
     */
    function _execFromSafeExpectingRevert(address to, bytes memory data) internal {
        bytes memory sig = _safeSignature(to, data);
        vm.expectRevert(bytes("GS013"));
        ISafe(safe).execTransaction(to, 0, data, 0, 0, 0, 0, address(0), payable(address(0)), sig);
    }

    function _safeSignature(address to, bytes memory data) internal view returns (bytes memory) {
        uint256 n = ISafe(safe).nonce();
        bytes32 txHash = ISafe(safe).getTransactionHash(to, 0, data, 0, 0, 0, 0, address(0), address(0), n);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerPk, txHash);
        return abi.encodePacked(r, s, v);
    }

    function _implOf(address proxy) internal view returns (address) {
        return address(uint160(uint256(vm.load(proxy, IMPL_SLOT))));
    }
}

interface IModuleList {
    function getModulesPaginated(address start, uint256 pageSize) external view returns (address[] memory, address);
    function isModuleEnabled(address module) external view returns (bool);
}

interface IUUPS {
    function upgradeToAndCall(address newImplementation, bytes calldata data) external payable;
}

interface IStakingView {
    function slashProposals(bytes32)
        external
        view
        returns (
            bytes32 didHash,
            address reporter,
            address victim,
            uint256 initiatedAt,
            uint8 state,
            bytes memory evidenceHash,
            uint256 challengeDeadline,
            uint256 disputedAt
        );
    function getStake(bytes32) external view returns (uint256);
    function claimable(address) external view returns (uint256);
    function executeSlash(bytes32) external;
}

interface ISafeProxyFactory {
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
    function proxyCreationCode() external pure returns (bytes memory);
}

interface ISafe {
    function setup(
        address[] calldata owners,
        uint256 threshold,
        address to,
        bytes calldata data,
        address fallbackHandler,
        address paymentToken,
        uint256 payment,
        address payable paymentReceiver
    ) external;
    function getThreshold() external view returns (uint256);
    function nonce() external view returns (uint256);
    function getTransactionHash(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address refundReceiver,
        uint256 nonce
    ) external view returns (bytes32);
    function execTransaction(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation,
        uint256 safeTxGas,
        uint256 baseGas,
        uint256 gasPrice,
        address gasToken,
        address payable refundReceiver,
        bytes calldata signatures
    ) external payable returns (bool);
}
