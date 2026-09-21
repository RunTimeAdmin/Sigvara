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
 * timelock is worth something even at one signer, because the property it provides is
 * not "several people agreed", it is "the code cannot change without N hours of public
 * notice". That holds however many owners the Safe has. If a second signer is added
 * later the Safe starts providing its own guarantee on top, and nothing here changes.
 *
 * ## Why this runs in phases
 *
 * Renouncing DEFAULT_ADMIN_ROLE is irreversible and unrecoverable. If the Safe address
 * is wrong, or the Safe cannot execute on this chain, the proxies are left frozen at
 * their current implementations with nobody able to upgrade them or grant a role, for
 * good. So the EOA gives its authority away before it drops any, and `renounce` reads
 * the chain and refuses unless the replacements are demonstrably already in place.
 *
 * The proof that the Safe works is not a separate ceremony. Phase 3 has the EOA grant
 * admin to the Safe, and phase 4 has *the Safe* grant upgrader to the timelock. That
 * grant is a step the migration needs anyway, and it can only succeed if the Safe can
 * really execute against these contracts on this chain. If phase 4 does not land,
 * phase 5 refuses, and the EOA still holds everything.
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
 *   # 3. EOA hands admin to the Safe. Reversible: the EOA still holds admin too.
 *   PHASE=grant-admin SAFE=0x... \
 *     forge script script/SplitAuthority.s.sol --rpc-url arc_testnet --broadcast -vv
 *
 *   # 4. Print the calls for the Safe to make. Paste them into the Safe transaction
 *   #    builder and execute there. This is the step that proves the Safe works.
 *   PHASE=safe-calldata SAFE=0x... TIMELOCK=0x... \
 *     forge script script/SplitAuthority.s.sol --rpc-url arc_testnet -vv
 *
 *   # 5. Only now does the EOA drop anything. Refuses unless step 4 actually landed.
 *   PHASE=renounce SAFE=0x... TIMELOCK=0x... CONFIRM=yes-drop-the-deployer \
 *     forge script script/SplitAuthority.s.sol --rpc-url arc_testnet --broadcast -vv
 *
 * Env:
 *   SAFE                 Safe address. Required for every phase except a bare `plan`.
 *   TIMELOCK             TimelockController address, from phase 2.
 *   TIMELOCK_MIN_DELAY   Seconds of notice before a scheduled upgrade can execute.
 *                        Default 48 hours.
 *   DEPLOYER_PRIVATE_KEY Broadcasting key for phases 2, 3 and 5. Must be the current
 *                        admin. Phases 1 and 4 never broadcast and never read it.
 *   CONFIRM              Must be `yes-drop-the-deployer` for phase 5.
 *
 * Rehearse first: test/SplitAuthorityFork.t.sol runs this migration against a fork of
 * the live deployment, with a real Safe deployed through Arc's own Safe factory, and
 * checks what the deployer can no longer do afterwards.
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

    function run() external {
        string memory phase = vm.envOr("PHASE", string("plan"));
        bytes32 p = keccak256(bytes(phase));

        if (p == keccak256("plan")) return _plan();
        if (p == keccak256("deploy-timelock")) return _deployTimelock();
        if (p == keccak256("grant-admin")) return _grantAdmin();
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
        console2.log("export TIMELOCK=", address(timelock));
    }

    // -------------------------------------------------------------------------
    // Phase 3: the EOA grants admin to the Safe
    // -------------------------------------------------------------------------

    /// @dev Additive only. The EOA keeps everything it had, so a wrong Safe address at
    ///      this point costs a transaction and nothing else.
    function _grantAdmin() internal {
        address safe = _requireSafe();
        Target[] memory targets = _targets();

        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        for (uint256 i = 0; i < targets.length; i++) {
            if (!IAccessControl(targets[i].addr).hasRole(ADMIN_ROLE, safe)) {
                IAccessControl(targets[i].addr).grantRole(ADMIN_ROLE, safe);
                console2.log("granted admin on", targets[i].name);
            } else {
                console2.log("already admin on", targets[i].name);
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
     */
    function _safeCalldata() internal view {
        address safe = _requireSafe();
        address timelock = _requireTimelock();
        Target[] memory targets = _targets();

        console2.log("=== execute these FROM THE SAFE ===");
        console2.log("safe", safe);
        console2.log("Transaction Builder, one transaction per entry, value 0.");
        console2.log("");

        uint256 pending;
        for (uint256 i = 0; i < targets.length; i++) {
            if (IAccessControl(targets[i].addr).hasRole(UPGRADER_ROLE, timelock)) {
                console2.log("done:", targets[i].name);
                continue;
            }
            pending++;
            console2.log(targets[i].name);
            console2.log("   to  ", targets[i].addr);
            console2.logBytes(abi.encodeWithSelector(IAccessControl.grantRole.selector, UPGRADER_ROLE, timelock));
        }

        console2.log("");
        if (pending == 0) {
            console2.log("All grants landed. PHASE=renounce is now unblocked.");
        } else {
            console2.log("pending", pending);
            console2.log("If the Safe cannot execute these, STOP. Do not renounce.");
        }
    }

    // -------------------------------------------------------------------------
    // Phase 5: the deployer drops its authority
    // -------------------------------------------------------------------------

    /**
     * @dev The only irreversible phase. Every check below stands for a way to end up
     *      with proxies nobody can administer:
     *
     *        - a Safe address with no code on this chain (a typo, or a Safe that only
     *          exists at that address on some other chain)
     *        - a Safe that is the deployer, which renounces nothing
     *        - a contract that never received the admin grant, because phase 3 ran
     *          before it was deployed or its name was missing from the artifact
     *        - a timelock that never received upgrader, because the Safe could not in
     *          fact execute
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
        }

        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        for (uint256 i = 0; i < targets.length; i++) {
            IAccessControl c = IAccessControl(targets[i].addr);
            // Upgrader first. If the run dies between the two calls the deployer is
            // left holding admin, which can grant upgrader back. The other order
            // leaves it holding upgrader with no way to restore admin.
            if (c.hasRole(UPGRADER_ROLE, deployer)) c.renounceRole(UPGRADER_ROLE, deployer);
            if (c.hasRole(ADMIN_ROLE, deployer)) c.renounceRole(ADMIN_ROLE, deployer);
            console2.log("deployer dropped on", targets[i].name);
        }
        vm.stopBroadcast();

        console2.log("");
        console2.log("=== done ===");
        console2.log("admin    ", safe);
        console2.log("upgrader ", timelock);
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
    function grantRole(bytes32 role, address account) external;
    function renounceRole(bytes32 role, address callerConfirmation) external;
}

interface ISafe {
    function getThreshold() external view returns (uint256);
    function getOwners() external view returns (address[] memory);
}
