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
OPERATOR_PRIVATE_KEY=0x...      # needs Arc testnet USDC for gas + SVR for stake
RPC_URL=https://rpc.testnet.arc.io
```

Testnet contract addresses (Arc testnet, chain ID `5042002` — from `deployments/5042002.json`):

```
IDENTITY_ADDRESS=0x7e3aFC532eE5d922ab3cc3FFb510c7C8151477Dd
REPUTATION_ADDRESS=0x6603C96275e85F724Cdf74666b399365e4cA29ed
STAKING_ADDRESS=0xA69d62B2a6774D21A2c15d5d83b27277eD31d35B
SVR_TOKEN=0x41De2D6D55318e197a00E8f5B496eA2790e23E6c
```


## 3. Get testnet stake tokens

The testnet SVRToken has an `onlyOwner` mint and a public `faucet(amount)`: up to 10,000 SVR per call, one call per wallet per 24 hours.

```typescript
import { ethers } from 'ethers';

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const signer = new ethers.Wallet(process.env.OPERATOR_PRIVATE_KEY, provider);

const svr = new ethers.Contract(
  '0x41De2D6D55318e197a00E8f5B496eA2790e23E6c',  // SVR_TOKEN
  ['function faucet(uint256 amount) external', 'function balanceOf(address) view returns (uint256)'],
  signer
);

await svr.faucet(ethers.parseEther('1000'));
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

## 5. Register on-chain, then post the bond

Registration comes first, then the bond activates the agent.

Two things to know. The agent address has to sign for its own registration, which is
what stops anyone claiming an address they do not control and choosing the key
verifiers will check against it. And registration alone leaves the agent
`PendingBond`: it is not Active, not scoreable and not slashable until a deposit
carries it over `minimumStake`. That deposit is what activates it.

```typescript
import { registerAgent, depositStake } from '@sigvara/protocol-sdk';

const minStake = ethers.parseEther('1000'); // minimumStake on testnet

// agentSigner proves control of agentAddress. Here the agent address IS the operator
// wallet (step 4), so the same signer does both jobs. When they differ, pass a signer
// for the agent address instead — or `{ signature }` and sign elsewhere, which is how
// an HSM, a Safe or any ERC-1271 contract agent registers.
const agentSigner = signer;

const { didHash, txHash } = await registerAgent(
  signer,
  agentAddress,
  agent.publicKeyBytes32,
  IDENTITY_ADDRESS,
  { agentSigner },
);
console.log('didHash:', didHash);
console.log('tx:', `https://explorer.testnet.arc.io/tx/${txHash}`);

const bond = await depositStake(signer, didHash, minStake, STAKING_ADDRESS);
console.log('bond tx:', bond.txHash, bond.approveTxHash ? '(approval sent first)' : '');
```

After a few blocks the oracle will detect the `AgentRegistered` event and begin tracking the agent. It will not propose a score until the bond lands. The first one will be low (tenure=0, no payments yet) and grows only as verified, paid work accrues — see the [Reputation Model](reputation-model.md).

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
console.log('Reputation score:', score);   // → 0 until the first epoch finalizes
```

Two reasons that reads 0 at first. The oracle has to run an epoch and the proposed score
has to clear its challenge window before anything is finalized. And `getTotalScore`
returns the *matured* score, which climbs toward the earned one over days rather than
landing at once — `getEarnedScore` shows the raw figure. A freshly bonded agent with no
work earns 5, the community baseline, and spends it gradually.

## 7. Sign a challenge (agent-to-agent authentication)

This is how your agent proves its identity to another agent without a central authority.

```typescript
// Your agent (the prover) — loaded from stored private key
const myAgent = new SigvaraAgent({
  privateKey: process.env.AGENT_ED25519_SEED,
  agentAddress,
  chainId: 5042002,
});

// Peer agent (the verifier) issues a challenge. It names myAgent as the prover and
// peerAgent as the audience, so the response proves "I am talking to you" and cannot be
// relayed on to a third agent.
const challenge = peerAgent.issueChallenge(myAgent.did);

// Sign the challenge payload with your Ed25519 key
const signature = myAgent.signChallenge(challenge.payload);

// Peer verifies: resolves pubkey from chain, checks signature + reputation.
// Passing the expected audience is what makes a relayed response fail.
const valid = await verifier.verifySignature(
  myAgent.did, challenge.payload, signature, 300, peerAgent.did,
);
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
