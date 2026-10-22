// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @notice The slice of SigvaraOracleBond that the contracts gating oracle writes need.
 * @dev    An interface rather than an import: the bond registry is deployed by its own
 *         script and is optional, so SigvaraReputation and SigvaraEpochFees should not carry
 *         a hard dependency on a contract that may not exist on a given chain.
 */
interface IOperatorSet {
    /// @notice Whether `account` may speak for an admitted, fully bonded operator: an Active
    ///         operator holding at least bondAmount, or the signer that operator registered.
    function isActiveOperator(address account) external view returns (bool);
}
