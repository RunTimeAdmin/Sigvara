// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "@openzeppelin/contracts/finance/VestingWallet.sol";

/**
 * @title LockTreasurySvr
 * @notice Deploys the lock that holds the treasury share of the deployer's launch-day SVR until 9 May 2027.
 *
 * The deployer bought 22,283,004.212403886 SVR in the launch transaction (docs/token.md, Team acquisitions):
 * 5,000,000 for the two oracle operator bonds, which stays out so the bonds can be posted when the mainnet
 * registries deploy, and the rest treasury inventory. The treasury share goes into this lock: OpenZeppelin's
 * VestingWallet with a duration of zero, so nothing can be released before START and everything can be at it.
 * Anyone may call release once START has passed; it pays the owner. The owner starts as the deployer and can
 * be handed to the treasury timelock once that exists. Ownership decides where the SVR goes, never when.
 *
 * Never call renounceOwnership on it. release would then pay the zero address, which SVR refuses, and the SVR
 * would stay in the lock for good.
 *
 * This script only deploys the lock. The SVR goes in afterwards, by a plain transfer the deployer signs.
 *
 *   forge script script/LockTreasurySvr.s.sol --rpc-url arc_mainnet               # simulate
 *   forge script script/LockTreasurySvr.s.sol --rpc-url arc_mainnet --broadcast
 */
contract LockTreasurySvr is Script {
    uint256 internal constant ARC_MAINNET = 5042;

    /// The deployer and SVR creator named in docs/token.md.
    address internal constant DEPLOYER = 0x8857A7C392d1Bb1A68647c64Ce18D9AA1Fd023b0;

    /// 9 May 2027 00:00:00 UTC, six months after launch.
    uint64 internal constant START = 1809820800;

    error WrongChain(uint256 chainId);
    error WrongDeployer(address deployer);

    function run() external returns (VestingWallet lock) {
        uint256 key = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(key);
        if (block.chainid != ARC_MAINNET) revert WrongChain(block.chainid);
        if (deployer != DEPLOYER) revert WrongDeployer(deployer);

        vm.startBroadcast(key);
        lock = _build(deployer);
        vm.stopBroadcast();

        console2.log("=== treasury SVR lock deployed ===");
        console2.log("address     ", address(lock));
        console2.log("owner       ", lock.owner());
        console2.log("releases at ", lock.start());
    }

    function _build(address owner) internal returns (VestingWallet lock) {
        lock = new VestingWallet(owner, START, 0);
        require(lock.owner() == owner, "owner");
        require(lock.start() == START && lock.duration() == 0 && lock.end() == START, "schedule");
    }
}
