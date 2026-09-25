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

## Write credentials

Write endpoints take a bearer token. Configure one per service rather than sharing one:

```
ORACLE_ADMIN_TOKEN=...            # the operator, named `admin`
ORACLE_TOKEN_COUNTERAUDIT=...     # named `counteraudit`
ORACLE_TOKEN_HOODSCAN=...         # named `hoodscan`
```

Any of them authorises any write; the names exist for **revocation and attribution**, not
for different permissions. Deleting one variable revokes exactly that caller and leaves
the rest working, which a single shared token cannot do — revoking one integration would
mean rotating all of them. The name is logged on every write, so `flag raised on 0x… by
counteraudit` is answerable where "someone with the token" was not.

Credentials are read once at startup and the banner lists the names it loaded, never the
values. Revoking means editing the environment and restarting, and that line is where you
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
- No successful epoch in the last 2× epoch interval (stale scoring)

`storeWritable` and `statePersisted` are not the same check and both are reported.
The first writes a few bytes to a test file and deletes them, so it answers whether the
path looks usable. The second is what the last real write actually did, which can fail
while the probe passes: a multi-megabyte state file needs space the probe does not.
It matters because `/attest` answers 200 on the strength of having recorded something,
so a failed persist means a payer was told a payment counted when a restart will lose
it. Pulled payments are found again by the next scan; attested outcomes are on chain
nowhere, so those do not come back.

`commit` is the git revision the container cloned at start, or `null` when the
deployment did not report one. It answers "are these two operators running the same
scoring code", which is the first thing to rule out when a checker disagrees and was
otherwise unanswerable from outside: the deployments clone `main` at container start,
so the only alternative was inferring it from restart times. **It is not a trust
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
| `sigvara_oracle_evidence_cache_total{result}` | `/evidence` responses served from cache against rebuilt. A miss hashes a Merkle tree over the agent's whole payment history and derives every proof, so the hit rate is the difference between a cheap endpoint and an expensive one. |

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
the credential. `{"success": false}`, a missing `success`, or any non-boolean value
returns 401 without one. `success` must be exactly `true` — `"yes"` is not a positive.

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

`packetId` is optional cross-evidence: the identifier of a sealed, timestamped record
of the same work. Stored beside the payment and served from `/evidence`, never part of
the Merkle leaf. Validated for shape only.

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

Flags decay on a half-life, `FLAG_HALF_LIFE_DAYS` (default 30), so the count the score
uses is age-weighted and fractional: a flag one half-life old counts 0.5 and costs one
point instead of two. A penalty has to be renewed to keep costing, which is the same rule
the payment evidence follows and means a watchdog feed that misfires once does not mark an
agent permanently. Set `FLAG_HALF_LIFE_DAYS=0` to disable decay.

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
proxy. Flags decay on their own as well; resolving is for clearing one outright rather
than waiting it out.

`before`, `after` and `resolved` are raw counts, not decayed weights: an operator undoing
a mistake is asking about the flags they raised, not what the score currently charges for
them.

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

The response names `committedFields` — the exact fields the root commits to, in leaf
order — so a verifier need not read this source to know what is covered.

`counterauditPacketId` appears on an event when the attestation carried one. It is
**corroboration, not evidence, and is deliberately not in the leaf**: it identifies a
tamper-evident, independently timestamped record of the same work, which a verifier
fetches from CounterAudit and checks for themselves. Two separate things then have to
be forged for the evidence to be fabricated. Committing to it would have changed the
leaf format and made roots already published on chain unreproducible, for a field the
verifier confirms elsewhere regardless. This oracle never calls CounterAudit to
validate it — an evidence path that depends on someone's SaaS is not evidence.

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

### `GET /badge/:address.svg`

The embeddable score badge. Takes an **agent address**, not a didHash, because it is
meant to be pasted into a README by someone holding the former and nothing else:

```
https://oracle.sigvara.xyz/badge/0x9a940B2e62a2c4a51E3cC38837944296717C4a96.svg
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
  "agents": {
    "0x8414ce0b…": [
      { "at": 1789852600000, "proposedAt": 1789852503,
        "pendingTotal": 12, "ownTotal": 31,
        "factors": { "successScore": { "pending": 7, "own": 26, "delta": 19 } } }
    ]
  }
}
```

`proposedAt` is the disputed proposal's timestamp, so a reader can work out whether it
is still inside its challenge window. That is the difference between something the
slashing committee can still reject and a post-mortem.

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

**The empty-slot rule is narrowed, not guaranteed.** The checker re-reads
`getPendingScore` immediately before it writes, so the gap is one RPC round trip rather
than a whole epoch. It is not zero: `proposeReputation` has no compare-and-swap, so a
proposal landing inside that gap is still overwritten. Closing it needs a
`proposeIfEmpty` variant on the contract that reverts if the slot changed. Until then a
checker can, rarely, overwrite a proposal it never saw.

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
3. `ORACLE_ROLE` on `SigvaraReputation`, granted by `DEFAULT_ADMIN_ROLE`.
4. Its own `ORACLE_STATE_PATH`. Sharing a state file would mean sharing the payment
   observations the score is computed from, which is most of what is being checked.
5. **`FEE_REGISTRY_ADDRESS` unset.** `SigvaraEpochFees.chargeEpoch` has no per-epoch
   idempotency, so a checker that ran the primary's fee path would debit the agent a
   second time for one scoring epoch. Startup refuses `ORACLE_MODE=checker` together
   with a fee registry. A checker's failover proposals are unbilled.
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
when it is up but has not completed an epoch within `MAX_SILENCE_MINUTES`, when the URL
turns out to be a primary rather than a checker, or when the checker reports
`seesProposals: false` because its epoch is too long to catch proposals before they
expire. Any of those make an empty divergence list meaningless, and a watcher that
reported them as "no divergences" would manufacture confidence out of an outage.

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
| `PAYMENT_FEE_UNIT` | `100000000` | Base units of volume per point of `feeScore`. With 6-decimal USDC this is one point per $100, so the 20-point cap lands at $2,000 of settled volume |
| `PAYMENT_HALF_LIFE_DAYS` | `90` | Days after which a payment counts half. `0` disables decay, which makes the score answer "was this agent ever busy" instead of "is it busy now" |
| `PAYMENT_MAX_PER_PAYER` | `4` | Most points of `feeScore`, and attestations of weight, any one payer can contribute. At 4, reaching the 20-point cap needs five distinct payers. `0` disables the cap |
| `PAYMENT_TRUST_WEIGHT` | `1` | Raises a counterparty's cap in proportion to its own matured score, and feeds `propagationScore`. `0` weights every payer alike |

Amounts are base units and handled as BigInt throughout, so an 18-decimal token does not
lose precision.

### Payment evidence by pull (ADR 0003)

| Variable | Default | Meaning |
|---|---|---|
| `PAYMENT_SCAN_ENABLED` | `0` | `1` enables scanning ERC-20 Transfer logs to agent addresses. Off by default because enabling it changes scores: an operator that has been missing payments starts counting them. |
| `PAYMENT_SCAN_FROM_BLOCK` | `FROM_BLOCK` | First block when there is no checkpoint. |
| `PAYMENT_SCAN_CHUNK` | `LOG_CHUNK_SIZE` | Blocks per `getLogs` call. |
| `PAYMENT_SCAN_CONFIRMATIONS` | `6` (floor) | Blocks to stay behind the head. May be raised, not lowered. Deeper than the attested path because a scan credits unattended; a credit records the tx hash as used, so a reorg would strand it. |

When a scan credits nothing, a **canary** runs before that emptiness is believed. It
re-issues the same filter shape against a settlement already in this operator's state:
one recipient, one block, one known transaction. A `getLogs` that matches nothing
returns the same empty array whether nothing happened or the query is wrong, and wrong
asset, wrong chain or an over-long topic filter all read as a set of agents nobody paid.

The verdict is logged and counted (`sigvara_oracle_payment_scan_canary_failures_total`):

| Verdict | Meaning |
|---|---|
| `passed` | The query works, so the empty range really was empty. |
| `failed` | The query did not find a settlement known to exist. **The range is unverified, not quiet.** |
| `unavailable` | No prior payment to point at, or the RPC could not answer. Never reported as `passed`. |

A probe without the recipient filter would not do: it proves the asset and chain are
right and then leaves the normal case, this asset moved but not to any of our agents,
indistinguishable from a broken recipient filter.

**Enable it on every operator or on none.** Two operators scanning and one not is the
same delivery asymmetry this exists to remove, pointed the other way.

A settlement is credited once **per recipient**, not once per transaction. One transfer
batch can pay several registered agents at a time, which is ordinary traffic for a
router or a payroll transaction, and each of them is credited for what it actually
received. Replaying the same transaction for the same agent is still refused. What
stops a receipt being spent on an agent it never paid is the recipient check rather
than the dedupe key: the attested path only counts transfers to the agent’s own
address, which is part of its DID and cannot be repointed, and the scan reads the
recipient from the log itself.

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
- **usedPaymentTxs**: Settlements already credited, as `txHash|didHash`, so the same receipt cannot be counted twice for the same agent. Keyed by the pair rather than the hash alone because one transaction can pay several registered agents. Entries written before this are bare hashes and still block every agent for that transaction, since which agent one belonged to is not recoverable: pruning drops old payment records and deliberately leaves this list alone
- **scanState**: The `AgentRegistered` log scan cursor, checkpointed per chunk so a rate-limited scan resumes instead of restarting from `FROM_BLOCK`

Writes are atomic (temp file + rename, with an `fsync` before the rename so a crash cannot leave an atomically-renamed empty file). `/health` reports both whether the path is writable and whether the last write actually succeeded, and returns 503 on either. The two are not the same check: the first writes a few bytes to a test file, which passes while a real state file fails for want of space.

Payment records are validated as they load. An `amount` that is not an integer string, or a missing settlement time, is dropped with the agent and the field named in the log, rather than throwing from inside the decay arithmetic later. Worth knowing when seeding this file by hand: `1.5` and `1_000_000` are both rejected, and fee volume and tenure for that agent are understated until the record is corrected.

This state is **per-oracle**. A second operator started against the same chain would
share none of it, which is the first thing that has to change before multiple operators
mean anything — see [Oracle Epochs](../docs/reputation-model.md#oracle-epochs).

## Tests

```bash
cd oracle
node --test
```

356 tests covering scoring formulas, payment verification and decay, per-payer caps and
the trust weighting, Merkle evidence trees, HTTP helpers, store persistence, chain
access with backoff and scan checkpointing, metrics, and cooldown logic. No network
access required.

The Merkle tree is cross-checked against the contracts: the oracle builds a tree in
JavaScript and a Foundry test verifies those exact proofs on chain. A disagreement about
leaf encoding or odd-node handling would otherwise pass each side's own tests and fail
only in production.
