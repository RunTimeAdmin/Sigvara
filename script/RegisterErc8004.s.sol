// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

/// The part of the ERC-8004 Identity Registry this script uses.
interface IERC8004Identity {
    function register(string calldata agentURI) external returns (uint256 agentId);
    function tokenURI(uint256 agentId) external view returns (string memory);
    function ownerOf(uint256 agentId) external view returns (address);
    function balanceOf(address owner) external view returns (uint256);
}

/**
 * @title RegisterErc8004
 * @notice Registers Sigvara itself as an agent in the ERC-8004 Identity Registry, so explorers
 *         and catalogs that index ERC-8004 list it with the trust models it offers. The NFT it
 *         mints is owned by the broadcasting address, and its agentURI points at
 *         site/.well-known/agent-registration.json as served from sigvara.xyz. One file is both
 *         the registration file and the domain check the spec describes, because it is served
 *         from the domain it names.
 *
 *         It refuses to run when the sender already owns an ERC-8004 agent, so a second run
 *         does not mint a second Sigvara. Set REGISTER_AGAIN=true to run it anyway.
 *
 * After it runs:
 *   1. Put the printed `registrations` entry into site/.well-known/agent-registration.json.
 *   2. Upload that file (docs/deploy-testnet.md, section 8), then check that
 *      https://sigvara.xyz/.well-known/agent-registration.json serves it.
 *
 * Rehearsal on a fork, with no key at all:
 *   anvil --fork-url https://rpc.testnet.arc.network --auto-impersonate --port 8546
 *   forge script script/RegisterErc8004.s.sol --rpc-url http://127.0.0.1:8546 --broadcast \
 *     --unlocked --sender <owner address>
 *
 * For real, on Arc testnet:
 *   forge script script/RegisterErc8004.s.sol --rpc-url $RPC --broadcast -vvvv
 *
 * Env:
 *   DEPLOYER_PRIVATE_KEY      the key that will own Sigvara's ERC-8004 agent. Left unset, the
 *                             script broadcasts as --sender, which is how the rehearsal runs.
 *   ERC8004_IDENTITY_ADDRESS  optional; defaults to the Arc testnet registry below
 *   AGENT_URI                 optional; defaults to the sigvara.xyz well-known file
 *   REGISTER_AGAIN            optional; true to register although the sender owns an agent
 */
contract RegisterErc8004 is Script {
    /// The official ERC-8004 Identity Registry on Arc testnet (chain 5042002).
    address constant ARC_TESTNET_IDENTITY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    string constant DEFAULT_AGENT_URI = "https://sigvara.xyz/.well-known/agent-registration.json";

    function run() external returns (uint256 agentId) {
        address registryAddress = vm.envOr("ERC8004_IDENTITY_ADDRESS", ARC_TESTNET_IDENTITY);
        string memory agentURI = vm.envOr("AGENT_URI", DEFAULT_AGENT_URI);
        bool again = vm.envOr("REGISTER_AGAIN", false);
        uint256 key = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        IERC8004Identity registry = IERC8004Identity(registryAddress);

        // The default registry address exists only on Arc testnet. Elsewhere it is either
        // empty, and the call fails, or something else, which is worse.
        require(
            registryAddress != ARC_TESTNET_IDENTITY || block.chainid == 5042002,
            "the default registry is Arc testnet's; set ERC8004_IDENTITY_ADDRESS for this chain"
        );

        if (key != 0) vm.startBroadcast(key);
        else vm.startBroadcast();
        // The broadcasting address, which is the address that will own the NFT. Read after
        // startBroadcast: msg.sender is the script contract until then.
        (, address owner,) = vm.readCallers();
        require(
            again || registry.balanceOf(owner) == 0,
            "the sender already owns an ERC-8004 agent; set REGISTER_AGAIN=true to mint another"
        );
        agentId = registry.register(agentURI);
        vm.stopBroadcast();

        require(registry.ownerOf(agentId) == owner, "the new agent is not owned by the sender");
        require(
            keccak256(bytes(registry.tokenURI(agentId))) == keccak256(bytes(agentURI)),
            "the new agent's URI is not the one sent"
        );

        console2.log("=== Sigvara on ERC-8004 ===");
        console2.log("Chain:    ", block.chainid);
        console2.log("Registry: ", registryAddress);
        console2.log("Owner:    ", owner);
        console2.log("agentId:  ", agentId);
        console2.log("agentURI: ", agentURI);
        console2.log("Add to site/.well-known/agent-registration.json, then upload it:");
        console2.log(
            string.concat(
                '  "registrations": [{ "agentId": ',
                vm.toString(agentId),
                ', "agentRegistry": "eip155:',
                vm.toString(block.chainid),
                ":",
                vm.toString(registryAddress),
                '" }]'
            )
        );
    }
}
