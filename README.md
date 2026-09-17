# Sigvara

**Computed reputation and staked slashing for autonomous AI agents, on top of ERC-8004.**

As AI agents become independent economic actors, they need a trust score that means something and accountability that costs something. [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) gives agents a standard on-chain identity and a raw feedback ledger, but deliberately leaves out the hard parts: computing a trustworthy score from that feedback, and putting slashable stake behind it. Sigvara is that layer. It takes ERC-8004 as the identity and feedback substrate, computes a normalized reputation score with an oracle, and enforces bonds and slashing — the accountability the standard omits. (Ed25519 PKI challenge-response for agent-to-agent auth rides alongside.)

> **Token: not launched yet.** The protocol's bond and fee asset will be **SVR**, a fixed-supply, ownerless ERC-20 launched through Tolly on Arc mainnet with no team allocation, no treasury allocation and no sale. Until its contract address appears in [docs/token.md](docs/token.md) and on [sigvara.xyz](https://sigvara.xyz), there is no genuine SVR; anything trading under the Sigvara name before then, or at any other address after, did not come from this team. On-chain utility begins when the registries deploy to Arc mainnet after audit.
>
> **Where this stands.** Sigvara is a computed-reputation and staked-slashing layer for autonomous agents on top of ERC-8004: the standard covers identity and raw feedback; Sigvara computes a normalized score and puts slashable bond behind it. Contracts, oracle and SDK are built and tested (Foundry unit and fuzz tests, Slither in CI). The same protocol ran for about a month on Robinhood Chain testnet with a live hourly oracle under its prior name (see [docs/lineage.md](docs/lineage.md)), and **Arc testnet** (chain ID `5042002`) is the next deployment target ([docs/arc.md](docs/arc.md)). The oracle trust model is not yet decentralized, and there is no external audit. This is early protocol work with real engineering and a documented testnet lineage, not a mainnet product claim. [CounterAudit](https://counteraudit.io) both consumes Sigvara scores and feeds work-outcome attestations back into them.

### This repo vs. the Countersig hosted platform

This repository (`sigvara`) is the **decentralized protocol**: computed reputation and staked slashing on top of ERC-8004 identity, with no central authority. Trust here is enforced by cryptography and cryptoeconomics — nothing to sign up for, nothing to trust us on.

There is a **separate product**, the Countersig platform (repo: [`RunTimeAdmin/Countersig`](https://github.com/RunTimeAdmin/Countersig)), which ships its own npm packages — `@countersig/sdk`, `@countersig/verify`, `@countersig/mcp`, `@countersig/react`. That platform is a centralized, hosted non-human-identity verification service. It is a different product with a different trust model, built by the same team, but it is **not this protocol** and does not read from or write to the contracts below. It kept the Countersig name; the protocol did not (see [docs/lineage.md](docs/lineage.md) for why).

If you're looking for MCP server support or React trust-badge components, those live in the platform repo, not here. If you're integrating with the on-chain protocol — DIDs, staked reputation, permissionless verification — you're in the right place, and `@sigvara/protocol-sdk` (in [`packages/sdk`](packages/sdk), successor to `@countersig/protocol-sdk`) is the only SDK for it.

## Documentation

| Guide | Audience |
|---|---|
| [Ecosystem Overview](docs/ecosystem.md) | Everyone — start here to understand the full picture |
| [Quickstart](docs/quickstart.md) | Developers — register your first agent in 10 minutes |
| [Arc](docs/arc.md) | Developers — deploy / test on Arc (5042002 / 5042), USDC gas |
| [SVR token](docs/token.md) | Everyone — the bond and fee token: contract, distribution, treasury policy, when utility starts |
| [Brand](docs/brand.md) | Designers / frontend — colors, type, layout and component rules for every Sigvara surface |
| [CounterAudit Integration](docs/counteraudit-integration.md) | Enterprise — embed agent identity in your audit trail |
| [AI Framework Integration](docs/ai-frameworks.md) | Developers — LangChain, AutoGen, CrewAI, Node.js |
| [Reputation Model](docs/reputation-model.md) | Everyone — how the 6-factor score works and grows |
| [Lineage](docs/lineage.md) | Everyone — the Robinhood Chain testnet run this protocol came from (addresses, oracle activity, what changed) |

---

## Protocol Architecture

Sigvara is the computed-reputation and staked-slashing layer on top of the
ERC-8004 identity and feedback registries. See [docs/architecture.md](docs/architecture.md)
for the full signal flow.

```mermaid
graph TB
    subgraph sources["Signal sources"]
        CA["CounterAudit<br/>work-outcome attestations"]
        WD["Watchdog scanners<br/>rug / abuse flags"]
    end

    subgraph erc8004["ERC-8004 · identity + feedback (canonical)"]
        EID["Identity Registry<br/>agent identity"]
        EREP["Reputation Registry<br/>raw feedback"]
    end

    subgraph sigvara["Sigvara · the trust layer"]
        OR(["Reputation Oracle<br/>computes the score"])
        REP["SigvaraReputation<br/>computed-score anchor"]
        ST["SigvaraStaking<br/>bonds + slashing"]
    end

    CONS["SDK · consumers · on-chain readers"]

    CA -->|"success / fail"| OR
    WD -->|"flags"| OR
    EID -->|"identity + age"| OR
    EREP -->|"feedback to externalScore"| OR
    OR -->|"propose / finalize"| REP
    ST -->|"slash · zero score"| REP
    CA -->|"giveFeedback"| EREP
    REP -->|"getTotalScore · meetsThreshold"| CONS
```

---

## Contracts

> **Identity layer: ERC-8004.** Sigvara has adopted the [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) Identity Registry as the canonical agent registry and no longer maintains a competing one. Sigvara is the **computed-reputation and staked-slashing layer on top of the standard** — the parts ERC-8004 deliberately leaves out. See [ADR 0001](docs/adr/0001-erc8004-as-identity-layer.md).

| Contract | Role |
|---|---|
| [`SigvaraReputation`](src/SigvaraReputation.sol) | **Computed-score anchor.** Stores the oracle's normalized, capped 6-factor score — the layer *above* ERC-8004's raw feedback. Exposes `getTotalScore()` and `meetsThreshold()` for on-chain consumers. |
| [`SigvaraStaking`](src/SigvaraStaking.sol) | **Staked accountability.** Agent bond management with committee-initiated slashing (7-day challenge window, permissionless execution after timelock). No ERC-8004 equivalent — this is the differentiator. Bond token is set by address at deploy: the faucet `SVRToken` on testnet, [SVR](docs/token.md) on mainnet — the contracts treat it as a plain `IERC20` either way. |
| [`SigvaraIdentity`](src/SigvaraIdentity.sol) | **Legacy.** Original `did:sigvara` registry + on-chain Ed25519 PKI. Deprecated in favor of the ERC-8004 Identity Registry; kept for continuity of already-registered testnet agents. Its non-redundant part (the on-chain Ed25519 auth key + slash status) becomes an extension keyed to an ERC-8004 agent id. |

The retained contracts use UUPS upgradeable proxies (OpenZeppelin v5), controlled by a governance timelock on mainnet.

---

## DID Method (legacy)

> **Deprecated.** The `did:sigvara` method below is retained for the testnet
> agents already registered on `SigvaraIdentity`. New agents are identified by
> their ERC-8004 agent id; see [ADR 0001](docs/adr/0001-erc8004-as-identity-layer.md).

**Format:** `did:sigvara:<chainId>:<agentAddress>`

**Example:** `did:sigvara:1:0x1234...abcd`

The `didHash` index key is derived trustlessly on-chain at registration:

```solidity
bytes32 didHash = keccak256(
    abi.encodePacked("did:sigvara:", block.chainid, ":", agentAddress)
);
```

Any party can reproduce the hash without querying contract state. The on-chain derivation prevents off-chain forgery.

### DID Document (resolved off-chain)

```json
{
  "@context": [
    "https://www.w3.org/ns/did/v1",
    "https://w3id.org/security/suites/ed25519-2020/v1"
  ],
  "id": "did:sigvara:1:0x1234abcd",
  "controller": "did:pkh:eip155:1:0xOperatorAddress",
  "verificationMethod": [{
    "id": "did:sigvara:1:0x1234abcd#key-1",
    "type": "Ed25519VerificationKey2020",
    "controller": "did:sigvara:1:0x1234abcd",
    "publicKeyMultibase": "z6MkhaXgBZDvotDkL5257faiztiCEsJ"
  }],
  "authentication": ["did:sigvara:1:0x1234abcd#key-1"],
  "assertionMethod": ["did:sigvara:1:0x1234abcd#key-1"]
}
```

---

## Agent Status State Machine

```mermaid
stateDiagram-v2
    direction LR
    [*] --> Active : registerAgent()

    Active --> Suspended : operator.updateStatus()\nor StakingCore.initiateSlash()
    Suspended --> Active : operator.updateStatus()\nor StakingCore.disputeSlash()

    Active --> Slashed : StakingCore.executeSlash()
    Suspended --> Slashed : StakingCore.executeSlash()

    Slashed --> [*] : terminal — no further transitions
```

Key invariants:
- Only `STAKING_CORE_ROLE` can set `Slashed`
- `Slashed` is terminal — no key rotation, no status change
- Suspended agents may rotate their Ed25519 key (key-compromise recovery path)

---

## Reputation System

Scores are computed off-chain by the oracle network and written to `SigvaraReputation`. The contract stores and serves; it does not compute.

| Factor | Max | Source | Formula | Status |
|---|---|---|---|---|
| Fee Activity | 30 | Attestation volume (proxy for paid activity) | `min(30, floor(attestations / 10))` | live |
| Success Rate | 25 | Task attestations from consumers (e.g. CounterAudit) | `floor((successful / total) × 25)` | live |
| Age | 20 | Registration timestamp | `min(20, floor(log₂(days+1) × 4))` | live |
| External Trust | 15 | Normalized ERC-8004 feedback (linked agents) | mean of recognized tags × 15 | live |
| Community | 5 | Flags from watchdog feeds (e.g. HoodScan) | `max(0, 5 − flags × 2)` | live |
| Propagation | 5 | Agent-vouching trust graph | — | Phase 2 |
| **Total** | **100** | | | |

The age formula reaches 20 around day 31 (logarithmic). Only propagationScore is still inactive (0 today), so a live score currently maxes at 95; externalScore is 0 unless the agent links an ERC-8004 identity it owns. A new agent with no work history sits near the community baseline (5) and climbs only as real attestations and age accrue — which is what makes the number meaningful. Success/fee signals come from consuming platforms reporting job outcomes; community flags come from watchdog services reporting misbehavior; external trust comes from the agent's ERC-8004 feedback. See the [Reputation Model](docs/reputation-model.md) guide for provenance detail.

---

## Slashing Model

**Testnet:** 3-of-5 multisig `SLASHING_COMMITTEE`. **Mainnet path:** UMA OptimisticOracleV3 or Kleros (isolated in the `initiateSlash` / `disputeSlash` interface, replaceable without storage migration).

### Slash Lifecycle

```mermaid
sequenceDiagram
    participant V as Victim
    participant CM as Committee (3-of-5)
    participant ST as SigvaraStaking
    participant ID as SigvaraIdentity
    participant REP as SigvaraReputation

    V->>CM: report agent + evidence package
    CM->>ST: initiateSlash(didHash, victim, evidenceHash)
    ST->>ID: updateStatus(didHash, Suspended)
    Note over ST: 7-day challenge period begins

    alt Operator disputes within window
        Op->>ST: disputeSlash(didHash)
        ST->>ID: updateStatus(didHash, Active)
        Note over ST: Proposal cancelled — re-initiation possible
    else Challenge period elapses undisputed
        Anyone->>ST: executeSlash(didHash)
        ST->>ID: updateStatus(didHash, Slashed)
        ST->>REP: zeroReputation(didHash)
        ST-->>0xdead: 50% burned
        ST-->>V: 25% to victim
        ST-->>CM: 25% to reporter
    end
```

### Slash Distribution

| Recipient | Share | Mechanism |
|---|---|---|
| `address(0xdead)` | 50% | Deflationary burn |
| Victim | 25% | Recourse for the harmed party |
| Committee reporter | 25% | Incentivizes accurate reporting |

---

## Protocol Flows

### Agent Registration

```mermaid
sequenceDiagram
    participant Op as Operator
    participant ST as SigvaraStaking
    participant ID as SigvaraIdentity

    Note over Op: Generate Ed25519 keypair off-chain
    Op->>ST: depositStake(didHash, minimumBond)
    ST-->>Op: stake recorded
    Op->>ID: registerAgent(agentAddress, ed25519PubKey)
    ID->>ID: didHash = keccak256("did:sigvara:" + chainId + ":" + agentAddress)
    ID-->>Op: AgentRegistered(didHash, operator, agentAddress, pubKey)
    Note over ID: did:sigvara:1:0xAgent now globally resolvable
```

### Agent-to-Agent (A2A) Trust Verification

```mermaid
sequenceDiagram
    participant A as Agent A
    participant B as Agent B
    participant ID as SigvaraIdentity
    participant REP as SigvaraReputation

    A->>B: request action
    B->>A: challenge payload\n"SIGVARA-VERIFY:{DID}:{nonce}:{timestamp}"
    A->>A: sign payload with Ed25519 private key
    A->>B: { did, signature }
    B->>ID: getIdentity(didHash)
    ID-->>B: { ed25519PubKey, status: Active }
    B->>B: verify Ed25519 signature against pubKey
    B->>REP: meetsThreshold(didHash, 60)
    REP-->>B: true / false
    alt threshold met and signature valid
        B-->>A: action permitted
    else
        B-->>A: rejected
    end
```

### Reputation Update Lifecycle (Optimistic Scoring)

Reputation updates go through a challenge window before taking effect, rather than writing atomically. This gives the slashing committee a chance to reject a bad proposal before it goes live, without needing a full multi-oracle consensus system.

```mermaid
sequenceDiagram
    participant UC as User / Counterparty
    participant OR as Oracle Network
    participant REP as SigvaraReputation
    participant CM as Slashing Committee

    UC->>OR: submit cryptographic attestation of task success
    Note over OR: epoch aggregation across all attestations
    OR->>OR: compute 6-factor scores for each agent
    OR->>REP: proposeReputation(didHash, ReputationData)
    REP->>REP: validate per-factor caps
    REP-->>OR: ScoreProposed(didHash, proposedAt)
    Note over REP: Challenge window open (e.g. 1-6 hours)

    alt Committee rejects during the window
        CM->>REP: rejectReputation(didHash)
        REP-->>CM: ScoreRejected(didHash)
        Note over REP: Previous finalized score is untouched
    else Window elapses unchallenged
        UC->>REP: finalizeReputation(didHash) — permissionless
        REP-->>UC: ReputationUpdated(didHash, totalScore)
        Note over REP: Score now live for A2A threshold checks
    end
```

---

## Key Rotation

If an Ed25519 private key is compromised:

1. Operator calls `updateStatus(didHash, Suspended)` immediately — invalidates the DID for authentication within one block.
2. Operator generates a new Ed25519 keypair off-chain.
3. Operator calls `rotatePublicKey(didHash, newEd25519PubKey)`.
4. Operator reinstates: `updateStatus(didHash, Active)`.

Slashed agents cannot rotate. The identity is permanently terminated.

---

## TypeScript SDK

```bash
npm install @sigvara/protocol-sdk
```

### Agent-to-Agent authentication

```typescript
import { SigvaraAgent, SigvaraVerifier } from '@sigvara/protocol-sdk';

// Agent A — the prover
const agentA = new SigvaraAgent({
  privateKey: process.env.AGENT_A_ED25519_SEED,  // 32-byte hex seed
  agentAddress: '0xAgentAAddress',
  chainId: 5042002,  // Arc testnet
});

// Agent B — the verifier (has its own identity + a verifier for on-chain lookups)
const agentB = new SigvaraAgent({
  privateKey: process.env.AGENT_B_ED25519_SEED,
  agentAddress: '0xAgentBAddress',
  chainId: 5042002,
});
const verifier = new SigvaraVerifier({
  rpcUrl: 'https://rpc.testnet.arc.io',
  addresses: {
    identity: '0x...  /* from deployments/5042002.json */',
    reputation: '0x...  /* from deployments/5042002.json */',
    staking: '0x...  /* from deployments/5042002.json */',
  },
  chainId: 5042002,
});

// B issues a challenge to A
const challenge = agentB.issueChallenge(agentA.did);

// A signs and returns its DID + signature
const signature = agentA.signChallenge(challenge.payload);

// B verifies: resolves pubkey from chain, checks signature + reputation
const valid = await verifier.verifySignature(agentA.did, challenge.payload, signature);
const trusted = await verifier.meetsThreshold(agentA.did, 60);
```

### On-chain registration (operator)

```typescript
import { registerAgent } from '@sigvara/protocol-sdk';

const { didHash } = await registerAgent(
  signer,                        // ethers.Signer with operator wallet
  agentA.did,                    // or just the agent's Ethereum address
  agentA.publicKeyBytes32,       // bytes32 Ed25519 public key
  IDENTITY_CONTRACT_ADDRESS
);
```

### DID Document resolution

```typescript
const didDoc = await verifier.buildDidDocument(agentA.did);
// Returns W3C-compliant DID Document with Ed25519VerificationKey2020
```

---

## Setup (contracts)

Requires [Foundry](https://getfoundry.sh).

```bash
git clone https://github.com/RunTimeAdmin/sigvara
cd sigvara
forge install
forge build
forge test
```

Running the fuzz suite at higher intensity:

```bash
FOUNDRY_PROFILE=ci forge test
```

## Testing

The test suite is organized into three tiers:

### Unit Tests (default)

Test individual contract functions in isolation. These run on Foundry's in-memory EVM and require no external network.

```bash
forge test                        # all unit tests
FOUNDRY_PROFILE=ci forge test     # denser fuzz runs (5000 iterations)
```

### E2E Integration Tests

Cover the full agent lifecycle: `register → stake → propose/finalize reputation → slash → zero-reputation`. These run in-memory with deployed fixture contracts.

```bash
forge test --match-contract E2EIntegrationTest -vvv
```

Key scenarios tested:
- Full lifecycle from registration to slash
- Slash dispute and agent reinstatement
- Reputation challenge (committee rejects bad score)
- Unbonding period enforcement
- Slash sweeping unbonding queue (dodge prevention)
- Multiple epochs of score evolution
- Multiple independent agents

---

## Access Control Summary

| Role | Holder (Testnet) | Permissions |
|---|---|---|
| `DEFAULT_ADMIN_ROLE` | Governance timelock | Grant/revoke all roles |
| `UPGRADER_ROLE` | Governance timelock | Authorize UUPS upgrades |
| `STAKING_CORE_ROLE` | `SigvaraStaking` | Suspend / slash agents, zero reputation |
| `ORACLE_ROLE` | Oracle consensus contract | Write reputation scores |
| `SLASHING_COMMITTEE_ROLE` | 3-of-5 multisig | Initiate slash proposals |
| Operator | Agent registrant | Register, suspend, reinstate, rotate key |

---

## Ecosystem & Integrations

Sigvara is designed as an open identity layer. Any system that needs to know *which* AI agent did *what* can integrate by querying the contracts or consuming CounterAudit enriched packets.

### CounterAudit

[CounterAudit](https://counteraudit.io) is the first integration partner, and it works in both directions. When an ingest call includes `agent_did`, CounterAudit queries the Sigvara contracts at seal time and embeds the agent's identity and reputation score inside the AES-GCM seal, covered by an RFC 3161 timestamp — forensically proving what the agent's reputation was at the moment of each action. When that ingest also carries an `outcome` (`success` / `failure`) for a registered agent, CounterAudit reports it to the reputation oracle, so audited work outcomes feed back into the agent's Success Rate and Fee Activity factors. Reading and writing the same reputation closes the loop.

```typescript
// Every action your agent takes gets sealed with identity + reputation
await fetch('https://api.counteraudit.io/v1/audit/ingest', {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${CA_API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    connector_id: 'my-agent',
    agent_did: 'did:sigvara:5042002:0x...',
    raw_event: { action: 'tool_call', tool: 'web_search', query: '...' },
  }),
});

// The sealed packet contains:
// agent_reputation_score: 47
// agent_identity_status: "Active"
// agent_identity_verified: true
// agent_enriched_at: "2026-06-30T16:33:39Z"
```

See the [CounterAudit Integration Guide](docs/counteraudit-integration.md) for full setup instructions.

### HoodScan

HoodScan is a rug-risk scanner for Robinhood Chain tokens. When a scan returns a red (high-risk) verdict, it reports the token's deployer address to the reputation oracle as a community flag. If that deployer operates a registered Sigvara agent, the flag lowers its Community factor — so on-chain misbehavior detected off-chain shows up in the agent's reputation. This is the watchdog half of the signal loop: consumers attest to good work, scanners flag bad actors. The oracle's flag endpoint is chain-agnostic, so any scanner can play the same role on Arc.

### On-chain consumers

Any smart contract can gate operations on an agent's reputation:

```solidity
ISigvaraReputation rep = ISigvaraReputation(REPUTATION_ADDRESS);
require(rep.meetsThreshold(didHash, 60), "insufficient reputation");
```

---

## Roadmap

| Phase | Timeline | Deliverables |
|---|---|---|
| Core Protocol | Q3 2026 | contracts, reputation oracle and `@sigvara/protocol-sdk` v1.0 built and tested · CounterAudit attestation + HoodScan flag feeds |
| Arc Port | Q4 2026 | Arc testnet deployment (`5042002`, USDC gas) · oracle epochs against Arc · SVR launch on Arc mainnet ([docs/token.md](docs/token.md)) |
| External Trust | Q4 2026 | ~~externalScore from ERC-8004 feedback~~ **done** (linked agents, live) · agent-vouching graph (propagationScore) · deeper ERC-8004 interop (publish CounterAudit validations to the Validation Registry) |
| Mainnet Registries | Q1 2027 | Tier-1 security audit · registry deployment on Arc mainnet (`5042`) with bonds and scoring fees in SVR |
| Cross-Chain | Q2 2027 | Solana + Base state mirroring via LayerZero |

The token-launch contract set (fixed-supply `SVR`, vesting, public sale) and the earlier tokenomics and oracle-first direction docs live under [`archive/token-launch/`](archive/token-launch/). They are out of the build; SVR launches through Archemist rather than these contracts.

---

## License

MIT
