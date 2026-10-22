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
 *   forge script script/DeployEpochFees.s.sol --rpc-url $RPC --broadcast -vvvv
 *
 * Do not pass --verify. Arc has no explorer entry in foundry.toml, and adding one breaks
 * forge script (docs/arc.md).
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY
 *   SVR_ADDRESS      — stake-token token
 *   IDENTITY_ADDRESS  — SigvaraIdentity proxy
 * Optional env (default to the deployer; on mainnet neither may be the deployer):
 *   ORACLE_ADDRESS    — granted ORACLE_ROLE (the oracle wallet)
 *   REWARD_POOL       — validator/oracle reward destination
 *   EPOCH_FEE         — initial per-epoch fee in wei (default 0 = gating disabled)
 *
 * Writes the proxy address into deployments/{chainId}.json under "epochFees", the way
 * DeployOracleBond does for "oracleBond". script/SplitAuthority.s.sol reads that key and
 * skips a contract that is missing from the artifact without a word, which would leave the
 * deployer as its admin and upgrader. As with the other scripts the file is written when
 * forge runs the script locally, before the transaction confirms, so check the chain
 * before trusting it, and do not use --resume.
 */
contract DeployEpochFees is Script {
    uint256 constant ARC_MAINNET = 5042;

    error RolesNotSeparated(address deployer, address oracle, address rewardPool);

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);

        address svr       = vm.envAddress("SVR_ADDRESS");
        address identity   = vm.envAddress("IDENTITY_ADDRESS");
        address oracle     = vm.envOr("ORACLE_ADDRESS", deployer);
        address rewardPool = vm.envOr("REWARD_POOL", deployer);
        uint256 epochFee   = vm.envOr("EPOCH_FEE", uint256(0));

        _checkRoleSeparation(deployer, oracle, rewardPool);

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

        _recordAddress(address(fees));
    }

    /// @dev The deployer keeps DEFAULT_ADMIN_ROLE and UPGRADER_ROLE. Left as the oracle it
    ///      also keeps ORACLE_ROLE, which the handover never takes from it, and left as the
    ///      reward pool it receives the fees. Tolerated on a testnet with a valueless faucet
    ///      token, refused on mainnet, matching the other deploy scripts.
    function _checkRoleSeparation(address deployer, address oracle, address rewardPool) internal view {
        bool oracleIsDeployer = oracle == deployer;
        bool poolIsDeployer = rewardPool == deployer;
        if (!oracleIsDeployer && !poolIsDeployer) return;

        if (block.chainid == ARC_MAINNET) {
            revert RolesNotSeparated(deployer, oracle, rewardPool);
        }
        console2.log("!! WARNING: roles are not separated.");
        if (oracleIsDeployer) console2.log("!!   ORACLE_ADDRESS is the deployer");
        if (poolIsDeployer)   console2.log("!!   REWARD_POOL is the deployer");
        console2.log("!! Acceptable on testnet only.");
    }

    /// @dev Merges into the existing artifact rather than replacing it, so the addresses
    ///      written by Deploy.s.sol and DeployOracleBond.s.sol survive. Only under
    ///      --broadcast or --resume, as in the other scripts.
    function _recordAddress(address fees) internal {
        if (!_broadcasting()) {
            console2.log("Dry run: artifact not written. Re-run with --broadcast to record.");
            return;
        }

        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        if (!vm.exists(path)) {
            console2.log("!! no deployments artifact at", path, "- record the address by hand");
            return;
        }
        vm.writeJson(string.concat("\"", vm.toString(fees), "\""), path, ".epochFees");
        console2.log("Recorded in:      ", path);
    }

    function _broadcasting() internal view returns (bool) {
        return vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)
            || vm.isContext(VmSafe.ForgeContext.ScriptResume);
    }
}
