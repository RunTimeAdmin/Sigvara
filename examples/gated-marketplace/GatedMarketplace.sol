// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISigvaraReader} from "../../src/interfaces/ISigvara.sol";

/**
 * @title GatedMarketplace
 * @notice Example of a contract that deals only with agents in good standing. An agent
 *         lists a service by calling `list`, which succeeds only while SigvaraReader
 *         says the agent is trusted at this marketplace's threshold. Anyone can remove
 *         a listing whose agent has since stopped qualifying.
 *
 * @dev    Illustrative: not audited and not meant to be deployed as it stands. It shows
 *         the three things a consumer usually needs: a gate at the point of entry, a
 *         way to keep the gate honest afterwards, and a read for a frontend that shows
 *         more than a yes or no.
 *
 *         The gate reads current standing, so a listing made yesterday says nothing
 *         about today. That is why `delistIfUntrusted` exists, and why `trustOf` reads
 *         live instead of from anything stored when the listing was made.
 */
contract GatedMarketplace {
    ISigvaraReader public immutable sigvara;

    /// Lowest spendable score an agent needs to list and to stay listed.
    uint8 public immutable minScore;

    struct Listing {
        address agent;
        bytes meta;
        uint64 listedAt;
    }

    mapping(uint256 => Listing) public listings;
    uint256 public nextId = 1;

    event Listed(uint256 indexed id, address indexed agent);
    event Delisted(uint256 indexed id);

    error NotTrusted(address agent);
    error NoSuchListing(uint256 id);
    error StillTrusted(uint256 id);

    constructor(address reader, uint8 minScore_) {
        sigvara = ISigvaraReader(reader);
        minScore = minScore_;
    }

    /// @notice List the caller, who is the agent address itself.
    function list(bytes calldata meta) external returns (uint256 id) {
        if (!sigvara.isTrusted(msg.sender, minScore)) revert NotTrusted(msg.sender);

        id = nextId++;
        listings[id] = Listing({agent: msg.sender, meta: meta, listedAt: uint64(block.timestamp)});
        emit Listed(id, msg.sender);
    }

    /// @notice Remove a listing whose agent no longer qualifies. Anyone may call this,
    ///         so the marketplace stays current without the agent's cooperation.
    function delistIfUntrusted(uint256 id) external {
        address agent = listings[id].agent;
        if (agent == address(0)) revert NoSuchListing(id);
        if (sigvara.isTrusted(agent, minScore)) revert StillTrusted(id);

        delete listings[id];
        emit Delisted(id);
    }

    /// @notice Everything a frontend needs to show beside a listing, read live.
    function trustOf(uint256 id) external view returns (ISigvaraReader.Trust memory) {
        address agent = listings[id].agent;
        if (agent == address(0)) revert NoSuchListing(id);
        return sigvara.trust(agent);
    }
}
