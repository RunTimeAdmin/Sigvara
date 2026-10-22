// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {
    ISigvaraIdentity,
    ISigvaraReputation,
    ISigvaraStaking,
    ISigvaraReader
} from "./interfaces/ISigvara.sol";

/**
 * @title SigvaraReader
 * @notice One call that answers whether an agent is in good standing and what stands
 *         behind it, for contracts that would otherwise make several calls across three
 *         registries, every one keyed by a didHash they have to derive first.
 *
 * @dev    Read-only, stateless and not upgradeable. It holds no funds and no roles, and
 *         its only storage is three immutable addresses. Nothing in the protocol reads
 *         from it, so deploying or replacing one carries no protocol risk. It is a
 *         convenience and not part of the trust model: it adds no rule the registries do
 *         not already enforce, and it cannot change an answer they give.
 *
 *         Point it at the registry PROXIES, whose addresses are stable. If a registry
 *         upgrade ever changes a function this reads, deploy a new reader. There is
 *         nothing to migrate.
 *
 *         Four things it does on purpose, because the raw reads get them wrong:
 *
 *         - `isTrusted` requires Active status as well as a score. `meetsThreshold` only
 *           compares a number, so a Suspended agent keeps its score and a threshold of
 *           zero is met by an address that was never registered.
 *         - `isTrusted` also requires that the bond held now meets the staking contract's
 *           CURRENT minimum. Status is stored and the minimum can be raised, so an agent
 *           admitted at the old minimum stays Active, with its score, while holding less
 *           than the new one asks. `collateralized` reports the same check.
 *         - `registered` is reported separately. AgentStatus.Active is the zero value, so
 *           an unregistered address reads as Active until registeredAt is checked.
 *         - The score is the spendable one, which is what `meetsThreshold` uses. The
 *           earned score comes back beside it so a caller can see how much of a recent
 *           increase is still being released.
 */
contract SigvaraReader is ISigvaraReader {
    ISigvaraIdentity public immutable identity;
    ISigvaraReputation public immutable reputation;
    ISigvaraStaking public immutable staking;

    error ZeroAddress();

    constructor(address identity_, address reputation_, address staking_) {
        if (identity_ == address(0) || reputation_ == address(0) || staking_ == address(0)) {
            revert ZeroAddress();
        }
        identity = ISigvaraIdentity(identity_);
        reputation = ISigvaraReputation(reputation_);
        staking = ISigvaraStaking(staking_);
    }

    /// @inheritdoc ISigvaraReader
    function didHashOf(address agent) external view returns (bytes32) {
        return identity.computeDidHash(agent);
    }

    /// @inheritdoc ISigvaraReader
    function trust(address agent) external view returns (Trust memory) {
        return _trust(identity.computeDidHash(agent));
    }

    /// @inheritdoc ISigvaraReader
    function trustByDid(bytes32 didHash) external view returns (Trust memory) {
        return _trust(didHash);
    }

    /// @inheritdoc ISigvaraReader
    function isTrusted(address agent, uint8 minScore) external view returns (bool) {
        bytes32 didHash = identity.computeDidHash(agent);
        return identity.isActive(didHash)
            && staking.hasMinimumStake(didHash)
            && reputation.meetsThreshold(didHash, minScore);
    }

    function _trust(bytes32 didHash) internal view returns (Trust memory t) {
        ISigvaraIdentity.AgentIdentity memory id = identity.getIdentity(didHash);

        // Nothing can be staked or scored for an agent that was never registered, so
        // there is nothing further to read, and `status` would only be the zero value.
        if (id.registeredAt == 0) return t;

        t.registered = true;
        t.status = id.status;
        t.active = id.status == ISigvaraIdentity.AgentStatus.Active;
        t.score = reputation.getTotalScore(didHash);
        t.earned = reputation.getEarnedScore(didHash);
        t.stake = staking.getStake(didHash);
        t.slash = staking.getSlashProposal(didHash).state;
        t.collateralized = staking.hasMinimumStake(didHash);
    }
}
