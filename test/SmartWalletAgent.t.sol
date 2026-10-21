// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./helpers/StackFixture.sol";
import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

contract AgentNFT is ERC721 {
    constructor() ERC721("Agent", "AGENT") {}

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }
}

/// The part of an ERC-6551 token-bound account that registration touches: a contract
/// wallet bound to one NFT, which answers ERC-1271 by asking whether the NFT's current
/// holder signed. ERC-6551 requires that of every account, and by default treats the
/// holder as the valid signer. This is a stand-in, not a production account.
contract TokenBoundAccount {
    ERC721 public immutable nft;
    uint256 public immutable tokenId;

    constructor(ERC721 nft_, uint256 tokenId_) {
        nft = nft_;
        tokenId = tokenId_;
    }

    function owner() public view returns (address) {
        return nft.ownerOf(tokenId);
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        return SignatureChecker.isValidSignatureNow(owner(), hash, signature)
            ? bytes4(0x1626ba7e)
            : bytes4(0xffffffff);
    }
}

/// Smart-wallet agents: what registering a token-bound account looks like, and what
/// selling the NFT behind one does and does not change. See docs/smart-wallet-agents.md.
contract SmartWalletAgentTest is StackFixture {
    AgentNFT nft;
    TokenBoundAccount account;
    address holder;
    uint256 holderPk;

    uint256 constant TOKEN_ID = 7;

    function setUp() public {
        _deployStack();
        (holder, holderPk) = makeAddrAndKey("holder");
        nft = new AgentNFT();
        nft.mint(holder, TOKEN_ID);
        account = new TokenBoundAccount(nft, TOKEN_ID);
    }

    /// What the NFT's holder signs: the registration digest, which names the operator
    /// that will submit it, wrapped the way personal_sign wraps it.
    function _signedBy(uint256 pk, address operator_) internal view returns (bytes memory) {
        bytes32 digest = identity.registrationDigest(address(account), operator_, PUB_KEY);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, MessageHashUtils.toEthSignedMessageHash(digest));
        return abi.encodePacked(r, s, v);
    }

    function test_account_registersWithItsHoldersSignatureAndIsTrustedOnceBonded() public {
        bytes memory signature = _signedBy(holderPk, operator);

        vm.prank(operator);
        bytes32 didHash = identity.registerAgent(address(account), PUB_KEY, signature);

        assertEq(didHash, identity.computeDidHash(address(account)));
        assertFalse(reader.isTrusted(address(account), 0), "registration alone does not activate");

        vm.prank(operator);
        staking.depositStake(didHash, MIN_STAKE);
        assertTrue(reader.isTrusted(address(account), 0));
    }

    function test_account_refusesASignatureFromSomeoneWhoDoesNotHoldTheNft() public {
        (, uint256 strangerPk) = makeAddrAndKey("stranger");
        bytes memory signature = _signedBy(strangerPk, operator);

        vm.expectRevert(
            abi.encodeWithSelector(SigvaraIdentity.BadRegistrationSignature.selector, address(account))
        );
        vm.prank(operator);
        identity.registerAgent(address(account), PUB_KEY, signature);
    }

    /// Control of the wallet is read from the NFT as it stands now, but registration
    /// checks it once. Selling the NFT hands the buyer the wallet and leaves the
    /// identity, its bond and its operator where they were.
    function test_account_sellingTheNftDoesNotMoveTheOperator() public {
        bytes memory signature = _signedBy(holderPk, operator);
        vm.prank(operator);
        bytes32 didHash = identity.registerAgent(address(account), PUB_KEY, signature);
        vm.prank(operator);
        staking.depositStake(didHash, MIN_STAKE);

        address buyer = makeAddr("buyer");
        vm.prank(holder);
        nft.transferFrom(holder, buyer, TOKEN_ID);

        // The seller's signature stops being one the account accepts.
        assertFalse(identity.verifyRegistration(address(account), operator, PUB_KEY, signature));

        // Registration stands, and so does the agent's standing.
        assertEq(identity.getIdentity(didHash).operator, operator);
        assertTrue(reader.isTrusted(address(account), 0));

        // The buyer controls the wallet and not the identity.
        vm.expectRevert(abi.encodeWithSelector(SigvaraIdentity.NotOperator.selector, didHash, buyer));
        vm.prank(buyer);
        identity.updateStatus(didHash, SigvaraIdentity.AgentStatus.Suspended);

        // Handing the identity over is the operator's two-step transfer.
        vm.prank(operator);
        identity.offerOperatorTransfer(didHash, buyer);
        vm.prank(buyer);
        identity.acceptOperatorTransfer(didHash);

        assertEq(identity.getIdentity(didHash).operator, buyer);
        assertEq(identity.operatorTransferCount(didHash), 1);
    }
}
