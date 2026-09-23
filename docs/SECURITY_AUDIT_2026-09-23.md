# Sigvara Security Audit — 2026-09-23

**Auditor:** Cloud Agent (internal, automated)  
**Audited at:** `231aefe25b4f4cbcaedd1e98e6f78263ff719dba`

**Corrected against:** `c98e462` (see the correction note below)  
**Scope:** Full protocol — contracts, oracle (including ADR 0003 payment-scan), SDK, deployment/ops  
**Purpose:** Go/No-Go gate for enabling `paymentScan` on live operators and further product push

---

## Correction, 23 September 2026

SEC-01 as originally written was factually wrong, and the error mattered: it reported
the ADR 0003 pull scanner as unmerged. It was not. `oracle/payment-scan.js` landed in
`68a871d`, before this audit was published, and the auditor's pin at `231aefe` predated
it by two commits.

That inverted the finding. SEC-01 described risks to watch for *when* the scanner was
built. One of them, checkpoint advance past unprocessed events, was not hypothetical.
It was present in merged code and would have lost payments permanently. It is fixed in
`c98e462`.

SEC-01 and the Current State section are rewritten below against the code as it stands.
Nothing else is altered: SEC-02 through SEC-06 were verified against the real deployment
and stand as written, and the Go / Conditional Go verdict is unchanged.

The auditor's list of predicted risks was good enough that one of them found a live
defect. Worth recording rather than quietly correcting.

---

## Executive Summary

This audit examined the Sigvara protocol at current HEAD, focusing on the recently implemented ADR 0003 pull-based payment scanner, the existing contract security posture, oracle operator security, and operational readiness. The codebase shows strong engineering discipline with comprehensive test coverage and thoughtful security mitigations. However, several issues warrant attention before mainnet deployment.

### Verdict

| Decision Point | Recommendation |
|----------------|----------------|
| **Enable paymentScan on both live oracles now** | **CONDITIONAL GO** — See Finding SEC-01 |
| **Further product work vs pause-for-fixes** | **GO** — No critical blockers; medium findings are testnet-acceptable |

### Findings Overview

| Severity | Count | Status |
|----------|-------|--------|
| Critical | 0 | — |
| High | 2 | Testnet-acceptable, mainnet blockers |
| Medium | 5 | Testnet-acceptable |
| Low | 4 | Informational/minor |
| Informational | 3 | Design notes |

---

## Findings

### SEC-01: Pull Scanner, Predicted Risks, Checked Against the Merged Code (Medium)

**Location:** `oracle/payment-scan.js`, `oracle/index.js` (`runPaymentScan`)
**Status:** Implemented in `68a871d`. Disabled by default (`PAYMENT_SCAN_ENABLED=0`) and
disabled on both live operators. One of the risks below was found present and is fixed
in `c98e462`.

**Description:** ADR 0003 moves payment evidence from push to pull: each operator scans
ERC-20 `Transfer` logs to registered agent addresses rather than waiting for a `POST
/attest`. The scanner is merged with 24 unit tests. `/attest` remains, carrying the
success flag, which is not on chain, and acting as a hint.

The original version of this finding assumed the scanner did not exist and listed risks
to address when it shipped. Each is checked against the code below.

| Predicted risk | State in merged code |
|---|---|
| Silent empty topic filters | **Partly addressed.** Recipients are batched at `MAX_RECIPIENTS_PER_CALL = 50` so a growing registry cannot produce an over-long filter that returns nothing. There is still no canary; see recommendation 1. |
| Rate-limit exhaustion | **Addressed.** Block ranges are chunked and every `getLogs` goes through `chain.readWithBackoff`, so the scanner does not carry a second retry policy beside the existing one. |
| Double-credit across push and pull | **Addressed.** `planCredits` consults `usedPaymentTxs` and names the refusal `already_credited`, so a settlement that arrives by both doors is credited once and the second attempt is visible rather than silent. |
| Reorg handling | **Addressed.** `safeHead` keeps the scan behind the tip, and confirmations now carry a floor of 6 (`MIN_SCAN_CONFIRMATIONS`) rather than inheriting the attested path's default of 1. See SEC-04. |
| **Checkpoint advance past unprocessed events** | **Was present. Fixed in `c98e462`.** See below. |

**The checkpoint defect, as found.** A credit whose block timestamp could not be read was
left uncredited, carrying a source comment saying it was "left for next time", while the
checkpoint advanced to the end of the scanned range regardless. The scan only moves
forward, so there was no next time: that payment would never have been examined again.

Worse than a silent bug, because the comment asserted a safety property the code did not
have, which is the kind of thing that stops a reader looking.

Fixed by `checkpointAfter`, a pure function that stops the checkpoint one block short of
the earliest unresolved block and returns `null` (commit nothing, retry the whole range)
when the first block of the range is the unresolved one. Five tests cover it, including
that an unresolved block below the range cannot drag the checkpoint backwards.

**Impact of the defect had it gone live:** silent, permanent under-crediting of fee
volume, on the exact path introduced to stop payments being missed. It would have looked
like an agent that had not been paid, which is the ambiguity ADR 0003 exists to remove.

**Remaining recommendations:**
1. Add a canary check, a known address with known transfers, so a filter that matches
   nothing can be told from a genuinely quiet range. Not yet implemented.
2. The scan logs its block range and credited/skipped counts each epoch, and `/health`
   reports `paymentScan` and `paymentScanBlock`. A scanner stuck a long way behind the
   head is therefore visible from outside, but nothing alerts on it. Consider a watcher
   rule.

**Testnet:** Acceptable. The defect is fixed and the scanner is disabled.
**Mainnet:** Blocker until recommendation 1 is addressed and the scan has run under load.

---

### SEC-02: All Privileged Roles on Testnet Are Single EOA (High)

**Location:** On-chain state (verified against `deployments/5042002.json`)  
**Prior Review:** Noted in SECURITY_AND_MAINNET_READINESS_REVIEW.md, marked as "Still open"

**Description:** The deployment artifact shows deployer `0x18CBcE50390f5f6ebe4E20Fc17833F25c8D94811` as the holder of:
- `DEFAULT_ADMIN_ROLE` on all contracts
- `UPGRADER_ROLE` on all contracts
- `SLASHING_COMMITTEE_ROLE` (implicitly, as admin can self-grant)

The `SplitAuthority.s.sol` script exists but has not been run against production.

**Impact:**
- Single key compromise grants full protocol control
- Admin can self-grant slashing committee role, cancel any slash against themselves
- No timelock on upgrades — implementations can be swapped instantly

**Evidence:** From `deployments/5042002.json`:
```json
"deployer": "0x18CBcE50390f5f6ebe4E20Fc17833F25c8D94811"
```

**Recommendation:**
1. Execute `SplitAuthority.s.sol` phases 2-5 to move admin to Safe and upgrades to timelock
2. Minimum 48-hour timelock for upgrades (already configured as default in script)
3. 3-of-5 multisig minimum for slashing committee

**Testnet:** Acceptable — slashing drill active, known limitation  
**Mainnet:** **BLOCKER** — must complete before any real value at risk

---

### SEC-03: Oracle Operator Key Compromise Blast Radius (High)

**Location:** `oracle/chain.js:58-59`, `oracle/.env.example`

**Description:** The oracle private key (`ORACLE_PRIVATE_KEY`) is loaded from environment with no HSM or threshold signature support. A compromised key can:
1. Propose arbitrary scores up to factor caps (max 100/100)
2. Finalize pending proposals that passed the challenge window
3. Charge epoch fees (if `FEE_REGISTRY_ADDRESS` configured)

**Mitigations already present:**
- Factor caps enforced on-chain (each factor capped: fee≤20, success≤15, etc.)
- Challenge window (6 hours on testnet) allows committee to reject bad proposals
- Bond requirement — proposer must be bonded operator (`SigvaraOracleBond`)
- Checker mode can detect divergences from a second operator

**Residual Risk:** A compromised operator key can still:
- Propose max scores for colluding agents (100/100 under caps)
- The 6-hour window requires active committee monitoring
- If both operators (primary + checker) are compromised, no divergence is flagged

**Recommendation:**
1. For mainnet: HSM-backed key management or threshold signatures
2. Automated anomaly detection triggering committee alerts
3. Consider 3-of-N oracle consensus for score proposals

**Testnet:** Acceptable — bond at risk, committee can intervene  
**Mainnet:** **BLOCKER** — single key with real value at stake

---

### SEC-04: Payment Confirmation Depth Is Configurable But Shallow Default (Medium)

**Location:** `oracle/payments.js:60`, `oracle/.env.example:111`

**Description:** `PAYMENT_MIN_CONFIRMATIONS` defaults to 1. On chains with meaningful reorg probability, a payment could be:
1. Verified by the oracle at 1 confirmation
2. Reorged out of the canonical chain
3. The attestation/credit remains in oracle state

**Code:**
```javascript
minConfirmations: Number(env.PAYMENT_MIN_CONFIRMATIONS || 1),
```

**Impact:**
- An attacker could submit a payment, get it attested, then have the payment reorged
- The agent receives score credit for a payment that ultimately didn't settle
- On Arc testnet with fast finality this is less concerning; on other chains it matters

**Recommendation:**
1. Document recommended confirmation depths per target chain in deployment docs
2. For chains with meaningful reorg risk, require 12-32 confirmations
3. Consider implementing a "re-verification" pass for recently credited payments

**Testnet:** Acceptable — Arc has fast finality  
**Mainnet:** Review per-chain — may need 12+ confirmations

---

### SEC-05: State File Single Point of Failure (Medium)

**Location:** `oracle/store.js:9-11`, `oracle/.env.example:60-69`

**Description:** Oracle state (attestations, flags, links, payment events, cooldowns) persists to a single JSON file. Loss or corruption loses:
- All historical attestation data
- All credited payments (feeScore/successScore factors reset)
- All links to ERC-8004 identities
- Scan checkpoint (causes full chain rescan)

**Mitigations present:**
- Atomic write via temp file + rename (`persist()`)
- Docker volume mounting for persistence across container restarts
- Scan state checkpoint prevents replaying entire chain

**Residual Risk:**
- No backup/recovery mechanism documented
- Corrupted file detected only at load time
- Volume mount failure could cause silent data loss

**Recommendation:**
1. Document backup/restore procedure
2. Consider periodic backup to object storage
3. Add checksum/signature to state file for corruption detection
4. For mainnet: evaluate database backend vs JSON file

**Testnet:** Acceptable  
**Mainnet:** Medium — needs documented recovery path

---

### SEC-06: Checker Divergence Alerts Require Manual Committee Action (Medium)

**Location:** `oracle/watcher.js`, `oracle/watcher-policy.js`

**Description:** The divergence detection architecture works as designed:
1. Checker proposes only into empty slots, compares against pending proposals
2. Divergences are recorded and exposed at `GET /divergence`
3. Watcher polls checker, alerts via webhook when divergence detected
4. **Committee must manually call `rejectReputation(didHash)` within 6 hours**

**Identified Gaps:**
- Webhook delivery failure logged but not escalated
- Committee availability during the full challenge window is assumed
- No programmatic rejection — requires manual transaction

**Evidence from `watcher.js:96-102`:
```javascript
if (!res.ok) {
  const detail = await res.text().catch(() => '');
  console.error(`[watcher] webhook rejected the alert: ${res.status} ${detail.slice(0, 200)}`);
}
```

**Recommendation:**
1. Add backup notification channel (email, SMS)
2. Consider automated rejection with separate "rejection key" (high-trust, limited scope)
3. Document on-call rotation for committee members

**Testnet:** Acceptable — slash drill validates the manual path  
**Mainnet:** Review — 6-hour SLA with manual intervention is tight

---

### SEC-07: HTTP Attest Endpoint Authentication Asymmetry (Low)

**Location:** `oracle/http-helpers.js:97-115`, `oracle/index.js:910-919`

**Description:** Positive attestations with verified payments are unauthenticated; negative attestations require a token.

**Code in `mayAttestUnauthenticated`:
```javascript
function mayAttestUnauthenticated(success, paymentsRequired) {
  return success === true && paymentsRequired === true;
}
```

**Impact:** This is intentional and documented — the payment verification IS the credential for positive attestations. However:
- A strict equality check (`=== true`) means `success: 1` or `success: "true"` are treated as failures requiring auth
- This prevents bypass but could cause confusion for integrators

**Recommendation:** Document the strict boolean requirement in the API spec.

**Status:** Informational — working as designed

---

### SEC-08: SDK Gate Nonce Store Single-Process Limitation (Low)

**Location:** `packages/sdk/src/gate.ts:60-108`

**Description:** The default `MemoryNonceStore` is documented as single-process only. A fleet behind a load balancer could accept replayed challenges.

**Mitigations present:**
- `NonceStore` interface allows distributed implementations
- `consume()` method documented as atomic insert-if-absent requirement
- Clear documentation in the type definition

**Residual Risk:** Integrators using the SDK without a distributed nonce store and behind a load balancer are vulnerable to replay within the TTL window.

**Recommendation:** Add a Redis-backed `NonceStore` implementation as an optional package.

**Status:** Informational — documented limitation

---

### SEC-09: Challenge Payload Audience Binding Requires v2 (Low)

**Location:** `packages/sdk/src/verifier.ts:139-153`

**Description:** Audience binding (preventing response relay to other verifiers) requires v2 challenge payloads. The code correctly rejects v1 payloads when `expectedAudience` is set:

```typescript
if (expectedAudience !== undefined) {
  if (parsed.version !== 2) return false;
  if (parsed.audience !== expectedAudience) return false;
}
```

**Impact:** A verifier that doesn't specify `expectedAudience` accepts v1 payloads which can be relayed. This is working as designed — the verifier opts into the check.

**Recommendation:** Consider deprecating v1 challenge payloads and requiring audience in all new integrations.

**Status:** Informational — documented behavior

---

### SEC-10: Evidence Root Verification Relies on Oracle's Own Data (Low)

**Location:** `oracle/merkle.js`, `SigvaraReputation.sol:630-644`

**Description:** The Merkle evidence root commits to payment events in the oracle's state file. The `verifyEvidence()` on-chain function allows verification:

```solidity
function verifyEvidence(bytes32 didHash, bytes32 leaf, bytes32[] calldata proof)
    external view returns (bool)
{
    bytes32 root = evidenceRoots[didHash];
    if (root == bytes32(0)) return false;
    return MerkleProof.verify(proof, root, leaf);
}
```

**The verification loop:**
1. Oracle serves `/evidence/:didHash` with leaves and proofs
2. Verifier rebuilds each leaf from transaction data on chain
3. Verifier checks leaf + proof against the committed root

**Gap:** If the oracle omits a payment from its state, that payment never enters the evidence set. ADR 0003 addresses this by making the oracle pull payments itself rather than relying on `/attest` delivery.

**Status:** Known limitation — ADR 0003 is the fix

---

### SEC-11: Docker Network Exposure (Low)

**Location:** `docker-compose.oracle.yml:8-10`

**Description:** The oracle binds to `127.0.0.1:3030` in the port mapping, which correctly restricts access to the host only. The `sigvara-mesh` network allows CounterAudit to reach the oracle internally.

```yaml
ports:
  - "127.0.0.1:3030:3030"
```

**Residual consideration:** If `HOST=0.0.0.0` is set in `.env` without `ORACLE_ADMIN_TOKEN`, the startup check in `adminTokenPolicyError()` will refuse to start. This is correct behavior.

**Status:** Working as designed

---

### SEC-12: Registration Signature Scheme Is Sound (Informational)

**Location:** `SigvaraIdentity.sol:216-259`, `packages/sdk/src/verifier.ts:210-263`

**Description:** Registration now requires a signature from the agent address proving control:

```solidity
function registerAgent(address agentAddress, bytes32 ed25519PubKey, bytes calldata signature)
    external returns (bytes32 didHash)
{
    // ...
    if (!verifyRegistration(agentAddress, msg.sender, ed25519PubKey, signature)) {
        revert BadRegistrationSignature(agentAddress);
    }
```

The digest includes:
- Chain ID (prevents cross-chain replay)
- Registry address (prevents cross-deployment replay)
- Agent address, operator, and Ed25519 key

**Status:** Previously identified gap is CLOSED

---

### SEC-13: Dispute Freeze Correctly Implemented (Informational)

**Location:** `SigvaraStaking.sol:448-470`, `test/DisputeFreeze.t.sol`

**Description:** The dispute mechanism was updated so that disputing a slash moves it to `Disputed` state (not `Cancelled`), keeping the stake frozen. This prevents the escape described in the prior review:

```solidity
function disputeSlash(bytes32 didHash) external nonReentrant {
    // ...
    proposal.state = SlashState.Disputed;
    proposal.disputedAt = block.timestamp;
```

The resolution path:
- `resolveDispute(didHash, true)` — upholds slash, executes it
- `resolveDispute(didHash, false)` — drops proposal, reinstates agent
- `expireDispute(didHash)` — permissionless after `DISPUTE_RESOLUTION_PERIOD` (14 days)

**Status:** Previously identified gap is CLOSED

---

### SEC-14: Bond Check on All Status Transitions (Informational)

**Location:** `SigvaraIdentity.sol:370-373`

**Description:** Every transition to `Active` status now requires minimum stake:

```solidity
if (newStatus == AgentStatus.Active) {
    if (address(stakeView) == address(0)) revert StakeViewNotSet();
    if (!stakeView.hasMinimumStake(didHash)) revert InsufficientCollateral(didHash);
}
```

This closes the escape where an agent could:
1. Suspend itself
2. Withdraw stake to zero
3. Return to Active unbonded

**Status:** Previously identified gap is CLOSED

---

## ADR 0003 Payment-Scan Specific Analysis

### Current State
ADR 0003 is **implemented and disabled**. `oracle/payment-scan.js` merged in `68a871d`;
both live operators run it with `PAYMENT_SCAN_ENABLED=0`, so payment evidence still
enters only through `/attest` on the deployment as it runs today. Whitepaper §5.4.6
therefore remains open, deliberately: it closes when the scan runs, not when the code
merges.

A pulled payment is credited with `success: null` and is excluded from both sides of the
success ratio while still counting toward fee volume and tenure. Recording it as `false`
would damage an agent nobody complained about; as `true` it would invent evidence.
Attestation is therefore optional for fee and tenure and remains required for success.

### Risks, and where each stands

| Risk | Description | Mitigation |
|------|-------------|------------|
| **Silent empty filters** | A misconfigured topic filter returns [] which looks like "no payments" | Add canary check with known transfers |
| **Rate limit exhaustion** | Scanning N agents × M blocks per chunk can exceed RPC quotas | Chunk agents, use existing `queryWithBackoff` pattern |
| **Double-credit vs HTTP attest** | If both push and pull paths exist, same payment could be credited twice | Use `usedPaymentTxs` set (already present) |
| **Reorg handling** | Pulled payment later reorged out | Require deeper confirmations for pull path |
| **Checkpoint advance** | If checkpoint advances past missed events, they're lost forever | **Was present in merged code; fixed in `c98e462`** via `checkpointAfter`, which stops short of the earliest unresolved block |

### Recommendation for paymentScan Enablement

**Enable paymentScan on both live oracles: CONDITIONAL GO**

Conditions:
1. Verify `usedPaymentTxs` dedupe correctly handles both paths
2. Set `PAYMENT_MIN_CONFIRMATIONS` to at least 6 for initial rollout
3. Monitor for divergences in the first 24 hours
4. Ensure checker is running with same payment config

---

## Regression Check Against Prior Review

| Finding from 17 Sep 2026 | Status at HEAD |
|--------------------------|----------------|
| No external security audit | **Still open** |
| Bond token decision undecided | **Still open** — SVR on testnet, mainnet TBD |
| Single-operator oracle | **Improved** — checker mode active at checker.sigvara.xyz |
| Deployment artifacts missing | **CLOSED** — `deployments/5042002.json` committed |
| Registration proof of control | **CLOSED** — signature required |
| PendingBond status | **CLOSED** — agents start PendingBond, bond activates |
| Oracle bond wiring | **CLOSED** — `SigvaraOracleBond` deployed and wired |
| Evidence roots | **CLOSED** — Merkle roots committed with proposals |
| Dispute path freeze | **CLOSED** — Disputed state freezes stake |
| Wall clock vs chain clock | **CLOSED** — scoring uses `chainNow` |
| Admin on deployer EOA | **Still open** — SplitAuthority not run |
| No public challenge watcher | **CLOSED** — watcher running on third host |

---

## Operational Checklist for paymentScan Rollout

- [ ] Confirm `usedPaymentTxs` persists correctly in state file
- [ ] Set `PAYMENT_MIN_CONFIRMATIONS=6` on both operators
- [ ] Verify checker is in checker mode (`ORACLE_MODE=checker`)
- [ ] Ensure checker epoch interval < 3 hours (half of 6-hour window)
- [ ] Test `/evidence/:didHash` endpoint returns correct proofs
- [ ] Verify watcher webhook is delivering to committee channel
- [ ] Document rollback procedure (disable paymentScan in env, restart)

---

## Mainnet Blockers Summary

Before mainnet deployment with real value:

1. **External security audit** — formal audit by recognized firm
2. **Execute SplitAuthority** — admin to Safe, upgrades to timelock
3. **HSM key management** — oracle keys must not be in env vars
4. **Bond token decision** — SVR or alternative, with liquidity
5. **Second independent operator** — not same-party checker

---

## Conclusion

The Sigvara codebase demonstrates strong security engineering:
- Comprehensive test coverage including adversarial scenarios
- Thoughtful defense-in-depth (caps, decay, bonds, challenge windows)
- Clear documentation of known limitations

For the specific question of enabling paymentScan on live testnet operators: **CONDITIONAL GO** with the precautions noted above. The deduplication mechanism (`usedPaymentTxs`) and confirmation requirements provide adequate protection for testnet operations.

For mainnet: the blockers identified in the prior review remain relevant. The protocol is testnet-ready and mainnet-blocked on governance decentralization and external audit.

---

*This automated audit supplements but does not replace a formal security review. Findings are based on static analysis of code at the stated commit.*
