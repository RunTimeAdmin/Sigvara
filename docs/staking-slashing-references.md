# Staking & Slashing Reference Implementations

Compiled 2026-10-23. Reference material for building Sigvara's staking, bonding, and slashing contracts on Arc testnet. Goal: avoid building from scratch by studying production and near-production systems that solve the same problems.

## Priority 1 — Closest to Sigvara's Design

### Stigmetry AgentStaking (Arc Testnet)
- **Repo:** https://github.com/Stigmetry/agent-staking
- **Why first:** Already deployed on Arc testnet (Chain ID 5042002), which is Sigvara's target chain. Locks USDC as collateral for ERC-8004 agents. 20% slash rate on disputes (SLASH_RATE_BPS = 2000), 7-day withdrawal cooldown to prevent front-running anticipated slashes, reputation bonus for staking above minimum threshold. Authorized slashers are AgentJob and AgentOrchestrator contracts.
- **What to steal:** The withdrawal cooldown pattern, the authorized-slasher role model, and the reputation-stake bonus mechanic. Read it against SigvaraIdentity and SigvaraReputation interfaces side by side.
- **Gap vs Sigvara:** Single flat slash rate, no challenge window, no bond-vs-reputation scaling, USDC-only.

### Vaultum agent-bonds
- **Repo:** https://github.com/vaultum/agent-bonds
- **Why:** Reputation-collateralized bonding protocol purpose-built for ERC-8004 agents. Agents stake ETH; bond requirements scale inversely with on-chain reputation (high rep = lower bond). Disputes resolve through the ERC-8004 Validation Registry with automatic slashing. UUPS upgradeable. Pull-payment pattern for bond releases.
- **What to steal:** The inverse reputation-to-bond mapping and the dispute-to-slash pipeline through the Validation Registry. The IReputationScorer composable scoring interface is a clean abstraction.
- **Gap vs Sigvara:** ETH-native, no SVR token, no per-event fee monetization, simpler dispute model.

## Priority 2 — Production Slashing Architecture

### EigenLayer (Layr-Labs/eigenlayer-contracts)
- **Repo:** https://github.com/Layr-Labs/eigenlayer-contracts
- **Key files:** `src/contracts/core/AllocationManager.sol`, `src/contracts/libraries/SlashingLib.sol`, docs in `docs/core/`
- **ELIPs:** ELIP-002 (Slashing via Unique Stake & Operator Sets), ELIP-006 (Redistributable Slashing), ELIP-016 (Slash Resolution Delay)
- **Why:** The most mature, most-audited slashing system in crypto. Unique Stake guarantees an operator's slashable allocation is exclusive to one AVS at a time — isolates slashing risk. 7-day SLASH_RESOLUTION_DELAY before slashed shares can be cleared or redistributed. `slashOperator` takes strategies + proportions in wads (parts per 1e18).
- **What to steal:** The Unique Stake isolation concept (map to Sigvara's per-agent bond exclusivity), the separation of slash initiation from slash resolution (delay + async clearing), and the wads-based proportion math.
- **Gap vs Sigvara:** Built for validator/AVS economics at massive scale. Operator-delegation model doesn't map to agent-to-client bonds. Overkill for v1 but the safety-delay thinking transfers directly.
- **Docs:** https://docs.eigencloud.xyz/eigenlayer/concepts/slashing/slashing-concept and https://docs.eigencloud.xyz/eigenlayer/developers/howto/build/slashing/implement-slashing

### The Graph (graphprotocol/contracts)
- **Repo:** https://github.com/graphprotocol/contracts
- **Key file:** `packages/contracts/contracts/staking/Staking.sol` (abstract base; L1Staking on mainnet, L2Staking on Arbitrum)
- **Why:** Long-running production system where Indexers stake GRT on subgraphs and bad proofs of indexing are slashable. Shows how a mature protocol handles stake allocation, slashing conditions tied to cryptographic proofs, and the L1/L2 split.
- **What to steal:** The proof-tied slashing condition pattern — slash only when misbehavior is attributable via a verifiable artifact, not at a slasher's discretion.

### Succinct Labs (succinctlabs/network)
- **Repo:** https://github.com/succinctlabs/network
- **Key file:** `contracts/src/SuccinctStaking.sol`
- **Why:** UUPS upgradeable staking for the Succinct Prover Network. `requestSlash` is restricted to a VApp role and a specific prover; creates slash claims that are later resolved. Clean role-gated slash request flow with claim indexing.
- **What to steal:** The request-then-resolve two-phase slash pattern and the prover-scoped authorization.

## Priority 3 — Agent-Economy Adjacent

### Flare Trustless Protocol StakeVault
- **Repo:** https://github.com/saiisback/flare-trustless-protocol (file: `trustless-protocol/contracts/v2/core/StakeVault.sol`)
- **Why:** Manages FLR stakes for agents with economic security via slashing. 7-day default withdrawal timelock, only a SlashingJudge can slash, max-slash-percentage cap, reentrancy-protected, role-based access. Beneficiary receives slashed funds.
- **What to steal:** The max-slash cap (percentage of stake, not absolute), the beneficiary-on-slash pattern, and the SlashingJudge role separation.

### 0xgasless agent-sdk-contracts
- **Repo:** https://github.com/0xgasless/agent-sdk-contracts
- **Why:** Official-style ERC-8004 implementation with stake-based security, slashing for unresponsive validators, plugin architecture, and four economic models (stake-based, reputation-based, hybrid, permissionless). Published parameters: 0.1 AVAX min stake, 10% slash, 1000-block expiration.
- **What to steal:** The multi-model comparison and the expiration-block concept for time-bounded stake commitments.
- **Note:** Deployed on Avalanche C-Chain mainnet — live reference addresses in the repo README.

### Stigmetry Agent DAO (Arc)
- **Repo:** https://github.com/Stigmetry/agent-dao
- **Why:** Reputation-weighted dispute arbitration for Arc. Agents vote on contested jobs using on-chain reputation in basis points; 3-day voting + 1-day execution timelock; USDC escrow distributed by vote outcome. Layer 7 of the Arc agentic commerce stack.
- **What to steal:** If Sigvara ever needs community-governed dispute resolution instead of automated slashing, this is the Arc-native pattern. Also useful context for how Arc's agent ecosystem layers compose.

### Ava Labs 8004-boilerplate
- **Repo:** https://github.com/ava-labs/8004-boilerplate
- **Key file:** `contracts/TaskAgent.sol`
- **Why:** Official Avalanche demo of ERC-8004 identity + reputation + validation registries wired into a task service. Not staking-focused, but the integration glue between registries is instructive.

### Vistara ERC-8004 example
- **Repo:** https://github.com/vistara-apps/erc-8004-example
- **Key file:** `contracts/src/ReputationRegistry.sol`
- **Why:** Lightweight Reputation Registry implementation with feedback authorization between agent-client pairs. Good reference for how reputation entries get authorized before acceptance.

## Security Primitives (not staking-specific, but required)

### OpenZeppelin Contracts
- **Repo:** https://github.com/OpenZeppelin/openzeppelin-contracts
- **Install:** `forge install OpenZeppelin/openzeppelin-contracts`
- **Use:** ReentrancyGuard, Pausable, AccessControl (role-based), ERC20/ERC20Burnable, UUPS upgradeable variants. No staking primitives — Sigvara builds those — but every reference above leans on these.

## Suggested Study Order

1. **Stigmetry AgentStaking** — Arc-native, closest threat model, read in one sitting.
2. **Vaultum agent-bonds** — reputation-bond inverse scaling, the Sigvara differentiator.
3. **EigenLayer AllocationManager + ELIP-002** — safety delays, Unique Stake isolation, async slash resolution.
4. **Flare StakeVault** — max-slash caps, beneficiary pattern, SlashingJudge role.
5. **The Graph Staking.sol** — proof-attributable slashing conditions.
6. **SuccinctStaking** — request-then-resolve two-phase flow.
7. **0xgasless agent-sdk-contracts** — multi-model economics, expiration blocks.
8. **Stigmetry Agent DAO** — only if community dispute resolution enters scope.

## Open Questions for Sigvara Design

- Should slash be a flat basis-point rate (Stigmetry) or reputation-scaled (Vaultum)?
- Is a 7-day withdrawal cooldown enough, or does Sigvara need EigenLayer-style async slash resolution with a separate clearing step?
- Who is the slasher — an automated oracle, a governance role, or the Validation Registry outcome?
- Does a slashed agent's bond go to the wronged client (redistribution) or get burned?
- How does the SVR token fit — is it the staking asset, or does staking stay in a separate collateral token with SVR as the fee/governance layer?

## Related Sigvara Docs

- `docs/slash-drill.md` and `docs/slash-drill-log.md` — existing Sigvara slash drill material
- `docs/token.md` and `docs/token-creation-venue.md` — SVR token design
- `docs/reputation-model.md` — six-factor score that would feed bond scaling
- `docs/adr/0004-operator-custody.md` — operator custody decisions
- `docs/adr/0005-governance-and-emergency-powers.md` — emergency powers that intersect with slashing authority
- `docs/deploy-testnet.md` — current testnet deploy process
