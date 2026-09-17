# Quickstart: Register Your First Agent

This guide takes you from zero to a registered, reputation-tracked AI agent on **Arc testnet** (chain ID `5042002`) in about 10 minutes. For deploy / RPC details see [Arc](arc.md).

## Prerequisites

- Node.js 18+
- A wallet with Arc testnet USDC ([faucet](https://faucet.circle.com))
- Testnet stake tokens — call the faucet on the SVRToken contract (see below)

## 1. Install the SDK

```bash
npm install @sigvara/protocol-sdk ethers
```

## 2. Set up your environment

```bash
# .env
OPERATOR_PRIVATE_KEY=0x...      # needs RH testnet ETH for gas + SVR for stake
RPC_URL=https://rpc.testnet.arc.io
```

Testnet contract addresses (Arc testnet, chain ID `5042002` — from `deployments/5042002.json`):

```
IDENTITY_ADDRESS=0x...   # from deployments/5042002.json after deploy
REPUTATION_ADDRESS=0x...   # from deployments/5042002.json after deploy
STAKING_ADDRESS=0x...   # from deployments/5042002.json after deploy
SVR_TOKEN=0x...   # from deployments/5042002.json after deploy
```


## 3. Get testnet stake tokens

The SVRToken has an `onlyOwner` mint and a public `faucet()`. Call it once per wallet:

```typescript
import { ethers } from 'ethers';

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const signer = new ethers.Wallet(process.env.OPERATOR_PRIVATE_KEY, provider);

const svr = new ethers.Contract(
  '0x...',  // from deployments/5042002.json
  ['function faucet() external', 'function balanceOf(address) view returns (uint256)'],
  signer
);

await svr.faucet();
const balance = await svr.balanceOf(signer.address);
console.log('SVR balance:', ethers.formatEther(balance));
```

## 4. Generate an Ed25519 keypair

The agent's cryptographic identity. Store the private key securely — it cannot be recovered.

```typescript
import { SigvaraAgent } from '@sigvara/protocol-sdk';

// The agent address can differ from the operator address.
// Often it IS the operator address on testnet.
const agentAddress = signer.address;

const { agent, privateKey } = SigvaraAgent.generate({
  agentAddress,
  chainId: 5042002,
});

console.log('DID:', agent.did);
// → did:sigvara:5042002:0x...

console.log('Ed25519 private key (store this):', privateKey);
```

## 5. Register on-chain

Two transactions: approve the staking contract to spend SVR, then register.

```typescript
import { registerAgent } from '@sigvara/protocol-sdk';

// Approve staking contract to pull SVR (1000 SVR minimum stake)
const minStake = ethers.parseEther('1000');
await svr.approve(STAKING_ADDRESS, minStake);

// Register — this calls depositStake + registerAgent atomically
const { didHash, txHash } = await registerAgent(
  signer,
  agentAddress,
  agent.publicKeyBytes32,
  IDENTITY_ADDRESS,
  STAKING_ADDRESS,
  minStake,
);

console.log('didHash:', didHash);
console.log('tx:', `https://explorer.testnet.arc.io/tx/${txHash}`);
```

After a few blocks the oracle will detect the `AgentRegistered` event and begin tracking the agent. The initial score will be low (age=0, activity=0) and will grow over time.

## 6. Verify registration

```typescript
import { SigvaraVerifier } from '@sigvara/protocol-sdk';

const verifier = new SigvaraVerifier({
  rpcUrl: process.env.RPC_URL,
  addresses: { identity: IDENTITY_ADDRESS, reputation: REPUTATION_ADDRESS, staking: STAKING_ADDRESS },
  chainId: 5042002,
});

const identity = await verifier.getIdentity(agent.did);
console.log('Status:', identity.status);   // → Active
console.log('Registered at block:', identity.registeredAt);

const score = await verifier.getTotalScore(agent.did);
console.log('Reputation score:', score);   // → 5 (new agent baseline)
```

## 7. Sign a challenge (agent-to-agent authentication)

This is how your agent proves its identity to another agent without a central authority.

```typescript
// Your agent (the prover) — loaded from stored private key
const myAgent = new SigvaraAgent({
  privateKey: process.env.AGENT_ED25519_SEED,
  agentAddress,
  chainId: 5042002,
});

// Peer agent (the verifier) issues a challenge
const challenge = peerAgent.issueChallenge(myAgent.did);

// Sign the challenge payload with your Ed25519 key
const signature = myAgent.signChallenge(challenge.payload);

// Peer verifies: resolves pubkey from chain, checks signature + reputation
const valid = await verifier.verifySignature(myAgent.did, challenge.payload, signature);
const trusted = await verifier.meetsThreshold(myAgent.did, 60);

console.log('Signature valid:', valid);
console.log('Meets 60-point threshold:', trusted);
```

## 8. Wire up CounterAudit (optional but recommended)

If you're using [CounterAudit](https://counteraudit.io) to audit your agent's actions, pass `agent_did` in every ingest call. CounterAudit will enrich each sealed packet with the agent's live on-chain identity and reputation score.

```typescript
await fetch('https://api.counteraudit.io/v1/audit/ingest', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${CA_API_KEY}`,
  },
  body: JSON.stringify({
    connector_id: 'my-agent',
    agent_did: myAgent.did,
    raw_event: {
      action: 'tool_call',
      tool: 'web_search',
      query: 'latest AI safety papers',
      result_count: 10,
    },
  }),
});
```

The sealed packet will contain `agent_reputation_score`, `agent_identity_status`, `agent_identity_verified`, and related fields — frozen at the moment of the action.

---

## Next steps

- [Arc](arc.md) — RPC, deploy, oracle wiring
- [CounterAudit Integration Guide](counteraudit-integration.md) — full setup and field reference
- [AI Framework Integration](ai-frameworks.md) — LangChain, AutoGen, CrewAI patterns
- [Reputation Model](reputation-model.md) — how your score grows over time
- [Ecosystem Overview](ecosystem.md) — the full protocol picture
