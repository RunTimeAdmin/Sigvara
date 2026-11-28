// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../src/SigvaraValidator.sol";

/// The ERC-8004 calls these tests make that the validator itself does not.
interface IAgentRegistryForTest {
    function register() external returns (uint256 agentId);
    function ownerOf(uint256 agentId) external view returns (address);
    function setMetadata(uint256 agentId, string calldata metadataKey, bytes calldata metadataValue) external;
    function transferFrom(address from, address to, uint256 agentId) external;
}

interface IValidationRegistryForTest {
    function validationRequest(address validatorAddress, uint256 agentId, string calldata requestURI, bytes32 requestHash)
        external;
    function getValidationStatus(bytes32 requestHash)
        external
        view
        returns (address, uint256, uint8, bytes32, string memory, uint256);
    function getSummary(uint256 agentId, address[] calldata validatorAddresses, string calldata tag)
        external
        view
        returns (uint64 count, uint8 avgResponse);
}

/**
 * SigvaraValidator against the live Arc testnet: the deployed ERC-8004 registries (2.0.0) and
 * Sigvara's own contracts. Forking rather than mocking the registries tests the code and the real
 * interfaces it calls: the Validation Registry's request and answer rules, the Identity Registry's
 * metadata, and SigvaraIdentity's struct layout.
 *
 *   forge test --match-contract SigvaraValidatorFork -vv
 *
 * The Sigvara agent is the simulation's solo agent. In setUp its operator makes a fresh link on
 * the fork, as an operator makes one on chain, so the tests do not depend on any live link
 * staying in place. Only a slash and an operator change are mocked (getIdentity, and getTotalScore
 * for a slash), since the real ones take a committee ruling or a transfer flow.
 */
contract SigvaraValidatorForkTest is Test {
    // ERC-8004 on Arc testnet.
    address constant AGENTS = 0x8004A818BFB912233c491871b3d84c89A494BD9e;
    address constant VALIDATIONS = 0x8004Cb1BF31DAf7788923b405b754f57acEB4272;
    // Sigvara on Arc testnet, from deployments/5042002.json.
    address constant IDENTITY = 0x7e3aFC532eE5d922ab3cc3FFb510c7C8151477Dd;
    address constant REPUTATION = 0x6603C96275e85F724Cdf74666b399365e4cA29ed;

    /// The simulation's solo agent, registered on Arc testnet.
    bytes32 constant DID = 0xb015ce41101a978a5b5a87596092d006aa4714b64271e003d23bdba531a2f557;

    string constant URI = "data:application/json;base64,e30=";
    bytes32 constant FILE_HASH = keccak256("{}");

    SigvaraValidator validator;
    IAgentRegistryForTest agents = IAgentRegistryForTest(AGENTS);
    IValidationRegistryForTest validations = IValidationRegistryForTest(VALIDATIONS);

    address publisher = makeAddr("publisher");
    address stranger = makeAddr("stranger");
    address operator;
    uint256 linked;
    uint8 score;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("arc_testnet"));
        validator = new SigvaraValidator(publisher, VALIDATIONS, AGENTS, IDENTITY, REPUTATION);

        operator = ISigvaraIdentity(IDENTITY).getIdentity(DID).operator;
        assertTrue(operator != address(0), "the simulation's solo agent is no longer registered");
        vm.startPrank(operator);
        linked = agents.register();
        agents.setMetadata(linked, "sigvara", abi.encodePacked(DID));
        vm.stopPrank();
        assertTrue(validator.linkHolds(linked, DID), "a fresh link by the operator does not hold");
        score = ISigvaraReputation(REPUTATION).getTotalScore(DID);
    }

    // ---- helpers ----

    function _request(uint256 agentId, address by, address named, string memory salt) internal returns (bytes32 h) {
        h = keccak256(abi.encode(agentId, named, salt));
        vm.prank(by);
        validations.validationRequest(named, agentId, "", h);
    }

    function _answer(bytes32 h, uint8 response) internal {
        vm.prank(publisher);
        validator.answer(h, DID, response, URI, FILE_HASH);
    }

    function _retire(bytes32 h) internal {
        vm.prank(publisher);
        validator.retire(h, URI, FILE_HASH);
    }

    function _summary(uint256 agentId, string memory tag) internal view returns (uint64 count, uint8 avg) {
        address[] memory only = new address[](1);
        only[0] = address(validator);
        return validations.getSummary(agentId, only, tag);
    }

    function _setLink(uint256 agentId, bytes memory value) internal {
        vm.prank(operator);
        agents.setMetadata(agentId, "sigvara", value);
    }

    function _mockIdentity(ISigvaraIdentity.AgentIdentity memory a) internal {
        vm.mockCall(IDENTITY, abi.encodeWithSelector(ISigvaraIdentity.getIdentity.selector, DID), abi.encode(a));
    }

    function _slash() internal {
        ISigvaraIdentity.AgentIdentity memory a = ISigvaraIdentity(IDENTITY).getIdentity(DID);
        a.status = ISigvaraIdentity.AgentStatus.Slashed;
        _mockIdentity(a);
        vm.mockCall(
            REPUTATION, abi.encodeWithSelector(ISigvaraReputation.getTotalScore.selector, DID), abi.encode(uint8(0))
        );
    }

    // ---- answering ----

    function test_answer_givesTheScoreOnChain() public {
        bytes32 h = _request(linked, operator, address(validator), "a");
        _answer(h, score);

        (address v, uint256 agentId, uint8 response,, string memory tag,) = validations.getValidationStatus(h);
        assertEq(v, address(validator));
        assertEq(agentId, linked);
        assertEq(response, score);
        assertEq(tag, "sigvara");
        (uint64 count, uint8 avg) = _summary(linked, "sigvara");
        assertEq(count, 1);
        assertEq(avg, score);
        assertEq(validator.keptRequest(linked), h);
        assertEq(validator.answeredFor(h), DID);
        assertEq(validator.liveRequest(DID), h);
    }

    function test_answer_refusesAnyOtherScore() public {
        bytes32 h = _request(linked, operator, address(validator), "a");
        uint8 wrong = score == 100 ? 99 : score + 1;
        vm.expectRevert(abi.encodeWithSelector(SigvaraValidator.ScoreMismatch.selector, score));
        _answer(h, wrong);
    }

    function test_answer_againUpdatesTheSameRequest() public {
        bytes32 h = _request(linked, operator, address(validator), "a");
        _answer(h, score);
        (,,,,, uint256 first) = validations.getValidationStatus(h);
        vm.warp(block.timestamp + 7 days);
        _answer(h, score);
        (,,,,, uint256 second) = validations.getValidationStatus(h);
        assertEq(second, first + 7 days);
        (uint64 count,) = _summary(linked, "sigvara");
        assertEq(count, 1);
    }

    function test_answer_keepsOneRequestPerAgent() public {
        bytes32 first = _request(linked, operator, address(validator), "a");
        bytes32 second = _request(linked, operator, address(validator), "b");
        _answer(first, score);
        vm.expectRevert(abi.encodeWithSelector(SigvaraValidator.NotKeptRequest.selector, first));
        _answer(second, score);
        (uint64 count,) = _summary(linked, "sigvara");
        assertEq(count, 1);
    }

    /// Zero means "no request kept yet", so a request with hash zero could never count as kept.
    function test_answer_refusesRequestHashZero() public {
        vm.expectRevert(SigvaraValidator.ZeroRequestHash.selector);
        _answer(bytes32(0), score);
    }

    function test_answer_refusesARequestForAnotherValidator() public {
        bytes32 h = _request(linked, operator, stranger, "a");
        vm.expectRevert(abi.encodeWithSelector(SigvaraValidator.NotThisValidator.selector, h));
        _answer(h, score);
    }

    function test_answer_refusesAnAgentThatNamesNoSigvaraAgent() public {
        vm.prank(stranger);
        uint256 unlinked = agents.register();
        bytes32 h = _request(unlinked, stranger, address(validator), "a");
        vm.expectRevert(abi.encodeWithSelector(SigvaraValidator.LinkDoesNotHold.selector, unlinked, DID));
        _answer(h, score);
    }

    /// Anyone can name a good agent's didHash in their own ERC-8004 agent. The link holds only for
    /// the Sigvara agent's operator, so the borrowed score is refused.
    function test_answer_refusesALinkTheOperatorDoesNotOwn() public {
        vm.startPrank(stranger);
        uint256 impostor = agents.register();
        agents.setMetadata(impostor, "sigvara", abi.encodePacked(DID));
        vm.stopPrank();
        bytes32 h = _request(impostor, stranger, address(validator), "a");
        assertFalse(validator.linkHolds(impostor, DID));
        vm.expectRevert(abi.encodeWithSelector(SigvaraValidator.LinkDoesNotHold.selector, impostor, DID));
        _answer(h, score);
    }

    function test_answer_refusesADidTheAgentDoesNotName() public {
        bytes32 h = _request(linked, operator, address(validator), "a");
        bytes32 other = keccak256("another sigvara agent");
        vm.expectRevert(abi.encodeWithSelector(SigvaraValidator.LinkDoesNotHold.selector, linked, other));
        vm.prank(publisher);
        validator.answer(h, other, 0, URI, FILE_HASH);
    }

    function test_answer_onlyTheOwner() public {
        bytes32 h = _request(linked, operator, address(validator), "a");
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vm.prank(stranger);
        validator.answer(h, DID, score, URI, FILE_HASH);
    }

    // ---- the link check ----

    function test_linkHolds_onlyForA32ByteValue() public {
        bytes memory short_ = new bytes(31);
        for (uint256 i; i < 31; i++) {
            short_[i] = DID[i];
        }
        bytes[3] memory values = [short_, abi.encodePacked(DID, bytes1(0)), abi.encodePacked(DID, DID)];
        for (uint256 i; i < values.length; i++) {
            _setLink(linked, values[i]);
            assertFalse(validator.linkHolds(linked, DID));
        }
    }

    function test_linkHolds_falseOnceTheSigvaraAgentChangesOperator() public {
        ISigvaraIdentity.AgentIdentity memory a = ISigvaraIdentity(IDENTITY).getIdentity(DID);
        a.operator = stranger;
        _mockIdentity(a);
        assertFalse(validator.linkHolds(linked, DID));
    }

    /// The contract sees only the present. An agent someone else set up and then handed to the
    /// operator passes linkHolds. The oracle refuses that claim (claimMadeByOperator in
    /// oracle/link-scan.js), so the publisher never answers it; only a stolen owner key could.
    function test_linkHolds_cannotSeeWhoSetTheKey() public {
        vm.startPrank(stranger);
        uint256 handedOver = agents.register();
        agents.setMetadata(handedOver, "sigvara", abi.encodePacked(DID));
        agents.transferFrom(stranger, operator, handedOver);
        vm.stopPrank();
        assertTrue(validator.linkHolds(handedOver, DID));
    }

    // ---- retiring ----

    function test_retire_refusedWhileTheLinkHolds() public {
        bytes32 h = _request(linked, operator, address(validator), "a");
        _answer(h, score);
        vm.expectRevert(abi.encodeWithSelector(SigvaraValidator.LinkStillHolds.selector, linked, DID));
        _retire(h);
    }

    function test_retire_afterTheLinkIsCleared() public {
        bytes32 h = _request(linked, operator, address(validator), "a");
        _answer(h, score);
        _setLink(linked, "");
        _retire(h);

        (,, uint8 response,, string memory tag,) = validations.getValidationStatus(h);
        assertEq(response, 0);
        assertEq(tag, "sigvara-unlinked");
        (uint64 count, uint8 avg) = _summary(linked, "sigvara");
        assertEq(count, 0, "a retired answer still counts");
        assertEq(avg, 0);
        // Nothing can be answered for the agent again until it links again.
        vm.expectRevert(abi.encodeWithSelector(SigvaraValidator.LinkDoesNotHold.selector, linked, DID));
        _answer(h, score);
    }

    function test_retire_afterTheAgentChangesHands() public {
        bytes32 h = _request(linked, operator, address(validator), "a");
        _answer(h, score);
        vm.prank(operator);
        agents.transferFrom(operator, stranger, linked);
        assertFalse(validator.linkHolds(linked, DID));
        _retire(h);
        (,,,, string memory tag,) = validations.getValidationStatus(h);
        assertEq(tag, "sigvara-unlinked");
    }

    /// When the score moves to a newer ERC-8004 agent of the same operator, the older agent still
    /// names the Sigvara agent, so its link still holds, but its answer can be retired.
    function test_retire_afterTheScoreMovesToANewerAgent() public {
        bytes32 older = _request(linked, operator, address(validator), "a");
        _answer(older, score);
        vm.prank(operator);
        uint256 newer = agents.register();
        _setLink(newer, abi.encodePacked(DID));
        bytes32 newest = _request(newer, operator, address(validator), "b");
        _answer(newest, score);
        assertEq(validator.liveRequest(DID), newest);

        assertTrue(validator.linkHolds(linked, DID));
        _retire(older);
        (uint64 count,) = _summary(linked, "sigvara");
        assertEq(count, 0);
        (uint64 newerCount, uint8 newerScore) = _summary(newer, "sigvara");
        assertEq(newerCount, 1);
        assertEq(newerScore, score);

        vm.expectRevert(abi.encodeWithSelector(SigvaraValidator.LinkStillHolds.selector, newer, DID));
        _retire(newest);
    }

    /// The value's size is the agent owner's choice. A large one must not make a retire too
    /// expensive to send: it reads as no link within METADATA_READ_GAS.
    function test_retire_afterAnOversizedValueStaysCheap() public {
        bytes32 h = _request(linked, operator, address(validator), "a");
        _answer(h, score);
        _setLink(linked, new bytes(6000));
        vm.expectRevert(abi.encodeWithSelector(SigvaraValidator.LinkDoesNotHold.selector, linked, DID));
        _answer(h, score);

        vm.cool(AGENTS);
        uint256 before = gasleft();
        _retire(h);
        uint256 used = before - gasleft();
        emit log_named_uint("retire gas with a 6,000-byte value", used);
        assertLt(used, 200_000);
    }

    function test_retire_refusesARequestNeverAnswered() public {
        bytes32 h = _request(linked, operator, address(validator), "a");
        vm.expectRevert(abi.encodeWithSelector(SigvaraValidator.NeverAnswered.selector, h));
        _retire(h);
    }

    function test_retire_onlyTheOwner() public {
        bytes32 h = _request(linked, operator, address(validator), "a");
        _answer(h, score);
        _setLink(linked, "");
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vm.prank(stranger);
        validator.retire(h, URI, FILE_HASH);
    }

    // ---- slashes ----

    function test_slash_whileLinked_answersZero() public {
        bytes32 h = _request(linked, operator, address(validator), "a");
        _answer(h, score);
        _slash();
        _answer(h, 0);
        (,, uint8 response,, string memory tag,) = validations.getValidationStatus(h);
        assertEq(response, 0);
        assertEq(tag, "sigvara");
    }

    /// Clearing the link after a slash cannot take the zero down: the answer stays 0 under
    /// `sigvara`, and it cannot be retired.
    function test_slash_zeroOutlivesTheLink() public {
        bytes32 h = _request(linked, operator, address(validator), "a");
        _answer(h, score);
        _setLink(linked, "");
        _slash();

        _answer(h, 0);
        (uint64 count, uint8 avg) = _summary(linked, "sigvara");
        assertEq(count, 1);
        assertEq(avg, 0);

        vm.expectRevert(abi.encodeWithSelector(SigvaraValidator.ScoreMismatch.selector, 0));
        _answer(h, 1);
        vm.expectRevert(abi.encodeWithSelector(SigvaraValidator.AgentSlashed.selector, DID));
        _retire(h);
    }

    /// A slash after a retire still reaches the request: the retired answer becomes a zero.
    function test_slash_afterARetireSetsZero() public {
        bytes32 h = _request(linked, operator, address(validator), "a");
        _answer(h, score);
        _setLink(linked, "");
        _retire(h);
        _slash();
        _answer(h, 0);
        (,, uint8 response,, string memory tag,) = validations.getValidationStatus(h);
        assertEq(response, 0);
        assertEq(tag, "sigvara");
    }

    // ---- ownership and construction ----

    function test_ownership_movesInTwoStepsAndKeepsTheRequests() public {
        bytes32 h = _request(linked, operator, address(validator), "a");
        _answer(h, score);
        address next = makeAddr("next publisher");

        vm.prank(publisher);
        validator.transferOwnership(next);
        assertEq(validator.pendingOwner(), next);
        _answer(h, score); // the old key answers until the new one accepts

        vm.prank(next);
        validator.acceptOwnership();
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, publisher));
        vm.prank(publisher);
        validator.answer(h, DID, score, URI, FILE_HASH);

        vm.prank(next);
        validator.answer(h, DID, score, URI, FILE_HASH);
        assertEq(validator.keptRequest(linked), h);
    }

    function test_renounceOwnership_isDisabled() public {
        vm.expectRevert(SigvaraValidator.RenounceDisabled.selector);
        vm.prank(publisher);
        validator.renounceOwnership();
        assertEq(validator.owner(), publisher);
    }

    function test_constructor_refusesAZeroAddress() public {
        vm.expectRevert(SigvaraValidator.ZeroAddress.selector);
        new SigvaraValidator(publisher, address(0), AGENTS, IDENTITY, REPUTATION);
        vm.expectRevert(SigvaraValidator.ZeroAddress.selector);
        new SigvaraValidator(publisher, VALIDATIONS, AGENTS, IDENTITY, address(0));
    }

    /// Links are judged against the agents the Validation Registry's requests name, so the two
    /// ERC-8004 addresses must belong together.
    function test_constructor_refusesRegistriesThatDoNotBelongTogether() public {
        vm.expectRevert(SigvaraValidator.RegistryMismatch.selector);
        new SigvaraValidator(publisher, VALIDATIONS, stranger, IDENTITY, REPUTATION);
    }
}
