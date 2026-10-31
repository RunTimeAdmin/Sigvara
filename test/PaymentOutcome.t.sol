// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "@openzeppelin/contracts/interfaces/IERC1271.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {PaymentOutcomeVectors as V} from "./vectors/PaymentOutcomeVectors.sol";

// The payment-outcome vectors (docs/adr/0006-payer-signed-outcomes.md), checked on chain.
//
// The oracle and the SDK verify a payer's signature off chain, and ADR 0006 says they apply the
// rule OpenZeppelin's SignatureChecker applies on chain. This is where that is checked: the
// domain separator comes from OpenZeppelin's own EIP712 at the testnet SigvaraReputation proxy's
// address and chain, every digest from its _hashTypedDataV4, the signatures from Foundry's
// signer, and the verdicts from SignatureChecker. test/vectors/payment-outcome.json holds the same
// cases for the JavaScript side, and scripts/check-outcome-vectors.mjs keeps the two equal.

/// A verifier built on OpenZeppelin's EIP712 with the domain ADR 0006 fixes.
contract OutcomeDomain is EIP712("Sigvara", "1") {
    function separator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function digest(bytes32 structHash) external view returns (bytes32) {
        return _hashTypedDataV4(structHash);
    }
}

/// An account that says yes to a signature by its owner, as most smart accounts do.
contract OwnerAccount {
    address public owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function signedByOwner(bytes32 hash, bytes calldata signature) internal view returns (bool) {
        (address got, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        return err == ECDSA.RecoverError.NoError && got == owner;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view virtual returns (bytes4) {
        return signedByOwner(hash, signature) ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }
}

/// Answers with the magic value and then a second word.
contract LongerAccount is OwnerAccount {
    constructor(address owner_) OwnerAccount(owner_) {}

    function isValidSignature(bytes32 hash, bytes calldata signature) external view override returns (bytes4) {
        bytes4 answer = signedByOwner(hash, signature) ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
        assembly {
            mstore(0x00, answer)
            mstore(0x20, 1)
            return(0x00, 0x40)
        }
    }
}

/// Answers with the four magic bytes alone.
contract ShortAccount is OwnerAccount {
    constructor(address owner_) OwnerAccount(owner_) {}

    function isValidSignature(bytes32 hash, bytes calldata signature) external view override returns (bytes4) {
        bytes4 answer = signedByOwner(hash, signature) ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
        assembly {
            mstore(0x00, answer)
            return(0x00, 0x04)
        }
    }
}

/// Writes storage while answering, which ERC-1271 forbids and a static call refuses.
contract WritingAccount {
    address public owner;
    uint256 public asked;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external returns (bytes4) {
        asked += 1;
        (address got, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        return err == ECDSA.RecoverError.NoError && got == owner ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }
}

contract PaymentOutcomeTest is Test {
    bytes32 constant DOMAIN_TYPE_HASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    function key(string memory name) internal pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked("sigvara/payment-outcome/vector/", name)));
    }

    function separator(uint256 chainId, address verifyingContract) internal pure returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPE_HASH, keccak256("Sigvara"), keccak256("1"), chainId, verifyingContract));
    }

    function structHash(V.Case memory c) internal pure returns (bytes32) {
        return keccak256(abi.encode(V.TYPE_HASH, c.didHash, c.txHash, c.payer, c.outcome, c.evidence, c.signedAt, c.deadline));
    }

    function same(string memory a, string memory b) internal pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    function accountArtifact(string memory kind) internal pure returns (string memory) {
        if (same(kind, "owner")) return "PaymentOutcome.t.sol:OwnerAccount";
        if (same(kind, "longer")) return "PaymentOutcome.t.sol:LongerAccount";
        if (same(kind, "short")) return "PaymentOutcome.t.sol:ShortAccount";
        if (same(kind, "writes")) return "PaymentOutcome.t.sol:WritingAccount";
        revert(string.concat("no account of kind ", kind));
    }

    /// SignatureChecker in a frame of its own with bounded gas, so a case whose account burns
    /// what it is given (a write inside a static call does) cannot starve the cases after it.
    function check(address payer, bytes32 digest, bytes calldata signature) external view returns (bool) {
        return SignatureChecker.isValidSignatureNow(payer, digest, signature);
    }

    function test_typeHashIsTheAdrType() public pure {
        assertEq(keccak256(bytes(V.TYPE_STRING)), V.TYPE_HASH);
    }

    function test_keysAreTheVectorsAddresses() public pure {
        assertEq(vm.addr(key("payer")), V.PAYER);
        assertEq(vm.addr(key("owner")), V.OWNER);
        assertEq(vm.addr(key("other")), V.OTHER);
        assertEq(address(uint160(uint256(keccak256("sigvara/payment-outcome/vector/account")))), V.ACCOUNT);
    }

    function test_domainAndDigestsAreOpenZeppelinsAtTheTestnetProxy() public {
        vm.chainId(V.CHAIN_ID);
        deployCodeTo("PaymentOutcome.t.sol:OutcomeDomain", V.REPUTATION);
        OutcomeDomain d = OutcomeDomain(V.REPUTATION);
        assertEq(d.separator(), V.DOMAIN_SEPARATOR);
        assertEq(separator(V.CHAIN_ID, V.REPUTATION), V.DOMAIN_SEPARATOR);
        V.Case[] memory cs = V.cases();
        for (uint256 i = 0; i < cs.length; i++) {
            assertEq(d.digest(structHash(cs[i])), cs[i].digest, cs[i].name);
        }
    }

    function test_signaturesAreWhatTheVectorKeysSign() public pure {
        V.Case[] memory cs = V.cases();
        uint256 signedHere;
        for (uint256 i = 0; i < cs.length; i++) {
            V.Case memory c = cs[i];
            // The malleable twin is derived from another case, not signed.
            if (bytes(c.signedBy).length == 0) continue;
            bytes32 under = MessageHashUtils.toTypedDataHash(separator(c.signedChainId, c.signedContract), structHash(c));
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(key(c.signedBy), under);
            assertEq(abi.encodePacked(r, s, v), c.signature, c.name);
            signedHere++;
        }
        assertEq(signedHere, cs.length - 1);
    }

    function test_signatureCheckerGivesEveryVerdict() public {
        V.Case[] memory cs = V.cases();
        for (uint256 i = 0; i < cs.length; i++) {
            V.Case memory c = cs[i];
            uint256 snap = vm.snapshotState();
            if (bytes(c.account).length > 0) {
                deployCodeTo(accountArtifact(c.account), abi.encode(c.accountOwner), c.payer);
            } else {
                assertEq(c.payer.code.length, 0, c.name);
            }
            assertEq(this.check{gas: 5_000_000}(c.payer, c.digest, c.signature), c.valid, c.name);
            vm.revertToState(snap);
        }
    }

    function test_theWritingAccountIsRefusedOnlyForWriting() public {
        V.Case[] memory cs = V.cases();
        for (uint256 i = 0; i < cs.length; i++) {
            if (!same(cs[i].account, "writes")) continue;
            deployCodeTo(accountArtifact("writes"), abi.encode(cs[i].accountOwner), cs[i].payer);
            // Called normally it says yes, so SignatureChecker's no is the static call refusing the write.
            assertEq(WritingAccount(cs[i].payer).isValidSignature(cs[i].digest, cs[i].signature), IERC1271.isValidSignature.selector);
            assertFalse(this.check{gas: 5_000_000}(cs[i].payer, cs[i].digest, cs[i].signature));
            return;
        }
        revert("no writes case");
    }

    function test_theMalleableTwinRecoversThePayer() public pure {
        V.Case[] memory cs = V.cases();
        for (uint256 i = 0; i < cs.length; i++) {
            if (!same(cs[i].name, "malleable_twin")) continue;
            bytes memory sig = cs[i].signature;
            bytes32 r;
            bytes32 s;
            uint8 v;
            assembly {
                r := mload(add(sig, 0x20))
                s := mload(add(sig, 0x40))
                v := byte(0, mload(add(sig, 0x60)))
            }
            // Plain ecrecover takes it, so OpenZeppelin's refusal is the high s and nothing else.
            assertEq(ecrecover(cs[i].digest, v, r, s), V.PAYER);
            return;
        }
        revert("no malleable_twin case");
    }
}
