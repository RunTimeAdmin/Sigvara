# Sigvara Oracle

Off-chain reputation oracle for the Sigvara protocol. Scores registered agents based on attestations, flags, age, and (optionally) cross-protocol ERC-8004 feedback.

## Quick Start

```bash
# Copy and configure environment
cp .env.example .env
# Edit .env with your RPC URL, private key, and contract addresses

# Install dependencies
npm install

# Run locally
node index.js

# Run tests
node --test
```

## Docker Deployment

```bash
# From the repo root
docker compose -f docker-compose.oracle.yml up -d
```

The compose file mounts `oracle_state` volume to `/data` for persistence. The HTTP port is published as `127.0.0.1:3030` (localhost only) — reverse-proxy with authentication before exposing to the internet.

## API Endpoints

### `GET /health`

Health check with operational signals for production alerting.

**Response (200 or 503):**
```json
{
  "ok": true,
  "epochMs": 3600000,
  "uptimeSeconds": 12345,
  "lastSuccessfulEpochMs": 1234567890000,
  "timeSinceLastEpochMs": 120000,
  "storeWritable": true,
  "statePath": "/data/oracle-state.json",
  "attestCooldownMs": 3600000,
  "epochRunning": false
}
```

Returns 503 when:
- State file path is not writable (likely volume mount issue)
- No successful epoch in the last 2× epoch interval (stale scoring)

### `GET /metrics`

Prometheus-format metrics for monitoring and alerting.

```
# HELP sigvara_oracle_uptime_seconds Process uptime in seconds
# TYPE sigvara_oracle_uptime_seconds gauge
sigvara_oracle_uptime_seconds 12345

# HELP sigvara_oracle_epochs_total Total epochs started
# TYPE sigvara_oracle_epochs_total counter
sigvara_oracle_epochs_total{status="started"} 100
sigvara_oracle_epochs_total{status="succeeded"} 99
sigvara_oracle_epochs_total{status="failed"} 1

# ... and more (propose, finalize, attest, flags, links, rate limits)
```

Scrape at `/metrics` with Prometheus or compatible tools.

### `POST /attest` (auth required)

Submit an attestation for an agent's task outcome. The `attester` field is mandatory and identifies the party submitting the attestation (e.g., client address or API key hash). A cooldown prevents the same attester from spamming attestations for the same agent.

**Request:**
```json
{
  "didHash": "0x...",
  "success": true,
  "attester": "unique-attester-id"
}
```

**Response (200):**
```json
{
  "didHash": "0x...",
  "attester": "unique-attester-id",
  "successful": 10,
  "total": 15
}
```

**Error (429) - Cooldown active:**
```json
{
  "error": "Attestation cooldown active",
  "attester": "unique-attester-id",
  "didHash": "0x...",
  "remainingSeconds": 2400,
  "cooldownMs": 3600000
}
```

### `POST /flag` (auth required)

Flag an agent for community review.

**Request:**
```json
{ "didHash": "0x..." }
```

### `POST /link` (auth required)

Link a Sigvara agent to its ERC-8004 identity for cross-protocol scoring.

**Request:**
```json
{
  "didHash": "0x...",
  "agentId": "123"
}
```

### `GET /score/:didHash`

Preview the computed score for an agent without writing to chain.

### `POST /epoch` (auth required)

Manually trigger an epoch run. Use for testing; production runs on the configured interval.

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `RPC_URL` | Ethereum JSON-RPC endpoint for the target chain |
| `ORACLE_PRIVATE_KEY` | Private key for the oracle wallet (must have ORACLE_ROLE) |
| `IDENTITY_ADDRESS` | SigvaraIdentity contract address |
| `REPUTATION_ADDRESS` | SigvaraReputation contract address |

### Recommended for Production

| Variable | Default | Description |
|----------|---------|-------------|
| `ORACLE_ADMIN_TOKEN` | (empty) | Bearer token for authenticated endpoints. **Set this before exposing the service.** Generate with `openssl rand -hex 32` |
| `ORACLE_STATE_PATH` | `/data/oracle-state.json` | Path to the persistent state file. Mount a volume here in Docker. |
| `ATTEST_COOLDOWN_MS` | `3600000` (1 hour) | Minimum time before the same attester can re-attest the same agent |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `EPOCH_HOURS` | `24` | Hours between automatic epoch runs |
| `HOST` | `127.0.0.1` | HTTP bind address. Use `0.0.0.0` in Docker. |
| `PORT` | `3030` | HTTP port |
| `FROM_BLOCK` | `0` | Block to start scanning AgentRegistered events from |
| `LOG_CHUNK_SIZE` | `2000` | Max blocks per eth_getLogs call |
| `FEE_REGISTRY_ADDRESS` | (empty) | SigvaraEpochFees address for fee-gated scoring |
| `EXTERNAL_RPC` | (empty) | RPC for ERC-8004 external score lookups |
| `EXTERNAL_IDENTITY_ADDRESS` | (empty) | ERC-8004 Identity contract |
| `EXTERNAL_REPUTATION_ADDRESS` | (empty) | ERC-8004 Reputation contract |

## Production Checklist

- [ ] **Set `ORACLE_ADMIN_TOKEN`** - Required before exposing the HTTP port
- [ ] **Mount persistent volume** to `ORACLE_STATE_PATH` - Attestation and flag state must survive restarts
- [ ] **Configure monitoring:**
  - Scrape `/metrics` with Prometheus
  - Alert on `/health` returning 503
  - Watch `sigvara_oracle_epochs_total{status="failed"}` for epoch failures
  - Watch `sigvara_oracle_attest_total{result="rejected_cooldown"}` for potential abuse attempts
- [ ] **Reverse proxy** with TLS if exposing beyond localhost
- [ ] **Fund oracle wallet** with native token for gas
- [ ] **Grant ORACLE_ROLE** on SigvaraReputation to the oracle address

## Attestation Cooldown

The `/attest` endpoint enforces a per-(attester, didHash) cooldown to prevent score inflation. The same attester cannot repeatedly attest the same agent faster than `ATTEST_COOLDOWN_MS`. This:

- Prevents a single party from artificially inflating an agent's fee/success scores
- Persists across restarts (stored in the state file)
- Returns a clear 429 error with remaining cooldown time when blocked

## State Persistence

The oracle persists the following to `ORACLE_STATE_PATH`:

- **attestations**: Per-agent attestation counts (successful/total)
- **flags**: Per-agent unresolved flag counts
- **links**: Agent-to-ERC-8004 identity links
- **attestCooldowns**: Per-(attester, didHash) last-attestation timestamps

Writes are atomic (temp file + rename) to prevent corruption. The health endpoint checks writability and returns 503 if the state path is not writable.

## Tests

```bash
cd oracle
node --test
```

Tests cover scoring formulas, HTTP helpers, store persistence, metrics, and cooldown logic.
