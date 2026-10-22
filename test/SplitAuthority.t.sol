// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/access/IAccessControl.sol";
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

/// A contract from before UPGRADER_ROLE administered itself: getRoleAdmin answers zero.
contract LegacyRoles {
    function getRoleAdmin(bytes32) external pure returns (bytes32) { return bytes32(0); }
}

contract SplitAuthority_Harness is SplitAuthority {
    function adminIsSelf(address target) external view returns (bool) { return _upgraderAdminIsSelf(target); }
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

            // And the Safe is still admin of everything else: grants and revokes work.
            address probe = address(0xBEEF);
            safe.exec(targets[i], abi.encodeCall(IAccessControl.grantRole, (keccak256("SLASHING_COMMITTEE_ROLE"), probe)));
            assertTrue(IAccessControl(targets[i]).hasRole(keccak256("SLASHING_COMMITTEE_ROLE"), probe));
            safe.exec(targets[i], abi.encodeCall(IAccessControl.revokeRole, (keccak256("SLASHING_COMMITTEE_ROLE"), probe)));
        }

        // The two wiring setters are upgrade-class. The Safe holds admin and is refused, and the
        // timelock holds the upgrader role and gets through, after its delay.
        _wiringGoesThroughTheTimelock(safe, timelock);

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

    /// setStakeView decides who counts as bonded and setOperatorBond decides who may score, and
    /// passing zero to either turns its check off. Each changes the protocol about as much as an
    /// upgrade, so after the handover the Safe cannot make either call and the timelock can.
    function _wiringGoesThroughTheTimelock(MockSafe safe, TimelockController timelock) internal {
        address identity = targets[0];
        address reputation = targets[1];
        address newView = makeAddr("newStakeView");
        address newSet = makeAddr("newOperatorSet");

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

        vm.expectRevert();
        timelock.execute(identity, 0, viewCall, bytes32(0), salt);

        vm.warp(block.timestamp + 48 hours);
        timelock.execute(identity, 0, viewCall, bytes32(0), salt);
        timelock.execute(reputation, 0, bondCall, bytes32(0), salt);
        assertEq(address(SigvaraIdentity(identity).stakeView()), newView, "stake view moved through the timelock");
        assertEq(address(SigvaraReputation(reputation).operatorBond()), newSet, "operator bond moved through it too");
    }

    bytes32 constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    // -------------------------------------------------------------------------
    // The check that tells the two kinds of proxy apart
    // -------------------------------------------------------------------------

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
