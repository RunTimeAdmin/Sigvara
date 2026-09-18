// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../../src/SigvaraIdentity.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/**
 * Registration needs a signature from the agent address, so every test that creates an
 * agent needs a key for it rather than a bare address. This keeps that in one place: a
 * test that wants an agent says so once and does not carry the signing ceremony around.
 */
abstract contract RegistrationHelper is Test {
    /// Signs `registrationDigest` with `agentPk` and registers as `operator`.
    function registerSigned(
        SigvaraIdentity identity,
        address operator,
        uint256 agentPk,
        bytes32 ed25519PubKey
    ) internal returns (bytes32 didHash) {
        address agentAddress = vm.addr(agentPk);
        bytes memory sig = signRegistration(identity, agentPk, operator, ed25519PubKey);
        vm.prank(operator);
        return identity.registerAgent(agentAddress, ed25519PubKey, sig);
    }

    /// The signature alone, for tests that need to tamper with it or the call.
    function signRegistration(
        SigvaraIdentity identity,
        uint256 agentPk,
        address operator,
        bytes32 ed25519PubKey
    ) internal view returns (bytes memory) {
        // The digest is unprefixed, as a wallet expects. Apply the EIP-191 prefix here,
        // which is what personal_sign does for a real signer.
        bytes32 digest = identity.registrationDigest(vm.addr(agentPk), operator, ed25519PubKey);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            agentPk, MessageHashUtils.toEthSignedMessageHash(digest)
        );
        return abi.encodePacked(r, s, v);
    }
}
