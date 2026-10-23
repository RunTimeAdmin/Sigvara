// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import "../src/SigvaraIdentity.sol";
import "../src/SigvaraReputation.sol";
import "../src/SigvaraStaking.sol";
import "../src/SVRToken.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/**
 * @title Deploy
 * @notice Deploys all Sigvara contracts behind UUPS proxies, wires roles,
 *         and writes the deployed addresses to deployments/{chainId}.json.
 *
 * Usage — Arc testnet (chain ID 5042002; gas is USDC, fund via https://faucet.circle.com):
 *   forge script script/Deploy.s.sol --rpc-url arc_testnet -vvvv              # simulate
 *   forge script script/Deploy.s.sol --rpc-url arc_testnet --broadcast -vvvv  # deploy
 *   # writes deployments/5042002.json; add --legacy if fee estimation fails
 *
 * Usage — Arc mainnet (chain ID 5042): same command with --rpc-url arc_mainnet, plus the
 * mainnet inputs below. On chain 5042 the script refuses to run without SVR_ADDRESS, with
 * a bond token that has no code or is not 18 decimals, with the oracle or committee equal
 * to the deployer or to each other, or with periods outside the floors and ceilings the
 * contracts' setters enforce.
 *
 * Forge runs the script locally before it sends anything, so deployments/{chainId}.json is
 * written at that point, not after the transactions confirm. A broadcast that fails or is
 * interrupted leaves the file naming contracts that may not exist, and `--resume` rewrites
 * it with addresses computed from the new nonce. Do not resume. After any broadcast, check
 * the chain (`node scripts/record-implementations.mjs` fails on an address that is not a
 * proxy) before the file is committed or trusted.
 *
 * Required env vars:
 *   DEPLOYER_PRIVATE_KEY   — deployer key (used for broadcast)
 *
 * Optional env vars:
 *   SVR_ADDRESS            — existing ERC-20 to use as the bond token. Required on mainnet.
 *                            When unset elsewhere, the script deploys the SVRToken testnet
 *                            faucet token instead.
 *   ORACLE_ADDRESS         — address that may call updateReputation() on the oracle network
 *                            defaults to deployer
 *   COMMITTEE_ADDRESS      — initial SLASHING_COMMITTEE_ROLE holder (testnet 3-of-5 multisig)
 *                            defaults to deployer
 *   MINIMUM_STAKE          — minimum stake-token stake in wei (default: 1,000 SVR; the default
 *                            is refused on mainnet, so state the number there)
 *   CHALLENGE_PERIOD       — slash challenge window in seconds (default: 7 days)
 *   SCORE_CHALLENGE_WINDOW — reputation-score challenge window in seconds (default: 6 hours)
 *   UNBONDING_PERIOD       — seconds a queued withdrawal is still slashable before claim (default: 21 days)
 *   MATURITY_RATE_PER_DAY  — points of score released per day (default: 4, so 100 takes 25 days;
 *                            at most 100)
 *   GUARDIAN_ADDRESS         the key granted GUARDIAN_ROLE on identity, reputation and staking.
 *                            It can pause new inflows for three days at a time, and nothing
 *                            else. Required on mainnet, where it may not be the deployer, the
 *                            oracle or the committee. Unset elsewhere means no guardian.
 */
contract Deploy is Script {
    /// 1,000 whole units of an 18-decimal bond token.
    ///
    /// The decimals are the token’s, not a constant of the protocol. Arc USDC has 6,
    /// so 1,000 USDC is 1_000e6 and deploying against it with this value would set the
    /// minimum stake to a quadrillion dollars and lock every agent out of bonding. The
    /// bond token is fixed at initialize with no setter, so that mistake is a
    /// redeployment rather than a fix. Override MINIMUM_STAKE when the bond is not an
    /// 18-decimal token.
    uint256 constant DEFAULT_MINIMUM_STAKE = 1_000e18;
    uint256 constant DEFAULT_CHALLENGE_PERIOD = 7 days;
    uint256 constant DEFAULT_SCORE_CHALLENGE_WINDOW = 6 hours;
    uint256 constant DEFAULT_UNBONDING_PERIOD = 21 days;
    /// Points of score released per day. At 4, a perfect score takes 25 days to
    /// become fully spendable, which is what stops a farm being cashed in the week
    /// it was built.
    uint256 constant DEFAULT_MATURITY_RATE = 4;

    uint256 constant ARC_MAINNET = 5042;

    /// The floors the contracts enforce in their initializers and setters: staking's challenge
    /// and unbonding periods, and the reputation registry's challenge window. The script checks
    /// them first on mainnet so a mistyped value is refused with its name before anything is sent.
    /// test/DeployScripts.t.sol pins all three to the contracts' own constants.
    uint256 constant MIN_CHALLENGE_PERIOD = 3 days;
    uint256 constant MIN_UNBONDING_PERIOD = 1 days;
    uint256 constant MIN_CHALLENGE_WINDOW = 1 hours;

    /// The ceilings the contracts enforce in the same places, checked first on mainnet for the same reason.
    /// test/DeployScripts.t.sol pins these to the contracts' own constants too.
    uint256 constant MAX_CHALLENGE_PERIOD = 30 days;
    uint256 constant MAX_UNBONDING_PERIOD = 90 days;
    uint256 constant MAX_CHALLENGE_WINDOW = 7 days;
    uint256 constant MAX_MATURITY_RATE_PER_DAY = 100;

    error RolesNotSeparated(address deployer, address oracle, address committee);
    error BondTokenNotSet();
    error BondTokenInvalid(address token);
    error PeriodBelowFloor(string name, uint256 value, uint256 floor);
    error AboveCeiling(string name, uint256 value, uint256 ceiling);
    error DefaultAmountOnMainnet(string name, uint256 value);
    error GuardianNotSet();
    error GuardianNotSeparated(address guardian);

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        address oracle        = vm.envOr("ORACLE_ADDRESS",        deployer);
        address committee     = vm.envOr("COMMITTEE_ADDRESS",     deployer);
        uint256 minStake      = vm.envOr("MINIMUM_STAKE",         DEFAULT_MINIMUM_STAKE);
        uint256 period        = vm.envOr("CHALLENGE_PERIOD",      DEFAULT_CHALLENGE_PERIOD);
        uint256 scoreWindow   = vm.envOr("SCORE_CHALLENGE_WINDOW", DEFAULT_SCORE_CHALLENGE_WINDOW);
        uint256 unbondPeriod  = vm.envOr("UNBONDING_PERIOD",      DEFAULT_UNBONDING_PERIOD);

        _checkRoleSeparation(deployer, oracle, committee);
        _checkMainnetToken(vm.envOr("SVR_ADDRESS", address(0)));
        _checkMainnetPeriods(period, unbondPeriod, scoreWindow);
        _checkMainnetMaturityRate(vm.envOr("MATURITY_RATE_PER_DAY", DEFAULT_MATURITY_RATE));
        _checkMainnetMinimumStake(minStake);
        _checkMainnetGuardian(deployer, oracle, committee, vm.envOr("GUARDIAN_ADDRESS", address(0)));

        vm.startBroadcast(deployerKey);

        // 1. Bond token: an existing ERC-20 from SVR_ADDRESS, or the testnet faucet token.
        SVRToken svr = _bondToken(deployer);

        // 2. Identity — stakingCore wired after staking is deployed
        SigvaraIdentity identityImpl = new SigvaraIdentity();
        SigvaraIdentity identity = SigvaraIdentity(address(new ERC1967Proxy(
            address(identityImpl),
            abi.encodeCall(SigvaraIdentity.initialize, (deployer, address(0)))
        )));

        // 3. Reputation — oracle, stakingCore, and committee wired after all are known
        SigvaraReputation repImpl = new SigvaraReputation();
        SigvaraReputation reputation = SigvaraReputation(address(new ERC1967Proxy(
            address(repImpl),
            abi.encodeCall(SigvaraReputation.initialize, (deployer, address(0), address(0), address(0), scoreWindow))
        )));
        // Reputation refuses to accept scores until it can check the identity registry.
        reputation.initializeV3(address(identity));
        reputation.initializeV4(vm.envOr("MATURITY_RATE_PER_DAY", DEFAULT_MATURITY_RATE));

        // 4. Staking — now we have identity + rep + token addresses
        SigvaraStaking stakingImpl = new SigvaraStaking();
        SigvaraStaking staking = SigvaraStaking(address(new ERC1967Proxy(
            address(stakingImpl),
            abi.encodeCall(SigvaraStaking.initialize, (
                deployer,
                address(identity),
                address(reputation),
                address(svr),
                minStake,
                period,
                unbondPeriod
            ))
        )));
        // SigvaraStaking.initializeV2 was written for proxies that predate unbonding, and this
        // script used to leave it alone. On a fresh deployment its version is still unused
        // after initialize, so the admin could call it once, later, with any value, and walk
        // around setUnbondingPeriod's one day floor. Use it up now with the period just set.
        staking.initializeV2(unbondPeriod);

        // 5. Wire cross-contract roles
        // Identity checks collateral before letting an operator return an agent to
        // Active, so it needs the staking address. Staking is deployed after identity,
        // hence a separate call rather than a constructor argument.
        identity.initializeV2(address(staking));
        identity.grantRole(identity.STAKING_CORE_ROLE(), address(staking));
        reputation.grantRole(reputation.STAKING_CORE_ROLE(), address(staking));
        reputation.grantRole(reputation.ORACLE_ROLE(), oracle);
        reputation.grantRole(reputation.SLASHING_COMMITTEE_ROLE(), committee);
        staking.grantRole(staking.SLASHING_COMMITTEE_ROLE(), committee);

        // 6. The pause guardian, if there is one: a different, lighter key than the ones above.
        _grantGuardian(identity, reputation, staking);

        vm.stopBroadcast();

        // Log the deployed addresses to stdout
        console2.log("=== Sigvara Deployment ===");
        console2.log("Chain:           ", block.chainid);
        console2.log("Deployer:        ", deployer);
        console2.log("---");
        console2.log("SVR Token:      ", address(svr));
        console2.log("Identity proxy:  ", address(identity));
        console2.log("Reputation proxy:", address(reputation));
        console2.log("Staking proxy:   ", address(staking));
        console2.log("---");
        console2.log("Identity impl:   ", address(identityImpl));
        console2.log("Reputation impl: ", address(repImpl));
        console2.log("Staking impl:    ", address(stakingImpl));
        console2.log("---");
        console2.log("Oracle:          ", oracle);
        console2.log("Committee:       ", committee);
        console2.log("Guardian:        ", vm.envOr("GUARDIAN_ADDRESS", address(0)));
        console2.log("Min stake (wei): ", minStake);
        console2.log("Challenge period:", period);
        console2.log("Score chal. win.:", scoreWindow);
        console2.log("Unbonding period:", unbondPeriod);
        console2.log("Maturity rate/day:", reputation.maturityRatePerDay());

        // Write addresses to deployments/{chainId}.json for SDK config
        _writeAddresses(deployer, address(svr), address(identity), address(reputation), address(staking));
    }

    /// @dev The deployer keeps DEFAULT_ADMIN_ROLE and UPGRADER_ROLE on every contract.
    ///      If it is also the oracle and the committee, one key can propose a score,
    ///      slash the agent it just scored, and upgrade the contracts that did it, so
    ///      the optimistic model has no independent party in it at all. Tolerated on a
    ///      testnet with a valueless faucet bond, refused on mainnet.
    function _checkRoleSeparation(address deployer, address oracle, address committee) internal view {
        bool oracleIsDeployer = oracle == deployer;
        bool committeeIsDeployer = committee == deployer;
        if (!oracleIsDeployer && !committeeIsDeployer && oracle != committee) return;

        if (block.chainid == ARC_MAINNET) {
            revert RolesNotSeparated(deployer, oracle, committee);
        }
        console2.log("!! WARNING: roles are not separated.");
        if (oracleIsDeployer)    console2.log("!!   ORACLE_ADDRESS is the deployer");
        if (committeeIsDeployer) console2.log("!!   COMMITTEE_ADDRESS is the deployer");
        if (oracle == committee) console2.log("!!   oracle and committee are the same address");
        console2.log("!! One key can score, slash and upgrade. Acceptable on testnet only.");
    }

    /// @dev Mainnet only. The bond token is fixed at initialize with no setter, so a wrong
    ///      one is a redeployment. With SVR_ADDRESS unset this script deploys the faucet token
    ///      and carries on, which is right on a testnet and a disaster here, since every
    ///      address could then mint the bond. Every amount in the protocol is written for 18
    ///      decimals, so a token with any other count is refused too.
    function _checkMainnetToken(address token) internal view {
        if (block.chainid != ARC_MAINNET) return;
        if (token == address(0)) revert BondTokenNotSet();
        if (token.code.length == 0) revert BondTokenInvalid(token);
        // A low-level call, not try/catch: a try cannot catch a return value that fails to
        // decode, so an address that answers every call with nothing (a permissive fallback,
        // or an account with delegated code, as several well-known test accounts have on Arc)
        // would revert with no reason at all.
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(IERC20Metadata.decimals.selector));
        if (!ok || ret.length != 32 || abi.decode(ret, (uint256)) != 18) revert BondTokenInvalid(token);
    }

    /// @dev Mainnet only. The contracts refuse these values themselves, in the initializers as
    ///      well as the setters, but a refusal there reverts the whole transaction with the
    ///      contract's error. This names the variable and fails before anything is sent. A
    ///      score window under the floor lets a proposal finalize before anyone can object.
    function _checkMainnetPeriods(uint256 period, uint256 unbondPeriod, uint256 scoreWindow) internal view {
        if (block.chainid != ARC_MAINNET) return;
        if (period < MIN_CHALLENGE_PERIOD) revert PeriodBelowFloor("CHALLENGE_PERIOD", period, MIN_CHALLENGE_PERIOD);
        if (unbondPeriod < MIN_UNBONDING_PERIOD) {
            revert PeriodBelowFloor("UNBONDING_PERIOD", unbondPeriod, MIN_UNBONDING_PERIOD);
        }
        if (scoreWindow < MIN_CHALLENGE_WINDOW) {
            revert PeriodBelowFloor("SCORE_CHALLENGE_WINDOW", scoreWindow, MIN_CHALLENGE_WINDOW);
        }
        if (period > MAX_CHALLENGE_PERIOD) revert AboveCeiling("CHALLENGE_PERIOD", period, MAX_CHALLENGE_PERIOD);
        if (unbondPeriod > MAX_UNBONDING_PERIOD) {
            revert AboveCeiling("UNBONDING_PERIOD", unbondPeriod, MAX_UNBONDING_PERIOD);
        }
        if (scoreWindow > MAX_CHALLENGE_WINDOW) {
            revert AboveCeiling("SCORE_CHALLENGE_WINDOW", scoreWindow, MAX_CHALLENGE_WINDOW);
        }
    }

    /// @dev Mainnet only, like the periods: the contract refuses a rate above its ceiling itself, and
    ///      this names the variable first. A rate of 100 already releases a whole score in a day.
    function _checkMainnetMaturityRate(uint256 rate) internal view {
        if (block.chainid != ARC_MAINNET) return;
        if (rate > MAX_MATURITY_RATE_PER_DAY) revert AboveCeiling("MATURITY_RATE_PER_DAY", rate, MAX_MATURITY_RATE_PER_DAY);
    }

    /// @dev Mainnet only. A forgotten MINIMUM_STAKE leaves the testnet default, which is a valid
    ///      number and a very different deployment from the one intended. The admin can change
    ///      it with a setter afterwards, but the first weeks would run on the wrong figure, so
    ///      the default is refused and the number has to be stated.
    function _checkMainnetMinimumStake(uint256 minStake) internal view {
        if (block.chainid != ARC_MAINNET) return;
        if (minStake == DEFAULT_MINIMUM_STAKE) revert DefaultAmountOnMainnet("MINIMUM_STAKE", minStake);
    }

    /// @dev Mainnet only. The pause guardian is the only fast response to a live bug, since the
    ///      other one is an upgrade 48 hours away, so a mainnet deployment without one is refused.
    ///      It must be its own key: if it were the deployer, the oracle or the committee, the
    ///      separation between the key that can stop inflows and the keys that hold the roles
    ///      would be nominal.
    function _checkMainnetGuardian(address deployer, address oracle, address committee, address guardian)
        internal
        view
    {
        if (block.chainid != ARC_MAINNET) return;
        if (guardian == address(0)) revert GuardianNotSet();
        if (guardian == deployer || guardian == oracle || guardian == committee) {
            revert GuardianNotSeparated(guardian);
        }
    }

    /// @dev Granted while the deployer still holds the admin role, so it needs no later step. The
    ///      admin Safe can grant and revoke it after the handover.
    function _grantGuardian(
        SigvaraIdentity identity,
        SigvaraReputation reputation,
        SigvaraStaking staking
    ) internal {
        address guardian = vm.envOr("GUARDIAN_ADDRESS", address(0));
        if (guardian == address(0)) return;
        identity.grantRole(identity.GUARDIAN_ROLE(), guardian);
        reputation.grantRole(reputation.GUARDIAN_ROLE(), guardian);
        staking.grantRole(staking.GUARDIAN_ROLE(), guardian);
    }

    // SVR_ADDRESS points at an existing ERC-20 (the mainnet bond asset). When unset,
    // deploy the SVRToken testnet faucet token. Kept out of run() to stay under the
    // stack limit.
    function _bondToken(address deployer) internal returns (SVRToken) {
        address existing = vm.envOr("SVR_ADDRESS", address(0));
        if (existing != address(0)) {
            _logToken(existing);
            return SVRToken(existing);
        }
        return new SVRToken(deployer);
    }

    /// What to compare by eye with the published token before anything is sent. The
    /// simulation prints it.
    function _logToken(address token) internal view {
        _logUint("Bond token decimals:", token, IERC20Metadata.decimals.selector);
        _logUint("Bond token supply (wei):", token, IERC20.totalSupply.selector);
    }

    function _logUint(string memory label, address token, bytes4 selector) internal view {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(selector));
        if (ok && ret.length == 32) console2.log(label, abi.decode(ret, (uint256)));
        else console2.log(label, "(unreadable)");
    }

    function _writeAddresses(
        address deployer,
        address svr,
        address identity,
        address reputation,
        address staking
    ) internal {
        string memory key = "out";
        vm.serializeUint(key,    "chainId",    block.chainid);
        vm.serializeAddress(key, "deployer",   deployer);
        vm.serializeAddress(key, "svrToken",  svr);
        vm.serializeAddress(key, "identity",   identity);
        vm.serializeAddress(key, "reputation", reputation);
        string memory json = vm.serializeAddress(key, "staking", staking);

        // Only under --broadcast or --resume, so a dry run does not leave the artifact naming
        // addresses that exist nowhere. That is not the same as after the transactions
        // confirm: forge executes this script locally before it sends anything, so the file
        // is written first. If the broadcast then fails, the file names contracts that may
        // not exist, and --resume runs this again from the new nonce and rewrites it with
        // addresses that were never deployed. Check the chain before trusting or committing
        // it (node scripts/record-implementations.mjs fails on an address that is not a proxy).
        if (!vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)
            && !vm.isContext(VmSafe.ForgeContext.ScriptResume)) {
            console2.log("Dry run: deployments artifact not written.");
            return;
        }

        vm.createDir("deployments", true);
        vm.writeFile(
            string.concat("deployments/", vm.toString(block.chainid), ".json"),
            json
        );
    }
}
