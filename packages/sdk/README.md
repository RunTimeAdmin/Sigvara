# @sigvara/protocol-sdk

TypeScript SDK for the Sigvara protocol: on-chain agent identity, computed
reputation, staked accountability, and Ed25519 challenge-response
authentication between agents. Successor to `@countersig/protocol-sdk`.

```bash
npm install @sigvara/protocol-sdk
```

Runtime dependencies are `ethers` v6 and `tweetnacl`. Node 18 or newer.

## What it does

- **Agent identity.** Generate an Ed25519 keypair, derive the agent's
  `did:sigvara:<chainId>:<address>` and its on-chain `didHash`, and register
  the agent from the operator wallet.
- **Agent-to-agent auth.** Issue a challenge to a peer, sign one with the
  agent's key, and verify a signature against the public key stored on chain.
- **Reads.** Identity, status, six-factor reputation, `meetsThreshold`, stake
  and minimum-stake checks, and a W3C DID Document built from chain state.
- **Stake.** `depositStake` handles the ERC-20 approval and the deposit in one
  call.

## Quick start

```typescript
import { SigvaraAgent, SigvaraVerifier, registerAgent, depositStake, generateChallenge } from '@sigvara/protocol-sdk';
import { ethers } from 'ethers';

const RPC = 'https://rpc.testnet.arc.io';
const CHAIN_ID = 5042002; // Arc testnet
const addresses = { identity: '0x…', reputation: '0x…', staking: '0x…' }; // deployments/5042002.json

// Operator side: create, register and bond an agent
const { agent, privateKey } = SigvaraAgent.generate({ agentAddress: '0xAgent…', chainId: CHAIN_ID });
const operator = new ethers.Wallet(process.env.OPERATOR_KEY!, new ethers.JsonRpcProvider(RPC));
await registerAgent(operator, agent.agentAddress, agent.publicKeyBytes32, addresses.identity);
await depositStake(operator, agent.didHash, 1000n * 10n ** 18n, addresses.staking);

// Counterparty side: challenge the agent, verify the signature, read status and score
const verifier = new SigvaraVerifier({ rpcUrl: RPC, addresses, chainId: CHAIN_ID });
const challenge = generateChallenge(agent.did);          // "SIGVARA-VERIFY:<did>:<nonce>:<timestamp>"
const signature = agent.signChallenge(challenge.payload); // done by the agent, returned to the counterparty
const ok = await verifier.verifySignature(agent.did, challenge.payload, signature);
const trusted = ok && (await verifier.isActive(agent.did)) && (await verifier.meetsThreshold(agent.did, 40));
```

Signature validity, status and score are separate reads; combine them into your
own routing decision. Full protocol documentation, the reputation model and the
contract addresses live in the repository.

## Links

- Repository: https://github.com/RunTimeAdmin/sigvara (this package is `packages/sdk`)
- Site and docs: https://sigvara.xyz
- License: MIT
