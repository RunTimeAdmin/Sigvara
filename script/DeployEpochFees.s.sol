// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import "../src/SigvaraEpochFees.sol";

/**
 * @title DeployEpochFees
 * @notice Deploys SigvaraEpochFees behind a UUPS proxy and grants ORACLE_ROLE
 *         to the oracle wallet. epochFee defaults to 0, so gating stays DISABLED
 *         until governance calls setEpochFee — deploying it does not disrupt the
 *         running oracle. Point the oracle at it via FEE_REGISTRY_ADDRESS to
 *         activate coverage checks once a non-zero fee is set.
 *
 * Usage:
 *   forge script script/DeployEpochFees.s.sol --rpc-url $RPC --broadcast --verify -vvvv
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY
 *   SVR_ADDRESS      — stake-token token
 *   IDENTITY_ADDRESS  — SigvaraIdentity proxy
 * Optional env (default to the deployer):
 *   ORACLE_ADDRESS    — granted ORACLE_ROLE (the oracle wallet)
 *   REWARD_POOL       — validator/oracle reward destination
 *   EPOCH_FEE         — initial per-epoch fee in wei (default 0 = gating disabled)
 */
contract DeployEpochFees is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        address svr       = vm.envAddress("SVR_ADDRESS");
        address identity   = vm.envAddress("IDENTITY_ADDRESS");
        address oracle     = vm.envOr("ORACLE_ADDRESS", deployer);
        address rewardPool = vm.envOr("REWARD_POOL", deployer);
        uint256 epochFee   = vm.envOr("EPOCH_FEE", uint256(0));

        vm.startBroadcast(deployerKey);

        SigvaraEpochFees impl = new SigvaraEpochFees();
        SigvaraEpochFees fees = SigvaraEpochFees(address(new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                SigvaraEpochFees.initialize,
                (deployer, oracle, svr, identity, rewardPool, epochFee)
            )
        )));

        vm.stopBroadcast();

        require(address(fees.svr()) == svr, "svr not set");
        require(address(fees.identityRegistry()) == identity, "identity not set");
        require(fees.epochFee() == epochFee, "epochFee not set");
        require(fees.hasRole(fees.ORACLE_ROLE(), oracle), "oracle role not granted");

        console2.log("=== Sigvara EpochFees Deployment ===");
        console2.log("Chain:           ", block.chainid);
        console2.log("EpochFees proxy: ", address(fees));
        console2.log("EpochFees impl:  ", address(impl));
        console2.log("Oracle:          ", oracle);
        console2.log("Reward pool:     ", rewardPool);
        console2.log("Epoch fee (wei): ", epochFee);
        console2.log("SVR:            ", svr);
        console2.log("Identity:        ", identity);
    }
}
