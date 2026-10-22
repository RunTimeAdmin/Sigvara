// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

import "../script/Deploy.s.sol";
import "../script/DeployEpochFees.s.sol";
import "../script/DeployOracleBond.s.sol";
import "../src/SigvaraStaking.sol";
import "../src/SigvaraOracleBond.sol";

contract Token18 is ERC20 {
    constructor() ERC20("Sigvara", "SVR") {}
}

contract Token6 is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}
    function decimals() public pure override returns (uint8) { return 6; }
}

/// Answers every call with nothing, like a permissive fallback or an account with delegated code.
contract SilentContract {
    fallback() external {}
}

contract Deploy_Harness is Deploy {
    function checkToken(address t) external view { _checkMainnetToken(t); }
    function checkPeriods(uint256 a, uint256 b, uint256 c) external view { _checkMainnetPeriods(a, b, c); }
    function checkMinimumStake(uint256 m) external view { _checkMainnetMinimumStake(m); }
    function checkGuardian(address d, address o, address c, address g) external view {
        _checkMainnetGuardian(d, o, c, g);
    }
    function floors() external pure returns (uint256, uint256, uint256) {
        return (MIN_CHALLENGE_PERIOD, MIN_UNBONDING_PERIOD, MIN_CHALLENGE_WINDOW);
    }
}

contract DeployOracleBond_Harness is DeployOracleBond {
    function checkBondAmount(uint256 a) external view { _checkMainnetBondAmount(a); }
    function checkUnbonding(uint256 u) external view { _checkMainnetUnbonding(u); }
    function checkGuardian(address d, address s, address g) external view { _checkMainnetGuardian(d, s, g); }
    function floor() external pure returns (uint256) { return MIN_UNBONDING; }
}

contract DeployEpochFees_Harness is DeployEpochFees {
    function checkRoles(address d, address o, address p) external view { _checkRoleSeparation(d, o, p); }
    function checkBond(address b) external view { _checkOperatorBond(b); }
}

/**
 * The guards the deploy scripts apply on Arc mainnet. Each exists because the script did
 * the wrong thing there without complaint: deployed the faucet token when SVR_ADDRESS was
 * unset, accepted a bond token with the wrong decimals, left a reinitializer open, and let
 * the reward pool and the oracle default to the deployer.
 */
contract DeployScriptGuardsTest is Test {
    Deploy_Harness h;
    DeployEpochFees_Harness f;
    DeployOracleBond_Harness b;

    address deployer = makeAddr("deployer");
    address oracle = makeAddr("oracle");
    address pool = makeAddr("pool");

    function setUp() public {
        h = new Deploy_Harness();
        f = new DeployEpochFees_Harness();
        b = new DeployOracleBond_Harness();
    }

    // ---- the bond token

    function test_mainnet_refusesAnUnsetBondToken() public {
        vm.chainId(5042);
        vm.expectRevert(Deploy.BondTokenNotSet.selector);
        h.checkToken(address(0));
    }

    function test_mainnet_refusesABondTokenWithNoCode() public {
        vm.chainId(5042);
        address eoa = makeAddr("eoa");
        vm.expectRevert(abi.encodeWithSelector(Deploy.BondTokenInvalid.selector, eoa));
        h.checkToken(eoa);
    }

    function test_mainnet_refusesASixDecimalBondToken() public {
        vm.chainId(5042);
        address usdc = address(new Token6());
        vm.expectRevert(abi.encodeWithSelector(Deploy.BondTokenInvalid.selector, usdc));
        h.checkToken(usdc);
    }

    function test_mainnet_refusesAContractThatIsNotAToken() public {
        vm.chainId(5042);
        address notAToken = address(h);
        vm.expectRevert(abi.encodeWithSelector(Deploy.BondTokenInvalid.selector, notAToken));
        h.checkToken(notAToken);
    }

    /// A try/catch cannot catch a return value that does not decode, so this used to revert
    /// with no reason. A test account with delegated code on Arc mainnet behaves this way.
    function test_mainnet_refusesAContractThatAnswersNothing() public {
        vm.chainId(5042);
        address silent = address(new SilentContract());
        vm.expectRevert(abi.encodeWithSelector(Deploy.BondTokenInvalid.selector, silent));
        h.checkToken(silent);
    }

    function test_mainnet_acceptsAnEighteenDecimalToken() public {
        vm.chainId(5042);
        h.checkToken(address(new Token18()));
    }

    function test_testnet_stillAcceptsAnUnsetBondTokenAndAnyDecimals() public {
        vm.chainId(5042002);
        h.checkToken(address(0));
        h.checkToken(address(new Token6()));
    }

    // ---- the periods

    function test_mainnet_refusesAChallengePeriodUnderTheFloor() public {
        vm.chainId(5042);
        vm.expectRevert(abi.encodeWithSelector(Deploy.PeriodBelowFloor.selector, "CHALLENGE_PERIOD", 2 days, 3 days));
        h.checkPeriods(2 days, 21 days, 6 hours);
    }

    function test_mainnet_refusesAnUnbondingPeriodUnderTheFloor() public {
        vm.chainId(5042);
        vm.expectRevert(abi.encodeWithSelector(Deploy.PeriodBelowFloor.selector, "UNBONDING_PERIOD", 0, 1 days));
        h.checkPeriods(7 days, 0, 6 hours);
    }

    function test_mainnet_refusesAScoreWindowUnderTheFloor() public {
        vm.chainId(5042);
        vm.expectRevert(
            abi.encodeWithSelector(Deploy.PeriodBelowFloor.selector, "SCORE_CHALLENGE_WINDOW", 0, 1 hours)
        );
        h.checkPeriods(7 days, 21 days, 0);

        vm.expectRevert(
            abi.encodeWithSelector(Deploy.PeriodBelowFloor.selector, "SCORE_CHALLENGE_WINDOW", 1 hours - 1, 1 hours)
        );
        h.checkPeriods(7 days, 21 days, 1 hours - 1);
    }

    function test_mainnet_acceptsTheFloorsThemselves() public {
        vm.chainId(5042);
        h.checkPeriods(3 days, 1 days, 1 hours);
    }

    function test_testnet_stillAcceptsShortPeriods() public {
        vm.chainId(5042002);
        h.checkPeriods(1 hours, 0, 0);
    }

    /// The script cannot read the contracts' constants before the contracts exist, so it
    /// carries copies. This is what stops them drifting.
    function test_floorsMatchTheContracts() public {
        SigvaraStaking s = new SigvaraStaking();
        (uint256 challenge, uint256 unbonding, uint256 window) = h.floors();
        assertEq(challenge, s.MIN_CHALLENGE_PERIOD());
        assertEq(unbonding, s.MIN_UNBONDING_PERIOD());
        assertEq(window, new SigvaraReputation().MIN_CHALLENGE_WINDOW());
        assertEq(b.floor(), new SigvaraOracleBond().MIN_UNBONDING_PERIOD());
    }

    function test_oracleBond_mainnet_refusesAnUnbondingPeriodUnderTheFloor() public {
        vm.chainId(5042);
        vm.expectRevert(
            abi.encodeWithSelector(DeployOracleBond.PeriodBelowFloor.selector, "ORACLE_UNBONDING", 0, 1 days)
        );
        b.checkUnbonding(0);

        vm.expectRevert(
            abi.encodeWithSelector(DeployOracleBond.PeriodBelowFloor.selector, "ORACLE_UNBONDING", 1 days - 1, 1 days)
        );
        b.checkUnbonding(1 days - 1);
    }

    function test_oracleBond_mainnet_acceptsTheUnbondingFloor() public {
        vm.chainId(5042);
        b.checkUnbonding(1 days);
    }

    function test_oracleBond_testnet_stillAcceptsAShortUnbonding() public {
        vm.chainId(5042002);
        b.checkUnbonding(0);
    }

    // ---- the amounts

    /// A forgotten variable gives a valid number and a very different deployment, so on mainnet
    /// the default is refused and the figure has to be stated.
    function test_mainnet_refusesTheDefaultMinimumStake() public {
        vm.chainId(5042);
        vm.expectRevert(abi.encodeWithSelector(Deploy.DefaultAmountOnMainnet.selector, "MINIMUM_STAKE", 1_000e18));
        h.checkMinimumStake(1_000e18);
    }

    function test_mainnet_acceptsAStatedMinimumStake() public {
        vm.chainId(5042);
        h.checkMinimumStake(10_000e18);
    }

    function test_testnet_stillAcceptsTheDefaultMinimumStake() public {
        vm.chainId(5042002);
        h.checkMinimumStake(1_000e18);
    }

    function test_oracleBond_mainnet_refusesTheDefaultBondAmount() public {
        vm.chainId(5042);
        vm.expectRevert(
            abi.encodeWithSelector(DeployOracleBond.DefaultAmountOnMainnet.selector, "ORACLE_BOND_AMOUNT", 1_000e18)
        );
        b.checkBondAmount(1_000e18);
    }

    function test_oracleBond_mainnet_acceptsAStatedBondAmount() public {
        vm.chainId(5042);
        b.checkBondAmount(2_500_000e18);
    }

    function test_oracleBond_testnet_stillAcceptsTheDefaultBondAmount() public {
        vm.chainId(5042002);
        b.checkBondAmount(1_000e18);
    }

    // ---- the pause guardian

    /// The guardian is the only fast response to a live bug, since the other one is an upgrade 48
    /// hours away. A mainnet deployment without one is refused, and so is one where the guardian is a
    /// key that already holds a role, because then the key that can stop inflows is not a separate one.
    function test_mainnet_refusesAnUnsetGuardian() public {
        vm.chainId(5042);
        address committee = makeAddr("committee");
        vm.expectRevert(Deploy.GuardianNotSet.selector);
        h.checkGuardian(deployer, oracle, committee, address(0));
    }

    function test_mainnet_refusesAGuardianThatHoldsAnotherRole() public {
        vm.chainId(5042);
        address committee = makeAddr("committee");
        address[3] memory same = [deployer, oracle, committee];
        for (uint256 i = 0; i < 3; i++) {
            vm.expectRevert(abi.encodeWithSelector(Deploy.GuardianNotSeparated.selector, same[i]));
            h.checkGuardian(deployer, oracle, committee, same[i]);
        }
    }

    function test_mainnet_acceptsASeparateGuardian() public {
        vm.chainId(5042);
        h.checkGuardian(deployer, oracle, makeAddr("committee"), makeAddr("guardian"));
    }

    function test_testnet_stillAcceptsNoGuardian() public {
        vm.chainId(5042002);
        h.checkGuardian(deployer, oracle, makeAddr("committee"), address(0));
        h.checkGuardian(deployer, oracle, makeAddr("committee"), deployer);
    }

    function test_oracleBond_mainnet_refusesAnUnsetOrUnseparatedGuardian() public {
        vm.chainId(5042);
        address slasher = makeAddr("slasher");
        vm.expectRevert(DeployOracleBond.GuardianNotSet.selector);
        b.checkGuardian(deployer, slasher, address(0));

        vm.expectRevert(abi.encodeWithSelector(DeployOracleBond.GuardianNotSeparated.selector, deployer));
        b.checkGuardian(deployer, slasher, deployer);
        vm.expectRevert(abi.encodeWithSelector(DeployOracleBond.GuardianNotSeparated.selector, slasher));
        b.checkGuardian(deployer, slasher, slasher);

        b.checkGuardian(deployer, slasher, makeAddr("guardian"));
    }

    function test_oracleBond_testnet_stillAcceptsNoGuardian() public {
        vm.chainId(5042002);
        b.checkGuardian(deployer, makeAddr("slasher"), address(0));
    }

    // ---- EpochFees roles

    function test_epochFees_mainnet_refusesTheDeployerAsOracle() public {
        vm.chainId(5042);
        vm.expectRevert(abi.encodeWithSelector(DeployEpochFees.RolesNotSeparated.selector, deployer, deployer, pool));
        f.checkRoles(deployer, deployer, pool);
    }

    function test_epochFees_mainnet_refusesTheDeployerAsRewardPool() public {
        vm.chainId(5042);
        vm.expectRevert(abi.encodeWithSelector(DeployEpochFees.RolesNotSeparated.selector, deployer, oracle, deployer));
        f.checkRoles(deployer, oracle, deployer);
    }

    function test_epochFees_mainnet_acceptsSeparatedRoles() public {
        vm.chainId(5042);
        f.checkRoles(deployer, oracle, pool);
    }

    function test_epochFees_testnet_stillWarnsOnly() public {
        vm.chainId(5042002);
        f.checkRoles(deployer, deployer, deployer);
    }

    /// On mainnet the right to charge follows the operator's bond. With no registry it would
    /// follow the role alone, and removing an operator would leave a second contract's role
    /// to be remembered.
    function test_epochFees_mainnet_refusesAMissingOperatorBond() public {
        vm.chainId(5042);
        vm.expectRevert(DeployEpochFees.OperatorBondNotSet.selector);
        f.checkBond(address(0));
    }

    function test_epochFees_mainnet_acceptsAnOperatorBond() public {
        vm.chainId(5042);
        f.checkBond(makeAddr("bond"));
    }

    function test_epochFees_testnet_warnsOnlyWithoutAnOperatorBond() public {
        vm.chainId(5042002);
        f.checkBond(address(0));
    }
}

/**
 * The scripts run end to end, under mainnet rules. Environment variables are process-wide,
 * so everything that sets them lives in one test and sets all of them every time.
 */
contract DeployScriptRunTest is Test {
    // Anvil's first test key. Public, valueless, and only ever used inside this test.
    uint256 constant KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    function _env(address svr, address oracle, address committee, uint256 unbonding) internal {
        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(bytes32(KEY)));
        vm.setEnv("SVR_ADDRESS", svr == address(0) ? "" : vm.toString(svr));
        vm.setEnv("ORACLE_ADDRESS", oracle == address(0) ? "" : vm.toString(oracle));
        vm.setEnv("COMMITTEE_ADDRESS", committee == address(0) ? "" : vm.toString(committee));
        vm.setEnv("UNBONDING_PERIOD", vm.toString(unbonding));
        vm.setEnv("CHALLENGE_PERIOD", "");
        vm.setEnv("SCORE_CHALLENGE_WINDOW", "");
        vm.setEnv("MINIMUM_STAKE", "");
        vm.setEnv("MATURITY_RATE_PER_DAY", "");
        vm.setEnv("GUARDIAN_ADDRESS", "");
    }

    /// The proxy that emitted UnbondingPeriodUpdated, which only initializeV2 and the setter
    /// emit. Deploy.run does not return its addresses, and the artifact is not written in a
    /// test.
    function _stakingFrom(Vm.Log[] memory logs) internal pure returns (address staking, uint256 period, uint256 n) {
        bytes32 sig = keccak256("UnbondingPeriodUpdated(uint256)");
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == sig) {
                staking = logs[i].emitter;
                period = abi.decode(logs[i].data, (uint256));
                n++;
            }
        }
    }

    function _emitterOf(Vm.Log[] memory logs, bytes32 topic0) internal pure returns (address emitter) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == topic0) emitter = logs[i].emitter;
        }
    }

    function test_deployAndEpochFeesRunUnderMainnetRules() public {
        address deployer = vm.addr(KEY);
        address oracle = makeAddr("oracle");
        address committee = makeAddr("committee");
        address pool = makeAddr("pool");
        address svr = address(new Token18());

        // Mainnet with the bond token unset: refused, not the faucet token.
        vm.chainId(5042);
        _env(address(0), oracle, committee, 21 days);
        Deploy d = new Deploy();
        vm.expectRevert(Deploy.BondTokenNotSet.selector);
        d.run();

        // Mainnet with an unbonding period under the floor: refused.
        _env(svr, oracle, committee, 0);
        vm.expectRevert(abi.encodeWithSelector(Deploy.PeriodBelowFloor.selector, "UNBONDING_PERIOD", 0, 1 days));
        d.run();

        // Mainnet with MINIMUM_STAKE left unset, which means the testnet default: refused, the
        // figure has to be stated.
        _env(svr, oracle, committee, 21 days);
        vm.expectRevert(abi.encodeWithSelector(Deploy.DefaultAmountOnMainnet.selector, "MINIMUM_STAKE", 1_000e18));
        d.run();

        // A stated minimum stake and no guardian: refused, since there would be no way to pause.
        _env(svr, oracle, committee, 21 days);
        vm.setEnv("MINIMUM_STAKE", vm.toString(uint256(10_000e18)));
        vm.expectRevert(Deploy.GuardianNotSet.selector);
        d.run();

        // A guardian that is also the oracle: refused, since the key that can stop inflows would
        // not be a separate one.
        vm.setEnv("GUARDIAN_ADDRESS", vm.toString(oracle));
        vm.expectRevert(abi.encodeWithSelector(Deploy.GuardianNotSeparated.selector, oracle));
        d.run();

        // Mainnet, valid inputs: runs, and uses up staking's initializeV2 with the period.
        vm.setEnv("GUARDIAN_ADDRESS", vm.toString(makeAddr("guardian")));
        vm.recordLogs();
        d.run();
        (address staking, uint256 period, uint256 n) = _stakingFrom(vm.getRecordedLogs());
        assertEq(n, 1, "initializeV2 should have run exactly once");
        assertEq(period, 21 days);
        assertEq(SigvaraStaking(staking).unbondingPeriod(), 21 days);
        assertEq(SigvaraStaking(staking).minimumStake(), 10_000e18, "the stated minimum stake is the one used");
        assertEq(address(SigvaraStaking(staking).svrToken()), svr, "the bond token is the one supplied");

        // The guardian holds its role on the three registries the script deploys, and no other key does.
        {
            bytes32 guardianRole = keccak256("GUARDIAN_ROLE");
            address guardian = makeAddr("guardian");
            address identityProxy = address(SigvaraStaking(staking).identityRegistry());
            address reputationProxy = address(SigvaraStaking(staking).reputationRegistry());
            assertTrue(SigvaraStaking(staking).hasRole(guardianRole, guardian));
            assertTrue(SigvaraIdentity(identityProxy).hasRole(guardianRole, guardian));
            assertTrue(SigvaraReputation(reputationProxy).hasRole(guardianRole, guardian));
            assertFalse(SigvaraStaking(staking).hasRole(guardianRole, oracle), "the oracle is not a guardian");
            assertFalse(SigvaraStaking(staking).hasRole(guardianRole, committee), "nor is the committee");
        }

        // The admin can no longer call it with another value, which is the point. A value that
        // would pass the floor, so that only the used-up version can be the reason for the revert.
        vm.prank(deployer);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        SigvaraStaking(staking).initializeV2(30 days);

        // Testnet: an unset token still means the faucet token, and initializeV2 is used up there too.
        vm.chainId(5042002);
        _env(address(0), oracle, committee, 21 days);
        vm.recordLogs();
        d.run();
        (staking, period, n) = _stakingFrom(vm.getRecordedLogs());
        assertEq(n, 1);
        assertEq(period, 21 days);
        assertTrue(address(SigvaraStaking(staking).svrToken()) != address(0));

        // EpochFees on mainnet: refused, whatever the inputs. The module is left out of launch
        // (docs/adr/0005), so even separated roles and a bond registry, which used to deploy, are
        // turned away.
        DeployEpochFees e = new DeployEpochFees();
        address bond = makeAddr("bond");
        vm.chainId(5042);
        vm.setEnv("SVR_ADDRESS", vm.toString(svr));
        vm.setEnv("IDENTITY_ADDRESS", vm.toString(makeAddr("identity")));
        vm.setEnv("EPOCH_FEE", "");
        vm.setEnv("ORACLE_ADDRESS", vm.toString(oracle));
        vm.setEnv("REWARD_POOL", vm.toString(pool));
        vm.setEnv("OPERATOR_BOND", vm.toString(bond));
        vm.setEnv("EPOCH_LENGTH", "");
        vm.expectRevert(DeployEpochFees.EpochFeesDeferredOnMainnet.selector);
        e.run();

        // Testnet still deploys it, and sets the epoch length and the registry, which are not
        // part of initialize.
        vm.chainId(5042002);
        vm.recordLogs();
        e.run();
        address fees = _emitterOf(vm.getRecordedLogs(), keccak256("EpochLengthUpdated(uint256)"));
        assertTrue(fees != address(0), "the epoch length was set");
        assertEq(SigvaraEpochFees(fees).epochLength(), 1 days, "the default is one day");
        assertEq(address(SigvaraEpochFees(fees).operatorBond()), bond);

        // And an explicit epoch length is used.
        vm.setEnv("EPOCH_LENGTH", "21600");
        vm.recordLogs();
        e.run();
        fees = _emitterOf(vm.getRecordedLogs(), keccak256("EpochLengthUpdated(uint256)"));
        assertEq(SigvaraEpochFees(fees).epochLength(), 6 hours);

        // OracleBond on mainnet: the default bond amount is refused, a stated one deploys.
        vm.chainId(5042);
        DeployOracleBond ob = new DeployOracleBond();
        vm.setEnv("SLASHER_ADDRESS", vm.toString(makeAddr("slasher")));
        vm.setEnv("SLASH_BENEFICIARY", vm.toString(makeAddr("beneficiary")));
        vm.setEnv("ORACLE_BOND_AMOUNT", "");
        vm.setEnv("ORACLE_UNBONDING", "");
        vm.expectRevert(
            abi.encodeWithSelector(DeployOracleBond.DefaultAmountOnMainnet.selector, "ORACLE_BOND_AMOUNT", 1_000e18)
        );
        ob.run();

        // A stated bond amount with an unbonding period under the floor: refused, by name.
        vm.setEnv("ORACLE_BOND_AMOUNT", vm.toString(uint256(2_500_000e18)));
        vm.setEnv("ORACLE_UNBONDING", "3600");
        vm.expectRevert(
            abi.encodeWithSelector(DeployOracleBond.PeriodBelowFloor.selector, "ORACLE_UNBONDING", 3600, 1 days)
        );
        ob.run();
        vm.setEnv("ORACLE_UNBONDING", "");

        // Valid amounts and no guardian: refused.
        vm.setEnv("GUARDIAN_ADDRESS", "");
        vm.expectRevert(DeployOracleBond.GuardianNotSet.selector);
        ob.run();

        vm.setEnv("GUARDIAN_ADDRESS", vm.toString(makeAddr("guardian")));
        vm.recordLogs();
        ob.run();
        address obProxy = _emitterOf(vm.getRecordedLogs(), keccak256("RoleGranted(bytes32,address,address)"));
        assertTrue(obProxy != address(0), "the bond registry was deployed");
        assertEq(SigvaraOracleBond(obProxy).bondAmount(), 2_500_000e18, "the stated bond amount is the one used");
        assertTrue(
            SigvaraOracleBond(obProxy).hasRole(keccak256("GUARDIAN_ROLE"), makeAddr("guardian")),
            "the guardian can pause new bonds"
        );

        // Leave the process environment as found, except DEPLOYER_PRIVATE_KEY. forge runs test
        // contracts in parallel threads of one process, and test/SplitAuthority.t.sol sets that
        // variable to this same public key. Clearing it here could land in the middle of that
        // test and make its script fail to parse an empty key. Left set, it is harmless: both
        // tests set it again before every script run, and it is a published anvil key.
        vm.setEnv("OPERATOR_BOND", "");
        vm.setEnv("EPOCH_LENGTH", "");
        vm.setEnv("SVR_ADDRESS", "");
        vm.setEnv("ORACLE_ADDRESS", "");
        vm.setEnv("COMMITTEE_ADDRESS", "");
        vm.setEnv("UNBONDING_PERIOD", "");
        vm.setEnv("IDENTITY_ADDRESS", "");
        vm.setEnv("REWARD_POOL", "");
        vm.setEnv("MINIMUM_STAKE", "");
        vm.setEnv("ORACLE_BOND_AMOUNT", "");
        vm.setEnv("ORACLE_UNBONDING", "");
        vm.setEnv("SLASHER_ADDRESS", "");
        vm.setEnv("SLASH_BENEFICIARY", "");
        vm.setEnv("GUARDIAN_ADDRESS", "");
    }
}
