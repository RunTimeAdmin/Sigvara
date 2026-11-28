// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import "../src/SigvaraValidator.sol";

/**
 * @title DeployValidator
 * @notice Deploys SigvaraValidator, which answers ERC-8004 validation requests with the Sigvara
 *         score (docs/adr/0014-answer-erc8004-validation-requests.md). It has no proxy and no
 *         roles: the four registries are fixed at construction, and its owner, the publisher
 *         key, is the only account that can answer. Ownership moves in two steps.
 *
 * Usage:
 *   forge script script/DeployValidator.s.sol --rpc-url $RPC --broadcast -vvvv
 *
 * Required env:
 *   DEPLOYER_PRIVATE_KEY
 *   PUBLISHER_ADDRESS               the owner: the publisher's address (ADR 0008)
 *   ERC8004_VALIDATION_ADDRESS      ERC-8004 Validation Registry
 *   ERC8004_IDENTITY_ADDRESS        ERC-8004 Identity Registry
 *   IDENTITY_ADDRESS                SigvaraIdentity proxy
 *   REPUTATION_ADDRESS              SigvaraReputation proxy
 * Optional env:
 *   SMOKE_AGENT_ID                  an ERC-8004 agent linked on chain. When set, the script fails
 *                                   unless the new validator finds its link, which exercises the
 *                                   Identity Registry's metadata and SigvaraIdentity's struct.
 */
contract DeployValidator is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");

        address publisher = vm.envAddress("PUBLISHER_ADDRESS");
        address validations = vm.envAddress("ERC8004_VALIDATION_ADDRESS");
        address agents = vm.envAddress("ERC8004_IDENTITY_ADDRESS");
        address identity = vm.envAddress("IDENTITY_ADDRESS");
        address reputation = vm.envAddress("REPUTATION_ADDRESS");
        uint256 smoke = vm.envOr("SMOKE_AGENT_ID", uint256(0));

        vm.startBroadcast(deployerKey);
        SigvaraValidator validator = new SigvaraValidator(publisher, validations, agents, identity, reputation);
        vm.stopBroadcast();

        require(validator.owner() == publisher, "owner not set");
        require(address(validator.validationRegistry()) == validations, "validation registry not set");
        require(address(validator.agentRegistry()) == agents, "agent registry not set");

        console2.log("=== Sigvara Validator Deployment ===");
        console2.log("Chain:      ", block.chainid);
        console2.log("Validator:  ", address(validator));
        console2.log("Owner:      ", publisher);
        console2.log("Validations:", validations);
        console2.log("Agents:     ", agents);
        console2.log("Identity:   ", identity);
        console2.log("Reputation: ", reputation);

        if (smoke != 0) {
            bytes memory named = IERC8004Identity(agents).getMetadata(smoke, validator.LINK_KEY());
            require(named.length == 32, "smoke agent names no Sigvara agent");
            // forge-lint: disable-next-line(unsafe-typecast)
            bytes32 didHash = bytes32(named);
            require(validator.linkHolds(smoke, didHash), "smoke agent's link does not hold");
            console2.log("Smoke agent:", smoke);
            console2.log("  score:    ", ISigvaraReputation(reputation).getTotalScore(didHash));
        }
    }
}
