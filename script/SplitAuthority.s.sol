// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/**
 * @title SplitAuthority
 * @notice Moves DEFAULT_ADMIN_ROLE and UPGRADER_ROLE off the deployer EOA and onto a
 *         Safe and a timelock.
 *
 * The other roles are already split. As deployed on Arc testnet the oracle key holds
 * only `reputation:ORACLE`, and the committee key holds the two committee roles plus
 * `oracleBond:SLASHER`. What is still concentrated is admin and upgrader, both on the
 * deployer, on every contract. Admin can grant itself SLASHING_COMMITTEE_ROLE, so that
 * one key can cancel a slash filed against it, and upgrader can replace any
 * implementation outright. Splitting those two is the whole job.
 *
 * Afterwards:
 *   DEFAULT_ADMIN_ROLE  -> Safe                (role grants, parameter changes)
 *   UPGRADER_ROLE       -> TimelockController  (Safe proposes, delay runs, anyone executes)
 *   everything else     -> unchanged
 *
 * ## Why the timelock and not just the Safe
 *
 * A Safe with one signer separates nothing; it is the same key with extra steps. A
 * timelock is meant to add a different property: not "several people agreed" but "an
 * upgrade made through it cannot land without N hours of public notice". That holds
 * however many owners the Safe has.
 *
 * It binds the Safe too, on contracts deployed with UPGRADER_ROLE as its own admin, which
 * is how every registry now initializes: DEFAULT_ADMIN_ROLE cannot grant the role, so the
 * Safe cannot give itself upgrade rights and skip the delay. Before that, DEFAULT_ADMIN_ROLE
 * administered UPGRADER_ROLE because no contract named another admin for it, and the Safe
 * could grant itself the role in one transaction and upgrade in the next (checked on a
 * fork). Proxies deployed before the change, the Arc testnet ones among them, are still
 * like that. `plan` and `renounce` say which case each contract is, rather than leave it to
 * be assumed. What the Safe can still do with no delay is everything else DEFAULT_ADMIN_ROLE
 * administers: role grants, setStakeView, setOperatorBond and the other setters. So the
 * Safe's owners and threshold matter as much as the timelock does.
 *
 * ## Why this runs in phases
 *
 * Renouncing UPGRADER_ROLE is irreversible. Only a holder can grant it, and afterwards the
 * only holder is the timelock, which only the Safe can drive. If the Safe address is wrong,
 * or the Safe cannot execute on this chain, the proxies are left frozen at their current
 * implementations with nobody able to upgrade them, for good. So the EOA gives its
 * authority away before it drops any, and `renounce` reads the chain and refuses unless the
 * replacements are demonstrably already in place.
 *
 * The proof that the Safe works is not a separate ceremony. Phase 3 has the EOA grant admin
 * to the Safe and upgrader to the timelock, and phase 4 has *the Safe* remove the EOA's
 * DEFAULT_ADMIN_ROLE. That removal is a step the migration needs anyway, and it can only
 * succeed if the Safe can really execute against these contracts on this chain. If phase 4
 * does not land, phase 5 refuses, and the EOA still holds everything it had.
 *
 * ## Usage
 *
 *   # 1. Look before touching anything. Read-only, safe to run at any point.
 *   SAFE=0x... forge script script/SplitAuthority.s.sol --rpc-url arc_testnet -vv
 *
 *   # 2. Deploy the timelock. Prints its address; export it as TIMELOCK.
 *   PHASE=deploy-timelock SAFE=0x... \
 *     forge script script/SplitAuthority.s.sol --rpc-url arc_testnet --broadcast -vv
 *
 *   # 3. EOA grants admin to the Safe and upgrader to the timelock. Reversible: the EOA
 *   #    still holds both too. (`grant-admin` is the old name for this phase.)
 *   PHASE=grant SAFE=0x... TIMELOCK=0x... \
 *     forge script script/SplitAuthority.s.sol --rpc-url arc_testnet --broadcast -vv
 *
 *   # 4. Print the calls for the Safe to make. Paste them into the Safe transaction
 *   #    builder and execute there. This is the step that proves the Safe works.
 *   PHASE=safe-calldata SAFE=0x... \
 *     forge script script/SplitAuthority.s.sol --rpc-url arc_testnet -vv
 *
 *   # 5. Only now does the EOA drop anything. Refuses unless step 4 actually landed.
 *   PHASE=renounce SAFE=0x... TIMELOCK=0x... CONFIRM=yes-drop-the-deployer \
 *     forge script script/SplitAuthority.s.sol --rpc-url arc_testnet --broadcast -vv
 *
 * Env:
 *   SAFE                 Safe address. Required for every phase except a bare `plan`.
 *   TIMELOCK             TimelockController address, from phase 2. Needed for phases 3 and 5.
 *   TIMELOCK_MIN_DELAY   Seconds of notice before a scheduled upgrade can execute.
 *                        Default 48 hours.
 *   DEPLOYER_PRIVATE_KEY Broadcasting key for phases 2, 3 and 5. Must be the current
 *                        admin and upgrader. Phases 1 and 4 never broadcast and never read it.
 *   CONFIRM              Must be `yes-drop-the-deployer` for phase 5.
 *
 * Rehearse first: test/SplitAuthority.t.sol runs every phase offline against fresh registries
 * and a stand-in Safe. test/SplitAuthorityFork.t.sol runs the same steps against a fork of
 * the live deployment, with a real Safe deployed through Arc's own Safe factory, and checks
 * what the deployer can no longer do afterwards.
 */
contract SplitAuthority is Script {
    bytes32 internal constant ADMIN_ROLE = 0x00; // DEFAULT_ADMIN_ROLE
    bytes32 internal constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    uint256 internal constant DEFAULT_MIN_DELAY = 48 hours;

    /// Every contract in the artifact that gates anything on these two roles. A name
    /// absent from the artifact is skipped, so this picks up epochFees once it deploys
    /// rather than silently leaving the deployer as its admin.
    string[5] internal NAMES = ["identity", "reputation", "staking", "oracleBond", "epochFees"];

    struct Target {
        string name;
        address addr;
    }

    error UnknownPhase(string phase);
    error SafeNotSet();
    error TimelockNotSet();
    error SafeHasNoCode(address safe);
    error SafeIsTheDeployer(address safe);
    error NoTargets(uint256 chainId);
    error NotConfirmed();
    error SafeMissingAdmin(string target, address safe);
    error TimelockMissingUpgrader(string target, address timelock);
    error TimelockCannotBeProposedTo(address timelock, address safe);
    error TimelockHasNoDelay(address timelock);
    error DeployerCanActAlone(address safe);
    error DeployerStillAdmin(string target, address deployer);

    function run() external {
        string memory phase = vm.envOr("PHASE", string("plan"));
        bytes32 p = keccak256(bytes(phase));

        if (p == keccak256("plan")) return _plan();
        if (p == keccak256("deploy-timelock")) return _deployTimelock();
        if (p == keccak256("grant") || p == keccak256("grant-admin")) return _grant();
        if (p == keccak256("safe-calldata")) return _safeCalldata();
        if (p == keccak256("renounce")) return _renounce();
        revert UnknownPhase(phase);
    }

    // -------------------------------------------------------------------------
    // Phase 1: plan
    // -------------------------------------------------------------------------

    /// @dev Read-only. Prints who holds what right now, and whatever is not yet true.
    function _plan() internal view {
        Target[] memory targets = _targets();
        address safe = vm.envOr("SAFE", address(0));
        address timelock = vm.envOr("TIMELOCK", address(0));
        address deployer = _deployerAddress();

        console2.log("=== SplitAuthority: plan ===");
        console2.log("chain     ", block.chainid);
        console2.log("deployer  ", deployer);
        console2.log("safe      ", safe);
        console2.log("timelock  ", timelock);
        console2.log("");

        console2.log("-- current holders --");
        for (uint256 i = 0; i < targets.length; i++) {
            console2.log(targets[i].name, targets[i].addr);
            _printHolder("   admin    ", targets[i].addr, ADMIN_ROLE, deployer, safe, timelock);
            _printHolder("   upgrader ", targets[i].addr, UPGRADER_ROLE, deployer, safe, timelock);
            _printUpgraderAdmin(targets[i].addr);
        }
        console2.log("");

        if (safe == address(0)) {
            console2.log("SAFE not set. Create one at app.safe.global (Arc is supported) and re-run.");
            return;
        }
        _describeSafe(safe, deployer);

        if (timelock == address(0)) {
            console2.log("TIMELOCK not set: run PHASE=deploy-timelock next.");
        } else {
            console2.log("timelock min delay (s)", TimelockController(payable(timelock)).getMinDelay());
        }
    }

    /// @dev The owner count is the honest part of this report. A Safe with one owner
    ///      and a threshold of one is the deployer key wearing a hat, and a milestone
    ///      claiming a signer split on top of it would not survive being checked.
    function _describeSafe(address safe, address deployer) internal view {
        if (safe == deployer) {
            console2.log("WARNING: SAFE is the deployer. That is not a split.");
            return;
        }
        try ISafe(safe).getThreshold() returns (uint256 threshold) {
            address[] memory owners = ISafe(safe).getOwners();
            console2.log("safe threshold", threshold);
            console2.log("safe owners   ", owners.length);

            if (_isOwner(safe, deployer)) {
                console2.log("WARNING: the deployer is an owner of this Safe.");
                if (threshold <= 1) {
                    console2.log("         At threshold 1 it can still act alone, so renouncing");
                    console2.log("         moves the same key behind a contract and changes nothing.");
                }
            }
            if (threshold <= 1 || owners.length <= 1) {
                console2.log("NOTE: 1-of-1. The timelock still delays upgrades, but DEFAULT_ADMIN");
                console2.log("      grants roles with no delay at all, so a single compromised owner");
                console2.log("      can still put itself on the slashing committee. Only a threshold");
                console2.log("      above one closes that path.");
            }
        } catch {
            console2.log("NOTE: SAFE has code but is not a Safe (no getThreshold). Check the address.");
        }
    }

    // -------------------------------------------------------------------------
    // Phase 2: deploy the timelock
    // -------------------------------------------------------------------------

    /**
     * @dev proposers = [safe], executors = [address(0)], admin = address(0).
     *
     *      An open executor role means anyone can push a scheduled call through once
     *      its delay has run. The delay is what constrains the upgrade, not who fires
     *      it, and leaving execution open means a scheduled change cannot be quietly
     *      withheld by whoever holds the keys.
     *
     *      No separate admin means the timelock administers itself: changing its own
     *      roles or its delay has to be scheduled through it and wait like anything
     *      else. The Safe is a proposer, so it is not locked out, only delayed.
     *      Passing the Safe as admin instead would let it rewrite the proposer set
     *      instantly, which gives away most of the guarantee for convenience.
     */
    function _deployTimelock() internal {
        address safe = _requireSafe();
        uint256 minDelay = vm.envOr("TIMELOCK_MIN_DELAY", DEFAULT_MIN_DELAY);

        address[] memory proposers = new address[](1);
        proposers[0] = safe;
        address[] memory executors = new address[](1);
        executors[0] = address(0); // open: anyone may execute once the delay has run

        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        TimelockController timelock = new TimelockController(minDelay, proposers, executors, address(0));
        vm.stopBroadcast();

        console2.log("=== timelock deployed ===");
        console2.log("address      ", address(timelock));
        console2.log("min delay (s)", minDelay);
        console2.log("proposer     ", safe);
        console2.log("executors     open");
        console2.log("");
        // One string, so the line pastes into a shell. Two arguments print a space after the =.
        console2.log(string.concat("export TIMELOCK=", vm.toString(address(timelock))));
    }

    // -------------------------------------------------------------------------
    // Phase 3: the EOA grants admin to the Safe and upgrader to the timelock
    // -------------------------------------------------------------------------

    /// @dev Additive only. The EOA keeps everything it had, so a wrong Safe or timelock
    ///      address at this point costs a transaction and nothing else.
    ///
    ///      The EOA grants upgrader because it is the only party that can. Once UPGRADER_ROLE
    ///      administers itself, the Safe holding DEFAULT_ADMIN_ROLE cannot hand it out, and
    ///      the migration used to rely on exactly that to have the Safe prove itself.
    function _grant() internal {
        address safe = _requireSafe();
        address timelock = _requireTimelock();
        Target[] memory targets = _targets();

        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        for (uint256 i = 0; i < targets.length; i++) {
            IAccessControl c = IAccessControl(targets[i].addr);
            if (!c.hasRole(ADMIN_ROLE, safe)) {
                c.grantRole(ADMIN_ROLE, safe);
                console2.log("granted admin to the Safe on", targets[i].name);
            } else {
                console2.log("Safe already admin on", targets[i].name);
            }
            if (!c.hasRole(UPGRADER_ROLE, timelock)) {
                c.grantRole(UPGRADER_ROLE, timelock);
                console2.log("granted upgrader to the timelock on", targets[i].name);
            } else {
                console2.log("timelock already upgrader on", targets[i].name);
            }
        }
        vm.stopBroadcast();

        console2.log("");
        console2.log("The deployer still holds admin and upgrader. Nothing is lost yet.");
        console2.log("Next: PHASE=safe-calldata, and execute those from the Safe.");
    }

    // -------------------------------------------------------------------------
    // Phase 4: the calls the Safe has to make
    // -------------------------------------------------------------------------

    /**
     * @dev Read-only, and deliberately so. These calls have to originate from the Safe
     *      to be worth anything: they are at once the migration step and the evidence
     *      that the Safe can execute against these contracts on this chain. Running
     *      them from the EOA would leave identical on-chain state and prove nothing,
     *      which is exactly the mistake that bricks the proxies one phase later.
     *
     *      The call is the removal of the EOA's DEFAULT_ADMIN_ROLE. It needs the Safe to
     *      hold admin already, so it cannot land before phase 3, and nothing but a Safe
     *      that can really execute here makes it land.
     */
    function _safeCalldata() internal view {
        address safe = _requireSafe();
        address deployer = _deployerAddress();
        Target[] memory targets = _targets();

        console2.log("=== execute these FROM THE SAFE ===");
        console2.log("safe", safe);
        console2.log("Transaction Builder, one transaction per entry, value 0.");
        console2.log("");

        uint256 pending;
        for (uint256 i = 0; i < targets.length; i++) {
            IAccessControl c = IAccessControl(targets[i].addr);
            if (!c.hasRole(ADMIN_ROLE, deployer)) {
                console2.log("done:", targets[i].name);
                continue;
            }
            pending++;
            if (!c.hasRole(ADMIN_ROLE, safe)) {
                console2.log("WARNING: the Safe is not admin on", targets[i].name, "yet. Run PHASE=grant first.");
            }
            console2.log(targets[i].name);
            console2.log("   to  ", targets[i].addr);
            console2.logBytes(_revokeDeployerAdminCall(deployer));
        }

        console2.log("");
        if (pending == 0) {
            console2.log("All removals landed. PHASE=renounce is now unblocked.");
        } else {
            console2.log("pending", pending);
            console2.log("If the Safe cannot execute these, STOP. Do not renounce.");
        }
    }

    // -------------------------------------------------------------------------
    // Phase 5: the deployer drops its authority
    // -------------------------------------------------------------------------

    /**
     * @dev The only irreversible phase. The deployer gives up UPGRADER_ROLE, which only a
     *      holder can grant, so afterwards the timelock is the sole upgrader and only the
     *      Safe can drive the timelock. Every check below stands for a way to end up with
     *      proxies nobody can upgrade:
     *
     *        - a Safe address with no code on this chain (a typo, or a Safe that only
     *          exists at that address on some other chain)
     *        - a Safe that is the deployer, which renounces nothing
     *        - a contract that never received the admin grant, because phase 3 ran
     *          before it was deployed or its name was missing from the artifact
     *        - a timelock that never received upgrader
     *        - a deployer that still holds DEFAULT_ADMIN_ROLE, which is the evidence that
     *          the Safe has not in fact executed phase 4
     *        - a timelock with no proposer or no delay, which can never be used
     *
     *      All of them are checked against the chain, not against what the earlier
     *      phases in this file intended to do.
     */
    function _renounce() internal {
        if (keccak256(bytes(vm.envOr("CONFIRM", string("")))) != keccak256("yes-drop-the-deployer")) {
            revert NotConfirmed();
        }

        address safe = _requireSafe();
        address timelock = _requireTimelock();
        address deployer = _deployerAddress();
        if (safe == deployer) revert SafeIsTheDeployer(safe);

        // `safe != deployer` is not enough on its own. A Safe whose only owner is the
        // deployer, at a threshold of one, passes every other check here while leaving
        // exactly the same key in charge of exactly the same powers. Renouncing to it
        // would cost a transaction and buy nothing, and the on-chain result would look
        // like a completed migration.
        if (_isOwner(safe, deployer) && _thresholdOf(safe) <= 1) revert DeployerCanActAlone(safe);

        TimelockController tl = TimelockController(payable(timelock));
        if (tl.getMinDelay() == 0) revert TimelockHasNoDelay(timelock);
        if (!tl.hasRole(tl.PROPOSER_ROLE(), safe)) revert TimelockCannotBeProposedTo(timelock, safe);

        Target[] memory targets = _targets();
        for (uint256 i = 0; i < targets.length; i++) {
            IAccessControl c = IAccessControl(targets[i].addr);
            if (!c.hasRole(ADMIN_ROLE, safe)) revert SafeMissingAdmin(targets[i].name, safe);
            if (!c.hasRole(UPGRADER_ROLE, timelock)) revert TimelockMissingUpgrader(targets[i].name, timelock);
            // The Safe removed it, or it is still there. Dropping it from here would reach
            // the same state and prove nothing about the Safe.
            if (c.hasRole(ADMIN_ROLE, deployer)) revert DeployerStillAdmin(targets[i].name, deployer);
        }

        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        for (uint256 i = 0; i < targets.length; i++) {
            IAccessControl c = IAccessControl(targets[i].addr);
            if (c.hasRole(UPGRADER_ROLE, deployer)) c.renounceRole(UPGRADER_ROLE, deployer);
            console2.log("deployer dropped upgrader on", targets[i].name);
        }
        vm.stopBroadcast();

        console2.log("");
        console2.log("=== done ===");
        console2.log("admin    ", safe);
        console2.log("upgrader ", timelock);
        for (uint256 i = 0; i < targets.length; i++) {
            if (!_upgraderAdminIsSelf(targets[i].addr)) {
                console2.log("WARNING: the Safe can still give itself upgrade rights on", targets[i].name);
                console2.log("   (UPGRADER_ROLE is administered by DEFAULT_ADMIN_ROLE there)");
            }
        }
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    function _targets() internal view returns (Target[] memory) {
        string memory json = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));

        Target[] memory buf = new Target[](NAMES.length);
        uint256 n;
        for (uint256 i = 0; i < NAMES.length; i++) {
            string memory key = string.concat(".", NAMES[i]);
            if (!vm.keyExistsJson(json, key)) continue;
            address addr = vm.parseJsonAddress(json, key);
            if (addr == address(0) || addr.code.length == 0) continue;
            buf[n++] = Target(NAMES[i], addr);
        }
        if (n == 0) revert NoTargets(block.chainid);

        Target[] memory out = new Target[](n);
        for (uint256 i = 0; i < n; i++) out[i] = buf[i];
        return out;
    }

    /// @dev From the artifact, so `plan` and `safe-calldata` never touch a private key.
    function _deployerAddress() internal view returns (address) {
        string memory json = vm.readFile(string.concat("deployments/", vm.toString(block.chainid), ".json"));
        return vm.parseJsonAddress(json, ".deployer");
    }

    function _requireSafe() internal view returns (address safe) {
        safe = vm.envOr("SAFE", address(0));
        if (safe == address(0)) revert SafeNotSet();
        if (safe.code.length == 0) revert SafeHasNoCode(safe);
    }

    function _requireTimelock() internal view returns (address timelock) {
        timelock = vm.envOr("TIMELOCK", address(0));
        if (timelock == address(0)) revert TimelockNotSet();
    }

    /// @dev The call the Safe pastes into the transaction builder for each contract. A function
    ///      of its own so that a test can read what the Safe will execute, instead of trusting a
    ///      log line: the wrong role here would have the Safe sign something that proves nothing.
    function _revokeDeployerAdminCall(address deployer) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IAccessControl.revokeRole.selector, ADMIN_ROLE, deployer);
    }

    /// @dev Both of these tolerate a SAFE that is some other kind of contract: another
    ///      multisig is a legitimate target, and a check that cannot be performed must
    ///      not be reported as a check that passed.
    function _isOwner(address safe, address account) internal view returns (bool) {
        try ISafe(safe).getOwners() returns (address[] memory owners) {
            for (uint256 i = 0; i < owners.length; i++) {
                if (owners[i] == account) return true;
            }
            return false;
        } catch {
            return false;
        }
    }

    function _thresholdOf(address safe) internal view returns (uint256) {
        try ISafe(safe).getThreshold() returns (uint256 threshold) {
            return threshold;
        } catch {
            return type(uint256).max; // unknown: do not trip the single-owner guard
        }
    }

    /// @dev Whether DEFAULT_ADMIN_ROLE could grant UPGRADER_ROLE on this contract. Read from
    ///      the contract, because it differs between a proxy initialized with UPGRADER_ROLE as
    ///      its own admin and one deployed before that was done.
    function _upgraderAdminIsSelf(address target) internal view returns (bool) {
        // A low-level call, not try/catch: a try cannot catch the revert a high-level call makes
        // when the target has no code, and an address that answers with nothing would then end
        // the whole plan instead of being reported as not self-administered.
        (bool ok, bytes memory ret) = target.staticcall(
            abi.encodeWithSelector(IAccessControl.getRoleAdmin.selector, UPGRADER_ROLE)
        );
        return ok && ret.length == 32 && abi.decode(ret, (bytes32)) == UPGRADER_ROLE;
    }

    function _printUpgraderAdmin(address target) internal view {
        if (_upgraderAdminIsSelf(target)) {
            console2.log("   upgrader role: administered by itself, so the Safe cannot grant it");
        } else {
            console2.log("   WARNING upgrader role: administered by DEFAULT_ADMIN_ROLE, so the Safe can skip the timelock");
        }
    }

    function _printHolder(
        string memory label,
        address target,
        bytes32 role,
        address deployer,
        address safe,
        address timelock
    ) internal view {
        IAccessControl c = IAccessControl(target);
        string memory who = "";
        if (c.hasRole(role, deployer)) who = string.concat(who, "deployer ");
        if (safe != address(0) && c.hasRole(role, safe)) who = string.concat(who, "safe ");
        if (timelock != address(0) && c.hasRole(role, timelock)) who = string.concat(who, "timelock ");
        console2.log(label, bytes(who).length == 0 ? "(none of the three)" : who);
    }
}

interface IAccessControl {
    function hasRole(bytes32 role, address account) external view returns (bool);
    function getRoleAdmin(bytes32 role) external view returns (bytes32);
    function grantRole(bytes32 role, address account) external;
    function revokeRole(bytes32 role, address account) external;
    function renounceRole(bytes32 role, address callerConfirmation) external;
}

interface ISafe {
    function getThreshold() external view returns (uint256);
    function getOwners() external view returns (address[] memory);
}
