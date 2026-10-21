// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import "../src/SigvaraReader.sol";

/**
 * @title DeployReader
 * @notice Deploys SigvaraReader, the one-call read for contracts that gate on an
 *         agent's standing. It has no proxy, no roles and nothing to initialize: the
 *         three registry proxies are fixed at construction, so pointing it elsewhere
 *         means deploying another. Nothing in the protocol reads from it, so it can be
 *         deployed or replaced at any time.
 *
 * Usage:
 *   forge script script/DeployReader.s.sol --rpc-url $RPC --broadcast -vvvv
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY
 *   IDENTITY_ADDRESS    SigvaraIdentity proxy
 *   REPUTATION_ADDRESS  SigvaraReputation proxy
 *   STAKING_ADDRESS     SigvaraStaking proxy
 * Optional env:
 *   SMOKE_AGENT         a registered agent address. When set, the script reads its
 *                       standing through the new reader and fails if it cannot. That
 *                       exercises every registry call, which catches a proxy running
 *                       an older implementation than the interfaces expect.
 */
contract DeployReader is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        address identity   = vm.envAddress("IDENTITY_ADDRESS");
        address reputation = vm.envAddress("REPUTATION_ADDRESS");
        address staking    = vm.envAddress("STAKING_ADDRESS");
        address smoke      = vm.envOr("SMOKE_AGENT", address(0));

        vm.startBroadcast(deployerKey);
        SigvaraReader reader = new SigvaraReader(identity, reputation, staking);
        vm.stopBroadcast();

        require(address(reader.identity()) == identity, "identity not set");
        require(address(reader.reputation()) == reputation, "reputation not set");
        require(address(reader.staking()) == staking, "staking not set");

        console2.log("=== Sigvara Reader Deployment ===");
        console2.log("Chain:      ", block.chainid);
        console2.log("Reader:     ", address(reader));
        console2.log("Identity:   ", identity);
        console2.log("Reputation: ", reputation);
        console2.log("Staking:    ", staking);

        if (smoke != address(0)) {
            ISigvaraReader.Trust memory t = reader.trust(smoke);
            require(t.registered, "smoke agent is not registered");
            console2.log("Smoke agent:", smoke);
            console2.log("  score:    ", t.score);
            console2.log("  earned:   ", t.earned);
            console2.log("  stake:    ", t.stake);
            console2.log("  active:   ", t.active);
        }
    }
}
