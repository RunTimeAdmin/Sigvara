# Sigvara Oracle

Off-chain reputation oracle for the Sigvara protocol. Each epoch it scans for registered
agents, computes the six-factor score from payment-verified attestations, watchdog flags,
tenure, counterparty standing and (optionally) cross-protocol ERC-8004 feedback, and
proposes it on chain together with a Merkle root over the evidence it used.

Only **bonded** agents are scored: `proposeReputation` refuses a `PendingBond` agent.
When `SigvaraReputation.operatorBond` is set, the oracle wallet must itself be an
admitted, bonded operator in `SigvaraOracleBond` before it can propose anything.

[`.env.example`](.env.example) is the authoritative, commented configuration reference;
the tables below summarize it.

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

The compose file mounts `oracle_state` volume to `/data` for persistence. The HTTP port is published as `127.0.0.1:3030` (localhost only), so nothing reaches the service without a reverse proxy in front of it.

Do not simply proxy the whole service. [`Caddyfile.oracle.example`](Caddyfile.oracle.example) publishes `/health`, `/score/*`, `/evidence/*` and `POST /attest`, and answers 404 for everything else, which is the arrangement running on the Arc testnet deployment at `oracle.sigvara.xyz`. `/flag`, `/flag/resolve`, `/link` and `/epoch` stay off the proxy: they are token-gated, but keeping them unreachable means an attacker needs a shell on the box before the token matters at all.

`/attest` being published does not make it open. The oracle decides per request: a **positive** attestation carrying a payment it verifies against the chain needs no token, because the payment is the credential and the payer is read from the transfer log rather than asserted. A **negative** one still requires the token. `successScore` is `successful / (total + prior)`, so a negative lowers the score directly, while the payment proves only that money moved and never that the work failed — leaving it open would let anyone downgrade any agent for the price of one minimum transfer, which on a faucet-backed testnet is free.

The read paths are deliberately unauthenticated: `/evidence` exists so a third party can re-derive a score without trusting the operator, and evidence nobody can fetch is evidence nobody can audit. They are rate-limited instead, as described under the endpoints below. `/metrics` is excluded from the proxy despite being harmless to serve, because its counters describe the operator rather than the protocol.

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

### `POST /attest` (token required only for a negative outcome)

Submit an attestation for an agent's task outcome. The request shape depends on
`PAYMENT_VERIFICATION`.

With verification required, `{"success": true}` needs no token: the verified payment is
the credential. `{"success": false}`, a missing `success`, or any non-boolean value
returns 401 without one. `success` must be exactly `true` — `"yes"` is not a positive.

**With `PAYMENT_VERIFICATION=required`** (what mainnet should run) the attestation must
carry the settlement transaction of a real payment to the agent — the `transaction`
field of an x402 `X-PAYMENT-RESPONSE`, or any transfer that settled on chain:

```json
{
  "didHash": "0x...",
  "success": true,
  "payment": { "txHash": "0x3daf88..." }
}
```

The oracle reads the agent's own address from the identity registry, finds transfers of
`PAYMENT_ASSET` to it in that receipt, checks the amount and confirmations, and takes
the payer **from the transfer log**. Anything in an `attester` field is ignored. The
settlement hash is recorded so the same receipt can never be credited twice, and the
event is stamped with the block's timestamp rather than the time it was submitted.

Payments from the agent's own operator or agent address are refused: paying yourself
costs only gas.

**With `PAYMENT_VERIFICATION=off`** (the default) the legacy shape applies: `attester`
is a caller-chosen string, and `feeScore` is a count of HTTP requests divided by ten.
This is fine for local testing and worthless as a trust signal in public.

**Response (200):**
```json
{
  "didHash": "0x...",
  "attester": "0xPayer...",
  "amount": "20000000",
  "successful": 10,
  "total": 15
}
```

| Status | Meaning |
|---|---|
| 200 | Accepted |
| 402 | The payment did not check out; `code` says why (including `self_payment`) |
| 409 | This settlement was already credited |
| 429 | Cooldown active for this (attester, didHash) — `remainingSeconds` says how long |
| 502 | The RPC failed. Not a verdict on the payment; retry |

The 502 case is counted separately from rejected attestations: a node having a bad
minute must not read as a caller trying it on.

See [docs/payment-backed-attestations.md](../docs/payment-backed-attestations.md) for
the full model.

### `POST /flag` (auth required)

Flag an agent for community review. Each flag costs two points of the five-point
Community factor: `max(0, 5 - flags * 2)`.

**Request:**
```json
{ "didHash": "0x..." }
```

### `POST /flag/resolve` (auth required)

Clear flags previously raised. Without this, flagging was one-way and a flag raised in
error cost an agent two Community points until someone edited the state file on the host
by hand — fine while flags come from a person, untenable once a threshold in another
service produces them.

**Request:** `count` defaults to 1.
```json
{ "didHash": "0x...", "count": 2 }
```

**Response (200):**
```json
{ "didHash": "0x...", "before": 3, "after": 1, "resolved": 2 }
```

Resolving more flags than exist clamps to zero rather than failing, and `resolved` reports
what actually changed, so a caller need not read the count first and race another writer.
At zero the entry is removed rather than stored as `0`.

This endpoint raises a score, so it is token-gated like `/flag` and stays off the public
proxy. Flags do not decay on their own; clearing one is a deliberate act.

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

### `GET /evidence/:didHash`

The payments behind an agent's score, with Merkle proofs. Unauthenticated on purpose:
evidence nobody can fetch is evidence nobody can audit.

Both read endpoints are rate-limited at 60 requests per caller per minute, the same cap
the writes use. Unauthenticated is not unmetered: `/score` costs several RPC round trips
and `/evidence` rebuilds a Merkle tree, so these are the most expensive things a stranger
can ask for once the read paths are proxied to the internet.

The caller is identified by socket address, or by the last `X-Forwarded-For` entry when
the connection arrives over loopback. Behind a reverse proxy the socket address is always
`127.0.0.1`, so keying on it alone would put every visitor in one bucket and let a single
abuser lock out everyone. Caddy sets that header itself, and the **last** entry is read
because a proxy appends to whatever the client sent, so a forged one cannot buy a fresh
bucket. Verify that if the proxy is ever replaced: trip the limit, then retry with a
forged `X-Forwarded-For`. A 200 means the limiter is bypassable.

**Response (200):**
```json
{
  "didHash": "0x...",
  "evidenceRoot": "0x...",
  "count": 2,
  "evidence": [
    {
      "txHash": "0x3daf88...",
      "payer": "0x...",
      "amount": "20000000",
      "settledAt": 1789000000,
      "success": true,
      "leaf": "0x...",
      "proof": ["0x..."]
    }
  ]
}
```

To audit a score without trusting this service: read each `txHash` off the chain to
confirm the payer, amount and settlement time, rebuild each leaf, rebuild the root, and
compare it against `evidenceRoots(didHash)` on `SigvaraReputation` — or check an
individual leaf with `verifyEvidence(didHash, leaf, proof)`. The served `leaf` is a
convenience; a verifier should derive it from the payment rather than trust it.

This detects a dropped or invented payment. It cannot detect a payment nobody ever
submitted, which is what an independent chain watcher would be for.

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

### Payment verification

Off by default so existing deployments keep working. Mainnet should run `required`:
with it off, the largest factor in the score is a count of HTTP requests.

| Variable | Default | Description |
|----------|---------|-------------|
| `PAYMENT_VERIFICATION` | `off` | `off` or `required` |
| `PAYMENT_ASSET` | (empty) | ERC-20 that payments settle in. **Required** when verification is on — a missing value stops the process at startup rather than silently disabling the check |
| `PAYMENT_MIN_AMOUNT` | `0` | Smallest payment that counts, in the asset's base units. Stops dust minting attestations |
| `PAYMENT_MIN_CONFIRMATIONS` | `1` | Confirmations before a settlement is accepted |
| `PAYMENT_FEE_UNIT` | `100000000` | Base units of volume per point of `feeScore`. With 6-decimal USDC this is one point per $100, so the 30-point cap lands at $3,000 of settled volume |
| `PAYMENT_HALF_LIFE_DAYS` | `90` | Days after which a payment counts half. `0` disables decay, which makes the score answer "was this agent ever busy" instead of "is it busy now" |
| `PAYMENT_MAX_PER_PAYER` | `5` | Most points of `feeScore`, and attestations of weight, any one payer can contribute. At 5, reaching the 30-point cap needs six distinct payers. `0` disables the cap |
| `PAYMENT_TRUST_WEIGHT` | `1` | Raises a counterparty's cap in proportion to its own matured score, and feeds `propagationScore`. `0` weights every payer alike |

Amounts are base units and handled as BigInt throughout, so an 18-decimal token does not
lose precision.

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
- [ ] **Set `PAYMENT_VERIFICATION=required`** and `PAYMENT_ASSET` — without it `feeScore` is a count of HTTP requests, and the `attester` is whatever the caller typed
- [ ] **Bond the oracle wallet** in `SigvaraOracleBond` and have it admitted, if `SigvaraReputation.operatorBond` is set. `proposeReputation` reverts otherwise

## Attestation Cooldown

The `/attest` endpoint enforces a per-(attester, didHash) cooldown to prevent score inflation. The same attester cannot repeatedly attest the same agent faster than `ATTEST_COOLDOWN_MS`. This:

- Prevents a single party from artificially inflating an agent's fee/success scores
- Persists across restarts (stored in the state file)
- Returns a clear 429 error with remaining cooldown time when blocked

With `PAYMENT_VERIFICATION=required` the cooldown keys on the **verified payer** rather
than a caller-supplied string, so it can no longer be sidestepped by inventing a new
name per request. Even then the cooldown is the weaker control: `PAYMENT_MAX_PER_PAYER`
is what bounds how much any one counterparty's evidence is worth, however long it waits
between payments.

## State Persistence

The oracle persists the following to `ORACLE_STATE_PATH`:

- **attestations**: Per-agent attestation counts (successful/total)
- **flags**: Per-agent unresolved flag counts
- **links**: Agent-to-ERC-8004 identity links
- **attestCooldowns**: Per-(attester, didHash) last-attestation timestamps
- **paymentEvents**: Per-agent verified payments, one record each (`txHash`, settlement time, amount, payer, outcome). Stored individually rather than as a running total, because a total cannot be decayed. Records whose weight falls below a thousandth are pruned once per epoch
- **usedPaymentTxs**: Settlement hashes already credited, so the same receipt cannot be counted twice
- **scanState**: The `AgentRegistered` log scan cursor, checkpointed per chunk so a rate-limited scan resumes instead of restarting from `FROM_BLOCK`

Writes are atomic (temp file + rename) to prevent corruption. The health endpoint checks writability and returns 503 if the state path is not writable.

This state is **per-oracle**. A second operator started against the same chain would
share none of it, which is the first thing that has to change before multiple operators
mean anything — see [Oracle Epochs](../docs/reputation-model.md#oracle-epochs).

## Tests

```bash
cd oracle
node --test
```

185 tests covering scoring formulas, payment verification and decay, per-payer caps and
the trust weighting, Merkle evidence trees, HTTP helpers, store persistence, chain
access with backoff and scan checkpointing, metrics, and cooldown logic. No network
access required.

The Merkle tree is cross-checked against the contracts: the oracle builds a tree in
JavaScript and a Foundry test verifies those exact proofs on chain. A disagreement about
leaf encoding or odd-node handling would otherwise pass each side's own tests and fail
only in production.
