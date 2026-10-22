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
/// from one, and answers the two reads the script makes of a Safe. test/SplitAuthorityFork.t.sol
/// is where a real Safe is driven by a real signature.
contract MockSafe {
    address[] internal owners_;
    uint256 internal threshold_;

    constructor(address[] memory owners, uint256 threshold) {
        owners_ = owners;
        threshold_ = threshold;
    }

    function getOwners() external view returns (address[] memory) { return owners_; }
    function getThreshold() external view returns (uint256) { return threshold_; }

    function exec(address to, bytes calldata data) external {
        (bool ok, bytes memory ret) = to.call(data);
        if (!ok) {
            assembly { revert(add(ret, 32), mload(ret)) }
        }
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

contract SplitAuthority_Harness is SplitAuthority {
    function adminIsSelf(address target) external view returns (bool) { return _upgraderAdminIsSelf(target); }
    function timelockedRoles(string memory name) external pure returns (bytes32[] memory) {
        return _timelockedRoles(name);
    }
    function firstOpenRole(string memory name, address target) external view returns (bool, bytes32) {
        return _firstRoleTheAdminCanGrant(name, target);
    }
    function revokeDeployerAdminCall(address d) external pure returns (bytes memory) { return _revokeDeployerAdminCall(d); }
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
    /// four names are used by this file alone.
    function _clearEnv() internal {
        vm.setEnv("PHASE", "");
        vm.setEnv("SAFE", "");
        vm.setEnv("TIMELOCK", "");
        vm.setEnv("CONFIRM", "");
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
        TimelockController timelock = new TimelockController(48 hours, proposers, executors, address(0));

        SplitAuthority s = new SplitAuthority();

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
        mTimelock = new TimelockController(48 hours, proposers, executors, address(0));
        mScript = new SplitAuthority();

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
