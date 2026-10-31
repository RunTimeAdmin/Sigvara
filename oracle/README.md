# Sigvara Oracle

Off-chain reputation oracle for the Sigvara protocol. Each epoch it scans for registered
agents, computes the six-factor score from payment-verified attestations, watchdog flags,
tenure, counterparty standing and (optionally) cross-protocol ERC-8004 feedback, and
proposes it on chain together with a Merkle root over the evidence it used.

Only **bonded** agents are scored: `proposeReputation` refuses a `PendingBond` agent.
When `SigvaraReputation.operatorBond` is set, the oracle wallet must itself be an
admitted, bonded operator in `SigvaraOracleBond`, or the signer such an operator has named, before it
can propose anything.

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

Do not simply proxy the whole service. [`Caddyfile.oracle.example`](Caddyfile.oracle.example) publishes `/health`, `/score/*`, `/evidence/*`, `/badge/*` and `POST /attest`, and answers 404 for everything else, which is the arrangement running on the Arc testnet deployment at `oracle.sigvara.xyz`. `/flag`, `/flag/resolve`, `/link` and `/epoch` stay off the proxy: they are token-gated, but keeping them unreachable means an attacker needs a shell on the box before the token matters at all.

`/attest` being published does not make it open. The oracle decides per request. A **positive** attestation carrying a payment it verifies against the chain needs no token to record that *payment*: the payer is read from the transfer log rather than asserted, and the payment counts toward fee volume and tenure. It records no *outcome*. A settlement hash is public, so whoever submits one has not shown that they paid or that they saw the work, and the first credit for a settlement is final; an outcome therefore needs the token, and a positive without one is stored the way a payment found by the scan is, with no outcome. A **negative** one still requires the token. `successScore` is `successful / (total + prior)`, so a negative lowers the score directly, while the payment proves only that money moved and never that the work failed — leaving it open would let anyone downgrade any agent for the price of one minimum transfer, which on a faucet-backed testnet is free.

The read paths are deliberately unauthenticated: `/evidence` exists so a third party can re-derive a score without trusting the operator, and evidence nobody can fetch is evidence nobody can audit. They are rate-limited instead, as described under the endpoints below. `/metrics` is excluded from the proxy despite being harmless to serve, because its counters describe the operator rather than the protocol.

## Write credentials

Write endpoints take a bearer token. Configure one per service rather than sharing one:

```
ORACLE_ADMIN_TOKEN=...            # the operator, named `admin`
ORACLE_TOKEN_COUNTERAUDIT=...     # named `counteraudit`
ORACLE_TOKEN_HOODSCAN=...         # named `hoodscan`
```

By default any of them authorises any write; the names exist for **revocation and
attribution**. Deleting one variable revokes exactly that caller and leaves the rest
working, which a single shared token cannot do — revoking one integration would
mean rotating all of them. The name is logged when a flag is raised or cleared, so `flag raised on 0x… by
counteraudit` is answerable where "someone with the token" was not.

To give a service less than everything, restrict it. `ORACLE_SCOPES_<NAME>` takes a
comma-separated list of `attest` (record outcomes), `flag` (`/flag` and `/flag/resolve`),
`link` and `epoch` (run an epoch, a chain write paid from the oracle wallet):

```
ORACLE_SCOPES_COUNTERAUDIT=attest   # CounterAudit records outcomes and can do nothing else
```

A restricted credential gets `403` on the other writes. With no variable a credential keeps
every scope, so nothing changes until you set one, and `admin` is never restricted. An
unknown scope, or a restriction naming a credential that does not exist, stops the process
at startup: a typo would otherwise leave a credential with more power than you meant to give
it. A token shorter than 32 characters still works but is named in a startup warning;
generate them with `openssl rand -hex 32`.

Credentials are read once at startup and the banner lists the names it loaded, never the
values. Revoking means deleting the variable and recreating the container with `docker compose up -d` (a plain `restart` does not re-read `env_file`), and that line is where you
confirm it took effect.

`ORACLE_ADMIN_TOKEN` keeps working exactly as before. Nothing needs to change to upgrade.

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
  "statePersisted": true,
  "lastPersistMs": 1234567890000,
  "statePath": "/data/oracle-state.json",
  "stateSource": "file",
  "chainId": 5042,
  "expectedChainId": 5042,
  "attestCooldownMs": 3600000,
  "epochRunning": false,
  "commit": "1f1456e3f6df0a625f0a107b84d4198f0a88f669",
  "externalFeed": "configured",
  "externalChainId": 5042002,
  "paymentScan": "disabled",
  "paymentScanBlock": null,
  "jobsFeed": "disabled",
  "jobsRegistry": null,
  "jobsChainId": null
}
```

Returns 503 when:
- State file path is not writable (likely volume mount issue)
- The last state write failed (`statePersisted: false`, with `statePersistError`)
- No successful epoch for two epoch intervals (stale scoring). After a success the two intervals are counted from it. Before the first success they are counted from process start, so a primary that has never completed an epoch reports 503 once it has been up that long, rather than staying green

`storeWritable` and `statePersisted` are not the same check and both are reported.
The first writes a few bytes to a test file and deletes them, so it answers whether the
path looks usable. The second is what the last real write actually did, which can fail
while the probe passes: a multi-megabyte state file needs space the probe does not.
It matters because `/attest` answers on the strength of having recorded something, so
a failed persist means a restart will lose what a payer was told. `/attest` says so: it
answers 202 with `"durable": false` instead of 200 while a save is failing, and counts
those as `accepted_not_durable`. Pulled payments are found again by the next scan;
attested outcomes are on chain nowhere, so those do not come back.

`/flag`, `/flag/resolve` and `/link` say the same thing for the same reason: 202 with
`"durable": false` while a save is failing, counted in
`sigvara_oracle_writes_not_durable_total`. The change is held in memory and written by the
next save that works, so check that `/health` is 200 again before treating it as kept. Do not
resend a flag or a resolve: a flag sent twice is two flags, and a resolve sent twice clears
another one. A link sets the same value again, so it can be sent once `/health` is 200.

`stateSource` is `file`, `fresh` (there was no state file) or `backup`. `backup` means the
state file could not be read and the previous save was used instead; the bad file is kept
beside it as `<state>.corrupt-<time>`, and anything recorded since that save is gone. A
recovery is something a person should hear about, which is why it is here and not only in
the log. See [State Persistence](#state-persistence).

`chainId` is the chain the RPC was last seen on, and `null` until the first check has
finished. `expectedChainId` is what `EXPECTED_CHAIN_ID` names, and `null` when it is unset.
They are separate because only the first is a fact: a deployment with the second unset signs
for whatever chain its RPC serves.

`commit` is the git revision the container runs (the VPS compose files take it from
`SIGVARA_COMMIT` and refuse to start unless the checkout equals it; the mainnet file builds from
`SIGVARA_REF` and passes it on as `SIGVARA_COMMIT`), or `null` when the deployment did not report one. It answers "are these two operators running the same
scoring code", which is the first thing to rule out when a checker disagrees and was
otherwise unanswerable from outside: the VPS deployments used to clone `main` at container
start, so the only alternative was inferring it from restart times. **It is not a trust
anchor.** The value is whatever the operator's container put in an environment
variable, so it catches a box that missed a deploy, not a dishonest operator. Anything
adversarial belongs to `/evidence`, which recomputes against the chain.

`externalFeed` is `disabled`, `configured` or `unreachable`, and exists because
`externalScore` renders 0 in three unrelated situations: `EXTERNAL_*` was never set, the
agent is not linked to an ERC-8004 id, or it is linked with no feedback in a recognized
tag. Those need different responses and the score cannot tell them apart.

`externalChainId` is the chain the feed actually reached, read from the provider rather
than parsed out of the URL, and `null` when it could not be reached.

Both fields exist because the earlier version of this one could not fail. It was a
truthiness check on three environment strings, so it reported `configured` for a
container holding a stale RPC that pointed at an entirely different chain, and would
report the same for an RPC pointing at nothing. Distinguishing `unreachable` from
`configured`, and naming the chain, is what makes it evidence rather than decoration.

The RPC URL itself is deliberately not published here: those often carry an API key in
the path, and this endpoint is public.

`paymentScan` is `enabled` or `disabled`, and `paymentScanBlock` is how far it has got.
Both are reported because a scanner nobody switched on and a scanner stuck a long way
behind the head both produce no new evidence, and only one of those is fine.

`jobsFeed` is `configured` or `disabled`, with `jobsRegistry` and `jobsChainId` naming
what it reads. Same reasoning as the external feed: a reader nobody enabled and a reader
pointed at the wrong chain both produce no jobs, and only one of those is fine.

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

Also exposed, and worth knowing about:

| series | what it answers |
|---|---|
| `sigvara_oracle_checker_comparisons_total{verdict}` | how many pending scores this checker re-measured, and how many it disagreed with. Zero on a primary, which never compares. |
| `sigvara_oracle_propose_total{result="slot_taken"}` | `proposeIfEmpty` declining to overwrite a pending score. A normal race outcome, not a failure. |
| `sigvara_oracle_propose_attempts_total`, `..._finalize_attempts_total` | attempts, so success + error + slot_taken can be reconciled rather than assumed to account for everything. |
| `sigvara_oracle_proposals_rejected_total` | scores the slashing committee rejected. |
| `sigvara_oracle_proposals_stranded_total` | pending proposals whose proposer had lost its authority (its operator removed or exited, its signer cleared, or its `ORACLE_ROLE` revoked), so the contract would not finalize them. The primary replaces one with a fresh proposal; a checker takes over from it. Nonzero after a key rotation is expected; nonzero otherwise means an operator was removed with proposals in flight. |
| `sigvara_oracle_fee_charges_total{result="already_paid"}` | agents the epoch fee was not taken from a second time, because the contract had already charged them in the same calendar epoch (an earlier run of this oracle, or anyone else). Scoring carried on. |
| `sigvara_oracle_evidence_cache_total{result}` | `/evidence` responses served from cache against rebuilt. A miss hashes a Merkle tree over the agent's whole payment history and derives every proof, so the hit rate is the difference between a cheap endpoint and an expensive one. |
| `sigvara_oracle_fee_charges_total{result="skipped"}` | agents not charged an epoch fee because the contract's dry run said their proposal would be refused, or because the dry run could not be made. Nonzero for long means proposals are being refused: look at the oracle's bond and the agents' status. |
| `sigvara_oracle_payer_outcomes_imported_total`, `..._payer_outcome_import_refused_total`, `..._import_errors_total`, `..._conflicts_total` | the import from other operators ([`GET /outcomes`](#get-outcomessincems)). Refused climbing means a peer is serving outcomes that fail this oracle's checks; errors, that a peer or this node is not answering; conflicts, that a peer served a different outcome for a payment this oracle already holds one for (not checked, so a peer serving junk raises it too). |
| `sigvara_oracle_tx_refused_total{reason}` | `fee_cap`: a transaction the oracle would not sign because the fee the RPC quoted was above `MAX_FEE_GWEI` or `MAX_TX_COST`. `unconfirmed`: a transaction that was sent and not seen mined within `TX_WAIT_SECONDS`, even after one replacement. Either one is a reason to look at the RPC. |

The first four were incremented by the epoch for some time while being declared nowhere,
and `metrics.inc()` ignores names it does not know. So they read zero throughout,
including the checker's disagreement counter while it was disagreeing. A test now scans
the source for every `metrics.inc`/`set` name and fails if one is undeclared, because
a counter that silently reads zero is worse than one that is missing.

Scrape at `/metrics` with Prometheus or compatible tools.

### `POST /attest` (token required only for a negative outcome)

Submit an attestation for an agent's task outcome. The request shape depends on
`PAYMENT_VERIFICATION`.

With verification required, `{"success": true}` needs no token: the verified payment is
the credential for the *payment*. Without the token it is recorded with no outcome (the
response says `"outcomeRecorded": false`). With the token the outcome is recorded: `true`,
`false`, or left out for none. `{"success": false}`, a missing `success`, or any non-boolean
value returns 401 without a token, and `success` must be exactly `true` for a stranger:
`"yes"` is not a positive. With a token, a non-boolean `success` is a 400.

A payment credited without an outcome (by the scan, or by a request with no token) can be
given one afterwards by a token holder, once. An outcome that is already recorded is final,
except that the payer's own signed outcome can replace a token holder's (below).

**An outcome signed by the payer** ([ADR 0006](../docs/adr/0006-payer-signed-outcomes.md)) needs
no token, whoever carries it: the signature is the credential. It goes in `payerOutcome`
instead of `success`, and only where `PAYER_OUTCOMES` is on:

```json
{
  "didHash": "0x...",
  "payment": { "txHash": "0x3daf88..." },
  "payerOutcome": {
    "payer": "0x5c...", "outcome": 1, "evidence": "0x00...",
    "signedAt": 1793400000, "deadline": 1793486400, "signature": "0x..."
  }
}
```

The signature is EIP-712 over `PaymentOutcome(bytes32 didHash, bytes32 txHash, address payer,
uint8 outcome, bytes32 evidence, uint64 signedAt, uint64 deadline)` in the domain `Sigvara`,
version `1`, on `EXPECTED_CHAIN_ID`, with `REPUTATION_ADDRESS` as the verifying contract.
`outcome` is `1` delivered or `2` not delivered. A payer without code signs by recovery; one
with code (a smart account, or an address delegated under EIP-7702) is asked through ERC-1271,
the rule OpenZeppelin's `SignatureChecker` applies on chain, down to taking an answer longer than
one word whose first word is the magic value. `test/vectors/payment-outcome.json` holds the cases,
and `test/PaymentOutcome.t.sol` checks the same ones with OpenZeppelin's code. Off chain it differs
only for accounts that break ERC-1271 or lean on its edges: an `eth_call` is not static, so one that
writes storage while answering is accepted here and refused on chain, and an empty signature (which
a Safe can take for a message it approved on chain) or one over 4096 bytes is refused before the
account is asked. Both are read at one confirmed
block, recorded with the outcome as `checkedAtBlock`, and the ERC-1271 call is capped at
2,000,000 gas. The oracle checks, in order, and refuses at the first failure: the payment, and
that `payer` has its own leg in it (`payer_mismatch`) that is not a self-payment
(`self_payment`; another sender's larger leg does not matter); for `2`, that negatives are on
(`negative_not_accepted`) and the leg reaches `PAYER_NEGATIVE_MIN_AMOUNT` (`below_minimum`);
`signedAt` no earlier than the payment's block, at most five minutes ahead of this host's clock
and at most an hour after the checked block, `deadline` not passed at the checked block's time
and at most 30 days after `signedAt` (`outcome_window`); the signature (`bad_signature`, and after five of those for one leg in an
hour, `bad_signature_throttled`); then precedence. The outcome goes on the signer's own leg. It
is final: a second signature for the leg is refused (`outcome_recorded`), before any chain
read. It replaces a token holder's outcome if the checked block is within
`PAYER_OUTCOME_WINDOW_DAYS` of the payment's block and the transaction had no other paying leg
(a token holder's outcome on a transaction with several payers was given for the whole job),
and the token holder's `packetId` goes with the outcome it backed. A token holder's outcome
never replaces a payer's. The deadline reads the checked block's time rather than this host's
clock, so that another operator importing the outcome later (see
[`GET /outcomes`](#get-outcomessincems)) reaches the same answer; the window reads this node's
confirmed head, when the outcome arrived here. Nothing is checked while that head is more than
`MAX_CLOCK_SKEW_SECONDS` from this host's clock (`rpc_error`), since a node behind would stretch
both by as much. `/evidence` marks each
outcome's source, `payer_signed` or `credentialed` (this oracle's label, not part of the leaf),
and where `PAYER_OUTCOMES_PUBLISH=on` serves the signed payload beside the leaf and the signing
domain as `payerOutcomeDomain`. The leaf is unchanged.

**With `PAYMENT_VERIFICATION=required`** (what mainnet should run) the attestation must
carry the settlement transaction of a real payment to the agent — the `transaction`
field of an x402 `X-PAYMENT-RESPONSE`, or any transfer that settled on chain:

```json
{
  "didHash": "0x...",
  "success": true,
  "payment": { "txHash": "0x3daf88..." },
  "packetId": "56ccbfd3-3868-4b98-8e56-97faa0aec031"
}
```

`packetId` is an optional pointer to a sealed, timestamped record of the same work.
Stored beside the payment and served from `/evidence` as unverified, never part of the
Merkle leaf. Validated for shape only. Only a token holder's `packetId` is kept: a
stranger's is ignored, as their `success` is. When a token holder gives an outcome to a
payment credited without one, their `packetId` goes on with it unless the payment
already has one.

The oracle reads the agent's own address from the identity registry, finds transfers of
`PAYMENT_ASSET` to it in that receipt, checks the amount and confirmations, and takes
the payer **from the transfer log**. Each sender is held to `PAYMENT_MIN_AMOUNT` on its
own, and a sender whose transfers sum to zero is not a payment at all; the pull scan
applies the same rule. Anything in an `attester` field is ignored. The
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
  "total": 15,
  "outcomeRecorded": true
}
```

| Status | Meaning |
|---|---|
| 200 | Accepted and saved |
| 202 | Accepted, but the state file could not be written, so a restart before the next good save loses it. The body has `"durable": false`. Do not resend: it is recorded here, and a resend is refused (409 for a settlement already credited, 429 inside the cooldown). `/health` is 503 until a save works |
| 400 | Malformed body, unknown agent, or a `success` that is not a boolean |
| 402 | The payment did not check out; `code` says why (`self_payment`, `no_transfer`, `below_minimum`) |
| 409 | `replayed`: this settlement was already credited. `outcome_recorded`: it already has an outcome, which is final |
| 413 | The body is over 1 MB. `/flag`, `/flag/resolve` and `/link` answer the same way |
| 429 | Cooldown active for this (attester, didHash) — `remainingSeconds` says how long. Applies to callers without a token; a token holder reporting on a verified payment is not throttled |
| 502 | The RPC failed. Not a verdict on the payment; retry |

The 502 case is counted separately from rejected attestations: a node having a bad
minute must not read as a caller trying it on.

See [docs/payment-backed-attestations.md](../docs/payment-backed-attestations.md) for
the full model.

### `POST /flag` (auth required)

Flag an agent for community review. Each flag costs two points of the five-point
Community factor: `max(0, 5 - flags * 2)`.

Flags decay on a half-life, `FLAG_HALF_LIFE_DAYS` (default 30), so the count the score
uses is age-weighted and fractional: a flag one half-life old counts 0.5 and costs one
point instead of two. A penalty has to be renewed to keep costing, which is the same rule
the payment evidence follows and means a watchdog feed that misfires once does not mark an
agent permanently. Set `FLAG_HALF_LIFE_DAYS=0` to disable decay.

**Request:**
```json
{ "didHash": "0x..." }
```

Answers 200 with the count of flags once the flag is saved, or 202 with `"durable": false` if
the state file could not be written (see `/health`). Do not resend a 202: it would be a second
flag.

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
proxy. Flags decay on their own as well; resolving is for clearing one outright rather
than waiting it out.

`before`, `after` and `resolved` are raw counts, not decayed weights: an operator undoing
a mistake is asking about the flags they raised, not what the score currently charges for
them.

A 202 with `"durable": false` means the state file could not be written, as for `/flag`. Do
not resend it: the flags are already cleared in memory, and a second call would clear another.

### `POST /link` (auth required)

Link a Sigvara agent to its ERC-8004 identity for cross-protocol scoring.

**Request:**
```json
{
  "didHash": "0x...",
  "agentId": "123"
}
```

Answers 200 once the link is saved, or 202 with `"durable": false` if the state file could
not be written. The same link can be sent again after `/health` is 200.

### `GET /score/:didHash`

Preview the computed score for an agent without writing to chain. It uses the same inputs as the
epoch, including counterparty standing and the chain's clock, so two operators' answers can be
compared by hand.

```json
{
  "didHash": "0x...",
  "status": 0,
  "scores": {
    "feeScore": 20, "successScore": 8, "ageScore": 3,
    "externalScore": 0, "communityScore": 5, "propagationScore": 0, "total": 36
  },
  "attestations": { "successful": 9, "total": 9 },
  "weighted": {
    "attestations": { "successful": 6.211, "total": 6.211 },
    "distinctPayers": 8,
    "activity": { "firstActivitySec": 1789734970, "lastActivitySec": 1789944267, "recency": 0.78 },
    "trustWeight": 1, "halfLifeDays": 90, "maxPerPayer": 4
  },
  "flags": 0,
  "flagWeight": 0,
  "erc8004AgentId": null
}
```

`status` is the identity registry's `AgentStatus`: 0 Active, 1 Suspended, 2 Slashed, 3 PendingBond.
`attestations` is the raw tally. `weighted` is what the score was computed from, and appears only
when payment verification is on. `flags` is the raw count and `flagWeight` the age-weighted one the
score charges for. A node that cannot answer, after retries, gets `502` with `code: "rpc_error"`.
Any other failure is a generic `500`: this route is public, so it does not echo error text.

### `GET /evidence/:didHash`

The payments behind an agent's score, with Merkle proofs. Unauthenticated on purpose:
evidence nobody can fetch is evidence nobody can audit.

The response names `committedFields` — the exact fields the root commits to, in leaf
order — so a verifier need not read this source to know what is covered.

`counterauditPacketId` appears on an event when the attestation carried one, and the
response lists it under `unverifiedFields`. It is **not evidence, is not in the leaf, and
is not verified here**: the token holder supplied it, and this oracle checks only that it
is UUID-shaped. Nothing here fetched the packet or confirmed that it records this payment
or this outcome, so treat it as a pointer, never as proof that the packet supports the
outcome. A reader who wants that association checks it themselves: if the packet was
sealed with a public proof, CounterAudit serves it at `/v1/proofs/{packetId}`, and its
`outcome_claim` names the payment transaction and the outcome to compare. Committing to
the id would have changed the leaf format and made roots already published on chain
unreproducible. This oracle never calls CounterAudit to validate it, because an evidence
path that depends on someone's SaaS is not evidence.

Both read endpoints are rate-limited at 60 requests per caller per minute, the same cap
the writes use. Unauthenticated is not unmetered: `/score` costs several RPC round trips
and `/evidence` rebuilds a Merkle tree, so these are the most expensive things a stranger
can ask for once the read paths are proxied to the internet.

The caller is identified by socket address, or by the `X-Forwarded-For` header when the
connection arrives from loopback or from a proxy listed in `TRUSTED_PROXIES`. Behind a
reverse proxy the socket address is the proxy's, so keying on it alone would put every
visitor in one bucket and let a single abuser lock out everyone, the watcher included.

`TRUSTED_PROXIES` is a comma-separated list of addresses or CIDR ranges whose header may be
believed. Loopback is always trusted, which covers a proxy on the same host. A proxy in a
container reaches the oracle from a Docker bridge address, and nginx on the host reaches a
published port from the bridge gateway, so list the proxy network, for example
`TRUSTED_PROXIES=172.16.0.0/12`. Do not list a range that includes untrusted clients: whoever
is in it can choose the address it is limited as. An entry that is not an address stops the
process at startup, and starting without the setting on a non-loopback listener logs a warning.

The header is read from the right. Each proxy appends the address it received the request
from, so trusted hops are skipped and the first address that is not one is the client; a
client that sends a forged prefix gains nothing. An entry that is not an IP address is never
used as a key. Verify this if the proxy is ever replaced: trip the limit, then retry with a
forged `X-Forwarded-For`. A 200 means the limiter is bypassable.

Buckets are per kind of route as well as per caller: writes, `/evidence`, `/divergence`, and
the other reads each have their own 60 a minute. `/divergence` is polled by the watcher, and
sharing a bucket with the expensive reads let anyone make that poll fail. The write routes
are metered before they are authorised, so guessing at a token is throttled too.

A request target must be a path in canonical form. `//evidence/metrics`, `/evidence/../metrics`,
absolute-form targets and anything the URL parser would rewrite get `400 bad request target`.
A proxy that matches on a normalised path and forwards the raw one cannot be used to reach a
route it did not allow, and a malformed target cannot end the process. Any error a route does
not handle itself is logged with the request line quoted and answered `500 internal error`.

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

### `GET /outcomes?since=<ms>`

The payer-signed outcomes this oracle has taken, oldest first, 500 to a page
([ADR 0006](../docs/adr/0006-payer-signed-outcomes.md), section 6). Unauthenticated, because
each one verifies on its own. Served only with `PAYER_OUTCOMES` on and
`PAYER_OUTCOMES_PUBLISH=on`, and 404 otherwise, since every copy is one the retention policy has
to cover.

```json
{
  "domain": { "name": "Sigvara", "version": "1", "chainId": 5042, "verifyingContract": "0x..." },
  "since": 0,
  "more": false,
  "next": 1793400000123,
  "outcomes": [
    {
      "didHash": "0x...", "txHash": "0x...", "payer": "0x...",
      "outcome": 1, "evidence": "0x00...", "signedAt": 1793400000, "deadline": 1793486400,
      "signature": "0x...", "signer": "eoa", "checkedAtBlock": 1234567, "acceptedAt": 1793400000123
    }
  ]
}
```

`acceptedAt` is when this oracle took the outcome, in its own milliseconds, each later than the
one before; pass the response's `next` as `since` for the following page.

**Import.** An oracle with `PAYER_OUTCOMES_PEERS` set pulls from each listed operator at the
start of every epoch, before the registry read and the scoring, and puts each outcome through
the same checks as a `POST /attest`, against its own node: the payment from its receipt, the
signer's leg, the timing, the signature, precedence. The one difference is the block. A post is
checked at this node's confirmed head; an import at the peer's `checkedAtBlock`, which must not
be before the payment (`bad_checked_block`), more than an hour before `signedAt`
(`outcome_window`), or past this node's confirmed head (retried at the next run). That keeps a
smart account's answer pinned to the state it was given against, and the deadline judged at the
same time on both operators. The window is judged at this node's own head, as for a post here,
so a peer naming an old block cannot reopen it. A payer with no code at this node's head is
checked by recovery, which needs no old state; one with code is checked at the recorded block,
which needs an archive node, and on a node that keeps only recent state those outcomes fail to
read and are passed over as below. An outcome this oracle already holds costs no chain read; if
the peer's says something different, it is counted
(`sigvara_oracle_payer_outcome_conflicts_total`, unchecked, so anyone serving one raises it) and
what is held stays. One that cannot be checked for a reason that is not its own (the node not
answering, an agent or payment it cannot see yet) holds the peer's import for at most three
runs, then is passed over; the cursor is kept in memory, so a restart reads every peer from the
start again and retries it. Each run checks at most 200 outcomes and spends at most a minute per
peer. Imported outcomes are served on at this oracle's `/outcomes`, so they reach operators that
do not list the first. Every operator should list every other one, and switch import on
together.

### `GET /badge/:address.svg`

The embeddable score badge. Takes an **agent address**, not a didHash, because it is
meant to be pasted into a README by someone holding the former and nothing else:

```
https://oracle.sigvara.xyz/badge/0xCc52Cd92963f8A86d04dB29a4810d1e01D193910.svg
```

```markdown
[![Sigvara score](https://oracle.sigvara.xyz/badge/0x<address>.svg)](https://sigvara.xyz/check?a=0x<address>)
```

A 64-character didHash answers `404`. The derivation from address to didHash is
deterministic and the oracle does it internally; asking a badge consumer to compute a
keccak hash before they can show a score defeats the point of the endpoint.

Unauthenticated, and it reports the **finalized on-chain score**, never this oracle's
pending proposal. A badge is a trust claim shown to strangers, so it carries the number
that survived a challenge window rather than the one this operator would like to propose.

| State | Renders |
|---|---|
| finalized score | `72 / 100`, coloured by band (≥75 green, ≥50 amber, ≥25 orange, below red) |
| registered, never finalized | `not yet scored`, neutral |
| no identity at that address | `not registered`, neutral |
| slashed | `slashed`, red |
| chain unreadable | `unavailable`, neutral |

**An unscored agent never renders as `0 / 100`.** `getTotalScore` returns 0 both for an
agent scored zero and for one that has never been finalized. Collapsing those accuses an
agent nobody has looked at yet, so `lastUpdated` separates them.

Every state that renders answers `200`, including `not registered`. An error status paints
a broken image on somebody else's page, which reads as "this protocol is broken" rather
than "this address has no agent". A malformed path is a different matter and 404s.

Response headers:

```
Content-Type: image/svg+xml; charset=utf-8
Cache-Control: public, max-age=300, stale-while-revalidate=600   (15s when unavailable)
Cross-Origin-Resource-Policy: cross-origin
Access-Control-Allow-Origin: *
```

`Cross-Origin-Resource-Policy` is the header that decides whether the badge renders on a
third-party page. A reverse proxy in front of this must not replace it; Caddy's `header`
directive **adds** rather than replaces, so setting one there produces two of each and an
invalid CORS response. See `Caddyfile.oracle.example`.

Cached for 60 seconds and bounded at 500 entries, since the key is an address supplied by
whoever asks. The rate limiter guards the miss path only: one badge read by thousands of
README viewers is absorbed by the cache, while an address enumerator misses every time.

The SVG defines no element ids. A `clipPath` id collided across badges inlined in one
document — `url(#id)` resolves to the first match in the DOCUMENT, so every badge after
the first was clipped to the first one's width and lost the end of its text. It looked
correct alone and broke on a list of agents, which is the page it exists for.

### `GET /jobs/:address` (ERC-8183, observation only)

Reports what an [ERC-8183](https://eips.ethereum.org/EIPS/eip-8183) job registry says
about one provider. **Nothing here feeds a score.** Disabled unless
`JOBS_REGISTRY_ADDRESS` is set, and answers `501` when disabled rather than an empty
list, because an empty list reads as "this agent has done no jobs".

An ERC-8183 job is escrow with a verdict: a client funds it, a provider submits work, a
named evaluator calls `complete()` or `reject()`. That verdict is the one thing this
oracle has never been able to check for itself. The existing path proves a payment
settled and takes "it went well" from whoever submitted the attestation; here it is a log
entry written by a third party, with the money in the same transaction, so an agent
cannot route around it by shelling out.

```json
{
  "provider": "0x…",
  "registry": "0x…",
  "chainId": 5042002,
  "window": { "fromBlock": 63100000, "toBlock": 63150000, "truncated": false },
  "counts": {
    "jobsSeen": 12, "usable": 9, "dropped": 3,
    "successful": 8, "independentlyEvaluated": 7
  },
  "dropped": [{ "jobId": "4", "reason": "self_evaluated" }],
  "evidence": [
    { "txHash": "0x…", "payer": "0x…", "amount": "450000000",
      "settledAt": 1790000000000, "success": true,
      "independentEvaluator": true, "jobId": "7" }
  ],
  "scored": false
}
```

`evidence` carries exactly the five fields the merkle leaf commits to — `txHash`,
`payer`, `amount`, `settledAt`, `success` — which is why a job could later be scored
without a new leaf format or a new evidence version. `independentEvaluator` and `jobId`
sit alongside as corroboration and would not be part of a leaf.

A job is only usable when the verdict was not written by the party it flatters:

| Dropped | Meaning |
|---|---|
| `self_evaluated` | The provider signed its own verdict. The spec permits it; it is the obvious way to farm a perfect record, and it supplies nothing the old attestation path did not already supply on trust. |
| `self_paid` | Client and provider are the same address. |
| `not_terminal:expired` | Nobody evaluated in time. Not held against the provider: expiry can as easily be the client failing to act, and counting it would let any client damage an agent by doing nothing. |
| `not_terminal:open` | Still in flight. |

Refusals are named rather than counted, because a job refused for self-evaluation and one
that merely expired say different things about the agent. `window` is reported for the
same reason: without it, "0 jobs" cannot be told from a narrow look.

A rejected job carries `amount: "0"`. The provider was not paid, so it earns no fee
volume, while still counting against the success rate. Recording the escrowed figure
would pay an agent, in score, for work that was refused.

`evaluator === client` is kept but marked `independentEvaluator: false`. A buyer
accepting their own delivery is ordinary commerce and weaker evidence than a third party,
and the two should not be quietly treated as equal.

### `POST /epoch` (auth required)

Manually trigger an epoch run. Use for testing; production runs on the configured interval.

### `GET /divergence` and `GET /divergence/:didHash` (checker mode only)

Where a checking operator's arithmetic disagreed with the score pending on chain.
Returns 404 on a primary, because an empty list there would read as "checked, found
nothing" rather than "this oracle does not check".

```json
{
  "mode": "checker",
  "tolerance": 3,
  "epochHours": 1,
  "challengeWindowHours": 6,
  "seesProposals": true,
  "total": 1,
  "truncated": false,
  "divergences": [
    { "didHash": "0x8414ce0b…", "at": 1789852600000, "proposedAt": 1789852503,
      "pendingTotal": 12, "ownTotal": 21,
      "factors": { "successScore": { "pending": 3, "own": 12, "delta": 9 } },
      "evidence": {
        "ownEvidenceRoot": "0x…", "proposedEvidenceRoot": "0x…",
        "ownPaymentEvents": 9, "ownDistinctPayers": 8,
        "compareWith": "https://oracle.sigvara.xyz/evidence/0x8414ce0b…"
      } }
  ]
}
```

The list holds the 100 most recent divergences, newest first, because a committee acts on what
is still inside its challenge window. `total` and `truncated` say whether more exist.
`/divergence/:didHash` returns `{ mode, tolerance, didHash, divergences }` for one agent.

`proposedAt` is the disputed proposal's timestamp, so a reader can work out whether it
is still inside its challenge window. That is the difference between something the
slashing committee can still reject and a post-mortem.

`evidence` says what each side was scoring, not only that the numbers differ. Different roots
mean different evidence, which can be diagnosed. Identical roots with different scores would
mean an arithmetic disagreement, which is a much more serious finding. `compareWith` names the
primary's `/evidence` for that agent and is built from `PRIMARY_EVIDENCE_URL` (default
`https://oracle.sigvara.xyz`). A stored record may lack `evidence`; the other fields are always present.

Unauthenticated, like `/score` and `/evidence`. The point of a second operator is that
its disagreements are visible to someone other than its own operator.

## Running a second operator

The contract has no notion of two oracles agreeing. `pendingScores` holds **one** slot
per agent; a second `proposeReputation` overwrites the first and restarts its challenge
window; `finalizeReputation` asks only that the window elapsed unchallenged. There is no
quorum, no median, no vote. Two operators both proposing would not produce agreement,
they would produce a race whose loser is silently discarded.

So the second operator runs with `ORACLE_MODE=checker` and never competes for the slot:

| pending proposal | checker does |
|---|---|
| none | proposes — covers for a silent primary |
| agrees, window open | nothing |
| agrees, window elapsed | finalizes |
| **disagrees** | **records a divergence and touches nothing** |

The last row is the one that matters. Overwriting a disputed proposal would restart the
challenge window and buy it another six hours beyond the reach of
`SLASHING_COMMITTEE_ROLE`, the only role that can reject it. A checker that overwrote
what it disputes would be protecting exactly what it was run to catch. Finalising a
disputed score is the same mistake in the other direction: it would launder a number
this oracle questions into the live value.

**The empty-slot rule is enforced by the contract.** The checker re-reads
`getPendingScore` immediately before it writes, which narrows the gap to one RPC round
trip, and then proposes through `proposeIfEmpty`, the contract's compare-and-swap. It
reverts with `ScoreAlreadyPending` if a proposal landed in that gap, so a checker never
overwrites a proposal it did not see. Losing that race is a normal outcome, because it means
the primary came back first, and it is counted as
`sigvara_oracle_propose_total{result="slot_taken"}` rather than as an error. A pending
proposal whose proposer has lost its authority (operator removed, signer cleared or
`ORACLE_ROLE` revoked) does not hold the slot: it can never be finalized, so
`proposeIfEmpty` replaces it, which is how a checker takes over from a removed primary. That clause is on
`main`, which the Arc testnet proxies run since their upgrade; the September code reverted for any pending proposal.
The primary keeps `proposeReputation`, because replacing its own stale proposal with a fresher
one is the intended behaviour.

The comparison fails **closed**. Every threshold test is `>`, and `>` against `NaN` is
false, so anything that cannot be compared — an unparseable tolerance, a factor that did
not decode — is treated as a divergence rather than as agreement. A checker that cannot
read a score must not bless it. `DIVERGENCE_TOLERANCE` is validated at startup for the
same reason: `Number('3 points')` is `NaN`, and an unvalidated tolerance would not make
the checker noisy, it would make it agree with everything, silently.

What this does and does not buy:

- **Does**: an independent recomputation of every score, and an alert the slashing
  committee can act on inside the challenge window. The committee has always held the
  reject power and has never had anything telling it when to use it.
- **Does**: failover. If the primary stops, the checker finds an empty slot and proposes.
- **Does not**: make agreement a protocol guarantee. Nothing in the contract requires the
  two to agree; a committee still has to act on the alert. Enforcing N-of-M agreement
  would need a storage change to `pendingScores` and a UUPS upgrade.
- **Does not**: fix ownership concentration on its own. A checker run by the same party
  as the primary breaks shared infrastructure and shared chain-view failure modes, which
  is worth having, but two operators under one owner are still one owner.

Setup, step by step with the exact transactions, is in
[RUNBOOK-second-operator.md](./RUNBOOK-second-operator.md). In outline:

1. A separate wallet, on separate hardware, with a **different RPC endpoint**. A checker
   sharing a host and a chain view with what it checks mostly proves the code is
   deterministic.
2. `depositBond()` on `SigvaraOracleBond` for at least `bondAmount` (25,000 SVR on
   Arc testnet), then admission by `DEFAULT_ADMIN_ROLE` via `admit()`. The testnet
   figure is set above the faucet's reach on purpose: `SVRToken.faucet()` mints up to
   10,000 per address per day, so a bond of 1,000 was a tenth of one free daily claim
   and deterred nothing. 25,000 is two and a half days of claims: a nuisance for a
   casual sybil, trivial for anyone actually standing up an operator.
3. `ORACLE_ROLE` on `SigvaraReputation`, granted by `DEFAULT_ADMIN_ROLE`. If another key owns
   the bond, that owner first names this wallet with `setSigner` (docs/arc.md, section 4b).
4. Its own `ORACLE_STATE_PATH`. Sharing a state file would mean sharing the payment
   observations the score is computed from, which is most of what is being checked.
5. **`FEE_REGISTRY_ADDRESS` unset.** A checker does not bill. A registry that predates the
   once-per-epoch charge has no memory of what it charged, so a checker that ran the
   primary's fee path would debit the agent a second time for one scoring epoch; a current
   one would refuse the second charge, and the two operators would still be racing for it.
   Startup refuses `ORACLE_MODE=checker` together with a fee registry. A checker's
   failover proposals are unbilled.
6. **`EPOCH_HOURS` below half the challenge window** (so under 3 on Arc testnet, where
   the window is 6h). A proposal is only auditable while it sits in `pendingScores`; a
   checker on a longer cadence misses proposals entirely and its empty `/divergence`
   would read as "checked, found nothing". The startup warns, and the endpoint reports
   `seesProposals` so a reader can tell the two apart.

Exit is not instant: `initiateUnbond()` starts a 7-day cooldown before `withdrawBond()`.

## The divergence watcher

A checker can only record that it disagrees. It cannot reject a proposal; only
`SLASHING_COMMITTEE_ROLE` can, and only inside the challenge window. Six hours on Arc.
Nobody watches an HTTP endpoint for six hours, so without something consuming
`/divergence` the signal is a log nobody reads and the committee's power stays
theoretical.

`watcher.js` closes that loop.

```bash
CHECKER_URL=https://checker.example RPC_URL=https://rpc.drpc.testnet.arc.io REPUTATION_ADDRESS=0x6603C96275e85F724Cdf74666b399365e4cA29ed node watcher.js
```

Or `docker compose -f docker-compose.watcher.yml up -d --build` from the repo root.

**It re-reads the chain before alerting.** The checker records what it saw when it saw
it. By the time the watcher polls, the disputed proposal may have been finalized,
rejected, or replaced by a newer one the checker has not examined. So each divergence is
classified against the live slot:

| Classification | Meaning | Alerts |
|---|---|---|
| `actionable` | same proposal, window still open | **yes** |
| `expired` | same proposal, window closed | no, too late to reject |
| `superseded` | a newer proposal holds the slot | no, the checker will re-examine it |
| `closed` | nothing pending | no |

Alerting about a proposal that no longer exists is how you train a committee to ignore
alerts, which is the failure this path exists to prevent.

**It alerts twice.** Once on discovery, and once more when the window is nearly gone
(`FINAL_WARNING_MINUTES`, default 60) if nothing has happened. The first says look; the
second says you are about to lose the ability to act.

**A silent checker is an alert, not quiet.** This is the property that makes the
component worth running. The watcher raises an alarm when the checker is unreachable,
when it is up but has not completed an epoch within `MAX_SILENCE_MINUTES` (counted from the moment it
started, if it has never completed one), when the URL
turns out to be a primary rather than a checker, or when the checker reports
`seesProposals: false` because its epoch is too long to catch proposals before they
expire, or when `/health` answers but `/divergence` cannot be read, which is what a spent
rate-limit bucket looks like. Any of those make an empty divergence list meaningless, and a
watcher that reported them as "no divergences" would manufacture confidence out of an outage.

**It says so when it is the one failing.** A poll that throws, its own RPC being down for
one, used to be logged and forgotten. After three in a row the watcher alerts, and it says so
again when it recovers. It does not follow redirects from the checker, and what it puts in an
alert is built from fields it can check: the agent must be a 32-byte hash, factor names come
from a fixed list, and every figure is rendered from a number. Discord alerts switch
mentions off and Slack alerts are escaped, so text that arrives from the checker cannot ping
a channel.

**It holds no private key.** Every action is a read or a notification, so a compromised
watcher can lie to you but cannot touch the protocol. Set `WEBHOOK_URL` to send alerts
somewhere a human will see them; without it they go to the container log, which nobody
reads at the hour this matters.

Run it on a third host. A watcher sharing a machine with the checker goes down with it,
and then its silence means nothing.

## Environment Variables

### Required

| Variable | Description |
|----------|-------------|
| `RPC_URL` | Ethereum JSON-RPC endpoint for the target chain |
| `ORACLE_PRIVATE_KEY` | Private key for the oracle wallet (must have ORACLE_ROLE). Required unless `ORACLE_PRIVATE_KEY_FILE` is set |
| `ORACLE_PRIVATE_KEY_FILE` | Path to a file holding that key, in place of `ORACLE_PRIVATE_KEY`; setting both stops the process. Prefer it in production: an environment variable shows in `docker inspect`, in `/proc/<pid>/environ` and in every child process, while a compose secret mounts the file read-only. A malformed key is refused with a fixed message that never contains the value |
| `IDENTITY_ADDRESS` | SigvaraIdentity contract address |
| `REPUTATION_ADDRESS` | SigvaraReputation contract address |

### Recommended for Production

| Variable | Default | Description |
|----------|---------|-------------|
| `ORACLE_ADMIN_TOKEN` | (empty) | Bearer token for authenticated endpoints. **Set this before exposing the service.** Generate with `openssl rand -hex 32` |
| `ORACLE_STATE_PATH` | `/data/oracle-state.json` | Path to the persistent state file. Mount a volume here in Docker. |
| `EXPECTED_CHAIN_ID` | (empty) | The chain this oracle is for: `5042` for Arc mainnet, `5042002` for the testnet. **Set this.** With it set, nothing is read for scoring or signed while the RPC reports another chain, and a state file saved on another chain is refused. Unset, the oracle signs for whatever chain `RPC_URL` serves and says so at startup |
| `ATTEST_COOLDOWN_MS` | `3600000` (1 hour) | Minimum time before the same attester can re-attest the same agent |

### Optional

| Variable | Default | Description |
|----------|---------|-------------|
| `EPOCH_HOURS` | `24` | Hours between automatic epoch runs |
| `HOST` | `127.0.0.1` | HTTP bind address. Use `0.0.0.0` in Docker. |
| `PORT` | `3030` | HTTP port |
| `TRUSTED_PROXIES` | (empty) | Addresses or CIDR ranges, comma-separated, whose `X-Forwarded-For` is believed besides loopback. Behind a reverse proxy in a container set the proxy network, for example `172.16.0.0/12`; otherwise every visitor shares one rate-limit bucket |
| `ORACLE_SCOPES_<NAME>` | (all) | Restricts the credential `ORACLE_TOKEN_<NAME>` to a list of `attest`, `flag`, `link`, `epoch` |
| `FROM_BLOCK` | `0` | Block to start scanning AgentRegistered events from |
| `LOG_CHUNK_SIZE` | `2000` | Max blocks per eth_getLogs call |
| `FEE_REGISTRY_ADDRESS` | (empty) | SigvaraEpochFees address for fee-gated scoring |
| `EXTERNAL_RPC` | (empty) | RPC for ERC-8004 external score lookups |
| `EXTERNAL_IDENTITY_ADDRESS` | (empty) | ERC-8004 Identity contract |
| `EXTERNAL_REPUTATION_ADDRESS` | (empty) | ERC-8004 Reputation contract |

### Transactions and the clock

The RPC chooses the fees it quotes, whether a transaction has been mined, and what time the
chain says it is. These bound how far the oracle takes its word for each.

| Variable | Default | Description |
|----------|---------|-------------|
| `TX_WAIT_SECONDS` | `60` | How long a transaction is waited for. After that it is replaced once, with the same nonce at twice the fee, and waited for again. If that does not land either the epoch moves on, and the next one reads the chain as it is. `5` to `3600` |
| `MAX_FEE_GWEI` | `1000` | The highest `maxFeePerGas` the oracle will sign, in gwei. A transaction over it is refused before it is signed and costs nothing. Arc's minimum base fee is 20 gwei, so the default is a long way above normal; tighten it once you have watched a week of real fees |
| `MAX_TX_COST` | `1` | The most one transaction may cost at its worst, gas limit times fee, in the native token (USDC on Arc). Catches an inflated gas estimate, which the fee cap alone does not |
| `MAX_CLOCK_SKEW_SECONDS` | `600` | How far the chain's latest block time may be from this host's clock before the epoch is not run. Payments are dated and scores aged by the block time the RPC reports, so a node serving a stale or false head moves every score the same way, and nothing else would show it |

### Settings are checked at startup

Every numeric setting in these tables is checked before anything starts. A value that is
set and is not a plain number in range stops the process, with every offending setting
named. `PAYMENT_MAX_PER_PAYER=four` used to remove the per-payer cap, and
`PAYMENT_HALF_LIFE_DAYS=90d` used to remove decay, because `Number('four')` is `NaN` and
every comparison against `NaN` is false. A blank value means unset and takes the default; write `0` to
switch off a control that allows it (decay, the per-payer cap, the trust weighting). A blank used to read as
`0` for those four and switched the control off without a word.

### Payment verification

Off by default so existing deployments keep working. Mainnet should run `required`:
with it off, the largest factor in the score is a count of HTTP requests.

| Variable | Default | Description |
|----------|---------|-------------|
| `PAYMENT_VERIFICATION` | `off` | `off` or `required` |
| `PAYMENT_ASSET` | (empty) | ERC-20 that payments settle in. **Required** when verification is on — a missing value stops the process at startup rather than silently disabling the check |
| `PAYMENT_MIN_AMOUNT` | `0` | Smallest payment that counts, per sender, in the asset's base units. Stops dust minting attestations. **Must be above 0 when verification is `required`**: the process refuses to start otherwise. A zero-value transfer never counts, whatever this is |
| `PAYMENT_MIN_CONFIRMATIONS` | `1` | Confirmations before a settlement is accepted |
| `PAYMENT_FEE_UNIT` | `100000000` | Base units of volume per point of `feeScore`. With 6-decimal USDC this is one point per $100, so the 20-point cap lands at $2,000 of settled volume |
| `PAYMENT_HALF_LIFE_DAYS` | `90` | Days after which a payment counts half. `0` disables decay, which makes the score answer "was this agent ever busy" instead of "is it busy now" |
| `PAYMENT_MAX_PER_PAYER` | `4` | Most points of `feeScore`, and attestations of weight, any one payer can contribute. At 4, reaching the 20-point cap needs five distinct payers. `0` disables the cap |
| `PAYER_OUTCOMES` | `off` | Payer-signed outcomes ([ADR 0006](../docs/adr/0006-payer-signed-outcomes.md)): `off`, `positive` (only "delivered") or `both`. Needs `PAYMENT_VERIFICATION=required`, `EXPECTED_CHAIN_ID` and `REPUTATION_ADDRESS`, or the process refuses to start. Set it the same on every operator: one taking them and another not is a delivery gap. `both` waits for a challenge process |
| `PAYER_OUTCOMES_PUBLISH` | `off` | `on` serves each payer's signed payload in `/evidence` and lists them at `GET /outcomes`. Stays off on mainnet until the retention policy covers copies held by other operators |
| `PAYER_OUTCOMES_PEERS` | (empty) | Comma-separated base URLs of the other operators to import payer-signed outcomes from, at the start of each epoch (see [`GET /outcomes`](#get-outcomessincems)). Needs `PAYER_OUTCOMES`. Off on mainnet for the same reason as publishing |
| `PAYER_OUTCOME_WINDOW_DAYS` | `14` | How long after the payment's block time a payer-signed outcome may replace a token holder's |
| `PAYER_NEGATIVE_MIN_AMOUNT` | `PAYMENT_MIN_AMOUNT` | Smallest payment leg whose payer's "not delivered" counts, in base units |
| `PAYMENT_TRUST_WEIGHT` | `1` | Raises a counterparty's cap in proportion to its own matured score, and feeds `propagationScore`. `0` weights every payer alike |

Amounts are base units and handled as BigInt throughout, so an 18-decimal token does not
lose precision.

A payer's standing is read from the chain once per epoch. A payer that is not registered, or is
slashed, has none. A payer the node could not answer for, because the read was throttled or dropped
and still failed after its retries, is not read as having none: that would lower the score this
operator proposes, and a checker whose read succeeded would record a divergence against an honest
primary. The agent is skipped for that epoch and scored at the next (counted with the other
propose errors, or with the throttled ones), and `GET /score/:didHash` answers 502 `rpc_error`
rather than a number it could not stand behind.

### Payment evidence by pull (ADR 0003)

| Variable | Default | Meaning |
|---|---|---|
| `PAYMENT_SCAN_ENABLED` | `0` | `1` enables scanning ERC-20 Transfer logs to agent addresses. Off by default because enabling it changes scores: an operator that has been missing payments starts counting them. |
| `PAYMENT_SCAN_FROM_BLOCK` | `FROM_BLOCK` | First block when there is no checkpoint. |
| `PAYMENT_SCAN_CHUNK` | `LOG_CHUNK_SIZE` | Blocks per `getLogs` call. |
| `PAYMENT_SCAN_CONFIRMATIONS` | `6` (floor) | Blocks to stay behind the head. May be raised, not lowered. Deeper than the attested path because a scan credits unattended; a credit records the tx hash as used, so a reorg would strand it. |
| `PAYMENT_SCAN_PACE_MS` | `500` | Milliseconds between `getLogs` calls. Measured, not guessed: both Arc endpoints limit with a bucket of about 60 requests, so back-to-back calls are refused ~60% of the time, 250ms clears the first 60 and then fails every one after, and 500ms sustains 72 of 72. Costs nothing in steady running, where an epoch is one call. `0` opts out. |

When a scan credits nothing, a **canary** runs before that emptiness is believed. It
re-issues the same filter shape against a settlement already in this operator's state:
one recipient, one block, one known transaction. A `getLogs` that matches nothing
returns the same empty array whether nothing happened or the query is wrong, and wrong
asset, wrong chain or an over-long topic filter all read as a set of agents nobody paid.

The verdict is logged and counted (`sigvara_oracle_payment_scan_canary_failures_total`):

| Verdict | Meaning |
|---|---|
| `passed` | The query works, so the empty range really was empty. |
| `failed` | The query did not find a settlement known to exist. **The range is unverified, not quiet**: the checkpoint is held where it was and the whole range is scanned again at the next epoch. |
| `unavailable` | No prior payment to point at, or the RPC could not answer. Never reported as `passed`. |

A probe without the recipient filter would not do: it proves the asset and chain are
right and then leaves the normal case, this asset moved but not to any of our agents,
indistinguishable from a broken recipient filter.

A long catch-up is what the pace is for. A cold scan from `FROM_BLOCK` on a chain this fast is hundreds of consecutive calls, and without spacing them the run is a coin flip rather than a wait: `readWithBackoff` allows four attempts, one chunk exhausting them throws out of the scan, the checkpoint is left unadvanced, and the whole range is retried next epoch. At the default pace a 255-call run takes a little over two minutes if nothing is refused, and longer in practice: a read-only probe of exactly that range on 3 Oct 2026 still had 27% of chunks refused at 500ms, because the bucket drains over a run that long even though 72 consecutive calls do not. The scan survives it where that probe would not, since every call goes through `readWithBackoff`. Pacing makes a catch-up finish; it does not make it refusal-free.

**Enable it on every operator or on none.** Two operators scanning and one not is the
same delivery asymmetry this exists to remove, pointed the other way.

A settlement is credited once **per recipient and sender**, not once per transaction. One
transfer batch can pay several registered agents, and can carry money from several senders,
both of which are ordinary traffic for a router, an aggregator or a payroll transaction.
Each agent is credited for what it actually received, from each counterparty that actually
paid it. Replaying the same transaction for the same agent from the same sender is still
refused.

Grouping by sender is deliberate rather than incidental. Collapsing several senders into one
payer understated how many distinct counterparties an agent has, which is what
`PAYMENT_MAX_PER_PAYER` and `propagationScore` read, so the cap did not bind where it should
have. It also required choosing which sender to keep, and the two intake paths chose
differently, so the same transaction credited a different payer depending on which route saw
it. Two honest operators could diverge over a payment nobody disputed. There is no longer a
payer to select.

An attested outcome lands on the largest leg alone. An attestation reports on one piece of
work, so repeating its boolean per sender would count one job several times in the success
ratio; the remaining legs carry `success: null`, count toward fee volume and tenure, and stay
out of both sides of the ratio.

What stops a receipt being spent on an agent it never paid is the recipient check rather
than the dedupe key: the attested path only counts transfers to the agent’s own
address, which is part of its DID and cannot be repointed, and the scan reads the
recipient from the log itself. A self-paying sender is refused leg by leg on both paths, so
an operator cannot slip its own leg into a transaction a real customer also paid into.

`sigvara_oracle_payment_scan_refused_total` counts credits the scan planned and the
store then refused. It should stay at zero: both consult the same predicate, so a
nonzero value means they disagree, or that a settlement credited before the key
carried a recipient is blocking one. Each is logged with the transaction and the agent.

A pulled payment is credited with `success: null` — no outcome. It counts toward fee
volume and tenure and is excluded from **both** sides of the success ratio. Recording it
as `false` would damage an agent nobody complained about; as `true` it would invent
evidence. Outcomes remain push, through `/attest`, and CounterAudit's negative
attestations remain the only source of failures.

So `/attest` keeps two jobs it alone can do: carrying the success flag, and acting as a
hint when a caller does not want to wait for the next scan. Attestation becomes optional
for fee and tenure, and stays required for success.

### ERC-8183 job registry (read only)

| Variable | Default | Meaning |
|---|---|---|
| `JOBS_REGISTRY_ADDRESS` | unset | Enables `GET /jobs/:address`. No default: there is no canonical ERC-8183 deployment, and guessing one would read an unrelated contract's logs as jobs. |
| `JOBS_RPC` | `RPC_URL` | Set only when the registry is on a different chain. |
| `JOBS_FROM_BLOCK` | `0` | Earliest block a scan starts from. |
| `JOBS_MAX_SPAN` | `50000` | Widest range one request may scan. |
| `JOBS_LOG_CHUNK` | `LOG_CHUNK_SIZE` | Blocks per `getLogs` call when reading the registry. |

### Checker mode

See [Running a second operator](#running-a-second-operator).

| Variable | Default | Meaning |
|---|---|---|
| `ORACLE_MODE` | `primary` | `checker` scores every agent, compares with the pending proposal, records divergences and proposes only into an empty slot. Refused together with `FEE_REGISTRY_ADDRESS`. Any value other than `primary` or `checker`, including `Checker`, stops the process |
| `DIVERGENCE_TOLERANCE` | `3` | Points of difference in the total that count as benign skew between two honest operators. A non-number, a negative value or one above `10` stops the process at startup, since each would make the checker agree with everything |
| `PRIMARY_EVIDENCE_URL` | `https://oracle.sigvara.xyz` | The primary's public base URL. Named in each divergence record as `compareWith`, so a reader is told where the other side's evidence lives |

### Divergence watcher

See [The divergence watcher](#the-divergence-watcher). `.env.watcher.example` is the commented reference.

| Variable | Default | Meaning |
|---|---|---|
| `CHECKER_URL` | (required) | The checker to watch. A primary answers 404 on `/divergence`, which the watcher raises as an alert rather than reading as good news |
| `RPC_URL` | (required) | A chain view independent of both the oracle and the checker |
| `REPUTATION_ADDRESS` | (required) | `SigvaraReputation`, where the pending score and challenge window are read |
| `POLL_SECONDS` | `300` | Seconds between polls, at least `30` |
| `MAX_SILENCE_MINUTES` | `120` | A checker that has not completed an epoch for this long is itself an alert |
| `FINAL_WARNING_MINUTES` | `60` | The second, louder alert when a challenge window is this close to closing |
| `WEBHOOK_URL` | (empty) | Where alerts go. Discord, Slack and Telegram URLs are recognised and shaped for; anything else gets a generic JSON body. Without it alerts reach the container log only |
| `WEBHOOK_CHAT_ID` | (empty) | Telegram only: the numeric `-100...` channel id, not the `@name` |

## Production Checklist

- [ ] **Set `ORACLE_ADMIN_TOKEN`** - Required before exposing the HTTP port
- [ ] **Set `EXPECTED_CHAIN_ID`** - Without it the oracle signs for whatever chain its RPC serves
- [ ] **Mount persistent volume** to `ORACLE_STATE_PATH` - Attestation and flag state must survive restarts
- [ ] **Copy the state file off the host** on a schedule. The `.bak` beside it is one save behind and on the same disk
- [ ] **Configure monitoring:**
  - Scrape `/metrics` with Prometheus
  - Alert on `/health` returning 503
  - Watch `sigvara_oracle_epochs_total{status="failed"}` for epoch failures
  - Watch `sigvara_oracle_tx_refused_total` and `sigvara_oracle_fee_charges_total{result="skipped"}`: a fee cap that trips is a reason to look at the RPC, and skipped charges mean proposals are being refused
  - Watch `stateSource` on `/health`: anything but `file` after a restart means the state was recovered or started empty
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
- **paymentEvents**: Per-agent verified payments, one record each (`txHash`, settlement time, amount, payer, outcome, and `blockNumber` for anything credited since 3 Oct 2026). Stored individually rather than as a running total, because a total cannot be decayed. Records whose weight falls below a thousandth are pruned once per epoch
- **usedPaymentTxs**: Settlements already credited, as `txHash|didHash|payer`, so the same receipt cannot be counted twice for the same agent from the same sender. Keyed by all three because one transaction can pay several agents and can carry several senders, and collapsing either loses what the per-payer cap and the distinct counterparty count read. Shorter keys from before each change are still honoured and block everything below them, since what they omit is not recoverable: pruning drops old payment records and deliberately leaves this list alone
- **scanState**: The `AgentRegistered` log scan cursor, checkpointed per chunk so a rate-limited scan resumes instead of restarting from `FROM_BLOCK`
- **paymentScanState**: The payment scan checkpoint. `PAYMENT_SCAN_FROM_BLOCK` applies only while there is none
- **divergences**: In checker mode, the disagreements with the primary that `GET /divergence` serves, capped per agent and pruned by age
- **schemaVersion** and **chainId**: The format the file was written in, and the chain it belongs to, recorded the first time the oracle checks which chain its RPC serves

Writes are atomic (temp file + rename, with an `fsync` before the rename so a crash cannot leave an atomically-renamed empty file). `/health` reports both whether the path is writable and whether the last write actually succeeded, and returns 503 on either. The two are not the same check: the first writes a few bytes to a test file, which passes while a real state file fails for want of space.

The file is written in pieces of about 1 MB (`state-serialize.js`) instead of being built as one string. The bytes are identical to `JSON.stringify` of the same state, so nothing that reads the file changes. What changes is memory: building the whole text and then a second copy for the write meant a save needed many times the size of the file. Measured on Node 20 in an otherwise idle process, the peak of one save went from 449 MB to 189 MB with 100,000 payments (a 38 MB file), from 700 MB to 280 MB with 200,000, and from 1,628 MB to 395 MB with 400,000. `docker-compose.mainnet.yml` limits the container to 768 MB, which the old save would have passed at roughly 225,000 payments. Save time is unchanged at 100,000 payments and 12 to 26 percent lower beyond that. Size the container for the peak of a save, not the size of the file.

Payment events are immutable once stored. `store.js` freezes each one when it is created, replaced or loaded, and `merkle.js` relies on that to cache each leaf and each agent's root by identity: an epoch in which an agent's evidence has not changed reuses its root instead of hashing every payment again. Code that changed a stored event in place would now throw. Replace the event with a new one instead, as `setPaymentOutcome` does.

Before each save the file it replaces is kept as `<state>.bak`. It is a hard link, so it costs no copy, and it is always the save before the current one. On start:

| What is found | What happens |
|---|---|
| No state file | Starts empty. Deleting the file is the documented way to rescan. A `.bak` left beside it is moved aside as `<state>.bak.orphaned-<time>` first, so the fresh start's own saves cannot rotate the old state away |
| A file that reads | It is used |
| A file that exists and cannot be read (cut off, or hand-edited wrongly) | The `.bak` is used instead, the bad file is moved aside as `<state>.corrupt-<time>`, and `/health` reports `stateSource: "backup"`. Anything recorded since that save is gone |
| An unreadable file and no usable `.bak` | The process stops and says why. Restore the file from a copy, or move it aside to start empty on purpose |
| A file written by a newer version of the oracle (`schemaVersion` above what this build reads) | The process stops. The `.bak` is older than that file, so it is not used either |
| A file saved on a different chain from the one the RPC reports | The process stops. Point `RPC_URL` at the right chain, or move the file aside |

An unreadable file used to be logged as "starting fresh" and the next save wrote an empty state over the original. What is in that file cannot be rebuilt from the chain (attested outcomes, flags, links, and the record of which settlements were already credited), and losing the last one means a settlement can be credited a second time.

`blockNumber` is where the settlement sits on the chain. It is kept because the only other way to find that out is `eth_getTransactionReceipt`, and every Arc endpoint prunes that index: measured 3 Oct 2026 at about 6 days on Circle’s and 13 on QuickNode’s. The scan canary needs the block to re-issue its filter against a settlement known to exist, so without it the canary reported `unavailable` for anything older than the horizon and no empty scan could be believed. It is corroboration rather than evidence and is deliberately absent from the Merkle leaf, since committing to it would change the leaf format and make published roots unreproducible; a verifier reads it off the chain anyway. Events stored before this omit the field rather than carrying a null, and the canary still falls back to a receipt lookup for those.

`scripts/backfill-payment-blocks.mjs` fills the field in for those older events, recovering each block from logs and block timestamps rather than from the receipt index that prunes. Dry run by default, applies this same load validation so it cannot annotate an event the oracle would drop, and writes by temp file and rename with a backup. **Run it with the oracle stopped**: state lives in memory and is rewritten on every persist, so an edit made while it runs is lost at the next epoch. Both live operators were repaired this way on 3 Oct 2026, eight events each, after which the canary passes.

Payment records are validated as they load. An `amount` that is not an integer string, or a missing settlement time, is dropped with the agent and the field named in the log, rather than throwing from inside the decay arithmetic later. Worth knowing when seeding this file by hand: `1.5` and `1_000_000` are both rejected, and fee volume and tenure for that agent are understated until the record is corrected.

This state is **per-oracle** on purpose, and a checker must never share the primary's file:
its own state is what makes it an independent check. What two operators share is the chain. With
the payment scan enabled on both ([ADR 0003](../docs/adr/0003-evidence-intake.md)) each finds
payments itself, and only the outcome of the work needs a shared channel. See
[Oracle Epochs](../docs/reputation-model.md#oracle-epochs).

## Tests

```bash
cd oracle
node --test
```

830 tests (as of 31 October 2026) covering scoring formulas, payment verification and decay, payer-signed outcomes, per-payer caps and
the trust weighting, Merkle evidence trees, HTTP helpers, store persistence and recovery,
the streamed state file, chain access with backoff, scan checkpointing, fee caps and transaction replacement,
metrics, and cooldown logic. Several of the files run the real `index.js` and `watcher.js`
as child processes against a stubbed chain (`test-support/`), so startup refusals, exit
codes and the order in which the epoch charges and proposes are tested as they happen. No
network access required.

One test is sensitive to machine load: "a rate-limited receipt lookup does not undo a transaction
that was mined" in `chain-safety.test.js` failed in 15 to 20 percent of runs when eight copies of
the suite ran at once, and passes alone every time. If it is the only red test, run it again before
looking for a cause.

The Merkle tree is cross-checked against the contracts: the oracle builds a tree in
JavaScript and a Foundry test verifies those exact proofs on chain. A disagreement about
leaf encoding or odd-node handling would otherwise pass each side's own tests and fail
only in production.
