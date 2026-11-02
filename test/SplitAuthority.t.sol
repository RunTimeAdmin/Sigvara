// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

// Named, because the script declares its own file-level IAccessControl, which would clash with the library one.
import {SplitAuthority} from "../script/SplitAuthority.s.sol";
import "../src/SigvaraIdentity.sol";
import "../src/SigvaraReputation.sol";
import "../src/SigvaraStaking.sol";
import "../src/SigvaraOracleBond.sol";
import "../src/SigvaraEpochFees.sol";
import "../src/SVRToken.sol";

/// Stands in for a Safe. It runs what it is told as itself, which is all the migration needs
/// from one, and answers the reads the script makes of a Safe. It is not Safe's code, so only
/// SplitAuthority_StandIn takes it for one. test/SplitAuthorityFork.t.sol is where a real Safe
/// is driven by a real signature.
contract MockSafe {
    address[] internal owners_;
    uint256 internal threshold_;
    address[] internal modules_;
    bool internal modulesHidden_;

    constructor(address[] memory owners, uint256 threshold) {
        owners_ = owners;
        threshold_ = threshold;
    }

    function getOwners() external view returns (address[] memory) { return owners_; }
    function getThreshold() external view returns (uint256) { return threshold_; }
    function getModulesPaginated(address, uint256) external view returns (address[] memory, address) {
        require(!modulesHidden_);
        return (modules_, address(0x1));
    }

    function enableModule(address module) external { modules_.push(module); }
    function hideModules() external { modulesHidden_ = true; }

    function exec(address to, bytes calldata data) external {
        (bool ok, bytes memory ret) = to.call(data);
        if (!ok) {
            assembly { revert(add(ret, 32), mload(ret)) }
        }
    }
}

/// A multisig that is not a Safe. It runs what it is told, but it has no getOwners or getThreshold: asking for
/// either reverts, or, when `silent`, succeeds and answers with nothing.
contract OtherMultisig {
    bool internal immutable silent;

    constructor(bool silent_) { silent = silent_; }

    fallback() external {
        if (!silent) revert();
    }

    function exec(address to, bytes calldata data) external {
        (bool ok, bytes memory ret) = to.call(data);
        if (!ok) {
            assembly { revert(add(ret, 32), mload(ret)) }
        }
    }
}

/// Answers every question phase 5 puts to a timelock the way the one phase 2 deploys would, and is not that
/// contract. What no getter shows is the way round the delay: anyone may run any call from here at once.
contract LookalikeTimelock {
    bytes32 public constant PROPOSER_ROLE = keccak256("PROPOSER_ROLE");
    bytes32 public constant CANCELLER_ROLE = keccak256("CANCELLER_ROLE");
    bytes32 public constant EXECUTOR_ROLE = keccak256("EXECUTOR_ROLE");

    function getMinDelay() external pure returns (uint256) { return 48 hours; }
    function hasRole(bytes32 role, address) external pure returns (bool) { return role != 0; }

    function execute(address to, bytes calldata data) external {
        (bool ok,) = to.call(data);
        require(ok);
    }
}

/// A registry set up the way the older code did it: UPGRADER_ROLE and every other role are administered by
/// DEFAULT_ADMIN_ROLE, so the Safe that holds admin can grant itself upgrade rights and the slasher role.
contract LegacyRegistry is AccessControl {
    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(keccak256("UPGRADER_ROLE"), admin);
    }
}

/// Half way: the upgrader role administers itself, and every other role is still the admin's to grant.
contract HalfwayRegistry is AccessControl {
    constructor(address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(keccak256("UPGRADER_ROLE"), admin);
        _setRoleAdmin(keccak256("UPGRADER_ROLE"), keccak256("UPGRADER_ROLE"));
    }
}

/// A contract from before UPGRADER_ROLE administered itself: getRoleAdmin answers zero.
contract LegacyRoles {
    function getRoleAdmin(bytes32) external pure returns (bytes32) { return bytes32(0); }
}

/// The script, told that a MockSafe stands for a Safe proxy running Safe's code. Nothing else changes, so every
/// other check still runs against the stand-in, its modules included. Which code counts as a Safe is checked
/// against Safes made by Arc's own factories in test/SplitAuthorityFork.t.sol.
contract SplitAuthority_StandIn is SplitAuthority {
    function _safeVersion(address safe) internal view override returns (string memory, string memory) {
        if (safe.codehash == keccak256(type(MockSafe).runtimeCode)) return ("stand-in", "MockSafe");
        return super._safeVersion(safe);
    }
}

contract SplitAuthority_Harness is SplitAuthority {
    function adminIsSelf(address target) external view returns (bool) { return _upgraderAdminIsSelf(target); }
    function timelockedRoles(string memory name) external pure returns (bytes32[] memory) {
        return _timelockedRoles(name);
    }
    function firstOpenRole(string memory name, address target) external view returns (bool, bytes32) {
        return _firstRoleTheAdminCanGrant(name, target);
    }
    function revokeDeployerAdminCall(address d) external pure returns (bytes memory) { return _revokeDeployerAdminCall(d); }
    function withoutMetadata(bytes memory code) external pure returns (bytes32) { return _withoutMetadata(code); }
}

/**
 * The handover, phase by phase, against fresh registries that initialize the way the deploy
 * scripts leave them, and a stand-in Safe.
 *
 * Environment variables and the deployments artifact are process-wide, so everything that
 * touches either is one test, run in order, and the others touch neither.
 */
contract SplitAuthorityTest is Test {
    bytes32 constant ADMIN_ROLE = 0x00;
    bytes32 constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    // Anvil's first test key. Public, valueless, and only used inside this test.
    uint256 constant KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    address deployer = vm.addr(KEY);

    address[5] internal targets;
    string[5] internal names = ["identity", "reputation", "staking", "oracleBond", "epochFees"];

    function _deployRegistries() internal {
        SVRToken svr = new SVRToken(address(this));
        address identity = address(new ERC1967Proxy(
            address(new SigvaraIdentity()),
            abi.encodeCall(SigvaraIdentity.initialize, (deployer, address(0)))
        ));
        address reputation = address(new ERC1967Proxy(
            address(new SigvaraReputation()),
            abi.encodeCall(SigvaraReputation.initialize, (deployer, address(0), address(0), address(0), 1 hours))
        ));
        address staking = address(new ERC1967Proxy(
            address(new SigvaraStaking()),
            abi.encodeCall(SigvaraStaking.initialize, (
                deployer, identity, reputation, address(svr), 1000e18, 7 days, 21 days
            ))
        ));
        address bond = address(new ERC1967Proxy(
            address(new SigvaraOracleBond()),
            abi.encodeCall(SigvaraOracleBond.initialize, (
                deployer, address(0), address(svr), 1000e18, 7 days, makeAddr("beneficiary")
            ))
        ));
        address fees = address(new ERC1967Proxy(
            address(new SigvaraEpochFees()),
            abi.encodeCall(SigvaraEpochFees.initialize, (
                deployer, address(0), address(svr), identity, makeAddr("pool"), 0
            ))
        ));
        targets = [identity, reputation, staking, bond, fees];
    }

    function _writeArtifact() internal {
        string memory json = string.concat(
            '{"chainId":', vm.toString(block.chainid),
            ',"deployer":"', vm.toString(deployer), '"'
        );
        for (uint256 i = 0; i < targets.length; i++) {
            json = string.concat(json, ',"', names[i], '":"', vm.toString(targets[i]), '"');
        }
        vm.createDir("deployments", true);
        vm.writeFile(_artifactPath(), string.concat(json, "}"));
    }

    function _artifactPath() internal view returns (string memory) {
        return string.concat("deployments/", vm.toString(block.chainid), ".json");
    }

    function _env(string memory phase, address safe, address timelock, string memory confirm) internal {
        vm.setEnv("PHASE", phase);
        vm.setEnv("SAFE", safe == address(0) ? "" : vm.toString(safe));
        vm.setEnv("TIMELOCK", timelock == address(0) ? "" : vm.toString(timelock));
        vm.setEnv("CONFIRM", confirm);
        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(bytes32(KEY)));
    }

    /// DEPLOYER_PRIVATE_KEY is not cleared. test/DeployScripts.t.sol sets the same public key,
    /// and forge runs test contracts in parallel threads of one process, so clearing it here could
    /// land in the middle of that test and make its script fail to parse an empty key. The other
    /// five names are used by this file alone.
    function _clearEnv() internal {
        vm.setEnv("PHASE", "");
        vm.setEnv("SAFE", "");
        vm.setEnv("TIMELOCK", "");
        vm.setEnv("CONFIRM", "");
        vm.setEnv("CONFIRM_UNINSPECTABLE_SAFE", "");
    }

    function test_theMigration_runsPhaseByPhase_andTheSafeCannotGiveItselfUpgrade() public {
        vm.chainId(7777001); // its own artifact path, so nothing else's is touched
        _deployRegistries();
        _writeArtifact();

        address[] memory owners = new address[](2);
        owners[0] = makeAddr("owner1");
        owners[1] = makeAddr("owner2");
        MockSafe safe = new MockSafe(owners, 2);
        address[] memory proposers = new address[](1);
        proposers[0] = address(safe);
        address[] memory executors = new address[](1); // open execution, as the script deploys it
        TimelockController timelock = _newTimelock(48 hours, proposers, executors, address(0));

        SplitAuthority s = new SplitAuthority_StandIn();

        // Phase 1: plan. Read-only, and runs with nothing but the artifact.
        _env("plan", address(safe), address(timelock), "");
        s.run();

        // At the start the deployer is everything, and on these registries UPGRADER_ROLE
        // administers itself.
        for (uint256 i = 0; i < targets.length; i++) {
            IAccessControl c = IAccessControl(targets[i]);
            assertTrue(c.hasRole(ADMIN_ROLE, deployer), names[i]);
            assertTrue(c.hasRole(UPGRADER_ROLE, deployer), names[i]);
            assertEq(c.getRoleAdmin(UPGRADER_ROLE), UPGRADER_ROLE, names[i]);
        }

        // Dropping anything before the replacements exist is refused, and says what is missing.
        _env("renounce", address(safe), address(timelock), "yes-drop-the-deployer");
        vm.expectRevert(abi.encodeWithSelector(SplitAuthority.SafeMissingAdmin.selector, "identity", address(safe)));
        s.run();

        // Phase 3: the deployer grants admin to the Safe and upgrader to the timelock. Both
        // grants are additive, so the deployer holds everything it did.
        _env("grant", address(safe), address(timelock), "");
        s.run();
        for (uint256 i = 0; i < targets.length; i++) {
            IAccessControl c = IAccessControl(targets[i]);
            assertTrue(c.hasRole(ADMIN_ROLE, address(safe)), names[i]);
            assertTrue(c.hasRole(UPGRADER_ROLE, address(timelock)), names[i]);
            assertTrue(c.hasRole(ADMIN_ROLE, deployer), "still held");
            assertTrue(c.hasRole(UPGRADER_ROLE, deployer), "still held");
        }

        // The old phase name still works and changes nothing now that it has all landed.
        _env("grant-admin", address(safe), address(timelock), "");
        s.run();

        // Nothing is dropped while a contract has no timelock behind it: with the Safe in place and
        // the timelock missing from one registry, the only route to an upgrade would be gone.
        vm.prank(deployer);
        IAccessControl(targets[0]).revokeRole(UPGRADER_ROLE, address(timelock));
        _env("renounce", address(safe), address(timelock), "yes-drop-the-deployer");
        vm.expectRevert(abi.encodeWithSelector(SplitAuthority.TimelockMissingUpgrader.selector, "identity", address(timelock)));
        s.run();
        vm.prank(deployer);
        IAccessControl(targets[0]).grantRole(UPGRADER_ROLE, address(timelock));

        // Phase 5 cannot run on phase 3 alone: the Safe has not yet shown that it can execute.
        _env("renounce", address(safe), address(timelock), "yes-drop-the-deployer");
        vm.expectRevert(abi.encodeWithSelector(SplitAuthority.DeployerStillAdmin.selector, "identity", deployer));
        s.run();

        // Phase 4: the calls it prints, made by the Safe.
        _env("safe-calldata", address(safe), address(timelock), "");
        s.run();
        for (uint256 i = 0; i < targets.length; i++) {
            safe.exec(targets[i], abi.encodeCall(IAccessControl.revokeRole, (ADMIN_ROLE, deployer)));
            assertFalse(IAccessControl(targets[i]).hasRole(ADMIN_ROLE, deployer), "the Safe removed it");
        }
        s.run(); // prints "done" for each

        // Phase 5 refuses without the confirmation, then goes through.
        _env("renounce", address(safe), address(timelock), "");
        vm.expectRevert(SplitAuthority.NotConfirmed.selector);
        s.run();
        _env("renounce", address(safe), address(timelock), "yes-drop-the-deployer");
        s.run();

        for (uint256 i = 0; i < targets.length; i++) {
            IAccessControl c = IAccessControl(targets[i]);
            assertFalse(c.hasRole(ADMIN_ROLE, deployer), names[i]);
            assertFalse(c.hasRole(UPGRADER_ROLE, deployer), names[i]);
            assertTrue(c.hasRole(ADMIN_ROLE, address(safe)), names[i]);
            assertTrue(c.hasRole(UPGRADER_ROLE, address(timelock)), names[i]);
        }

        _clearEnv();
        vm.removeFile(_artifactPath());

        // After the handover, the thing the migration is for.
        _afterTheHandover(safe, timelock);

        // And what it refuses to do on a registry that would leave the Safe a way round the timelock.
        _renounceRefusesRegistriesThatWouldLeaveAWayRound();

        // And that it will not run at all on an artifact that is missing one of the four launch registries.
        _theHandoverNeedsAllFourRegistries();

        // And that it will not leave the upgrade path to a timelock or a Safe weaker than the ADR describes.
        _renounceNeedsTheTimelockAndSafeTheAdrDescribes();

        // And that it takes no answer on trust that it cannot check: a multisig that cannot say what its threshold
        // is, and a contract that only answers like the timelock phase 2 deploys.
        _renounceRefusesASafeItCannotReadAndATimelockItDoesNotKnow();
        _anAccountThatHasDelegatedIsNotASafe();

        // And that a Safe's answers count only from Safe's own code, and not from a Safe with a module enabled.
        _renounceNeedsSafesOwnCodeAndNoModules();
    }

    MockSafe internal mSafe;
    TimelockController internal mTimelock;
    SplitAuthority internal mScript;

    /// The grant phase, then the Safe removing the deployer's admin: everything the renounce phase checks
    /// for, short of the renounce itself.
    function _handoverUpToTheRenounce() internal {
        _writeArtifact();
        address[] memory owners = new address[](2);
        owners[0] = makeAddr("owner1");
        owners[1] = makeAddr("owner2");
        mSafe = new MockSafe(owners, 2);
        address[] memory proposers = new address[](1);
        proposers[0] = address(mSafe);
        address[] memory executors = new address[](1);
        mTimelock = _newTimelock(48 hours, proposers, executors, address(0));
        mScript = new SplitAuthority_StandIn();

        _env("grant", address(mSafe), address(mTimelock), "");
        mScript.run();
        for (uint256 i = 0; i < targets.length; i++) {
            mSafe.exec(targets[i], abi.encodeCall(IAccessControl.revokeRole, (ADMIN_ROLE, deployer)));
        }
    }

    /// Phase 5 cannot be undone, so it reads the chain and refuses unless the arrangement the timelock exists
    /// for is the one in place. It used to print a warning afterwards, once the deployer had already gone.
    /// Run from the migration test, because the environment is process-wide.
    function _renounceRefusesRegistriesThatWouldLeaveAWayRound() internal {
        // 1. oracleBond is set up the way older code did it: the Safe could grant itself upgrade rights.
        vm.chainId(7777002);
        _deployRegistries();
        targets[3] = address(new LegacyRegistry(deployer));
        _handoverUpToTheRenounce();
        _env("renounce", address(mSafe), address(mTimelock), "yes-drop-the-deployer");
        vm.expectRevert(abi.encodeWithSelector(SplitAuthority.UpgraderRoleNotSelfAdministered.selector, "oracleBond"));
        mScript.run();
        assertTrue(IAccessControl(targets[3]).hasRole(UPGRADER_ROLE, deployer), "nothing was dropped");
        _clearEnv();
        vm.removeFile(_artifactPath());

        // 2. The upgrader role administers itself there, but the slasher role is still the admin's to grant.
        vm.chainId(7777003);
        _deployRegistries();
        targets[3] = address(new HalfwayRegistry(deployer));
        _handoverUpToTheRenounce();
        _env("renounce", address(mSafe), address(mTimelock), "yes-drop-the-deployer");
        vm.expectRevert(abi.encodeWithSelector(
            SplitAuthority.RoleNotTimelocked.selector, "oracleBond", keccak256("SLASHER_ROLE")
        ));
        mScript.run();
        assertTrue(IAccessControl(targets[3]).hasRole(UPGRADER_ROLE, deployer), "nothing was dropped");
        _clearEnv();
        vm.removeFile(_artifactPath());

        // 3. The same sequence on current registries goes through, so the refusals above are about the roles
        //    and not about the setup.
        vm.chainId(7777004);
        _deployRegistries();
        _handoverUpToTheRenounce();
        _env("renounce", address(mSafe), address(mTimelock), "yes-drop-the-deployer");
        mScript.run();
        for (uint256 i = 0; i < targets.length; i++) {
            assertFalse(IAccessControl(targets[i]).hasRole(UPGRADER_ROLE, deployer), names[i]);
        }
        _clearEnv();
        vm.removeFile(_artifactPath());
    }

    /// The artifact with one of the four launch registries damaged: `how` 0 leaves it out, 1 sets it to the zero
    /// address, 2 points it at an address with no code.
    function _writeArtifactDamaged(uint256 which, uint256 how) internal {
        string memory json = string.concat(
            '{"chainId":', vm.toString(block.chainid),
            ',"deployer":"', vm.toString(deployer), '"'
        );
        for (uint256 i = 0; i < targets.length; i++) {
            if (i == which && how == 0) continue;
            address a = targets[i];
            if (i == which) a = how == 1 ? address(0) : makeAddr("no code here");
            json = string.concat(json, ',"', names[i], '":"', vm.toString(a), '"');
        }
        vm.createDir("deployments", true);
        vm.writeFile(_artifactPath(), string.concat(json, "}"));
    }

    /// The artifact is the script's whole idea of what exists, and it used to skip a registry that was missing from
    /// it, held the zero address or had no code. Skipped, that proxy kept the deployer's admin and upgrade rights
    /// in every phase, and the last one printed "done". The renounce phase checks the contracts it was shown, so
    /// it could not notice one it was never shown. The four launch registries are now required in every phase;
    /// epochFees, which the mainnet launch leaves out, stays optional.
    /// Run from the migration test, because the environment is process-wide.
    function _theHandoverNeedsAllFourRegistries() internal {
        vm.chainId(7777005);
        _deployRegistries();
        address[] memory owners = new address[](2);
        owners[0] = makeAddr("owner1");
        owners[1] = makeAddr("owner2");
        MockSafe safe = new MockSafe(owners, 2);
        address[] memory proposers = new address[](1);
        proposers[0] = address(safe);
        address[] memory executors = new address[](1);
        TimelockController timelock = _newTimelock(48 hours, proposers, executors, address(0));
        SplitAuthority s = new SplitAuthority_StandIn();

        string[4] memory phases = ["plan", "grant", "safe-calldata", "renounce"];
        for (uint256 which = 0; which < 4; which++) {
            for (uint256 how = 0; how < 3; how++) {
                _writeArtifactDamaged(which, how);
                for (uint256 p = 0; p < phases.length; p++) {
                    _env(phases[p], address(safe), address(timelock), "yes-drop-the-deployer");
                    vm.expectRevert(abi.encodeWithSelector(SplitAuthority.MissingTarget.selector, names[which]));
                    s.run();
                }
            }
        }
        for (uint256 i = 0; i < targets.length; i++) {
            assertFalse(IAccessControl(targets[i]).hasRole(ADMIN_ROLE, address(safe)), "none of those runs granted anything");
        }

        // An artifact with the four and no epochFees is a whole one, and epochFees is left alone.
        _writeArtifactWithoutEpochFees();
        _env("grant", address(safe), address(timelock), "");
        s.run();
        for (uint256 i = 0; i < 4; i++) {
            assertTrue(IAccessControl(targets[i]).hasRole(ADMIN_ROLE, address(safe)), names[i]);
        }
        assertFalse(IAccessControl(targets[4]).hasRole(ADMIN_ROLE, address(safe)), "epochFees was not in the artifact");

        _clearEnv();
        vm.removeFile(_artifactPath());
    }

    /// A timelock created the way phase 2 creates one, from the deployer account. Phases 3 and 5 check where the
    /// timelock came from, because a constructor can leave state that its code does not show.
    function _newTimelock(uint256 delay, address[] memory proposers, address[] memory executors, address admin)
        internal
        returns (TimelockController)
    {
        vm.prank(deployer);
        return new TimelockController(delay, proposers, executors, admin);
    }

    /// A timelock as phase 2 builds one: `proposer` proposes and cancels, anyone executes when `open`, and it
    /// administers itself unless `admin` is named. Those three are what a test gets to spoil.
    function _timelock(address proposer, uint256 delay, address admin, bool open)
        internal
        returns (TimelockController)
    {
        address[] memory proposers = new address[](1);
        proposers[0] = proposer;
        address[] memory executors = new address[](open ? 1 : 0); // [address(0)] is open execution
        return _newTimelock(delay, proposers, executors, admin);
    }

    /// Every registry's upgrader role also goes to `timelock`, as phase 3 would have, so that the one thing phase 5
    /// can object to is the timelock and not a grant that was never made.
    function _grantUpgrader(address timelock) internal {
        vm.startPrank(deployer);
        for (uint256 i = 0; i < targets.length; i++) {
            IAccessControl(targets[i]).grantRole(UPGRADER_ROLE, timelock);
        }
        vm.stopPrank();
    }

    function _renounceIsRefused(SplitAuthority s, address safe, address timelock, bytes memory err) internal {
        _env("renounce", safe, timelock, "yes-drop-the-deployer");
        vm.expectRevert(err);
        s.run();
    }

    /// Phase 5 cannot be undone, and the timelock it leaves in charge of every upgrade is only worth what it was
    /// built with. The delay, who may propose, cancel and execute, and who administers the timelock are all set in
    /// its constructor, and afterwards only the timelock can change them. Each refusal here is a way of ending up with
    /// proxies that nobody can upgrade, or that one key can upgrade with less notice than anyone was promised.
    /// Run from the migration test, because the environment is process-wide.
    function _renounceNeedsTheTimelockAndSafeTheAdrDescribes() internal {
        vm.chainId(7777006);
        _deployRegistries();
        _writeArtifact();
        address[] memory owners = new address[](2);
        owners[0] = makeAddr("owner1");
        owners[1] = makeAddr("owner2");
        MockSafe safe = new MockSafe(owners, 2);
        TimelockController good = _timelock(address(safe), 48 hours, address(0), true);
        SplitAuthority s = new SplitAuthority_StandIn();

        // Everything phase 5 reads is in place: the Safe is admin and has removed the deployer's admin.
        _env("grant", address(safe), address(good), "");
        s.run();
        for (uint256 i = 0; i < targets.length; i++) {
            safe.exec(targets[i], abi.encodeCall(IAccessControl.revokeRole, (ADMIN_ROLE, deployer)));
        }

        // 1. Under 48 hours, down to one second and to none. A delay typed as 48 where seconds were meant is a
        //    one-line mistake that no earlier phase would notice.
        uint256[3] memory delays = [uint256(0), 1, 48 hours - 1];
        for (uint256 i = 0; i < delays.length; i++) {
            TimelockController t = _timelock(address(safe), delays[i], address(0), true);
            _grantUpgrader(address(t));
            _renounceIsRefused(s, address(safe), address(t), abi.encodeWithSelector(
                SplitAuthority.TimelockDelayTooShort.selector, address(t), delays[i], 48 hours
            ));
        }

        // 2. The Safe cannot propose to it.
        TimelockController other = _timelock(makeAddr("not the safe"), 48 hours, address(0), true);
        _grantUpgrader(address(other));
        _renounceIsRefused(s, address(safe), address(other), abi.encodeWithSelector(
            SplitAuthority.TimelockCannotBeProposedTo.selector, address(other), address(safe)
        ));

        // 3. The Safe proposes but cannot cancel a scheduled call it has changed its mind about.
        TimelockController noCancel = _timelock(address(safe), 48 hours, address(this), true);
        noCancel.revokeRole(noCancel.CANCELLER_ROLE(), address(safe));
        noCancel.renounceRole(ADMIN_ROLE, address(this));
        _grantUpgrader(address(noCancel));
        _renounceIsRefused(s, address(safe), address(noCancel), abi.encodeWithSelector(
            SplitAuthority.TimelockCannotBeCancelledBy.selector, address(noCancel), address(safe)
        ));

        // 4. Nobody can execute. A scheduled call would never run, and so neither would the call that gives
        //    anyone the executor role.
        TimelockController noExecutor = _timelock(address(safe), 48 hours, address(0), false);
        _grantUpgrader(address(noExecutor));
        _renounceIsRefused(s, address(safe), address(noExecutor), abi.encodeWithSelector(
            SplitAuthority.TimelockExecutionNotOpen.selector, address(noExecutor)
        ));

        // 5. The Safe, or the deployer, can still rewrite the timelock's roles at once.
        address[2] memory admins = [address(safe), deployer];
        for (uint256 i = 0; i < admins.length; i++) {
            TimelockController t = _timelock(address(safe), 48 hours, admins[i], true);
            _grantUpgrader(address(t));
            _renounceIsRefused(s, address(safe), address(t), abi.encodeWithSelector(
                SplitAuthority.TimelockHasOutsideAdmin.selector, address(t), admins[i]
            ));
        }

        // 6. An address with no code is no timelock: a typo, or an address that only exists on another chain. It
        //    is refused before the deployer grants it anything, as well as before it renounces.
        address nothing = makeAddr("no timelock here");
        _renounceIsRefused(s, address(safe), nothing, abi.encodeWithSelector(
            SplitAuthority.TimelockHasNoCode.selector, nothing
        ));
        _env("grant", address(safe), nothing, "");
        vm.expectRevert(abi.encodeWithSelector(SplitAuthority.TimelockHasNoCode.selector, nothing));
        s.run();

        // 7. A Safe of one owner. The deployer's own is refused for what it is; another key's is still one key.
        address[] memory alone = new address[](2);
        alone[0] = deployer;
        alone[1] = makeAddr("owner1");
        MockSafe deployerSafe = new MockSafe(alone, 1);
        _renounceIsRefused(s, address(deployerSafe), address(good), abi.encodeWithSelector(
            SplitAuthority.DeployerCanActAlone.selector, address(deployerSafe)
        ));
        address[] memory one = new address[](1);
        one[0] = makeAddr("owner1");
        MockSafe oneOwner = new MockSafe(one, 1);
        _renounceIsRefused(s, address(oneOwner), address(good), abi.encodeWithSelector(
            SplitAuthority.SafeThresholdTooLow.selector, address(oneOwner), 1, 2
        ));

        // None of that dropped anything, and the same sequence with the timelock phase 2 builds goes through, so
        // the refusals above are about the timelock and the Safe and not about the setup.
        for (uint256 i = 0; i < targets.length; i++) {
            assertTrue(IAccessControl(targets[i]).hasRole(UPGRADER_ROLE, deployer), "nothing was dropped");
        }
        _env("renounce", address(safe), address(good), "yes-drop-the-deployer");
        s.run();
        for (uint256 i = 0; i < targets.length; i++) {
            assertFalse(IAccessControl(targets[i]).hasRole(UPGRADER_ROLE, deployer), names[i]);
        }

        _clearEnv();
        vm.removeFile(_artifactPath());
    }

    /// Answers the renounce phase used to take on trust. A multisig that cannot say what its threshold is got none of
    /// the owner checks, and the threshold guard passed it as if it had cleared them. A timelock was judged by what it
    /// said about itself, so a contract that says the right things and lets anyone upgrade at once passed every
    /// check; so did a contract with the right code, though a constructor can leave state that the code does not
    /// show. An account that has delegated to a contract (EIP-7702) was taken for a Safe. Each is set up so that the
    /// old code goes all the way through, and the deployer's upgrader role is what shows it. The timelock is
    /// recognized by its code, not by its metadata, which depends on where the sources were read. Run from the
    /// migration test, because the environment is process-wide.
    function _renounceRefusesASafeItCannotReadAndATimelockItDoesNotKnow() internal {
        vm.chainId(7777007);
        _deployRegistries();
        _writeArtifact();
        SplitAuthority s = new SplitAuthority_StandIn();

        // One multisig whose getters revert and one whose fallback answers with nothing, each with a real timelock.
        OtherMultisig[2] memory others = [new OtherMultisig(false), new OtherMultisig(true)];
        TimelockController[2] memory real;
        for (uint256 i = 0; i < others.length; i++) {
            real[i] = _timelock(address(others[i]), 48 hours, address(0), true);
        }
        // A Safe that reads fine, and four things in the timelock's place: a lookalike, a real one rebuilt with other
        // metadata, a real one with a byte of its code changed, and a real one that the deployer did not create.
        address[] memory owners = new address[](2);
        owners[0] = makeAddr("owner1");
        owners[1] = makeAddr("owner2");
        MockSafe safe = new MockSafe(owners, 2);
        LookalikeTimelock fake = new LookalikeTimelock();
        TimelockController rebuilt = _timelock(address(safe), 48 hours, address(0), true);
        TimelockController tampered = _timelock(address(safe), 48 hours, address(0), true);
        address[] memory proposers = new address[](1);
        proposers[0] = address(safe);
        TimelockController foreign = new TimelockController(48 hours, proposers, new address[](1), address(0));

        // The script's own grant phase makes each multisig admin and gives the real timelocks their upgrader role. It
        // would refuse the other three, so those get the role by hand, which leaves the old code nothing to object
        // to. Then the deployer's admin is gone.
        for (uint256 i = 0; i < others.length; i++) {
            _env("grant", address(others[i]), address(real[i]), "");
            s.run();
        }
        _env("grant", address(safe), address(rebuilt), "");
        s.run();
        for (uint256 i = 0; i < targets.length; i++) {
            safe.exec(targets[i], abi.encodeCall(IAccessControl.revokeRole, (ADMIN_ROLE, deployer)));
        }
        _grantUpgrader(address(fake));
        _grantUpgrader(address(tampered));
        _grantUpgrader(address(foreign));

        // solc ends the code with metadata that includes a hash of the sources as read, so the same contract built
        // on another machine (CRLF in a Windows checkout) has other metadata and the same code to run. The last two
        // bytes are the metadata's length; the one before them is inside it. The tampered copy changes a byte that
        // runs.
        bytes memory code = address(rebuilt).code;
        code[code.length - 3] = bytes1(uint8(code[code.length - 3]) ^ 0x01);
        vm.etch(address(rebuilt), code);
        code = address(tampered).code;
        code[code.length / 2] = bytes1(uint8(code[code.length / 2]) ^ 0x01);
        vm.etch(address(tampered), code);
        assertTrue(address(rebuilt).codehash != address(real[0]).codehash, "the metadata differs");

        // 1. Not a Safe, so no threshold to believe. Refused, and a nearly right confirmation (or the sentence an
        //    older version of the script asked for) is not the operator saying they checked. Neither keeps anything
        //    in storage slot 0, where a Safe proxy keeps its implementation.
        for (uint256 i = 0; i < others.length; i++) {
            bytes memory err = abi.encodeWithSelector(
                SplitAuthority.SafeNotRecognized.selector, address(others[i]), address(others[i]).codehash, address(0)
            );
            _renounceIsRefused(s, address(others[i]), address(real[i]), err);
            vm.setEnv("CONFIRM_UNINSPECTABLE_SAFE", "yes");
            _renounceIsRefused(s, address(others[i]), address(real[i]), err);
            vm.setEnv("CONFIRM_UNINSPECTABLE_SAFE", "yes-i-checked-the-threshold");
            _renounceIsRefused(s, address(others[i]), address(real[i]), err);
            vm.setEnv("CONFIRM_UNINSPECTABLE_SAFE", "");
        }

        // 2. Not the timelock phase 2 makes. The lookalike and the changed byte are told by their code, which differs
        //    from what phase 2 deploys; the error names the hash it found and the one it expected, which are what
        //    `cast codehash` and `forge inspect TimelockController deployedBytecode | cast keccak` print. The genuine
        //    copy that someone else created has the right code and is told by where it came from: equal code is not
        //    equal state, since a constructor can leave an operation already scheduled or a role holder with no event.
        address[3] memory notIt = [address(fake), address(tampered), address(foreign)];
        bytes[3] memory notItError = [
            abi.encodeWithSelector(
                SplitAuthority.TimelockCodeNotRecognized.selector, address(fake), address(fake).codehash, address(real[0]).codehash
            ),
            abi.encodeWithSelector(
                SplitAuthority.TimelockCodeNotRecognized.selector, address(tampered), address(tampered).codehash, address(real[0]).codehash
            ),
            abi.encodeWithSelector(SplitAuthority.TimelockNotCreatedByDeployer.selector, address(foreign), deployer)
        ];
        for (uint256 i = 0; i < notIt.length; i++) {
            // Phase 3 is the one that gives the timelock the right to upgrade every registry, so it refuses first.
            _env("grant", address(safe), notIt[i], "");
            vm.expectRevert(notItError[i]);
            s.run();
            _renounceIsRefused(s, address(safe), notIt[i], notItError[i]);
        }

        // None of that dropped anything.
        _assertDeployerHolds();

        // 3. Everything above had the same registries and the same Safes, so what separates a refusal from a pass is
        //    the one thing each case changes. Each pass runs from the same starting point, and the deployer losing
        //    its upgrader role is what shows that the renounce ran. With the exact sentence a multisig that cannot be
        //    read goes through; so does a timelock whose code runs the same and whose metadata does not.
        uint256 start = vm.snapshotState();
        vm.setEnv("CONFIRM_UNINSPECTABLE_SAFE", "yes-i-checked-the-safe");
        for (uint256 i = 0; i < others.length; i++) {
            _env("renounce", address(others[i]), address(real[i]), "yes-drop-the-deployer");
            s.run();
            _assertDeployerDropped();
            vm.revertToState(start);
        }
        vm.setEnv("CONFIRM_UNINSPECTABLE_SAFE", "");
        _env("renounce", address(safe), address(rebuilt), "yes-drop-the-deployer");
        s.run();
        _assertDeployerDropped();

        _clearEnv();
        vm.removeFile(_artifactPath());
    }

    /// An account that has delegated to a contract (EIP-7702) has 23 bytes of code: 0xef0100 and an address. On Arc a
    /// call to it runs that contract's code, so it can report any threshold and any owners, and its own key can still
    /// act as itself whatever they say. This test chain is cancun, where a call to it just fails, so the refusal has
    /// to come from the code and not from the getters. Other 23-byte code is not that. The Safe is the first thing
    /// every phase looks at, so none of this needs the registries or a timelock. Run from the migration test,
    /// because the environment is process-wide.
    function _anAccountThatHasDelegatedIsNotASafe() internal {
        SplitAuthority s = new SplitAuthority_StandIn();
        address elsewhere = makeAddr("a contract the account delegates to");
        address timelock = makeAddr("a timelock the Safe check never reaches");

        address delegated = makeAddr("a delegated account");
        vm.etch(delegated, bytes.concat(hex"ef0100", bytes20(elsewhere)));
        bytes memory refused = abi.encodeWithSelector(SplitAuthority.SafeIsADelegatedAccount.selector, delegated);
        _renounceIsRefused(s, delegated, timelock, refused);
        _env("grant", delegated, timelock, "");
        vm.expectRevert(refused);
        s.run();

        // Not a delegation: the version byte is wrong. It gets past the Safe check, and the run stops at the next
        // one, because the timelock has no code.
        address otherCode = makeAddr("23 bytes of something else");
        vm.etch(otherCode, bytes.concat(hex"ef0200", bytes20(elsewhere)));
        _env("renounce", otherCode, timelock, "yes-drop-the-deployer");
        vm.expectRevert(abi.encodeWithSelector(SplitAuthority.TimelockHasNoCode.selector, timelock));
        s.run();

        _clearEnv();
    }

    /// A Safe's owners and threshold are what its implementation answers, and a Safe address is a proxy that runs
    /// whatever implementation it keeps in storage slot 0. So phase 5 believes them only from a proxy and an
    /// implementation that are code Safe published, and not from a Safe with a module enabled, since a module acts
    /// as the Safe with none of the owners. Here the plain script, which has no stand-in, refuses the MockSafe the
    /// other tests use, and the stand-in, which takes it for Safe's code, still holds it to its modules. Run from
    /// the migration test, because the environment is process-wide.
    function _renounceNeedsSafesOwnCodeAndNoModules() internal {
        vm.chainId(7777008);
        _deployRegistries();
        _handoverUpToTheRenounce();
        SplitAuthority plain = new SplitAuthority();
        uint256 start = vm.snapshotState();

        // 1. Not Safe's code. The error names the code hash and what slot 0 holds, to compare with Safe's own.
        address slot0 = address(uint160(uint256(vm.load(address(mSafe), bytes32(0)))));
        bytes memory notASafe = abi.encodeWithSelector(
            SplitAuthority.SafeNotRecognized.selector, address(mSafe), address(mSafe).codehash, slot0
        );
        _renounceIsRefused(plain, address(mSafe), address(mTimelock), notASafe);
        vm.setEnv("CONFIRM_UNINSPECTABLE_SAFE", "yes-i-checked-the-threshold");
        _renounceIsRefused(plain, address(mSafe), address(mTimelock), notASafe);

        // 2. A module enabled. It can run any call as the Safe, so the threshold limits nobody who controls it.
        vm.setEnv("CONFIRM_UNINSPECTABLE_SAFE", "");
        address module = makeAddr("a module");
        mSafe.enableModule(module);
        _renounceIsRefused(mScript, address(mSafe), address(mTimelock), abi.encodeWithSelector(
            SplitAuthority.SafeHasModules.selector, address(mSafe), module
        ));
        vm.revertToState(start);

        // 3. A Safe that will not list its modules has not shown that it has none.
        mSafe.hideModules();
        _renounceIsRefused(mScript, address(mSafe), address(mTimelock), abi.encodeWithSelector(
            SplitAuthority.SafeModulesUnreadable.selector, address(mSafe)
        ));
        vm.revertToState(start);

        // None of that dropped anything.
        _assertDeployerHolds();

        // 4. What separates those from a pass is the one thing each changed: the plain script goes through on the
        //    exact sentence, and the stand-in with no module needs none.
        vm.setEnv("CONFIRM_UNINSPECTABLE_SAFE", "yes-i-checked-the-safe");
        _env("renounce", address(mSafe), address(mTimelock), "yes-drop-the-deployer");
        plain.run();
        _assertDeployerDropped();
        vm.revertToState(start);
        vm.setEnv("CONFIRM_UNINSPECTABLE_SAFE", "");
        _env("renounce", address(mSafe), address(mTimelock), "yes-drop-the-deployer");
        mScript.run();
        _assertDeployerDropped();

        _clearEnv();
        vm.removeFile(_artifactPath());
    }

    function _assertDeployerHolds() internal view {
        for (uint256 i = 0; i < targets.length; i++) {
            assertTrue(IAccessControl(targets[i]).hasRole(UPGRADER_ROLE, deployer), "nothing was dropped");
        }
    }

    function _assertDeployerDropped() internal view {
        for (uint256 i = 0; i < targets.length; i++) {
            assertFalse(IAccessControl(targets[i]).hasRole(UPGRADER_ROLE, deployer), names[i]);
        }
    }

    function _writeArtifactWithoutEpochFees() internal {
        string memory json = string.concat(
            '{"chainId":', vm.toString(block.chainid),
            ',"deployer":"', vm.toString(deployer), '"'
        );
        for (uint256 i = 0; i < 4; i++) {
            json = string.concat(json, ',"', names[i], '":"', vm.toString(targets[i]), '"');
        }
        vm.createDir("deployments", true);
        vm.writeFile(_artifactPath(), string.concat(json, "}"));
    }

    function _afterTheHandover(MockSafe safe, TimelockController timelock) internal {
        address freshImpl = address(new SigvaraStaking());

        for (uint256 i = 0; i < targets.length; i++) {
            // The deployer can no longer upgrade or grant.
            vm.prank(deployer);
            vm.expectRevert(abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, deployer, UPGRADER_ROLE
            ));
            IUUPSLike(targets[i]).upgradeToAndCall(freshImpl, "");

            // The Safe holds admin and still cannot give itself upgrade rights, because
            // admin does not administer that role here.
            vm.expectRevert(abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, address(safe), UPGRADER_ROLE
            ));
            safe.exec(targets[i], abi.encodeCall(IAccessControl.grantRole, (UPGRADER_ROLE, address(safe))));

            // Nor can it take the timelock's role away.
            vm.expectRevert(abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, address(safe), UPGRADER_ROLE
            ));
            safe.exec(targets[i], abi.encodeCall(IAccessControl.revokeRole, (UPGRADER_ROLE, address(timelock))));

            // And the Safe is still admin of the roles that stayed with it: grants and revokes work.
            address probe = address(0xBEEF);
            bytes32 guardianRole = keccak256("GUARDIAN_ROLE");
            safe.exec(targets[i], abi.encodeCall(IAccessControl.grantRole, (guardianRole, probe)));
            assertTrue(IAccessControl(targets[i]).hasRole(guardianRole, probe));
            safe.exec(targets[i], abi.encodeCall(IAccessControl.revokeRole, (guardianRole, probe)));
        }

        // The wiring setters are upgrade-class. The Safe holds admin and is refused, and the
        // timelock holds the upgrader role and gets through, after its delay.
        _wiringGoesThroughTheTimelock(safe, timelock);

        // So are the roles that take funds or change an agent's standing.
        _fundRolesGoThroughTheTimelock(safe, timelock);

        // An upgrade goes through the timelock, with its delay.
        address staking = targets[2];
        bytes memory upgradeCall = abi.encodeCall(IUUPSLike.upgradeToAndCall, (freshImpl, ""));
        bytes32 salt = keccak256("handover-rehearsal");
        safe.exec(
            address(timelock),
            abi.encodeCall(TimelockController.schedule, (staking, 0, upgradeCall, bytes32(0), salt, 48 hours))
        );
        vm.warp(block.timestamp + 48 hours - 1);
        vm.expectRevert();
        timelock.execute(staking, 0, upgradeCall, bytes32(0), salt);
        vm.warp(block.timestamp + 2);
        vm.prank(address(0xD00D)); // execution is open
        timelock.execute(staking, 0, upgradeCall, bytes32(0), salt);
        assertEq(address(uint160(uint256(vm.load(staking, IMPL_SLOT)))), freshImpl, "upgrade landed through the timelock");

        // The timelock, as the upgrader, can hand the role on, after its delay. Pranked here
        // because the point is only that the role is administered by its holders.
        vm.prank(address(timelock));
        IAccessControl(staking).grantRole(UPGRADER_ROLE, address(0xCAFE));
        assertTrue(IAccessControl(staking).hasRole(UPGRADER_ROLE, address(0xCAFE)));
    }

    /// setStakeView decides who counts as bonded, setOperatorBond decides who may score, and passing
    /// zero to either turns its check off, and setSlashBeneficiary decides where slashed bond goes.
    /// Each changes the protocol about as much as an upgrade, so after the handover the Safe cannot
    /// make any of the calls and the timelock can.
    function _wiringGoesThroughTheTimelock(MockSafe safe, TimelockController timelock) internal {
        address identity = targets[0];
        address reputation = targets[1];
        address bond = targets[3];
        address newView = makeAddr("newStakeView");
        address newSet = makeAddr("newOperatorSet");
        address newBeneficiary = makeAddr("newBeneficiary");

        vm.expectRevert(abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, address(safe), UPGRADER_ROLE
        ));
        safe.exec(bond, abi.encodeCall(SigvaraOracleBond.setSlashBeneficiary, (newBeneficiary)));

        vm.expectRevert(abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, address(safe), UPGRADER_ROLE
        ));
        safe.exec(identity, abi.encodeCall(SigvaraIdentity.setStakeView, (newView)));

        vm.expectRevert(abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, address(safe), UPGRADER_ROLE
        ));
        safe.exec(reputation, abi.encodeCall(SigvaraReputation.setOperatorBond, (address(0))));

        bytes memory viewCall = abi.encodeCall(SigvaraIdentity.setStakeView, (newView));
        bytes memory bondCall = abi.encodeCall(SigvaraReputation.setOperatorBond, (newSet));
        bytes32 salt = keccak256("wiring-rehearsal");
        safe.exec(
            address(timelock),
            abi.encodeCall(TimelockController.schedule, (identity, 0, viewCall, bytes32(0), salt, 48 hours))
        );
        safe.exec(
            address(timelock),
            abi.encodeCall(TimelockController.schedule, (reputation, 0, bondCall, bytes32(0), salt, 48 hours))
        );
        bytes memory beneficiaryCall = abi.encodeCall(SigvaraOracleBond.setSlashBeneficiary, (newBeneficiary));
        safe.exec(
            address(timelock),
            abi.encodeCall(TimelockController.schedule, (bond, 0, beneficiaryCall, bytes32(0), salt, 48 hours))
        );

        vm.expectRevert();
        timelock.execute(identity, 0, viewCall, bytes32(0), salt);

        vm.warp(block.timestamp + 48 hours);
        timelock.execute(identity, 0, viewCall, bytes32(0), salt);
        timelock.execute(reputation, 0, bondCall, bytes32(0), salt);
        timelock.execute(bond, 0, beneficiaryCall, bytes32(0), salt);
        assertEq(address(SigvaraIdentity(identity).stakeView()), newView, "stake view moved through the timelock");
        assertEq(address(SigvaraReputation(reputation).operatorBond()), newSet, "operator bond moved through it too");
        assertEq(SigvaraOracleBond(bond).slashBeneficiary(), newBeneficiary, "and so did the slash beneficiary");
    }

    /// The roles that take bonded funds or change an agent's standing are granted by the upgrader,
    /// so after the handover the Safe is refused on each, the timelock gets through after its delay,
    /// and the Safe can still take the role away at once.
    function _fundRolesGoThroughTheTimelock(MockSafe safe, TimelockController timelock) internal {
        bytes32 core = keccak256("STAKING_CORE_ROLE");
        bytes32 committee = keccak256("SLASHING_COMMITTEE_ROLE");
        bytes32 slasher = keccak256("SLASHER_ROLE");
        // identity, reputation (twice), staking, oracleBond: the contract and the role it hands out
        address[5] memory on = [targets[0], targets[1], targets[1], targets[2], targets[3]];
        bytes32[5] memory role = [core, core, committee, committee, slasher];
        address probe = address(0xBEEF);

        for (uint256 i = 0; i < on.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, address(safe), UPGRADER_ROLE
            ));
            safe.exec(on[i], abi.encodeCall(IAccessControl.grantRole, (role[i], probe)));

            safe.exec(
                address(timelock),
                abi.encodeCall(
                    TimelockController.schedule,
                    (on[i], 0, abi.encodeCall(IAccessControl.grantRole, (role[i], probe)), bytes32(0), keccak256(abi.encode(i)), 48 hours)
                )
            );
        }

        vm.warp(block.timestamp + 48 hours);
        for (uint256 i = 0; i < on.length; i++) {
            timelock.execute(
                on[i], 0, abi.encodeCall(IAccessControl.grantRole, (role[i], probe)), bytes32(0), keccak256(abi.encode(i))
            );
            assertTrue(IAccessControl(on[i]).hasRole(role[i], probe), "granted through the timelock");

            safe.exec(on[i], abi.encodeCall(IAccessControl.revokeRole, (role[i], probe)));
            assertFalse(IAccessControl(on[i]).hasRole(role[i], probe), "and revoked by the Safe at once");
        }
    }

    bytes32 constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    // -------------------------------------------------------------------------
    // The check that tells the two kinds of proxy apart
    // -------------------------------------------------------------------------

    /// What the script believes the timelock protects must be what the contracts actually do. For each
    /// registry as it initializes now, a role is administered by the upgrader exactly when the script lists
    /// it, so a contract that moves another role under the timelock, or drops one, fails here until the
    /// script's table is updated with it.
    function test_theTimelockedRolesTableIsExactlyWhatTheContractsDo() public {
        _deployRegistries();
        SplitAuthority_Harness h = new SplitAuthority_Harness();
        bytes32[6] memory candidates = [
            keccak256("STAKING_CORE_ROLE"), keccak256("SLASHING_COMMITTEE_ROLE"), keccak256("SLASHER_ROLE"),
            keccak256("ORACLE_ROLE"), keccak256("GUARDIAN_ROLE"), ADMIN_ROLE
        ];
        for (uint256 i = 0; i < targets.length; i++) {
            bytes32[] memory listed = h.timelockedRoles(names[i]);
            for (uint256 j = 0; j < candidates.length; j++) {
                bool administeredByUpgrader = IAccessControl(targets[i]).getRoleAdmin(candidates[j]) == UPGRADER_ROLE;
                bool inTable;
                for (uint256 k = 0; k < listed.length; k++) if (listed[k] == candidates[j]) inTable = true;
                assertEq(inTable, administeredByUpgrader, string.concat(names[i], " role ", vm.toString(candidates[j])));
            }
            (bool open,) = h.firstOpenRole(names[i], targets[i]);
            assertFalse(open, string.concat(names[i], ": nothing is left to the admin"));
        }
        assertEq(h.timelockedRoles("not a registry").length, 0);
    }

    function test_aRegistryFromTheOlderCodeIsReportedAsOpen() public {
        SplitAuthority_Harness h = new SplitAuthority_Harness();
        address legacy = address(new LegacyRegistry(deployer));
        (bool open, bytes32 role) = h.firstOpenRole("oracleBond", legacy);
        assertTrue(open);
        assertEq(role, keccak256("SLASHER_ROLE"));

        // A registry whose roles cannot be read is not assumed safe either.
        (open,) = h.firstOpenRole("oracleBond", address(0xABCD));
        assertTrue(open);
    }

    function test_upgraderAdminIsSelf_readsTheContract() public {
        _deployRegistries();
        SplitAuthority_Harness h = new SplitAuthority_Harness();
        for (uint256 i = 0; i < targets.length; i++) assertTrue(h.adminIsSelf(targets[i]), names[i]);

        assertFalse(h.adminIsSelf(address(new LegacyRoles())), "a registry from before the change");
        assertFalse(h.adminIsSelf(address(0xABCD)), "an address with no such function is not assumed safe");
    }

    // -------------------------------------------------------------------------
    // How the timelock's code is recognized
    // -------------------------------------------------------------------------

    /// solc ends the code with a metadata blob and, in two bytes, the blob's length. Phase 5 compares the code
    /// without it, because the blob depends on where the sources were read and the code to run does not. The
    /// migration test shows that on a real timelock; this pins the arithmetic, including a blob of 256 bytes or
    /// more, whose length needs both bytes, and input that does not end in a readable length.
    function test_withoutMetadata_dropsTheTailSolcAppendsAndNothingElse() public {
        SplitAuthority_Harness h = new SplitAuthority_Harness();
        bytes memory code = hex"6080604052600080fd";
        bytes memory blob = new bytes(300);
        bytes memory otherBlob = new bytes(300);
        otherBlob[7] = 0x01;

        assertEq(h.withoutMetadata(bytes.concat(code, blob, hex"012c")), keccak256(code), "the blob and its length go");
        assertEq(h.withoutMetadata(bytes.concat(code, otherBlob, hex"012c")), keccak256(code), "whatever the blob says");
        assertTrue(
            h.withoutMetadata(bytes.concat(hex"6080604052600180fd", blob, hex"012c")) != keccak256(code),
            "code that differs before the blob is other code"
        );

        // No length to read, or one that claims more than there is: the whole input is hashed.
        assertEq(h.withoutMetadata(hex""), keccak256(hex""));
        assertEq(h.withoutMetadata(hex"60"), keccak256(hex"60"));
        bytes memory claimsTooMuch = bytes.concat(code, hex"ffff");
        assertEq(h.withoutMetadata(claimsTooMuch), keccak256(claimsTooMuch));
    }

    // -------------------------------------------------------------------------
    // What the Safe is told to execute
    // -------------------------------------------------------------------------

    /// The migration test above runs the phase that prints the call and then makes the call by hand,
    /// so it cannot tell a wrong printed call from a right one. The Safe signs what is printed, and
    /// signing the removal of the wrong role proves nothing about the Safe, so the bytes are pinned.
    function test_theCallPrintedForTheSafe_removesTheDeployersAdminRole() public {
        SplitAuthority_Harness h = new SplitAuthority_Harness();
        assertEq(
            h.revokeDeployerAdminCall(deployer),
            abi.encodeCall(IAccessControl.revokeRole, (ADMIN_ROLE, deployer)),
            "revokeRole(DEFAULT_ADMIN_ROLE, deployer)"
        );
        assertTrue(
            keccak256(h.revokeDeployerAdminCall(deployer))
                != keccak256(abi.encodeCall(IAccessControl.revokeRole, (UPGRADER_ROLE, deployer))),
            "and not the upgrader role"
        );
    }
}

interface IUUPSLike {
    function upgradeToAndCall(address newImplementation, bytes calldata data) external payable;
}
