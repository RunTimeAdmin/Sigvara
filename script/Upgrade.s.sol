// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";

import "../src/SigvaraIdentity.sol";
import "../src/SigvaraReputation.sol";
import "../src/SigvaraStaking.sol";
import "../src/SigvaraOracleBond.sol";
import "../src/SigvaraEpochFees.sol";

/**
 * @title Upgrade
 * @notice Upgrades one UUPS proxy to a freshly compiled implementation.
 *
 * Every registry in this repo is a UUPS proxy whose `_authorizeUpgrade` is
 * gated on `UPGRADER_ROLE`. That makes the upgrade the single most dangerous
 * operation in the system, so it gets its own script rather than being done by
 * hand: the proxy address comes from the committed deployment artifact, the
 * implementation slot is read before and after, and the run reverts if the
 * slot did not actually move.
 *
 * Usage:
 *   TARGET=staking forge script script/Upgrade.s.sol --rpc-url arc_testnet -vvvv            # simulate
 *   TARGET=staking forge script script/Upgrade.s.sol --rpc-url arc_testnet --broadcast -vvvv
 *
 * Required env vars:
 *   DEPLOYER_PRIVATE_KEY — must hold UPGRADER_ROLE on the target proxy. On mainnet
 *                          that role belongs to the governance timelock, so this
 *                          script is used to simulate and to produce the calldata,
 *                          not to broadcast.
 *   TARGET               — identity | reputation | staking | oracleBond | epochFees
 *
 * Optional env vars:
 *   PROXY                — proxy address override. Without it the address is read
 *                          from deployments/<chainId>.json, which only carries the
 *                          three core registries; oracleBond and epochFees are
 *                          deployed by their own scripts and need this override.
 *   INIT_CALLDATA        — abi-encoded call executed atomically with the upgrade
 *                          (a reinitializer). Empty by default. A bare upgrade that
 *                          needed an initializer would leave the new storage at
 *                          zero, so pass this whenever the new implementation adds
 *                          state that must not start at zero.
 *
 * This script does not verify storage-layout compatibility. That is what the
 * slot-pinning tests in test/ and test/Upgrade.t.sol are for; run them before
 * broadcasting.
 */
contract Upgrade is Script {
    /// ERC-1967 implementation slot: keccak256("eip1967.proxy.implementation") - 1.
    bytes32 internal constant IMPL_SLOT =
        0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;

    error UnknownTarget(string target);
    error ProxyNotFound(string target, uint256 chainId);
    error ImplementationUnchanged(address proxy, address impl);

    function run() external {
        string memory target = vm.envString("TARGET");
        _requireKnownTarget(target); // fail on a typo before touching the artifact
        address proxy = _proxyAddress(target);
        bytes memory initData = vm.envOr("INIT_CALLDATA", bytes(""));

        address oldImpl = _implementationOf(proxy);

        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        address newImpl = _deployImplementation(target);
        IUUPSProxy(proxy).upgradeToAndCall(newImpl, initData);
        vm.stopBroadcast();

        address afterImpl = _implementationOf(proxy);
        if (afterImpl == oldImpl) revert ImplementationUnchanged(proxy, afterImpl);

        console2.log("=== Sigvara Upgrade ===");
        console2.log("Chain:          ", block.chainid);
        console2.log("Target:         ", target);
        console2.log("Proxy:          ", proxy);
        console2.log("Old impl:       ", oldImpl);
        console2.log("New impl:       ", afterImpl);
        console2.log("Init calldata:  ", initData.length == 0 ? "none" : "supplied");
    }

    /// @dev Fresh implementation for `target`. Implementations hold no state, so a
    ///      new one is deployed on every run rather than reusing an existing address.
    function _deployImplementation(string memory target) internal returns (address) {
        bytes32 t = keccak256(bytes(target));
        if (t == keccak256("identity"))   return address(new SigvaraIdentity());
        if (t == keccak256("reputation")) return address(new SigvaraReputation());
        if (t == keccak256("staking"))    return address(new SigvaraStaking());
        if (t == keccak256("oracleBond")) return address(new SigvaraOracleBond());
        if (t == keccak256("epochFees"))  return address(new SigvaraEpochFees());
        revert UnknownTarget(target);
    }

    function _requireKnownTarget(string memory target) internal pure {
        bytes32 t = keccak256(bytes(target));
        if (
            t != keccak256("identity") && t != keccak256("reputation") && t != keccak256("staking")
                && t != keccak256("oracleBond") && t != keccak256("epochFees")
        ) revert UnknownTarget(target);
    }

    /// @dev PROXY wins when set; otherwise read the committed deployment artifact.
    function _proxyAddress(string memory target) internal view returns (address) {
        address override_ = vm.envOr("PROXY", address(0));
        if (override_ != address(0)) return override_;

        string memory path = string.concat("deployments/", vm.toString(block.chainid), ".json");
        address fromFile = vm.parseJsonAddress(vm.readFile(path), string.concat(".", target));
        if (fromFile == address(0)) revert ProxyNotFound(target, block.chainid);
        return fromFile;
    }

    function _implementationOf(address proxy) internal view returns (address) {
        return address(uint160(uint256(vm.load(proxy, IMPL_SLOT))));
    }
}

/// @dev Minimal view of the UUPS entry point; avoids pulling the full upgradeable
///      base into the script just for one selector.
interface IUUPSProxy {
    function upgradeToAndCall(address newImplementation, bytes calldata data) external payable;
}
