// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * The parts of the ERC-8004 registries that SigvaraValidator calls, as deployed from
 * erc-8004/erc-8004-contracts (getVersion 2.0.0 on Arc testnet and mainnet).
 */

/// @notice The ERC-8004 Identity Registry: one ERC-721 token per agent, with metadata.
interface IERC8004Identity {
    function ownerOf(uint256 agentId) external view returns (address);

    function getMetadata(uint256 agentId, string calldata metadataKey) external view returns (bytes memory);
}

/// @notice The ERC-8004 Validation Registry. Only the validator a request names can answer it.
interface IERC8004Validation {
    /// @notice The Identity Registry whose agents this registry's requests name.
    function getIdentityRegistry() external view returns (address);

    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash,
        string calldata tag
    ) external;

    /// @dev Reverts ("unknown") for a request hash that was never used.
    function getValidationStatus(bytes32 requestHash)
        external
        view
        returns (
            address validatorAddress,
            uint256 agentId,
            uint8 response,
            bytes32 responseHash,
            string memory tag,
            uint256 lastUpdate
        );
}
