# CounterAudit Integration Guide

> **Status: enrichment live since 19 September 2026; outcome reporting built, and off in
> production since 30 October 2026.**
>
> Enrichment works and is running on `api.counteraudit.io`, verified against a real
> sealed packet carrying `agent_chain_id: 5042002` with the correct DID hash and the
> live score. It had been broken for the two days since the rename: the code parsed
> `did:countersig:`, hashed that prefix, and was pointed at the predecessor deployment
> on Robinhood Chain.
>
> **Outcome reporting is built, and off in production.** Add `outcome`
> (`success`/`failure`) and `payment_tx_hash` to an ingest and the result is attested to
> the oracle, feeding the agent's Success Rate and Fee Activity, but only for an org
> listed in CounterAudit's `CA_OUTCOME_PUBLISH_ORG_IDS`. The outcome is the ingesting
> org's word, not something CounterAudit checked, so since 30 October 2026 the production
> deployment lists no org. The oracle's last recorded outcome is from 20 September. The settlement hash is required: the oracle
> re-reads that transaction from the chain and takes the payer from the transfer log
> rather than trusting the caller, so a forged hash fails at the oracle. The outcome is
> recorded because CounterAudit presents an oracle token (`SIGVARA_ORACLE_URL` and
> `SIGVARA_ORACLE_TOKEN`, below). A request without a token credits the payment and
> records no outcome.

CounterAudit is a tamper-evident AI audit trail service. An `agent_did` field on an ingest
call enriches each sealed packet with the agent's on-chain Sigvara identity and reputation
score before sealing, so the enrichment sits inside the AES-GCM seal and is covered by the
same tamper-evidence and RFC 3161 timestamp as the rest of the packet.

The property it buys is a reputation score frozen into a tamper-evident record at the
moment of the action, rather than looked up afterwards from a score that has since moved.

---

## How It Works

When your application calls `POST /v1/audit/ingest` with an `agent_did` field:

1. CounterAudit parses the DID: `did:sigvara:<chainId>:<agentAddress>`
2. It computes the `didHash` using the same formula as the on-chain contract
3. It reads one block (the `finalized` block by default), then queries `SigvaraIdentity.getIdentity(didHash)` and `SigvaraReputation.getTotalScore(didHash)` in parallel, both at that block
4. The results are spread into the packet body **before** the AES-GCM seal is applied
5. The full packet body — including Sigvara fields — is then sealed, hashed, and timestamped

This means the reputation score is frozen in time. If an agent's reputation changes after the action, the sealed record still shows what it was at the moment the action occurred.

---

## Setup

### Self-hosted CounterAudit

Add these variables to your `.env`:

`SIGVARA_*` is read first; the older `COUNTERSIG_*` spellings still work as a fallback
so an existing deployment keeps running across the rename.

```bash
# Sigvara identity enrichment (Arc testnet)
SIGVARA_RPC_URL=https://rpc.testnet.arc.io
SIGVARA_IDENTITY_ADDRESS=0x...   # from deployments/5042002.json
SIGVARA_REPUTATION_ADDRESS=0x...   # from deployments/5042002.json
SIGVARA_CHAIN_ID=5042002

# Optional — default is 5000ms
SIGVARA_ENRICH_TIMEOUT_MS=5000

# Optional. The block both enrichment reads are made at. Default 'finalized'; a node
# that refuses it falls back to 'latest', and the snapshot is sealed as provisional.
SIGVARA_BLOCK_TAG=finalized

# Outcome reporting back to the oracle. Both are needed, and the ingesting org must be
# listed in CA_OUTCOME_PUBLISH_ORG_IDS; without them CounterAudit still enriches packets
# and reports nothing.
SIGVARA_ORACLE_URL=https://oracle.sigvara.xyz
SIGVARA_ORACLE_TOKEN=...   # a write credential the oracle operator issued for CounterAudit

# Optional, default is 4000ms
SIGVARA_ORACLE_TIMEOUT_MS=4000
```


Then rebuild and restart the container:

```bash
docker compose -f docker-compose.selfhost.yml build --no-cache counteraudit
docker compose -f docker-compose.selfhost.yml up -d counteraudit
```

On startup you will see: `[counteraudit] sigvara enrichment enabled`

If the three required vars are absent, the service silently no-ops. No existing ingest calls are affected.

### Managed CounterAudit (api.counteraudit.io)

The managed service runs this integration against Arc testnet. Contact CounterAudit to
enable it for your organization.

---

## Making Ingest Calls

Add `agent_did` alongside your existing fields:

```bash
curl -X POST https://api.counteraudit.io/v1/audit/ingest \
  -H "Authorization: Bearer $CA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "connector_id": "my-agent-connector",
    "agent_did": "did:sigvara:5042002:0xYourAgentAddress",
    "raw_event": {
      "action": "tool_call",
      "tool": "web_search",
      "query": "carbon capture techniques",
      "result_count": 10
    }
  }'
```

Response is unchanged — you get `packet_id`, `entry_hash`, `created_at` as normal.

### TypeScript

```typescript
async function auditAction(agentDid: string, event: Record<string, unknown>) {
  const res = await fetch('https://api.counteraudit.io/v1/audit/ingest', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.CA_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      connector_id: 'my-agent',
      agent_did: agentDid,
      raw_event: event,
    }),
  });
  return res.json();
}
```

### Python

```python
import httpx, os

def audit_action(agent_did: str, event: dict) -> dict:
    resp = httpx.post(
        "https://api.counteraudit.io/v1/audit/ingest",
        headers={
            "Authorization": f"Bearer {os.environ['CA_API_KEY']}",
            "Content-Type": "application/json",
        },
        json={
            "connector_id": "my-agent",
            "agent_did": agent_did,
            "raw_event": event,
        },
        timeout=10,
    )
    resp.raise_for_status()
    return resp.json()
```

---

## Reading Enriched Data

Call the verify endpoint with the `packet_id` returned from ingest:

```bash
curl https://api.counteraudit.io/v1/audit/verify/$PACKET_ID \
  -H "Authorization: Bearer $CA_API_KEY"
```

The decrypted `packet` object contains (the values here are illustrative):

```json
{
  "agent_did": "did:sigvara:5042002:0xbCB531B68A87F4BcC3a0394ccD2DB95C52bB4E08",
  "agent_did_hash": "0xef55a65a321380b8e74bb38087a4d3ddfcb5789f86b456317a2a47950dcceca9",
  "agent_chain_id": 5042002,
  "agent_reputation_score": 47,
  "agent_identity_status": "Active",
  "agent_identity_verified": true,
  "agent_enriched_at": "2026-06-30T16:33:39.381Z",
  "agent_chain_snapshot": {
    "chain_id": 5042002,
    "block_number": 69938672,
    "block_hash": "0xda7876205908989efd3c623c65539daf8f83a310096228daea78b9bf3dc1d598",
    "finality": "final",
    "identity_contract": "0x7e3aFC532eE5d922ab3cc3FFb510c7C8151477Dd",
    "reputation_contract": "0x6603C96275e85F724Cdf74666b399365e4cA29ed"
  }
}
```

---

## Enriched Field Reference

| Field | Type | Present when | Description |
|---|---|---|---|
| `agent_did` | string | Always (if agent_did provided) | The W3C DID |
| `agent_did_hash` | hex string | DID parses successfully | On-chain index key |
| `agent_chain_id` | number | DID registered | EVM chain ID |
| `agent_reputation_score` | 0–100 | DID registered | Total score at seal time |
| `agent_identity_status` | string | DID registered | `PendingBond`, `Active`, `Suspended`, or `Slashed` |
| `agent_identity_verified` | boolean | Always | `true` if registered and Active |
| `agent_enriched_at` | ISO 8601 | Always | When the enrichment query ran |
| `agent_chain_snapshot` | object | A block was read | The chain id, block number and hash, `finality` (`final` or `provisional`) and both contract addresses the reads used |
| `agent_enrichment_error` | string | On failure only | Reason (see below) |

### Error values for `agent_enrichment_error`

| Value | Meaning |
|---|---|
| `invalid_did_format` | DID string is malformed |
| `unsupported_chain:<id>` | Chain ID in the DID is not configured |
| `not_registered` | DID parses and resolves but is not registered |
| `chain_snapshot_unavailable` | No block could be read, so neither contract was queried |
| `rpc_timeout` | Enrichment query exceeded `SIGVARA_ENRICH_TIMEOUT_MS` |
| `rpc_error` | RPC call failed for another reason |

In all error cases, `agent_identity_verified` is `false` and the packet still seals normally. Enrichment is never a blocking dependency.

---

## Forensic Properties

**Reputation is frozen at seal time.** If an agent is slashed next month, every audit packet sealed today still shows `agent_reputation_score: 47` and `agent_identity_status: Active`. The RFC 3161 timestamp proves when the seal was applied.

**The chain state is recorded.** Both reads are made at one block, and `agent_chain_snapshot` seals that block's number and hash and the two contracts read, so any party can call `getIdentity` and `getTotalScore` at the same block and get the same values. A `finalized` block is sealed as `final`. When the node offered only its latest block the snapshot says `provisional`, which a reorganization could still change. Packets sealed before CounterAudit added this, on 31 October 2026, carry no snapshot: their two reads went to whatever head the node had and could straddle an update.

**Enrichment is inside the AES-GCM seal.** The seal covers the entire `bodyForHash` object including Sigvara fields. Tampering with any field — including `agent_reputation_score` — invalidates the seal.

**The `didHash` is deterministic.** Any party can verify the hash independently:

```typescript
import { ethers } from 'ethers';

const didHash = ethers.keccak256(
  ethers.solidityPacked(
    ['string', 'uint256', 'string', 'address'],
    ['did:sigvara:', BigInt(5042002), ':', agentAddress]
  )
);
```

This means an auditor can confirm the `agent_did_hash` in a sealed packet matches the agent's actual on-chain identity without trusting CounterAudit's computation.

---

## Building a Trust Gate

You can gate which agents are allowed to operate by checking reputation before accepting their actions. Example using the CounterAudit ingest plus an on-chain check:

```typescript
import { SigvaraVerifier } from '@sigvara/protocol-sdk';

const verifier = new SigvaraVerifier({ rpcUrl, addresses, chainId: 5042002 });

async function handleAgentAction(agentDid: string, action: object) {
  // Block agents below threshold, or not Active, before their action is even audited
  const meets = (await verifier.isActive(agentDid)) && (await verifier.meetsThreshold(agentDid, 30));
  if (!meets) {
    throw new Error(`Agent ${agentDid} does not meet minimum reputation threshold`);
  }

  // Audit the action — enrichment will confirm identity and seal current score
  return auditAction(agentDid, action);
}
```

The status and threshold checks (`isActive`, `meetsThreshold`) are view calls — no gas, <100ms on a good RPC.

---

## Related

- [Ecosystem Overview](ecosystem.md) — how Sigvara and CounterAudit fit together
- [Quickstart: Register your first agent](quickstart.md)
- [AI Framework Integration](ai-frameworks.md)
