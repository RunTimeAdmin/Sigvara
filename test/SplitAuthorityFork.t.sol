// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import "../src/SigvaraStaking.sol";

/**
 * Rehearsal for script/SplitAuthority.s.sol, against a fork of the live Arc testnet
 * deployment with its real roles, real bonds and the real in-flight slash drill in it.
 *
 * The migration it rehearses ends with the deployer renouncing DEFAULT_ADMIN_ROLE,
 * which cannot be undone. If the replacement authority does not work, the proxies are
 * frozen for good. So the questions worth answering before broadcasting are not "does
 * the script run" but:
 *
 *   - can the deployer still do the two things it should no longer be able to do
 *   - can the Safe still administer, using a Safe deployed through Arc's own factory
 *     and driven by a real owner signature, rather than a stand-in with a call method
 *   - does the timelock actually impose the delay, and does anyone-can-execute work
 *   - did any of this disturb the oracle, committee or cross-contract roles
 *   - does the slash filed on 20 September still settle on 27 September
 *
 * That last one is the reason this is a fork test rather than a unit test. The drill
 * is in its challenge window right now, its settlement reaches across three contracts,
 * and a migration that stranded it would not show up anywhere else.
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

    bytes32 constant ADMIN_ROLE = 0x00;
    bytes32 constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
    bytes32 constant COMMITTEE_ROLE = keccak256("SLASHING_COMMITTEE_ROLE");
    bytes32 constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    bytes32 constant SLASHER_ROLE = keccak256("SLASHER_ROLE");
    bytes32 constant STAKING_CORE_ROLE = keccak256("STAKING_CORE_ROLE");

    bytes32 constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    /// The slash filed on 20 September 2026, still Pending as this is written.
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
     * The slash drill is mid-window on the live chain. Settlement moves the agent to
     * Slashed in the identity registry and zeroes its reputation, both through roles
     * the migration does not touch, but that is an argument rather than evidence.
     * This warps past the real deadline and settles the real proposal.
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
    // The migration itself, in the order the script performs it
    // -------------------------------------------------------------------------

    function _migrate() internal {
        for (uint256 i = 0; i < targets.length; i++) {
            vm.prank(DEPLOYER);
            IAccessControl(targets[i]).grantRole(ADMIN_ROLE, safe);
        }

        // From the Safe, exactly as phase 4 requires. Running these as the deployer
        // would reach the same state and prove nothing.
        for (uint256 i = 0; i < targets.length; i++) {
            _execFromSafe(targets[i], abi.encodeCall(IAccessControl.grantRole, (UPGRADER_ROLE, address(timelock))));
        }

        for (uint256 i = 0; i < targets.length; i++) {
            vm.startPrank(DEPLOYER);
            IAccessControl(targets[i]).renounceRole(UPGRADER_ROLE, DEPLOYER);
            IAccessControl(targets[i]).renounceRole(ADMIN_ROLE, DEPLOYER);
            vm.stopPrank();
        }
    }

    // -------------------------------------------------------------------------
    // Safe plumbing
    // -------------------------------------------------------------------------

    function _deployRealSafe(address owner) internal returns (address) {
        address[] memory owners = new address[](1);
        owners[0] = owner;
        bytes memory initializer = abi.encodeCall(
            ISafe.setup, (owners, 1, address(0), "", address(0), address(0), 0, payable(address(0)))
        );
        address proxy = ISafeProxyFactory(SAFE_FACTORY).createProxyWithNonce(SAFE_SINGLETON, initializer, 0);
        assertGt(proxy.code.length, 0, "Safe factory produced no code");
        assertEq(ISafe(proxy).getThreshold(), 1, "unexpected threshold");
        return proxy;
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
