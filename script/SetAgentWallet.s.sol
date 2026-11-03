// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

/// The part of the ERC-8004 Identity Registry this script uses.
interface IERC8004AgentWallet {
    function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature) external;
    function getAgentWallet(uint256 agentId) external view returns (address);
    function ownerOf(uint256 agentId) external view returns (address);
}

/**
 * @title SetAgentWallet
 * @notice Makes the ERC-8004 publisher the agentWallet of Sigvara's own registration, so consumers
 *         can find the address Sigvara publishes from with getAgentWallet (ADR 0008; runbook
 *         section 5, step 2). Sent by the registration's owner, with a signature from the new
 *         wallet that oracle/agent-wallet.js gets from the remote signer. The registry refuses a
 *         deadline more than five minutes ahead, so run this straight after agent-wallet.js.
 *
 * Usage, from D:\Sigvara so Forge reads the owner's key from its .env (the project on the same drive):
 *   forge script <worktree>/script/SetAgentWallet.s.sol:SetAgentWallet --root <worktree> \
 *     --rpc-url https://rpc.testnet.arc.network --broadcast
 *
 * Env:
 *   DEPLOYER_PRIVATE_KEY      the registration's owner. Left unset, the script broadcasts as
 *                             --sender, which is how the rehearsal runs.
 *   PUBLISHER_ADDRESS         the new agentWallet
 *   DEADLINE, SIGNATURE       printed by oracle/agent-wallet.js
 *   ERC8004_IDENTITY_ADDRESS  optional; defaults to the Arc testnet registry below
 *   SIGVARA_ERC8004_AGENT_ID  optional; defaults to 897764
 */
contract SetAgentWallet is Script {
    /// The official ERC-8004 Identity Registry on Arc testnet (chain 5042002).
    address constant ARC_TESTNET_IDENTITY = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    uint256 constant SIGVARA_AGENT_ID = 897764;

    function run() external {
        address registryAddress = vm.envOr("ERC8004_IDENTITY_ADDRESS", ARC_TESTNET_IDENTITY);
        uint256 agentId = vm.envOr("SIGVARA_ERC8004_AGENT_ID", SIGVARA_AGENT_ID);
        address publisher = vm.envAddress("PUBLISHER_ADDRESS");
        uint256 deadline = vm.envUint("DEADLINE");
        bytes memory signature = vm.envBytes("SIGNATURE");
        uint256 key = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        IERC8004AgentWallet registry = IERC8004AgentWallet(registryAddress);

        require(
            registryAddress != ARC_TESTNET_IDENTITY || block.chainid == 5042002,
            "the default registry is Arc testnet's; set ERC8004_IDENTITY_ADDRESS for this chain"
        );
        require(block.timestamp <= deadline, "the signature's deadline has passed; run agent-wallet.js again");

        if (key != 0) vm.startBroadcast(key);
        else vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        require(registry.ownerOf(agentId) == sender, "the sender does not own the registration");
        registry.setAgentWallet(agentId, publisher, deadline, signature);
        vm.stopBroadcast();

        require(registry.getAgentWallet(agentId) == publisher, "the agentWallet is not the publisher after the call");
        console2.log("=== Sigvara agentWallet ===");
        console2.log("Agent:       ", agentId);
        console2.log("agentWallet: ", publisher);
    }
}
