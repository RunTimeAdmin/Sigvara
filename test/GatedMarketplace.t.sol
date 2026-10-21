// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./helpers/StackFixture.sol";
import {ISigvaraIdentity, ISigvaraStaking, ISigvaraReader} from "../src/interfaces/ISigvara.sol";
import "../examples/gated-marketplace/GatedMarketplace.sol";

/// The example consumer in examples/gated-marketplace, run against the real registries.
contract GatedMarketplaceTest is StackFixture {
    GatedMarketplace market;
    address agent;
    uint256 agentPk;

    uint8 constant MIN_SCORE = 40;

    function setUp() public {
        _deployStack();
        (agent, agentPk) = makeAddrAndKey("agent");
        market = new GatedMarketplace(address(reader), MIN_SCORE);
    }

    function test_list_refusesAnAgentThatHasNoScore() public {
        _registerAndBond(agentPk, 2 * MIN_STAKE);

        vm.expectRevert(abi.encodeWithSelector(GatedMarketplace.NotTrusted.selector, agent));
        vm.prank(agent);
        market.list("service");
    }

    function test_list_refusesAnAddressThatIsNotRegistered() public {
        vm.expectRevert(abi.encodeWithSelector(GatedMarketplace.NotTrusted.selector, agent));
        vm.prank(agent);
        market.list("service");
    }

    function test_list_acceptsATrustedAgent() public {
        bytes32 didHash = _registerAndBond(agentPk, 2 * MIN_STAKE);
        _finalize(didHash, _score40());

        vm.prank(agent);
        uint256 id = market.list("service");

        (address listed, bytes memory meta, uint64 listedAt) = market.listings(id);
        assertEq(listed, agent);
        assertEq(meta, "service");
        assertEq(listedAt, block.timestamp);
    }

    function test_delistIfUntrusted_keepsAListingWhileTheAgentQualifiesAndDropsItAfter() public {
        bytes32 didHash = _registerAndBond(agentPk, 2 * MIN_STAKE);
        _finalize(didHash, _score40());
        vm.prank(agent);
        uint256 id = market.list("service");

        vm.expectRevert(abi.encodeWithSelector(GatedMarketplace.StillTrusted.selector, id));
        market.delistIfUntrusted(id);

        vm.prank(operator);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Suspended);

        market.delistIfUntrusted(id); // anyone may call it
        (address listed,,) = market.listings(id);
        assertEq(listed, address(0));

        vm.expectRevert(abi.encodeWithSelector(GatedMarketplace.NoSuchListing.selector, id));
        market.delistIfUntrusted(id);
    }

    /// The read shown beside a listing is live: it follows the agent's standing and
    /// does not freeze at what it was when the listing was made.
    function test_trustOf_followsTheAgentAfterListing() public {
        bytes32 didHash = _registerAndBond(agentPk, 2 * MIN_STAKE);
        _finalize(didHash, _score40());
        vm.prank(agent);
        uint256 id = market.list("service");

        ISigvaraReader.Trust memory t = market.trustOf(id);
        assertTrue(t.active);
        assertEq(t.score, 40);
        assertEq(t.stake, 2 * MIN_STAKE);

        vm.prank(committee);
        staking.initiateSlash(didHash, victim, "evidence");

        t = market.trustOf(id);
        assertFalse(t.active);
        assertEq(uint8(t.slash), uint8(ISigvaraStaking.SlashState.Pending));
        assertEq(uint8(t.status), uint8(ISigvaraIdentity.AgentStatus.Suspended));

        vm.expectRevert(abi.encodeWithSelector(GatedMarketplace.NoSuchListing.selector, id + 1));
        market.trustOf(id + 1);
    }
}
