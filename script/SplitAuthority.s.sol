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
 * deployer, on every contract. On a proxy deployed before the review fixes, admin can
 * grant itself SLASHING_COMMITTEE_ROLE, so that one key can cancel a slash filed against
 * it, and upgrader can replace any implementation outright. Splitting those two is the
 * whole job.
 *
 * Afterwards:
 *   DEFAULT_ADMIN_ROLE  -> Safe                (oracle and guardian grants, any revocation,
 *                                               parameter changes, the veto and dispute rulings)
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
 * like that. `plan` says which case each contract is, and `renounce` refuses unless every one
 * is the first, since renouncing cannot be undone. The same holds for the roles that take funds or change an agent's standing
 * (SLASHER, SLASHING_COMMITTEE, STAKING_CORE), the slash beneficiary, setStakeView and
 * setOperatorBond: on a registry initialized by the current code they need the timelock, and
 * the Safe can only revoke. What the Safe can still do with no delay is what DEFAULT_ADMIN_ROLE
 * administers: granting the oracle and guardian roles, revoking any role, the parameter
 * setters, and ruling on or vetoing a slash. So the Safe's owners and threshold matter as much
 * as the timelock does.
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
 * Phase 5 holds the timelock and the Safe to what docs/adr/0005 promises as well, because the timelock it
 * leaves in charge of every upgrade is only worth what it was built with. It refuses a delay under 48 hours,
 * a timelock the Safe cannot propose to or cancel on, one that not everyone can execute on, one whose roles
 * the Safe or the deployer can rewrite at once, and a Safe with a threshold under two. A bad value for any
 * of these is cheap to fix before the renounce and expensive after it. Those are answers the contracts give
 * about themselves, so phases 3 and 5 also refuse a timelock whose code is not the TimelockController phase 2
 * deploys, or that the deployer did not create, and a Safe that is an account which has delegated to a
 * contract (EIP-7702). The Safe's owners and threshold are its own answers too, so phase 5 believes them only
 * from a Safe proxy running code Safe published (1.3.0, 1.4.1 or 1.5.0, by code hash) whose storage Safe's own
 * factory made, from a setup that delegated to nothing but Safe's L2 switch: Safe's code decides who may act from
 * storage, and its getters list only what is linked into their lists. It refuses a Safe with a module enabled,
 * since a module acts as the Safe without its owners, and one with a guard, which can refuse every transaction
 * the Safe makes, the ones that schedule upgrades included. Any other multisig is refused unless the operator
 * names it as one they checked some other way.
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
 *   # 4b. Before dropping anything, read the grant history. This script checks the contracts it is
 *   #     shown, and only the history shows a holder nobody expected. The upgrader role answers only to
 *   #     the timelock once the deployer is gone, so an extra holder is cheap to remove now and slow
 *   #     to remove later. Go on only if it passes; run it again without BEFORE_RENOUNCE afterwards.
 *   BEFORE_RENOUNCE=1 SAFE=0x... TIMELOCK=0x... COMMITTEE=0x... ORACLE=0x... GUARDIAN=0x... \
 *     node scripts/check-role-holders.mjs
 *
 *   # 5. Only now does the EOA drop anything. Refuses unless step 4 actually landed. SAFE_FACTORY and
 *   #    SAFE_CREATION_CALL come from the transaction that created the Safe: its factory and its input.
 *   PHASE=renounce SAFE=0x... TIMELOCK=0x... SAFE_FACTORY=0x... SAFE_CREATION_CALL=0x... \
 *     CONFIRM=yes-drop-the-deployer \
 *     forge script script/SplitAuthority.s.sol --rpc-url arc_testnet --broadcast -vv
 *
 * Env:
 *   SAFE                 Safe address. Required for every phase except a bare `plan`.
 *   TIMELOCK             TimelockController address, from phase 2. Needed for phases 3 and 5, which both refuse
 *                        an address that phase 2 did not create from the deployer account.
 *   TIMELOCK_MIN_DELAY   Seconds of notice before a scheduled upgrade can execute.
 *                        Default 48 hours, which is also the least phase 5 accepts.
 *   DEPLOYER_PRIVATE_KEY Broadcasting key for phases 2, 3 and 5. Must be the current
 *                        admin and upgrader. Phases 1 and 4 never broadcast and never read it.
 *   CONFIRM              Must be `yes-drop-the-deployer` for phase 5.
 *   SAFE_FACTORY         The Safe proxy factory that created SAFE: the `to` of the creation transaction.
 *   SAFE_CREATION_CALL   That transaction's input, a createProxyWithNonce or createChainSpecificProxyWithNonce call.
 *                        Phase 5 works out the address it creates and refuses a SAFE that is not that address.
 *   CONFIRM_UNINSPECTABLE_SAFE
 *                        SAFE's own address lets phase 5 go ahead when SAFE is not a Safe proxy running code Safe
 *                        published (another multisig, or a Safe version this file does not list). Set it only once
 *                        you have checked its code, owners, threshold, modules and history some other way. Unset,
 *                        or naming another address, such a SAFE is refused.
 *
 * Rehearse first: test/SplitAuthority.t.sol runs every phase offline against fresh registries
 * and a stand-in Safe. test/SplitAuthorityFork.t.sol runs the same steps against a fork of
 * the live deployment, with a real Safe deployed through Arc's own Safe factory, and checks
 * what the deployer can no longer do afterwards.
 */
contract SplitAuthority is Script {
    bytes32 internal constant ADMIN_ROLE = 0x00; // DEFAULT_ADMIN_ROLE
    bytes32 internal constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 internal constant STAKING_CORE_ROLE = keccak256("STAKING_CORE_ROLE");
    bytes32 internal constant SLASHING_COMMITTEE_ROLE = keccak256("SLASHING_COMMITTEE_ROLE");
    bytes32 internal constant SLASHER_ROLE = keccak256("SLASHER_ROLE");

    /// The delay phase 2 deploys with unless told otherwise, and the least phase 5 accepts: docs/adr/0005
    /// promises 48 hours of notice, and scripts/check-mainnet.sh compares the live timelock with it.
    uint256 internal constant DEFAULT_MIN_DELAY = 48 hours;
    /// The Safe threshold below which one owner key acts alone. A Safe can change its own threshold later, so
    /// this is the launch policy (docs/launch-checklist.md) and not a point of no return.
    uint256 internal constant MIN_SAFE_THRESHOLD = 2;

    /// What a Safe is, as code. A Safe address holds a short proxy that runs, for every call, the implementation
    /// whose address it keeps in storage slot 0, so `getOwners` and `getThreshold` are whatever that code says.
    /// The proxy hashes are the runtime each version's SafeProxyFactory deploys. The implementation hashes are
    /// the ones safe-global/safe-deployments publishes (its L2 variants included), and all of them were checked
    /// against the code at Safe's own addresses on Arc testnet. Hashes and not addresses, so the check does not
    /// depend on which chain the Safe is on.
    bytes32 internal constant SAFE_PROXY_1_3_0 = 0xb89c1b3bdf2cf8827818646bce9a8f6e372885f8c55e5c07acbd307cb133b000;
    bytes32 internal constant SAFE_PROXY_1_4_1 = 0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c;
    bytes32 internal constant SAFE_PROXY_1_5_0 = 0x4e381985ca68b3e5d27b4425fa581c19cf33146d3f887a3cfca96f55528ea46f;
    bytes32 internal constant SAFE_1_3_0 = 0xbba688fbdb21ad2bb58bc320638b43d94e7d100f6f3ebaab0a4e4de6304b1c2e;
    bytes32 internal constant SAFE_L2_1_3_0 = 0x21842597390c4c6e3c1239e434a682b054bd9548eee5e9b1d6a4482731023c0f;
    bytes32 internal constant SAFE_1_4_1 = 0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4;
    bytes32 internal constant SAFE_L2_1_4_1 = 0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff;
    bytes32 internal constant SAFE_1_5_0 = 0xdda019cbd7c867a533a2a86e5c53434fdc50b13122b5a5ddb4a8df61b31c20f2;
    bytes32 internal constant SAFE_L2_1_5_0 = 0x180193227186ccb85316c94db1f0d156ed932b14712cfaac78901899178572dc;
    /// The runtime of each version's SafeProxyFactory, and of the SafeToL2Setup a Safe made for an L2 delegates to
    /// in its setup, from safe-deployments as well and checked on Arc testnet.
    bytes32 internal constant SAFE_FACTORY_1_3_0 = 0x337d7f54be11b6ed55fef7b667ea5488db53db8320a05d1146aa4bd169a39a9b;
    bytes32 internal constant SAFE_FACTORY_1_4_1 = 0x50c3cdc4074750a7a974204a716c999edd37482f907608d960b2b025ee0b3317;
    bytes32 internal constant SAFE_FACTORY_1_5_0 = 0x967dae4cda22b0c9ef7f31b010bdc1ceb0af9904b0c3dc060b5302e4c18a4529;
    bytes32 internal constant SAFE_TO_L2_SETUP_1_4_1 = 0x2f25df28caf984366ee584e13241707e85dcd5a6ea0c14267928dafc1fd6274b;
    bytes32 internal constant SAFE_TO_L2_SETUP_1_5_0 = 0xf6034d841bcbff8912aa55526b0f1609212536aaf60bb16f5e8a269a4ab38f18;
    /// Where a Safe keeps its guard and its fallback handler, which the plan prints.
    bytes32 internal constant SAFE_GUARD_SLOT = keccak256("guard_manager.guard.address");
    bytes32 internal constant SAFE_FALLBACK_HANDLER_SLOT = keccak256("fallback_manager.handler.address");
    /// The head of a Safe's module list (SENTINEL_MODULES).
    address internal constant SAFE_MODULES_HEAD = address(0x1);

    /// Every contract in the artifact that gates anything on these two roles. The first four are the
    /// launch registries and are required in every phase: one that is missing from the artifact, holds
    /// the zero address or has no code stops the script. Skipped, that proxy would keep the deployer's
    /// admin and upgrade rights through every phase, and the last would still print "done". epochFees
    /// is optional because the mainnet launch leaves it out (docs/adr/0005); it is picked up if the
    /// artifact has it, rather than silently leaving the deployer as its admin.
    string[5] internal NAMES = ["identity", "reputation", "staking", "oracleBond", "epochFees"];
    uint256 internal constant REQUIRED_TARGETS = 4;

    struct Target {
        string name;
        address addr;
    }

    error UnknownPhase(string phase);
    error SafeNotSet();
    error TimelockNotSet();
    error SafeHasNoCode(address safe);
    error SafeIsTheDeployer(address safe);
    error MissingTarget(string name);
    error NotConfirmed();
    error SafeMissingAdmin(string target, address safe);
    error TimelockMissingUpgrader(string target, address timelock);
    error TimelockHasNoCode(address timelock);
    error TimelockCodeNotRecognized(address timelock, bytes32 found, bytes32 expected);
    error TimelockNotCreatedByDeployer(address timelock, address deployer);
    error TimelockCannotBeProposedTo(address timelock, address safe);
    error TimelockCannotBeCancelledBy(address timelock, address safe);
    error TimelockDelayTooShort(address timelock, uint256 delay, uint256 minimum);
    error TimelockExecutionNotOpen(address timelock);
    error TimelockHasOutsideAdmin(address timelock, address admin);
    error DeployerCanActAlone(address safe);
    error SafeThresholdTooLow(address safe, uint256 threshold, uint256 minimum);
    error SafeNotRecognized(address safe, bytes32 proxyCodeHash, address implementation);
    error SafeHasModules(address safe, address module);
    error SafeModulesUnreadable(address safe);
    error SafeHasGuard(address safe, address guard);
    error DeployerIsAModule(address safe);
    error SafeCreationNotShown(address safe);
    error SafeFactoryNotRecognized(address factory, bytes32 codeHash);
    error SafeNotCreatedAsShown(address safe, address created);
    error SafeSetupDelegatedTo(address safe, address to);
    error SafeIsADelegatedAccount(address safe);
    error DeployerStillAdmin(string target, address deployer);
    error UpgraderRoleNotSelfAdministered(string target);
    error RoleNotTimelocked(string target, bytes32 role);

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
            _printUpgraderAdmin(targets[i].name, targets[i].addr);
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
        (string memory proxy, string memory implementation) = _safeVersion(safe);
        if (bytes(proxy).length == 0 || bytes(implementation).length == 0) {
            console2.log("NOTE: SAFE is not a Safe proxy running code Safe published, so its owners and threshold are");
            console2.log("      its own word. PHASE=renounce refuses it unless CONFIRM_UNINSPECTABLE_SAFE is set to its address.");
        } else {
            console2.log("safe proxy    ", proxy);
            console2.log("safe code     ", implementation);
            (bool answered, address[] memory modules) = _modulesOf(safe);
            if (!answered) console2.log("WARNING: SAFE did not list its modules. PHASE=renounce refuses it.");
            for (uint256 i = 0; i < modules.length; i++) {
                console2.log("WARNING: module enabled, which can act as the Safe without its owners:", modules[i]);
            }
            if (modules.length > 0) console2.log("         PHASE=renounce refuses this Safe until the owners disable it.");
            address guard = address(uint160(uint256(vm.load(safe, SAFE_GUARD_SLOT))));
            if (guard != address(0)) {
                console2.log("WARNING: a guard, which can refuse any Safe transaction. PHASE=renounce refuses it:", guard);
            }
            console2.log("safe fallback ", address(uint160(uint256(vm.load(safe, SAFE_FALLBACK_HANDLER_SLOT)))));
            console2.log("PHASE=renounce also needs SAFE_FACTORY and SAFE_CREATION_CALL from the Safe's creation transaction.");
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
                console2.log("NOTE: 1-of-1. The timelock still delays upgrades, but DEFAULT_ADMIN acts with");
                console2.log("      no delay at all (the oracle and guardian grants, any revocation, the");
                console2.log("      parameters, the veto), and on a proxy deployed before the review fixes it");
                console2.log("      can also put itself on the slashing committee. A single compromised owner");
                console2.log("      can do all of it. Only a threshold above one closes that path.");
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
        if (minDelay < DEFAULT_MIN_DELAY) {
            console2.log("WARNING: under 48 hours. PHASE=renounce refuses this timelock. A delay meant as hours or");
            console2.log("         days and typed as seconds is the usual way to land here.");
        }
        console2.log("");
        // One string, so the line pastes into a shell. Two arguments print a space after the =.
        console2.log(string.concat("export TIMELOCK=", vm.toString(address(timelock))));
    }

    // -------------------------------------------------------------------------
    // Phase 3: the EOA grants admin to the Safe and upgrader to the timelock
    // -------------------------------------------------------------------------

    /// @dev Additive only. The EOA keeps everything it had, so a wrong Safe or timelock
    ///      address at this point costs a transaction and nothing else. The timelock is still looked at
    ///      first (see `_requireTimelockPhase2Made`), because this is the phase that gives it the right
    ///      to upgrade every registry.
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
     *          before it was deployed (a name missing from the artifact never gets this far:
     *          the four launch registries are required, and `_targets` stops at one that is not there)
     *        - a timelock that never received upgrader
     *        - a deployer that still holds DEFAULT_ADMIN_ROLE, which is the evidence that
     *          the Safe has not in fact executed phase 4
     *        - a timelock the Safe cannot propose to, which can never be used, or cannot cancel on,
     *          which leaves a call it has changed its mind about to run
     *        - a timelock that not everyone can execute on. With nobody able to execute, a scheduled
     *          call never runs, and repairing the roles is itself a scheduled call
     *        - a delay under 48 hours, which gives less notice than anyone was told to expect (a
     *          delay typed as 48 where seconds were meant is the likely way to get one)
     *        - a timelock whose roles the Safe or the deployer can still rewrite at once, which is
     *          not the timelock administering itself. They cannot shorten the delay (only the
     *          timelock can), but they can change who proposes, cancels and executes
     *        - a Safe with a threshold under two, which leaves one owner key acting alone on
     *          everything DEFAULT_ADMIN_ROLE administers, with no delay
     *        - a Safe that is not Safe's code, or that Safe's factory did not create from a plain setup: its
     *          owners and threshold would be only what it says, and storage written around its lists can act
     *          without showing. Another multisig can be a legitimate target, so the operator may name it as one
     *          they checked some other way (CONFIRM_UNINSPECTABLE_SAFE); nothing here has
     *        - a Safe with a module enabled, the deployer as a module, or a guard: a module acts as the Safe
     *          without the owners, and a guard can refuse whatever the Safe does
     *        - a timelock whose code is not the TimelockController phase 2 deploys. Its delay and its roles are
     *          only what it says they are, and a contract can say the right things while letting its owner
     *          upgrade at once
     *        - a timelock the deployer did not create, whatever its code. A constructor can write storage and
     *          still return the genuine code, so the state is only as trustworthy as whoever ran the constructor
     *        - a Safe that is an account which has delegated to a contract (EIP-7702): its own key can still act
     *          as itself, whatever threshold the contract it delegates to reports
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
        // Everything below asks the Safe about itself, so first that the answers are Safe's own code and storage.
        _requireKnownSafe(
            safe, deployer, vm.envOr("SAFE_FACTORY", address(0)), vm.envOr("SAFE_CREATION_CALL", bytes(""))
        );

        // `safe != deployer` is not enough on its own. A Safe whose only owner is the
        // deployer, at a threshold of one, passes every other check here while leaving
        // exactly the same key in charge of exactly the same powers. Renouncing to it
        // would cost a transaction and buy nothing, and the on-chain result would look
        // like a completed migration.
        if (_isOwner(safe, deployer) && _thresholdOf(safe) <= 1) revert DeployerCanActAlone(safe);
        // One owner who is not the deployer is a different key, but still one key. The Safe can raise its own
        // threshold later; until it does, that owner can use everything DEFAULT_ADMIN_ROLE administers with no
        // delay, and propose any upgrade. A Safe that cannot answer is refused unless the operator vouches for it
        // (see _thresholdOf).
        uint256 threshold = _thresholdOf(safe);
        if (threshold < MIN_SAFE_THRESHOLD) revert SafeThresholdTooLow(safe, threshold, MIN_SAFE_THRESHOLD);

        _requireTimelockPolicy(TimelockController(payable(timelock)), safe, deployer);

        Target[] memory targets = _targets();
        for (uint256 i = 0; i < targets.length; i++) {
            IAccessControl c = IAccessControl(targets[i].addr);
            if (!c.hasRole(ADMIN_ROLE, safe)) revert SafeMissingAdmin(targets[i].name, safe);
            if (!c.hasRole(UPGRADER_ROLE, timelock)) revert TimelockMissingUpgrader(targets[i].name, timelock);
            // The Safe removed it, or it is still there. Dropping it from here would reach
            // the same state and prove nothing about the Safe.
            if (c.hasRole(ADMIN_ROLE, deployer)) revert DeployerStillAdmin(targets[i].name, deployer);
            // This cannot be undone, so it also refuses to leave the Safe a way round the timelock. On a
            // registry set up by the older code the admin Safe can grant itself UPGRADER_ROLE, or the
            // slasher, committee and staking-core roles, in one transaction. That used to be a warning
            // printed after the deployer had already gone.
            if (!_upgraderAdminIsSelf(targets[i].addr)) revert UpgraderRoleNotSelfAdministered(targets[i].name);
            (bool open, bytes32 role) = _firstRoleTheAdminCanGrant(targets[i].name, targets[i].addr);
            if (open) revert RoleNotTimelocked(targets[i].name, role);
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
            address addr = vm.keyExistsJson(json, key) ? vm.parseJsonAddress(json, key) : address(0);
            if (addr == address(0) || addr.code.length == 0) {
                if (i < REQUIRED_TARGETS) revert MissingTarget(NAMES[i]);
                continue;
            }
            buf[n++] = Target(NAMES[i], addr);
        }

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
        // An account that has delegated to a contract (EIP-7702) has 23 bytes of code: 0xef0100 and that contract's
        // address. A call to it runs the contract, which can report any threshold and any owners, but its own key
        // can still send transactions as itself, so no threshold it reports limits anyone.
        bytes memory c = safe.code;
        if (c.length == 23 && c[0] == 0xef && c[1] == 0x01 && c[2] == 0x00) revert SafeIsADelegatedAccount(safe);
    }

    function _requireTimelock() internal view returns (address timelock) {
        timelock = vm.envOr("TIMELOCK", address(0));
        if (timelock == address(0)) revert TimelockNotSet();
        // A typo, or an address that only exists on another chain: phase 3 would grant UPGRADER_ROLE to it and
        // phase 5 would ask it for its delay.
        if (timelock.code.length == 0) revert TimelockHasNoCode(timelock);
        _requireTimelockPhase2Made(timelock);
    }

    /// @dev Phase 3 gives this address the right to upgrade every registry, so what it is has to be known before that
    ///      and not at the last step. Two things, because neither is enough alone.
    ///
    ///      Its code is compared with the TimelockController this file compiles, which is what phase 2 deploys and has
    ///      no immutables, so equal builds have equal code. Every check in `_requireTimelockPolicy` is the timelock's
    ///      own account of itself, and a contract that is not a TimelockController can give whatever account it likes
    ///      while letting its owner upgrade at once. The metadata solc appends is left out of the comparison (see
    ///      `_withoutMetadata`). A mismatch is a different contract or a different build, and the cure for the second
    ///      is to run the phase from the commit that deployed the timelock.
    ///
    ///      Equal code is still not equal state. A constructor can write storage and then return the genuine code, for
    ///      instance an operation already scheduled that upgrades every registry, or a role holder that no event
    ///      records, and neither the policy checks nor the role-holder replay would see it. So the address must also
    ///      be one the deployer created, which is how phase 2 makes it: the deployer is the account this script
    ///      already trusts with everything.
    function _requireTimelockPhase2Made(address timelock) internal view {
        bytes memory expected = type(TimelockController).runtimeCode;
        if (_withoutMetadata(timelock.code) != _withoutMetadata(expected)) {
            revert TimelockCodeNotRecognized(timelock, timelock.codehash, keccak256(expected));
        }
        address deployer = _deployerAddress();
        uint256 nonce = vm.getNonce(deployer);
        for (uint256 n = 0; n < nonce; n++) {
            if (vm.computeCreateAddress(deployer, n) == timelock) return;
        }
        revert TimelockNotCreatedByDeployer(timelock, deployer);
    }

    /// @dev What the notice on an upgrade rests on, read from the timelock itself. These are the checks that
    ///      scripts/check-mainnet.sh makes by hand in check_timelock, put in front of the one step that cannot be
    ///      undone. A timelock that phase 2 deployed passes them. One built another way may not, and afterwards
    ///      only the timelock can change its own roles or its delay. They are the timelock's own answers, which
    ///      `_requireTimelock` has already made worth reading: it is the contract phase 2 creates.
    function _requireTimelockPolicy(TimelockController tl, address safe, address deployer) internal view {
        address timelock = address(tl);
        uint256 delay = tl.getMinDelay();
        if (delay < DEFAULT_MIN_DELAY) revert TimelockDelayTooShort(timelock, delay, DEFAULT_MIN_DELAY);
        if (!tl.hasRole(tl.PROPOSER_ROLE(), safe)) revert TimelockCannotBeProposedTo(timelock, safe);
        if (!tl.hasRole(tl.CANCELLER_ROLE(), safe)) revert TimelockCannotBeCancelledBy(timelock, safe);
        // A role granted to address(0) is open to everyone, which is how this timelock spells "anyone may execute".
        if (!tl.hasRole(tl.EXECUTOR_ROLE(), address(0))) revert TimelockExecutionNotOpen(timelock);
        // The constructor makes the timelock its own admin whatever else it does, so what is left to check is that
        // nobody outside it was given the role too. The role-holder replay (scripts/check-role-holders.mjs) is what
        // finds an admin nobody named here.
        if (tl.hasRole(ADMIN_ROLE, safe)) revert TimelockHasOutsideAdmin(timelock, safe);
        if (tl.hasRole(ADMIN_ROLE, deployer)) revert TimelockHasOutsideAdmin(timelock, deployer);
    }

    /// @dev The hash of `code` without the metadata solc appends to it: a CBOR blob and, in the last two bytes, its
    ///      length. The blob carries a hash of the source files as they were read, so the same contract built from
    ///      sources with other line endings (a Windows checkout of OpenZeppelin can have CRLF) has other metadata,
    ///      a different `codehash`, and the same code to run. Code with no readable length is hashed whole.
    function _withoutMetadata(bytes memory code) internal pure returns (bytes32 h) {
        uint256 n = code.length;
        if (n < 2) return keccak256(code);
        uint256 cut = 2 + ((uint256(uint8(code[n - 2])) << 8) | uint8(code[n - 1]));
        if (cut > n) return keccak256(code);
        assembly {
            h := keccak256(add(code, 32), sub(n, cut))
        }
    }

    /// @dev The call the Safe pastes into the transaction builder for each contract. A function
    ///      of its own so that a test can read what the Safe will execute, instead of trusting a
    ///      log line: the wrong role here would have the Safe sign something that proves nothing.
    function _revokeDeployerAdminCall(address deployer) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IAccessControl.revokeRole.selector, ADMIN_ROLE, deployer);
    }

    /// @dev False for a SAFE that is some other kind of contract: another multisig is a legitimate target, and a
    ///      check that cannot be performed must not be reported as a check that passed. `_thresholdOf` is what keeps
    ///      this from being a way round the single-owner guard.
    function _isOwner(address safe, address account) internal view returns (bool) {
        (bool ok, bytes memory ret) = safe.staticcall(abi.encodeWithSelector(ISafe.getOwners.selector));
        if (!ok || ret.length < 64) return false;
        address[] memory owners = abi.decode(ret, (address[]));
        for (uint256 i = 0; i < owners.length; i++) {
            if (owners[i] == account) return true;
        }
        return false;
    }

    /// @dev A SAFE that cannot say what its threshold is gets neither owner guard in `_renounce`. Only one the
    ///      operator vouched for reaches this without an answer, because `_requireKnownSafe` runs first and Safe's
    ///      own code always answers. Both reads are low-level, like the others that ask a contract this file does
    ///      not control: a typed call cannot catch a contract whose fallback answers with nothing, and would end
    ///      the script on a decoding error instead of reaching the refusal.
    function _thresholdOf(address safe) internal view returns (uint256) {
        (bool ok, bytes memory ret) = safe.staticcall(abi.encodeWithSelector(ISafe.getThreshold.selector));
        if (ok && ret.length == 32) return abi.decode(ret, (uint256));
        return type(uint256).max; // unknown, on the operator's word: do not trip the owner guards
    }

    /// @dev Phase 5's answer to "is this a Safe": a Safe proxy running code Safe published, created by Safe's
    ///      factory as the operator shows, with no module and no guard. Anything else goes ahead only when the
    ///      operator names it, and is then still asked for its owners and threshold, so an answer that fails the
    ///      owner guards is refused even so.
    function _requireKnownSafe(address safe, address deployer, address factory, bytes memory creation)
        internal
        view
    {
        (string memory proxy, string memory implementation) = _safeVersion(safe);
        if (bytes(proxy).length == 0 || bytes(implementation).length == 0) {
            if (!_vouchedFor(safe)) revert SafeNotRecognized(safe, safe.codehash, _implementationOf(safe));
            // Its own word, but a module it admits to is still one too many.
            (, address[] memory admitted) = _modulesOf(safe);
            if (admitted.length > 0) revert SafeHasModules(safe, admitted[0]);
            console2.log("WARNING: SAFE is not code Safe published. You named it as checked; nothing here has.");
            return;
        }
        // Safe's code decides who may act from storage, and getOwners and getModulesPaginated list only the
        // entries linked into their lists. One written around them, by a delegatecall at setup or later or by a
        // constructor that left Safe's proxy code behind, acts and does not show. So the storage has to be what
        // Safe's factory and a plain setup made.
        _requireSafeCreatedByFactory(safe, factory, creation);
        // A module runs any call as the Safe with none of the owners' signatures, so no threshold limits whoever
        // controls it. The deployer is asked about by name too, which finds it even outside the list.
        (bool answered, address[] memory modules) = _modulesOf(safe);
        if (!answered) revert SafeModulesUnreadable(safe);
        if (modules.length > 0) revert SafeHasModules(safe, modules[0]);
        (bool ok, bytes memory ret) = safe.staticcall(abi.encodeWithSelector(ISafe.isModuleEnabled.selector, deployer));
        if (!ok || ret.length != 32) revert SafeModulesUnreadable(safe);
        if (abi.decode(ret, (bool))) revert DeployerIsAModule(safe);
        // A guard can refuse any transaction the Safe makes, the ones that schedule upgrades and the one that would
        // remove the guard included. Phase 4 shows only that it let the role changes through.
        address guard = address(uint160(uint256(vm.load(safe, SAFE_GUARD_SLOT))));
        if (guard != address(0)) revert SafeHasGuard(safe, guard);
    }

    /// @dev Whether CONFIRM_UNINSPECTABLE_SAFE names this SAFE. A sentence would carry over, in a .env file that
    ///      forge reads by itself, to whatever SAFE a later run is given; an address vouches for one contract.
    function _vouchedFor(address safe) internal view returns (bool) {
        string memory said = vm.envOr("CONFIRM_UNINSPECTABLE_SAFE", string(""));
        if (bytes(said).length == 0) return false;
        try vm.parseAddress(said) returns (address named) {
            return named == safe;
        } catch {
            return false;
        }
    }

    /// @dev SAFE is the address `factory` gives the call in `creation`, the input of the transaction that created
    ///      the Safe, so its storage is what that factory's proxy and that call's setup left. The factory is known
    ///      by its code, the address is worked out here and not taken from anything SAFE says, and the setup may
    ///      delegate to nothing or to Safe's SafeToL2Setup. What the Safe has done since is not here: the launch
    ///      checklist has two signers review every transaction it makes. Virtual only for the unit tests' stand-in.
    function _requireSafeCreatedByFactory(address safe, address factory, bytes memory creation)
        internal
        view
        virtual
    {
        if (factory == address(0) || creation.length < 4) revert SafeCreationNotShown(safe);
        bytes32 factoryCode = factory.codehash;
        if (factoryCode != SAFE_FACTORY_1_3_0 && factoryCode != SAFE_FACTORY_1_4_1 && factoryCode != SAFE_FACTORY_1_5_0) {
            revert SafeFactoryNotRecognized(factory, factoryCode);
        }
        (address singleton, bytes memory initializer, uint256 saltNonce) =
            abi.decode(_afterSelector(creation), (address, bytes, uint256));
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes4 how = bytes4(creation); // the selector, which is all the first four bytes are
        bytes32 salt;
        if (how == ISafeProxyFactory.createProxyWithNonce.selector) {
            salt = keccak256(abi.encodePacked(keccak256(initializer), saltNonce));
        } else if (how == ISafeProxyFactory.createChainSpecificProxyWithNonce.selector) {
            salt = keccak256(abi.encodePacked(keccak256(initializer), saltNonce, block.chainid));
        } else {
            revert SafeCreationNotShown(safe);
        }
        bytes memory deployment =
            abi.encodePacked(ISafeProxyFactory(factory).proxyCreationCode(), uint256(uint160(singleton)));
        address created = vm.computeCreate2Address(salt, keccak256(deployment), factory);
        if (created != safe) revert SafeNotCreatedAsShown(safe, created);
        // The factory calls the new Safe with the initializer, and setup is the only call that does anything before
        // the Safe has owners. Its `to` runs as the Safe, by delegatecall, and could write any storage at all.
        if (initializer.length < 4) revert SafeCreationNotShown(safe);
        // forge-lint: disable-next-line(unsafe-typecast)
        if (bytes4(initializer) != ISafe.setup.selector) revert SafeCreationNotShown(safe);
        (,, address to,,,,,) = abi.decode(
            _afterSelector(initializer), (address[], uint256, address, bytes, address, address, uint256, address)
        );
        if (to != address(0) && to.codehash != SAFE_TO_L2_SETUP_1_4_1 && to.codehash != SAFE_TO_L2_SETUP_1_5_0) {
            revert SafeSetupDelegatedTo(safe, to);
        }
    }

    function _afterSelector(bytes memory data) internal pure returns (bytes memory rest) {
        rest = new bytes(data.length - 4);
        for (uint256 i = 0; i < rest.length; i++) {
            rest[i] = data[i + 4];
        }
    }

    /// @dev Which SafeProxy SAFE's code is and which Safe its implementation runs, each empty when it is not code
    ///      Safe published. Virtual only so the unit tests can stand a plain contract in for a Safe;
    ///      test/SplitAuthorityFork.t.sol checks this one against a Safe made by Arc's own factory.
    function _safeVersion(address safe)
        internal
        view
        virtual
        returns (string memory proxy, string memory implementation)
    {
        proxy = _safeProxyVersion(safe.codehash);
        implementation = _safeImplementationName(_implementationOf(safe).codehash);
    }

    /// @dev The address a Safe proxy runs, from its storage slot 0 rather than from anything the code reports.
    function _implementationOf(address safe) internal view returns (address) {
        return address(uint160(uint256(vm.load(safe, bytes32(0)))));
    }

    function _safeProxyVersion(bytes32 codeHash) internal pure returns (string memory) {
        if (codeHash == SAFE_PROXY_1_3_0) return "1.3.0";
        if (codeHash == SAFE_PROXY_1_4_1) return "1.4.1";
        if (codeHash == SAFE_PROXY_1_5_0) return "1.5.0";
        return "";
    }

    function _safeImplementationName(bytes32 codeHash) internal pure returns (string memory) {
        if (codeHash == SAFE_1_3_0) return "Safe 1.3.0";
        if (codeHash == SAFE_L2_1_3_0) return "SafeL2 1.3.0";
        if (codeHash == SAFE_1_4_1) return "Safe 1.4.1";
        if (codeHash == SAFE_L2_1_4_1) return "SafeL2 1.4.1";
        if (codeHash == SAFE_1_5_0) return "Safe 1.5.0";
        if (codeHash == SAFE_L2_1_5_0) return "SafeL2 1.5.0";
        return "";
    }

    /// @dev Up to ten of SAFE's enabled modules, and whether it answered at all. One is already too many.
    ///      Asked with a gas limit: Safe's own code answers in well under it, and a list that does not end, or a Safe
    ///      whose setup never ran (1.4.1 then hits an invalid opcode), cannot spend the rest of the run.
    function _modulesOf(address safe) internal view returns (bool answered, address[] memory modules) {
        (bool ok, bytes memory ret) = safe.staticcall{gas: 1_000_000}(
            abi.encodeWithSignature("getModulesPaginated(address,uint256)", SAFE_MODULES_HEAD, uint256(10))
        );
        // An empty list still takes three words: its offset, the next-page pointer and its length.
        if (!ok || ret.length < 96) return (false, modules);
        (modules,) = abi.decode(ret, (address[], address));
        return (true, modules);
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

    function _printUpgraderAdmin(string memory name, address target) internal view {
        if (_upgraderAdminIsSelf(target)) {
            console2.log("   upgrader role: administered by itself, so the Safe cannot grant it");
        } else {
            console2.log("   WARNING upgrader role: administered by DEFAULT_ADMIN_ROLE, so the Safe can skip the timelock");
        }
        (bool open,) = _firstRoleTheAdminCanGrant(name, target);
        if (open) {
            console2.log("   WARNING roles: the slasher, committee or staking-core role is still the admin's to grant,");
            console2.log("   so the Safe can install a holder with no delay. PHASE=renounce refuses on this.");
        }
    }

    /// @dev The roles the timelock protects on each contract: the ones that move funds or change an agent's
    ///      standing. On a registry initialized by the current code each is administered by UPGRADER_ROLE,
    ///      so granting one takes the timelock's delay and the admin can only revoke. The oracle and
    ///      guardian roles stay with the admin on purpose (docs/adr/0005), and are not listed.
    ///      test/SplitAuthority.t.sol compares this table with what the contracts actually do.
    function _timelockedRoles(string memory name) internal pure returns (bytes32[] memory roles) {
        bytes32 h = keccak256(bytes(name));
        if (h == keccak256("identity")) {
            roles = new bytes32[](1);
            roles[0] = STAKING_CORE_ROLE;
        } else if (h == keccak256("reputation")) {
            roles = new bytes32[](2);
            roles[0] = STAKING_CORE_ROLE;
            roles[1] = SLASHING_COMMITTEE_ROLE;
        } else if (h == keccak256("staking")) {
            roles = new bytes32[](1);
            roles[0] = SLASHING_COMMITTEE_ROLE;
        } else if (h == keccak256("oracleBond")) {
            roles = new bytes32[](1);
            roles[0] = SLASHER_ROLE;
        }
    }

    /// @dev The first of those roles that DEFAULT_ADMIN_ROLE can still grant on this contract. A role
    ///      whose admin cannot be read counts as open, because a check that cannot be made must not be
    ///      reported as one that passed.
    function _firstRoleTheAdminCanGrant(string memory name, address target)
        internal
        view
        returns (bool open, bytes32 role)
    {
        bytes32[] memory roles = _timelockedRoles(name);
        for (uint256 i = 0; i < roles.length; i++) {
            (bool ok, bytes memory ret) = target.staticcall(
                abi.encodeWithSelector(IAccessControl.getRoleAdmin.selector, roles[i])
            );
            if (!ok || ret.length != 32 || abi.decode(ret, (bytes32)) != UPGRADER_ROLE) return (true, roles[i]);
        }
        return (false, bytes32(0));
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
    function isModuleEnabled(address module) external view returns (bool);
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
}

interface ISafeProxyFactory {
    function proxyCreationCode() external pure returns (bytes memory);
    function createProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
    function createChainSpecificProxyWithNonce(address singleton, bytes memory initializer, uint256 saltNonce)
        external
        returns (address proxy);
}
