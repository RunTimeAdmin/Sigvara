// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/Ownable2Step.sol";

import "./interfaces/ISigvara.sol";
import "./interfaces/IERC8004.sol";

/**
 * @title SigvaraValidator
 * @notice Answers ERC-8004 validation requests with the Sigvara score
 *         (docs/adr/0014-answer-erc8004-validation-requests.md).
 *
 * An ERC-8004 agent linked to a Sigvara agent opens a request in the ERC-8004 Validation
 * Registry that names this contract. The publisher, which owns this contract, answers with the
 * linked agent's spendable score and keeps the answer current. This contract refuses any answer
 * that is not true on chain in the block it is given:
 *
 *   - The request's ERC-8004 agent must name the Sigvara agent in its `sigvara` metadata and be
 *     owned by that agent's operator. That is the test a link must still pass whenever the oracle
 *     reads it (claimHolds in oracle/external.js).
 *   - The response must equal SigvaraReputation.getTotalScore for that agent.
 *   - Once the Sigvara agent a request was last answered for is Slashed, the answer is 0, whatever
 *     its link says now, so clearing the link cannot keep a slashed score showing.
 *
 * What it cannot check is history. The oracle also requires that the operator owned the ERC-8004
 * agent when it set the key, and when several of an operator's agents name the same Sigvara agent
 * it takes the newest claim (oracle/link-scan.js). Which ERC-8004 agent gets the answer is
 * therefore the publisher's choice, made by those rules. A stolen owner key can delay, skip or
 * retire answers, or answer for another agent the operator owns that names the same Sigvara agent,
 * but it cannot publish a score that SigvaraReputation does not hold. The response file is not
 * checked either: it is the publisher's, and it names the block anyone can check it against.
 *
 * One request is kept per ERC-8004 agent, the first one answered, and every other request for that
 * agent is refused. getSummary(agentId, [this], "sigvara") then counts at most one answer, and the
 * gas spent answering grows with linked agents, not with the requests an agent's owner opens.
 *
 * Ownership moves in two steps, so a new publisher key keeps this address and every kept request,
 * and it cannot be renounced. There is no proxy. If the registry's interface changes, a new
 * validator is deployed and agents open new requests.
 */
contract SigvaraValidator is Ownable2Step {
    /// @notice The tag of a live answer. The feedback tag and the link key are the same word.
    string public constant TAG = "sigvara";
    /// @notice The tag of a retired answer. A summary filtered on TAG stops counting it.
    string public constant RETIRED_TAG = "sigvara-unlinked";
    /// @notice The metadata key under which an ERC-8004 agent names its Sigvara agent's didHash.
    string public constant LINK_KEY = "sigvara";

    /// @notice The gas a link check gives the Identity Registry to read the LINK_KEY value. A
    ///         32-byte value needs a fraction of it. The value's size is the agent owner's choice,
    ///         so a larger one runs out of this allowance and reads as no link, at a bounded cost,
    ///         rather than making a retire too expensive to send.
    uint256 public constant METADATA_READ_GAS = 50_000;

    IERC8004Validation public immutable validationRegistry;
    IERC8004Identity public immutable agentRegistry;
    ISigvaraIdentity public immutable identity;
    ISigvaraReputation public immutable reputation;

    /// @notice The request kept for an ERC-8004 agent: the first one this contract answered. Zero
    ///         until then, which is why a request hash of zero is never answered.
    mapping(uint256 => bytes32) public keptRequest;

    /// @notice The Sigvara agent a kept request was last answered for. A retire leaves it, so a
    ///         later slash of that agent can still set the answer to 0.
    mapping(bytes32 => bytes32) public answeredFor;

    /// @notice The kept request a Sigvara agent's score was last answered on while linked. When the
    ///         publisher moves the score to a newer ERC-8004 agent of the same operator, the older
    ///         request can be retired even though its agent still names the Sigvara agent.
    mapping(bytes32 => bytes32) public liveRequest;

    event Answered(uint256 indexed agentId, bytes32 indexed requestHash, bytes32 indexed didHash, uint8 response);
    event Retired(uint256 indexed agentId, bytes32 indexed requestHash, bytes32 indexed didHash);

    error ZeroAddress();
    error RegistryMismatch();
    error ZeroRequestHash();
    error NotThisValidator(bytes32 requestHash);
    error NotKeptRequest(bytes32 keptRequestHash);
    error LinkDoesNotHold(uint256 agentId, bytes32 didHash);
    error ScoreMismatch(uint8 expected);
    error NeverAnswered(bytes32 requestHash);
    error LinkStillHolds(uint256 agentId, bytes32 didHash);
    error AgentSlashed(bytes32 didHash);
    error GasTooLow();
    error RenounceDisabled();

    /// @dev The Validation Registry must be bound to `agentRegistry_`: links are judged against the
    ///      agents that registry's requests name.
    constructor(
        address owner_,
        address validationRegistry_,
        address agentRegistry_,
        address identity_,
        address reputation_
    ) Ownable(owner_) {
        if (
            validationRegistry_ == address(0) || agentRegistry_ == address(0) || identity_ == address(0)
                || reputation_ == address(0)
        ) revert ZeroAddress();
        if (IERC8004Validation(validationRegistry_).getIdentityRegistry() != agentRegistry_) revert RegistryMismatch();
        validationRegistry = IERC8004Validation(validationRegistry_);
        agentRegistry = IERC8004Identity(agentRegistry_);
        identity = ISigvaraIdentity(identity_);
        reputation = ISigvaraReputation(reputation_);
    }

    /**
     * @notice Answers `requestHash` with the spendable score of the Sigvara agent `didHash`.
     * @dev The request must name this contract and be its agent's kept request; the first request
     *      answered for an agent becomes the kept one. Then either the link holds and `response`
     *      equals getTotalScore(didHash), or the request was last answered for `didHash`, that
     *      agent is Slashed, and `response` is 0.
     */
    function answer(
        bytes32 requestHash,
        bytes32 didHash,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash
    ) external onlyOwner {
        uint256 agentId = _keep(requestHash);
        if (answeredFor[requestHash] == didHash && _isSlashed(didHash)) {
            if (response != 0) revert ScoreMismatch(0);
        } else {
            if (!linkHolds(agentId, didHash)) revert LinkDoesNotHold(agentId, didHash);
            uint8 score = reputation.getTotalScore(didHash);
            if (response != score) revert ScoreMismatch(score);
            liveRequest[didHash] = requestHash;
        }
        answeredFor[requestHash] = didHash;
        emit Answered(agentId, requestHash, didHash, response);
        validationRegistry.validationResponse(requestHash, response, responseURI, responseHash, TAG);
    }

    /**
     * @notice Answers a kept request with 0 and RETIRED_TAG once its link no longer holds, or once
     *         its Sigvara agent's score has been answered on another ERC-8004 agent's request.
     * @dev Refused for good once the Sigvara agent it was last answered for is Slashed, so a slashed
     *      agent's zero stays.
     */
    function retire(bytes32 requestHash, string calldata responseURI, bytes32 responseHash) external onlyOwner {
        bytes32 didHash = answeredFor[requestHash];
        if (didHash == bytes32(0)) revert NeverAnswered(requestHash);
        (, uint256 agentId,,,,) = validationRegistry.getValidationStatus(requestHash);
        if (_isSlashed(didHash)) revert AgentSlashed(didHash);
        if (liveRequest[didHash] == requestHash && linkHolds(agentId, didHash)) {
            revert LinkStillHolds(agentId, didHash);
        }
        emit Retired(agentId, requestHash, didHash);
        validationRegistry.validationResponse(requestHash, 0, responseURI, responseHash, RETIRED_TAG);
    }

    /**
     * @notice Whether the ERC-8004 agent `agentId` names the Sigvara agent `didHash` under LINK_KEY
     *         and is owned by that agent's operator, now.
     */
    function linkHolds(uint256 agentId, bytes32 didHash) public view returns (bool) {
        // A call passes on at most 63/64 of the gas left (EIP-150). Make sure the read gets its
        // whole allowance, so a short gas limit cannot make a link that holds read as gone.
        if (gasleft() < (METADATA_READ_GAS * 64) / 63 + 10_000) revert GasTooLow();
        (bool ok, bytes memory ret) = address(agentRegistry).staticcall{gas: METADATA_READ_GAS}(
            abi.encodeCall(IERC8004Identity.getMetadata, (agentId, LINK_KEY))
        );
        // A 32-byte value comes back as three words: its offset, its length and the value.
        if (!ok || ret.length != 96) return false;
        (uint256 offset, uint256 length, bytes32 named) = abi.decode(ret, (uint256, uint256, bytes32));
        if (offset != 32 || length != 32 || named != didHash) return false;

        ISigvaraIdentity.AgentIdentity memory agent = identity.getIdentity(didHash);
        if (agent.registeredAt == 0) return false;
        try agentRegistry.ownerOf(agentId) returns (address owner_) {
            return owner_ == agent.operator;
        } catch {
            return false;
        }
    }

    /// @notice Disabled. Without an owner, a later slash could never be written as a zero, and every
    ///         kept request would be stranded.
    function renounceOwnership() public pure override {
        revert RenounceDisabled();
    }

    /// @dev The ERC-8004 agent of `requestHash`, once the request is known to be this contract's
    ///      and its agent's kept one. Records it as kept if the agent has none yet.
    function _keep(bytes32 requestHash) private returns (uint256 agentId) {
        if (requestHash == bytes32(0)) revert ZeroRequestHash();
        address validator;
        (validator, agentId,,,,) = validationRegistry.getValidationStatus(requestHash);
        if (validator != address(this)) revert NotThisValidator(requestHash);
        bytes32 kept = keptRequest[agentId];
        if (kept == bytes32(0)) keptRequest[agentId] = requestHash;
        else if (kept != requestHash) revert NotKeptRequest(kept);
    }

    function _isSlashed(bytes32 didHash) private view returns (bool) {
        ISigvaraIdentity.AgentIdentity memory agent = identity.getIdentity(didHash);
        return agent.registeredAt != 0 && agent.status == ISigvaraIdentity.AgentStatus.Slashed;
    }
}
