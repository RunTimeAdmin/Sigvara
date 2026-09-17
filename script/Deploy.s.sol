// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import "../src/SigvaraIdentity.sol";
import "../src/SigvaraReputation.sol";
import "../src/SigvaraStaking.sol";
import "../src/SVRToken.sol";

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
 * Usage — Arc mainnet (chain ID 5042): same command with --rpc-url arc_mainnet.
 *
 * Required env vars:
 *   DEPLOYER_PRIVATE_KEY   — deployer key (used for broadcast)
 *
 * Optional env vars:
 *   SVR_ADDRESS            — existing ERC-20 to use as the bond token (mainnet). When unset,
 *                            the script deploys the SVRToken testnet faucet token instead.
 *   ORACLE_ADDRESS         — address that may call updateReputation() on the oracle network
 *                            defaults to deployer
 *   COMMITTEE_ADDRESS      — initial SLASHING_COMMITTEE_ROLE holder (testnet 3-of-5 multisig)
 *                            defaults to deployer
 *   MINIMUM_STAKE          — minimum stake-token stake in wei (default: 1,000 SVR)
 *   CHALLENGE_PERIOD       — slash challenge window in seconds (default: 7 days)
 *   SCORE_CHALLENGE_WINDOW — reputation-score challenge window in seconds (default: 6 hours)
 *   UNBONDING_PERIOD       — seconds a queued withdrawal is still slashable before claim (default: 21 days)
 */
contract Deploy is Script {
    uint256 constant DEFAULT_MINIMUM_STAKE = 1_000e18;
    uint256 constant DEFAULT_CHALLENGE_PERIOD = 7 days;
    uint256 constant DEFAULT_SCORE_CHALLENGE_WINDOW = 6 hours;
    uint256 constant DEFAULT_UNBONDING_PERIOD = 21 days;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        address oracle        = vm.envOr("ORACLE_ADDRESS",        deployer);
        address committee     = vm.envOr("COMMITTEE_ADDRESS",     deployer);
        uint256 minStake      = vm.envOr("MINIMUM_STAKE",         DEFAULT_MINIMUM_STAKE);
        uint256 period        = vm.envOr("CHALLENGE_PERIOD",      DEFAULT_CHALLENGE_PERIOD);
        uint256 scoreWindow   = vm.envOr("SCORE_CHALLENGE_WINDOW", DEFAULT_SCORE_CHALLENGE_WINDOW);
        uint256 unbondPeriod  = vm.envOr("UNBONDING_PERIOD",      DEFAULT_UNBONDING_PERIOD);

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

        // 5. Wire cross-contract roles
        identity.grantRole(identity.STAKING_CORE_ROLE(), address(staking));
        reputation.grantRole(reputation.STAKING_CORE_ROLE(), address(staking));
        reputation.grantRole(reputation.ORACLE_ROLE(), oracle);
        reputation.grantRole(reputation.SLASHING_COMMITTEE_ROLE(), committee);
        staking.grantRole(staking.SLASHING_COMMITTEE_ROLE(), committee);

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
        console2.log("Min stake (wei): ", minStake);
        console2.log("Challenge period:", period);
        console2.log("Score chal. win.:", scoreWindow);
        console2.log("Unbonding period:", unbondPeriod);

        // Write addresses to deployments/{chainId}.json for SDK config
        _writeAddresses(deployer, address(svr), address(identity), address(reputation), address(staking));
    }

    // SVR_ADDRESS points at an existing ERC-20 (the mainnet bond asset). When unset,
    // deploy the SVRToken testnet faucet token. Kept out of run() to stay under the
    // stack limit.
    function _bondToken(address deployer) internal returns (SVRToken) {
        address existing = vm.envOr("SVR_ADDRESS", address(0));
        if (existing != address(0)) return SVRToken(existing);
        return new SVRToken(deployer);
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

        vm.createDir("deployments", true);
        vm.writeFile(
            string.concat("deployments/", vm.toString(block.chainid), ".json"),
            json
        );
    }
}
