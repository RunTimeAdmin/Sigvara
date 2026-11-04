// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import "../src/SigvaraRewardDistributor.sol";

/**
 * @title DeployRewardDistributor
 * @notice Deploys SigvaraRewardDistributor. It has no owner and no proxy, so there is nothing
 *         to hand over afterwards: what this script passes to the constructor is final.
 *
 *         Deploying it changes nothing on its own. Two steps follow, each by whoever holds the
 *         authority for it:
 *           - point the fee registry at it: SigvaraEpochFees.setRewardPool(distributor), by its
 *             DEFAULT_ADMIN_ROLE;
 *           - set REWARD_DISTRIBUTOR_ADDRESS on every oracle operator, so scores are finalized
 *             through it and credited. A score finalized directly earns no point.
 *
 * Usage:
 *   forge script script/DeployRewardDistributor.s.sol --rpc-url $RPC --broadcast -vvvv
 *
 * Do not pass --verify. Arc has no explorer entry in foundry.toml, and adding one breaks
 * forge script (docs/arc.md).
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY
 * Optional env (default to the deployments artifact):
 *   SVR_ADDRESS        - the token it pays in; "svrToken" in the artifact
 *   REPUTATION_ADDRESS - SigvaraReputation proxy; "reputation" in the artifact
 *   OPERATOR_BOND      - SigvaraOracleBond proxy; "oracleBond" in the artifact
 * Optional env:
 *   PERIOD_LENGTH      - seconds in one reward period, at least 1 day (default 7 days)
 *   CLAIM_PERIODS      - periods a closed period stays claimable (default 13, about a quarter)
 *
 * Writes the address into deployments/{chainId}.json under "rewardDistributor", like the other
 * scripts, and only under --broadcast. Check the chain before trusting it.
 */
contract DeployRewardDistributor is Script {
    uint256 constant DEFAULT_PERIOD_LENGTH = 7 days;
    uint256 constant DEFAULT_CLAIM_PERIODS = 13;

    error AddressNotFound(string key);
    error NoCodeAt(string key, address at);

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        address token = _address("SVR_ADDRESS", ".svrToken");
        address reputation = _address("REPUTATION_ADDRESS", ".reputation");
        address operatorBond = _address("OPERATOR_BOND", ".oracleBond");
        uint256 periodLength = vm.envOr("PERIOD_LENGTH", DEFAULT_PERIOD_LENGTH);
        uint256 claimPeriods = vm.envOr("CLAIM_PERIODS", DEFAULT_CLAIM_PERIODS);

        vm.startBroadcast(deployerKey);
        SigvaraRewardDistributor dist =
            new SigvaraRewardDistributor(token, reputation, operatorBond, periodLength, claimPeriods);
        vm.stopBroadcast();

        console2.log("=== Sigvara RewardDistributor Deployment ===");
        console2.log("Chain:           ", block.chainid);
        console2.log("Distributor:     ", address(dist));
        console2.log("Token:           ", token);
        console2.log("Reputation:      ", reputation);
        console2.log("Operator bond:   ", operatorBond);
        console2.log("Period (s):      ", periodLength);
        console2.log("Claim periods:   ", claimPeriods);
        console2.log("Next: SigvaraEpochFees.setRewardPool, and REWARD_DISTRIBUTOR_ADDRESS on every operator.");

        _recordAddress(address(dist));
    }

    /// @dev The env var wins when set; otherwise the deployments artifact. Each must have code,
    ///      since an immutable constructor argument pointing at nothing cannot be fixed later.
    function _address(string memory envKey, string memory jsonKey) internal view returns (address a) {
        a = vm.envOr(envKey, address(0));
        if (a == address(0)) {
            string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
            if (!vm.exists(path)) revert AddressNotFound(envKey);
            string memory json = vm.readFile(path);
            if (!vm.keyExistsJson(json, jsonKey)) revert AddressNotFound(envKey);
            a = vm.parseJsonAddress(json, jsonKey);
        }
        if (a.code.length == 0) revert NoCodeAt(envKey, a);
    }

    function _recordAddress(address dist) internal {
        if (!_broadcasting()) {
            console2.log("Dry run: artifact not written. Re-run with --broadcast to record.");
            return;
        }
        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        if (!vm.exists(path)) {
            console2.log("!! no deployments artifact at", path, "- record the address by hand");
            return;
        }
        vm.writeJson(string.concat("\"", vm.toString(dist), "\""), path, ".rewardDistributor");
        console2.log("Recorded in:     ", path);
    }

    function _broadcasting() internal view returns (bool) {
        return vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)
            || vm.isContext(VmSafe.ForgeContext.ScriptResume);
    }
}
