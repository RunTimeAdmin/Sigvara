# Sigvara Security and Mainnet Readiness Review

**Review Date:** 2026-09-17  
**Reviewer:** External Security Review  
**Repository:** `RunTimeAdmin/sigvara`  
**Scope:** Full protocol review — contracts, oracle, SDK, deployment configuration

---

> ## Status since this review — 2026-09-20
>
> The body below is left as written on 17 September and is **not** a current statement
> of readiness. What has changed since:
>
> **Closed.**
> - `deployments/5042002.json` is committed, and the protocol is deployed and running on
>   Arc testnet.
> - `SigvaraOracleBond` is deployed and wired into `SigvaraReputation.operatorBond`; the
>   oracle operator is bonded and admitted, so proposing a score now costs something if
>   it is wrong.
> - Reputation is bound to identity: an unregistered or slashed agent cannot be scored.
> - Agents are no longer `Active` on registration. Registration mints `PendingBond` and
>   requires a signature from the agent address proving control; the bond is what
>   activates, and every transition into `Active` re-checks collateral. An invariant test
>   covers it, and found a real escape via the dispute path while it was being written.
> - Attestations are payment-backed, decayed on a half-life, capped per counterparty, and
>   refused for self-payments. Calendar age is replaced by tenure. Scores mature over days
>   rather than landing at once, and a transfer restarts maturity.
> - Every proposal commits to a Merkle root over the evidence behind it, servable and
>   re-verifiable against the chain.
> - The six factor weights were rebalanced after this review: fee 30 to 20, success 25 to
>   15, tenure 20 to 30, external 15 to 25. Community and propagation are unchanged at 5.
>   Section 3.1.1 below quotes the struct as it stood on 17 September, so its caps read
>   low or high against the code today. The finding itself is unaffected, since the fields
>   are `uint8` either way and the conclusion was that the packing needs no change.
>
> **Still open, and still mainnet blockers.**
> - No external security audit.
> - Mainnet bond asset undecided; SVR has not launched.
> - Both oracle operators are run by the same party. A second bonded operator has run in
>   checker mode since 20 September on separate hardware and a separate RPC provider, and
>   `activeCount` is 2, but two independent recomputations agreeing is not two independent
>   parties agreeing. Only the primary writes scores; the checker makes a disagreement
>   legible and a committee must still act on it.
> - ~~Scoring reads the wall clock rather than the chain clock.~~ Closed 20 September.
>   The epoch scores against the block timestamp, and the checker rescores a pending
>   proposal at its own `proposedAt` before comparing. The second half is the one that
>   mattered: two operators run on independent schedules, so sharing a clock source does
>   not make them simultaneous. Asking "what should the primary have computed when it
>   proposed this" does, and a divergence now means the evidence disagreed rather than the
>   epochs being minutes apart. The 0.982146/0.982148 difference cited here as evidence of
>   drift was the latency between two endpoint fetches roughly twenty seconds apart, not
>   host clocks.
> - Every privileged role on testnet is a single EOA, including the slashing committee.
>   Admin and upgrade rights are not on a timelock or Safe.
> - No slash has been run end to end on a live network.
> - ~~No public challenge watcher.~~ Running since 20 September 2026 on a third host,
>   polling the checker's `/divergence`, re-reading each disputed slot on chain and
>   alerting while rejection is still possible. It holds no key, mounts no state and
>   signs nothing. The checker's read-only surface is public at `checker.sigvara.xyz`
>   (`/health` and `/divergence` only; every write path 404s). Procedure in
>   `oracle/RUNBOOK-second-operator.md` section 11.

---

## Executive Summary

Sigvara is a **computed reputation and staked slashing layer for autonomous AI agents**, built on top of ERC-8004. The protocol is well-architected with clear separation of concerns, comprehensive test coverage, and thoughtful security considerations. However, **mainnet deployment should be blocked** pending completion of several critical items:

1. **No external security audit** — the protocol handles slashable economic value
2. **Bond token decision undecided** — contracts accept any ERC-20 but mainnet asset is TBD
3. **Centralized oracle** — single-operator oracle with no liveness guarantees
4. **Missing production deployment artifacts** — `deployments/5042002.json` not committed

**Overall Assessment: CONDITIONAL NO-GO** — the protocol is architecturally sound but requires audit, decentralization work, and operational hardening before mainnet.

---

## 1. Project Status

### 1.1 What the System Is

Sigvara provides three capabilities on top of ERC-8004 identity:

| Capability | Description | Contract |
|---|---|---|
| **Computed Reputation** | 6-factor normalized score (0-100) computed off-chain and anchored on-chain | `SigvaraReputation` |
| **Staked Accountability** | Bond deposits with committee-initiated slashing (7-day challenge) | `SigvaraStaking` |
| **Ed25519 PKI** | On-chain public key storage for agent-to-agent challenge-response auth | `SigvaraIdentity` |

Supporting components:

| Component | Purpose | Status |
|---|---|---|
| `SigvaraOracleBond` | Performance bonds for oracle operators | Implemented, not deployed |
| `SigvaraEpochFees` | Pay-per-epoch scoring gate | Implemented, not deployed |
| `SVRToken` | Testnet faucet token | Testnet only |
| `oracle/` | Off-chain scoring service | Single-operator, not production-ready |
| `packages/sdk/` | TypeScript SDK for agent registration and verification | v1.0 quality |

### 1.2 Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           Signal Sources                                 │
│  CounterAudit (attestations)    Watchdog scanners (flags)               │
└─────────────────┬───────────────────────────────────┬───────────────────┘
                  │                                   │
                  ▼                                   ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Reputation Oracle                                │
│  Computes 6-factor score from attestations, flags, age, external trust  │
│  Proposes scores with challenge window before finalization              │
└─────────────────┬───────────────────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         On-Chain Contracts                               │
│  ┌──────────────┐  ┌─────────────────┐  ┌─────────────────────────────┐ │
│  │SigvaraIdentity│  │SigvaraReputation│  │    SigvaraStaking           │ │
│  │  (legacy DID) │  │ (score anchor)  │  │ (bonds + slashing)          │ │
│  └──────────────┘  └─────────────────┘  └─────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                           Consumers                                      │
│  SDK verifiers, on-chain `meetsThreshold()` checks, CounterAudit        │
└─────────────────────────────────────────────────────────────────────────┘
```

### 1.3 Maturity Signals

| Signal | Status | Assessment |
|---|---|---|
| **Smart Contract Tests** | ✅ Comprehensive | Unit tests, E2E tests, fuzz tests (1000/5000 runs), storage layout tests |
| **CI Pipeline** | ✅ Present | Forge build/test, Vitest (SDK), Node test (oracle), Slither static analysis |
| **Static Analysis** | ✅ Integrated | Slither in CI, fails on High findings, accepted findings documented in ADR-0002 |
| **SDK Tests** | ✅ Present | Vitest suite for all SDK modules |
| **Oracle Tests** | ✅ Present | Node test runner for all oracle modules |
| **External Audit** | ❌ None | No third-party security audit has been performed |
| **Deployment Scripts** | ✅ Present | `script/Deploy.s.sol` with role wiring |
| **Deployment Artifacts** | ❌ Missing | `deployments/5042002.json` not committed (`.gitkeep` only) |
| **Documentation** | ✅ Good | Architecture, quickstart, integration guides, ADRs present |
| **Security Policy** | ✅ Present | `SECURITY.md` with disclosure process |
| **Lineage Documentation** | ✅ Present | Prior testnet run documented in `docs/lineage.md` |

### 1.4 Open Issues/PRs Affecting Readiness

| Item | Type | Impact |
|---|---|---|
| Dependabot PRs (6) | Closed | No blocking dependencies |
| No open issues | — | No known blocking bugs |

---

## 2. Security Review

### 2.1 Smart Contract / Crypto-Economic Risks

#### 2.1.1 Access Control (Severity: **Informational**)

**Finding:** Access control is well-structured using OpenZeppelin's `AccessControlUpgradeable`.

**Evidence:**

```solidity
// src/SigvaraReputation.sol:40-50
bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
bytes32 public constant STAKING_CORE_ROLE = keccak256("STAKING_CORE_ROLE");
bytes32 public constant SLASHING_COMMITTEE_ROLE = keccak256("SLASHING_COMMITTEE_ROLE");
bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");
```

**Assessment:** Roles are correctly separated. `STAKING_CORE_ROLE` can only zero reputation (not inflate it). `ORACLE_ROLE` can only propose scores (not bypass challenge windows). `SLASHING_COMMITTEE_ROLE` can reject proposals but not write arbitrary scores.

**Recommendation:** No changes required for role structure. Ensure mainnet deployment uses a governance timelock for `DEFAULT_ADMIN_ROLE`.

---

#### 2.1.2 Upgradeability (Severity: **Medium**)

**Finding:** All core contracts use UUPS upgradeable proxies with `UPGRADER_ROLE` gating.

**Evidence:**

```solidity
// src/SigvaraReputation.sol:312
function _authorizeUpgrade(address) internal override onlyRole(UPGRADER_ROLE) {}
```

**Risks:**
1. A compromised `UPGRADER_ROLE` holder can replace contract logic arbitrarily
2. Storage layout tests are present but manual — could drift if developers forget to update them

**Assessment:** UUPS is industry-standard. The team has implemented storage layout tests to prevent slot corruption, which is excellent practice.

**Recommendations:**
- **[HIGH PRIORITY]** Mainnet `UPGRADER_ROLE` must be a governance timelock (minimum 48h delay)
- Consider using OpenZeppelin's storage gap pattern in addition to slot pinning tests
- Document the upgrade procedure including simulation requirements

---

#### 2.1.3 Oracle Trust Model (Severity: **High**)

**Finding:** The reputation oracle is a single trusted party with no on-chain liveness or correctness guarantees.

**Evidence:**

```javascript
// oracle/index.js:42-43
if (!cfg.rpcUrl || !cfg.privateKey || !cfg.identityAddress || !cfg.reputationAddress) {
  console.error('[oracle] Missing required env vars...');
```

The oracle holds `ORACLE_ROLE` and can propose any score within factor caps. The challenge window (1-6 hours) allows committee rejection, but:
1. Committee must be online during the window
2. Committee must actively monitor proposals
3. No automated detection of anomalous scores

**Crypto-Economic Risks:**
- Oracle collusion with agents to inflate scores
- Oracle downtime preventing score updates (agents can't build reputation)
- Oracle private key compromise allows arbitrary score proposals

**Recommendations:**
- **[CRITICAL for Mainnet]** Implement multi-oracle consensus (UMA OptimisticOracle, Kleros, or custom threshold signature)
- Add oracle bond requirement via `SigvaraOracleBond` (already implemented but not wired)
- Implement automated anomaly detection for the challenge window
- Consider on-chain verifiable score computation for critical factors

---

#### 2.1.4 Slashing Fairness (Severity: **Medium**)

**Finding:** Slashing is committee-initiated with a 7-day challenge period. The dispute mechanism is limited.

**Evidence:**

```solidity
// src/SigvaraStaking.sol:329-347
function disputeSlash(bytes32 didHash) external nonReentrant {
    SlashProposal storage proposal = slashProposals[didHash];
    if (proposal.state != SlashState.Pending) revert NoActivePendingSlash(didHash);
    // ...
    proposal.state = SlashState.Cancelled;
    identityRegistry.updateStatus(didHash, SigvaraIdentity.AgentStatus.Active);
}
```

**Concerns:**
1. Dispute simply cancels the slash — no evidence evaluation
2. Committee can re-initiate immediately after cancellation (griefing vector)
3. Evidence is stored as an opaque hash (`evidenceHash`) — no on-chain verification

**Assessment:** The model is intentionally simple for testnet. The documentation acknowledges mainnet should use UMA or Kleros.

**Recommendations:**
- **[HIGH PRIORITY for Mainnet]** Implement proper dispute resolution (UMA bond escalation or Kleros arbitration)
- Add cooldown between slash cancellation and re-initiation for the same agent
- Consider requiring committee bond that is slashed on successful disputes

---

#### 2.1.5 Reentrancy Protection (Severity: **Informational**)

**Finding:** All state-changing functions with external calls use `nonReentrant` modifier.

**Evidence:**

```solidity
// src/SigvaraStaking.sol:194
function depositStake(bytes32 didHash, uint256 amount) external nonReentrant {
```

**Assessment:** Reentrancy is properly mitigated throughout. CEI (Checks-Effects-Interactions) pattern is followed.

---

#### 2.1.6 Economic Attack: Unbonding Queue Dodge (Severity: **Fixed**)

**Finding:** Previously, an operator could queue a full withdrawal to dodge slashing. This has been fixed.

**Evidence:**

```solidity
// src/SigvaraStaking.sol:299-304
// Slashable balance is the active stake PLUS anything queued for withdrawal.
if (stakes[didHash].amount + stakes[didHash].unbondingAmount == 0) revert NoStake(didHash);
```

**Assessment:** The fix correctly includes unbonding amounts in the slashable balance. Test coverage confirms this: `test_exitDodge_slashStillInitiableWhenFullyQueued`.

---

#### 2.1.7 Timestamp Dependence (Severity: **Low**)

**Finding:** Challenge windows and unbonding periods use `block.timestamp`.

**Evidence:**

```solidity
// src/SigvaraReputation.sol:208
if (block.timestamp < finalizableAt) revert ChallengeWindowActive(didHash, finalizableAt);
```

**Assessment:** Documented in ADR-0002 as acceptable. Minimum window is 6 hours (score challenge), making validator timestamp manipulation (~15 seconds) irrelevant.

---

#### 2.1.8 No Score Enforcement for Slashed Agents (Severity: **Low**)

**Finding:** The oracle can still propose scores for slashed agents; enforcement is off-chain.

**Evidence:**

```solidity
// test/E2E.t.sol:476-486
// New proposal still results in zero because slash clears pending too
// (The oracle could still propose, but finalization writes to storage
// which is immediately zeroed by any subsequent slash — in practice,
// the oracle should not propose for slashed agents)
```

**Recommendation:** Add on-chain check in `proposeReputation` to reject proposals for slashed agents (query SigvaraIdentity status).

---

### 2.2 Off-Chain / Operations Risks

#### 2.2.1 Oracle Key Management (Severity: **High**)

**Finding:** Oracle private key is loaded from environment variable with no HSM or threshold signature support.

**Evidence:**

```javascript
// oracle/chain.js:39-40
provider = deps.provider ?? new ethers.JsonRpcProvider(cfg.rpcUrl);
wallet = deps.wallet ?? new ethers.Wallet(cfg.privateKey, provider);
```

**Recommendations:**
- **[CRITICAL for Mainnet]** Use HSM-backed key management (AWS CloudHSM, Azure Key Vault)
- Consider threshold signatures (at minimum 2-of-3)
- Implement key rotation procedure without service interruption

---

#### 2.2.2 Oracle State Persistence (Severity: **Medium**)

**Finding:** Attestation and flag state is persisted to a JSON file. Loss of this file resets agent scores.

**Evidence:**

```javascript
// oracle/store.js:9-11
const STATE_PATH = process.env.ORACLE_STATE_PATH || '/data/oracle-state.json';
```

**Risks:**
1. Single point of failure for off-chain attestation data
2. No backup/recovery mechanism documented
3. Corruption during write (mitigated by atomic write)

**Recommendations:**
- Implement redundant state storage (database, distributed KV store)
- Add backup/restore procedures
- Consider on-chain attestation anchoring for critical data

---

#### 2.2.3 Admin Token for Oracle API (Severity: **Medium**)

**Finding:** Oracle HTTP endpoints are gated by a shared `ORACLE_ADMIN_TOKEN`.

**Evidence:**

```javascript
// oracle/index.js:262
if (!isAuthorized(req.headers, cfg.adminToken)) return json(res, 401, { error: 'Unauthorized' });
```

**Risks:**
1. Single shared secret for all attestation sources
2. No per-client API keys or rate limits beyond IP-based
3. Token in environment variable could be leaked

**Recommendations:**
- Implement per-client API keys with rotation support
- Add request signing (HMAC or asymmetric)
- Implement IP allowlisting for production deployments

---

#### 2.2.4 RPC Trust (Severity: **Low**)

**Finding:** Both oracle and SDK trust a single RPC endpoint without verification.

**Evidence:**

```javascript
// oracle/chain.js:39
provider = deps.provider ?? new ethers.JsonRpcProvider(cfg.rpcUrl);
```

**Recommendations:**
- Use multiple RPC endpoints with consistency checking
- Consider running own node for mainnet
- Implement RPC response validation for critical reads

---

### 2.3 Dependency and Supply-Chain Risks

#### 2.3.1 Solidity Dependencies (Severity: **Low**)

| Dependency | Version | Notes |
|---|---|---|
| OpenZeppelin Contracts | v5.6.1 | Pinned, well-audited |
| OpenZeppelin Contracts Upgradeable | v5.6.1 | Pinned, well-audited |
| forge-std | latest | Test-only, not deployed |

**Assessment:** Dependencies are minimal and well-maintained. OZ pinning is good practice.

---

#### 2.3.2 Oracle Dependencies (Severity: **Low**)

| Dependency | Version | Notes |
|---|---|---|
| ethers | ^6.0.0 | Well-maintained |
| dotenv | ^17.4.2 | Minimal, low risk |

**Assessment:** Minimal dependency tree reduces supply-chain risk.

---

#### 2.3.3 SDK Dependencies (Severity: **Low**)

The SDK has dev dependencies for TypeScript and Vitest but minimal runtime dependencies.

**Recommendations:**
- Enable Dependabot auto-merge for patch updates
- Pin critical dependencies
- Run `npm audit` in CI

---

### 2.4 Findings Summary

| ID | Severity | Finding | Status |
|---|---|---|---|
| SEC-01 | **Critical** | No external security audit | Open |
| SEC-02 | **Critical** | Single-operator oracle with no consensus | Open |
| SEC-03 | **High** | Oracle key management via environment variable | Open |
| SEC-04 | **High** | Slashing dispute has no arbitration mechanism | Open |
| SEC-05 | **Medium** | UPGRADER_ROLE must use timelock on mainnet | Open |
| SEC-06 | **Medium** | Oracle state persistence is single-file JSON | Open |
| SEC-07 | **Medium** | Committee can grief-slash by re-initiating after dispute | Open |
| SEC-08 | **Low** | Timestamp dependence in challenge windows | Accepted (ADR-0002) |
| SEC-09 | **Low** | No on-chain rejection of scores for slashed agents | Open |
| SEC-10 | **Informational** | Access control well-structured | N/A |
| SEC-11 | **Informational** | Reentrancy protection present throughout | N/A |
| SEC-12 | **Fixed** | Unbonding queue slashing dodge | Fixed |

---

## 3. Enhancements and Optimizations

### 3.1 Gas Optimizations

#### 3.1.1 Pack ReputationData Struct (Severity: **Low**)

The `ReputationData` struct uses 6 `uint8` fields plus a `uint256 lastUpdated`. The `uint8` fields pack into a single slot, which is already efficient.

**Current:**
```solidity
struct ReputationData {
    uint8 feeScore;          // max 30
    uint8 successScore;      // max 25
    uint8 ageScore;          // max 20
    uint8 externalScore;     // max 15
    uint8 communityScore;    // max  5
    uint8 propagationScore;  // max  5
    uint256 lastUpdated;
}
```

**Assessment:** Already optimally packed. No changes needed.

---

#### 3.1.2 Batch Score Proposals

**Enhancement:** Allow oracle to propose multiple agent scores in a single transaction.

**Benefit:** Reduces gas costs per agent by amortizing base transaction costs.

**Priority:** Medium (operational cost reduction)

---

### 3.2 Reliability Improvements

#### 3.2.1 Oracle Health Monitoring

**Enhancement:** The `/health` endpoint exists but lacks external alerting integration.

**Recommendations:**
- Add Prometheus-compatible `/metrics` endpoint (exists)
- Set up Grafana dashboards for epoch latency, proposal success rate
- Configure PagerDuty/Slack alerts for epoch failures

**Priority:** High (operational reliability)

---

#### 3.2.2 Graceful Epoch Degradation

**Enhancement:** Currently, if the oracle fails mid-epoch, partial work is lost.

**Recommendations:**
- Implement checkpoint-based epoch processing
- Store per-agent proposal state to resume after failure
- Add epoch timeout with automatic retry

**Priority:** Medium

---

### 3.3 Developer Experience

#### 3.3.1 Local Development Setup

**Enhancement:** No `docker-compose` for full local stack (contracts + oracle + test UI).

**Recommendations:**
- Add `docker-compose.local.yml` with Anvil fork, oracle, and test harness
- Document local testing workflow

**Priority:** Low (DX improvement)

---

#### 3.3.2 SDK Error Messages

**Enhancement:** Some SDK errors return raw ethers exceptions.

**Recommendations:**
- Wrap common errors with user-friendly messages
- Add error codes for programmatic handling

**Priority:** Low

---

### 3.4 Protocol Design Improvements

#### 3.4.1 Score History

**Enhancement:** Only the latest score is stored on-chain. Historical scores require event indexing.

**Recommendations:**
- Consider emitting richer events with factor breakdown
- Document recommended indexing approach (The Graph, custom indexer)

**Priority:** Low (consumer convenience)

---

#### 3.4.2 Partial Slashing

**Enhancement:** Current model is all-or-nothing slash.

**Recommendations:**
- Consider graduated slashing based on offense severity
- Add explicit slashing tiers to committee evidence requirements

**Priority:** Medium (fairness improvement)

---

### 3.5 Prioritized Backlog

| Priority | Item | Effort |
|---|---|---|
| P0 | External security audit | External |
| P0 | Multi-oracle consensus design | High |
| P1 | HSM key management for oracle | Medium |
| P1 | Dispute arbitration integration (UMA/Kleros) | High |
| P1 | Governance timelock deployment | Low |
| P2 | Oracle state redundancy | Medium |
| P2 | Per-client API authentication | Medium |
| P2 | Batch score proposals | Medium |
| P3 | Local development Docker setup | Low |
| P3 | Score history indexing docs | Low |

---

## 4. Mainnet Readiness Assessment

### 4.1 Checklist

| Category | Item | Ready | Notes |
|---|---|---|---|
| **Security** | External audit completed | ❌ | No audit performed |
| **Security** | All Critical/High findings resolved | ❌ | SEC-01 through SEC-04 open |
| **Security** | Slither passes (High severity) | ✅ | CI enforces |
| **Security** | Access control reviewed | ✅ | Roles well-separated |
| **Deployment** | Governance timelock configured | ❌ | Not deployed |
| **Deployment** | Multisig for committee role | ❌ | Not deployed |
| **Deployment** | Bond token decided | ❌ | TBD (SVR vs WETH/USDC) |
| **Deployment** | Deployment artifacts committed | ❌ | `deployments/` empty |
| **Deployment** | Deployment runbook documented | ⚠️ | `docs/arc.md` partial |
| **Operations** | Oracle monitoring/alerting | ❌ | Metrics endpoint exists, no alerting |
| **Operations** | Incident response plan | ❌ | Not documented |
| **Operations** | Key rotation procedures | ❌ | Not documented |
| **Testing** | Contract unit tests | ✅ | Comprehensive |
| **Testing** | Contract fuzz tests | ✅ | 1000/5000 runs |
| **Testing** | E2E integration tests | ✅ | Full lifecycle covered |
| **Testing** | SDK tests | ✅ | Vitest suite |
| **Testing** | Oracle tests | ✅ | Node test runner |
| **Testing** | Testnet deployment validated | ⚠️ | Prior Robinhood Chain run; Arc not committed |
| **Documentation** | Architecture documented | ✅ | |
| **Documentation** | Security policy published | ✅ | SECURITY.md |
| **Documentation** | Integration guides | ✅ | Quickstart, AI frameworks |

### 4.2 Go / No-Go Assessment

**Verdict: CONDITIONAL NO-GO**

The protocol demonstrates strong engineering fundamentals:
- Clean architecture with well-separated concerns
- Comprehensive test coverage including fuzz testing
- Thoughtful security considerations (reentrancy guards, storage layout tests, CEI pattern)
- Good documentation and security disclosure process

However, the following **must be true** before responsible mainnet deployment:

#### Mandatory (Blocking)

1. **Complete a Tier-1 security audit** (Trail of Bits, OpenZeppelin, Consensys Diligence, or equivalent)
2. **Deploy governance timelock** for `DEFAULT_ADMIN_ROLE` and `UPGRADER_ROLE` (48h minimum)
3. **Deploy committee multisig** (3-of-5 minimum) for `SLASHING_COMMITTEE_ROLE`
4. **Decide and document bond token** — if using native USDC on Arc, verify ERC-20 interface compatibility
5. **Commit deployment artifacts** to `deployments/{chainId}.json`

#### Strongly Recommended

6. **Implement oracle consensus** or multi-signature proposal (single-operator oracle is unacceptable for mainnet)
7. **HSM-backed oracle key management** (AWS CloudHSM, Azure Key Vault)
8. **Dispute arbitration integration** (UMA OptimisticOracle or Kleros)
9. **Operational monitoring** (Prometheus + Grafana + PagerDuty/Slack)
10. **Incident response runbook** documenting pause, key rotation, and recovery procedures

### 4.3 Gap Analysis vs Stated Goals

| Goal | Status | Gap |
|---|---|---|
| **ERC-8004 identity layer** | ✅ Adopted | ADR-0001 documents transition; `/link` bridge implemented |
| **Computed reputation** | ✅ Implemented | 6-factor model live; oracle computes and proposes |
| **Staked slashing** | ✅ Implemented | Bond management, challenge window, 50/25/25 distribution |
| **Arc deployment** | ⚠️ Partial | Deploy script works; no committed artifacts |
| **Decentralized oracle** | ❌ Missing | Single-operator only; roadmap says "Phase 2" |
| **External trust (ERC-8004 feedback)** | ✅ Implemented | `externalScore` factor live via `/link` |
| **Trust propagation** | ❌ Stub | `propagationScore` always 0 |

---

## 5. Recommendations Summary

### Immediate Actions (Before Any Production Use)

1. **Engage a security auditor** — scope should include all `src/*.sol` contracts
2. **Do not deploy to Arc mainnet** until audit is complete
3. **Commit testnet deployment** artifacts to track deployed addresses

### Pre-Mainnet Checklist

1. Complete audit and remediate findings
2. Deploy governance timelock (48h+ delay)
3. Deploy 3-of-5 committee multisig
4. Finalize bond token (verify Arc native USDC compatibility)
5. Wire `SigvaraOracleBond` for oracle accountability
6. Set up monitoring and alerting
7. Document incident response procedures
8. Perform mainnet dry-run on Arc testnet with full ops stack

### Post-Mainnet Roadmap

1. Implement multi-oracle consensus (Phase 2)
2. Integrate UMA or Kleros for dispute resolution
3. Complete trust propagation (`propagationScore`) factor
4. Full ERC-8004 migration (retire `SigvaraIdentity` registry)

---

## Appendix A: Files Reviewed

### Contracts
- `src/SigvaraReputation.sol`
- `src/SigvaraStaking.sol`
- `src/SigvaraIdentity.sol`
- `src/SigvaraOracleBond.sol`
- `src/SigvaraEpochFees.sol`
- `src/SVRToken.sol`

### Tests
- `test/E2E.t.sol`
- `test/SigvaraReputation.t.sol`
- `test/SigvaraStaking.t.sol`
- `test/SigvaraIdentity.t.sol`
- `test/SigvaraOracleBond.t.sol`
- `test/SigvaraEpochFees.t.sol`

### Oracle
- `oracle/index.js`
- `oracle/chain.js`
- `oracle/scoring.js`
- `oracle/store.js`
- `oracle/epoch-policy.js`
- `oracle/external.js`

### SDK
- `packages/sdk/src/*.ts`
- `packages/sdk/test/*.ts`

### Deployment
- `script/Deploy.s.sol`
- `foundry.toml`
- `.github/workflows/ci.yml`

### Documentation
- `README.md`
- `SECURITY.md`
- `docs/architecture.md`
- `docs/arc.md`
- `docs/quickstart.md`
- `docs/reputation-model.md`
- `docs/adr/0001-erc8004-as-identity-layer.md`
- `docs/adr/0002-analyzer-accepted-findings.md`
- `site/SECURITY_DEPLOYMENT_CHECKLIST.md`

---

## Appendix B: Test Coverage Verification

```bash
# Contract tests (1000 fuzz runs default, 5000 in CI)
forge test -vvv

# Oracle tests
cd oracle && node --test

# SDK tests
cd packages/sdk && npm test
```

All test suites pass as of review date.

---

## Appendix C: Static Analysis Output

Slither 0.11.5 reports 0 High findings. Medium/Low findings are documented and accepted in `docs/adr/0002-analyzer-accepted-findings.md`.

---

*This review is provided for informational purposes and does not constitute a formal security audit. A professional audit by a specialized firm is strongly recommended before mainnet deployment.*
