# Smart-wallet agents

An agent address does not have to be an externally owned account. Registration accepts any
address that can validate an ERC-1271 signature, which covers ERC-6551 token-bound accounts,
multisigs and other smart wallets. This page covers how to register one and what changes when
the wallet and the identity can end up with different owners.

## How registration works for a contract wallet

Registration needs the agent address to vouch for it. An EOA signs. For a contract wallet,
the registry calls `isValidSignature` on it, as ERC-1271 describes, through OpenZeppelin's
`SignatureChecker`. What is checked is a signature over
`registrationDigest(agent, operator, ed25519PubKey)`, wrapped with the EIP-191 prefix the way
`personal_sign` wraps it. The digest names the operator that will submit the registration, so
a signature cannot be used by anyone else.

ERC-6551 requires every token-bound account to implement ERC-1271 and, by default, treats the
holder of the NFT the account is bound to as a valid signer. So the holder signs. The standard
lets an account add rules of its own, so confirm that yours accepts the holder's signature
before you send anything. `verifyRegistration(agent, operator, ed25519PubKey, signature)` is a
free view that returns whether the registry will accept it.

## Steps

1. Generate the Ed25519 key as for any agent. It authenticates the agent to other agents
   off-chain and has nothing to do with the wallet.
2. Choose the operator: the address that will submit `registerAgent` and afterwards control the
   bond and the status. The NFT holder is the usual choice. Any address works, because the
   signature names it.
3. Ask the identity registry for the digest:
   `registrationDigest(account, operator, ed25519PubKey)`.
4. Have the NFT holder sign that digest as a message. With ethers, pass the 32 raw bytes and
   not the hex string: `holder.signMessage(getBytes(digest))`.
5. The operator calls `registerAgent(account, ed25519PubKey, signature)`. With the SDK:

   ```typescript
   await registerAgent(operatorSigner, account, ed25519PubKey, IDENTITY_ADDRESS, { signature });
   ```

6. The operator deposits the bond with `depositStake`. The agent becomes Active once the bond
   reaches `minimumStake`, as for any agent.

## Before you sell or move the NFT

- **Control is checked once.** After registration the registry never asks the wallet again.
- **The operator is a separate role.** It is recorded at registration. Selling the NFT hands
  the buyer the wallet, and anything paid to it, but not the identity. The operator, the bond
  and the status stay where they were.
- **Handing the identity over is its own step.** The operator offers it and the buyer accepts.
  The agent has to be bonded and have no slash pending, the bond stays with the agent, and the
  release of its score restarts, so a score cannot be sold already spendable.
- **Move them together.** The wallet follows the NFT and the identity follows the operator, so
  they can end up with different people. If you sell one, plan for the other.

## What has been tested

[`test/SmartWalletAgent.t.sol`](../test/SmartWalletAgent.t.sol) registers a token-bound-style
account with its holder's signature, bonds it, refuses a signature from someone who does not
hold the NFT, and sells the NFT to show the operator staying put. The account in that test is a
minimal stand-in that follows ERC-6551's rule for signature validation. It has not been tried
against a production account implementation or on a live network.

To read an agent's standing from a contract once it is registered, see the
[integration guide](integration.md).
