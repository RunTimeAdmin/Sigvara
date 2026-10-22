// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title InflowGuard
 * @notice A guardian can pause the ways new state or value ENTER a registry, for a bounded time.
 *
 * @dev    Why it exists. The only fast response to a live bug used to be a timelocked upgrade,
 *         48 hours away, during which the bug could keep being fed. A pause stops the feeding and
 *         nothing else.
 *
 *         What it covers, per registry (each marks these with `whenInflowsOpen`):
 *
 *           SigvaraIdentity     registerAgent
 *           SigvaraStaking      depositStake
 *           SigvaraReputation   proposeReputation, proposeIfEmpty
 *           SigvaraOracleBond   depositBond
 *
 *         What it never covers: withdrawals and claims, unbonding and withdrawing a bond,
 *         disputes, rulings and slash execution, finalizing or rejecting a score that was
 *         already proposed, operator transfers, and every admin and role call. A pause cannot hold
 *         anyone's funds or stop accountability. It can only stop new entries.
 *
 *         Bounded. One pause lasts PAUSE_DURATION and ends by itself. That is three days, longer
 *         than the 48 hour upgrade delay, so a pause can bridge an emergency upgrade. The next
 *         pause cannot start until PAUSE_COOLDOWN after the last one would have ended, counted from
 *         its start even if it was lifted early, so a guardian cannot hold inflows shut for good.
 *         The admin revokes a guardian at once.
 *
 *         Who. Only GUARDIAN_ROLE pauses. The guardian or the admin lifts a pause early. The admin
 *         can grant itself the role, so this separates duties and does not add a new trust
 *         assumption: the point is that the key that pauses can be a different, lighter key from
 *         the one that holds the roles.
 *
 *         Storage. The state lives in an ERC-7201 namespaced slot and not in the inheriting
 *         contract's own layout, so adding this to a live proxy shifts no existing variable.
 *         The slot is keccak256(abi.encode(uint256(keccak256("sigvara.storage.InflowGuard")) - 1))
 *         & ~bytes32(uint256(0xff)), and a test recomputes it.
 */
abstract contract InflowGuard {
    /// Holder may pause inflows. It can do nothing else: it cannot move funds, change a parameter
    /// or touch a role.
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

    /// How long one pause lasts.
    uint256 public constant PAUSE_DURATION = 3 days;

    /// How long after the end of a pause the next one may not begin.
    uint256 public constant PAUSE_COOLDOWN = 1 days;

    bytes32 private constant INFLOW_GUARD_STORAGE =
        0x287c8fb15631f80ef6f31f6f05488520b9eeb2c6cd268d791bdb00597a165800;

    /// @custom:storage-location erc7201:sigvara.storage.InflowGuard
    struct InflowGuardStorage {
        uint64 pausedUntil;   // inflows are closed while block.timestamp < pausedUntil
        uint64 lastPausedAt;  // when the latest pause began, zero if none ever did
    }

    event InflowsPaused(address indexed by, uint256 until);
    event InflowsResumed(address indexed by);

    /// Inflows are closed until `until`.
    error InflowsPausedUntil(uint256 until);
    error InflowsNotPaused();
    /// A pause is already running and ends at `until`.
    error InflowsAlreadyPaused(uint256 until);
    /// The last pause began too recently: the next one may begin at `availableAt`.
    error PauseCooldownActive(uint256 availableAt);

    /// Reverts while a pause is running. Put it on the functions that take something in.
    modifier whenInflowsOpen() {
        uint256 until = _inflowGuard().pausedUntil;
        if (block.timestamp < until) revert InflowsPausedUntil(until);
        _;
    }

    /// @notice Close the inflows for PAUSE_DURATION. Guardian only.
    function pauseInflows() external {
        _checkGuardian();
        InflowGuardStorage storage g = _inflowGuard();

        if (block.timestamp < g.pausedUntil) revert InflowsAlreadyPaused(g.pausedUntil);
        if (g.lastPausedAt != 0) {
            uint256 availableAt = uint256(g.lastPausedAt) + PAUSE_DURATION + PAUSE_COOLDOWN;
            if (block.timestamp < availableAt) revert PauseCooldownActive(availableAt);
        }

        uint256 until = block.timestamp + PAUSE_DURATION;
        // A timestamp fits in 64 bits for the next 584 billion years, so neither cast truncates.
        // forge-lint: disable-next-line(unsafe-typecast)
        g.lastPausedAt = uint64(block.timestamp);
        // forge-lint: disable-next-line(unsafe-typecast)
        g.pausedUntil = uint64(until);
        emit InflowsPaused(msg.sender, until);
    }

    /// @notice Reopen the inflows before the pause runs out. The guardian or the admin. It does not
    ///         shorten the cooldown: the next pause is counted from the start of this one.
    function resumeInflows() external {
        _checkGuardianOrAdmin();
        InflowGuardStorage storage g = _inflowGuard();
        if (block.timestamp >= g.pausedUntil) revert InflowsNotPaused();
        g.pausedUntil = 0;
        emit InflowsResumed(msg.sender);
    }

    /// @notice True while a pause is running.
    function inflowsPaused() external view returns (bool) {
        return block.timestamp < _inflowGuard().pausedUntil;
    }

    /// @notice When the running pause ends, or an earlier time if none is running.
    function inflowsPausedUntil() external view returns (uint256) {
        return _inflowGuard().pausedUntil;
    }

    /// @notice When the latest pause began, zero if none ever did.
    function lastInflowPauseAt() external view returns (uint256) {
        return _inflowGuard().lastPausedAt;
    }

    /// Reverts unless the caller holds GUARDIAN_ROLE. Implemented by the registry, which owns the roles.
    function _checkGuardian() internal view virtual;

    /// Reverts unless the caller holds GUARDIAN_ROLE or DEFAULT_ADMIN_ROLE.
    function _checkGuardianOrAdmin() internal view virtual;

    function _inflowGuard() private pure returns (InflowGuardStorage storage g) {
        bytes32 slot = INFLOW_GUARD_STORAGE;
        assembly {
            g.slot := slot
        }
    }
}
