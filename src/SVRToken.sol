// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title SVRToken
 * @notice Testnet stake token (SVR). Mintable by owner for operator onboarding and faucet use.
 *         Mainnet token will be non-mintable (fixed supply, governance-controlled).
 */
contract SVRToken is ERC20, Ownable {
    uint256 public constant FAUCET_CAP = 10_000e18;
    uint256 public constant FAUCET_COOLDOWN = 1 days;

    mapping(address => uint256) public lastFaucetUse;

    error FaucetCooldownActive(address caller, uint256 availableAt);

    constructor(address owner_) ERC20("Sigvara", "SVR") Ownable(owner_) {}

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    // Permissionless testnet faucet — capped per call and rate-limited per address
    // to prevent unbounded token inflation from repeated calls.
    function faucet(uint256 amount) external {
        if (amount > FAUCET_CAP) revert("SVRToken: max 10,000 SVR per call");

        uint256 availableAt = lastFaucetUse[msg.sender] + FAUCET_COOLDOWN;
        if (block.timestamp < availableAt) revert FaucetCooldownActive(msg.sender, availableAt);

        lastFaucetUse[msg.sender] = block.timestamp;
        _mint(msg.sender, amount);
    }
}
