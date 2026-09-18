# Payment-backed attestations

## The problem

An attestation is a claim that an agent did a job well. Until now anyone could
make one by sending an HTTP request:

```bash
curl -X POST http://oracle/attest \
  -d '{"didHash":"0x84...","success":true,"attester":"whoever-i-say-i-am"}'
```

The `attester` field was a string the caller chose. The only control was a one
hour cooldown keyed on that string, so a caller who wanted forty attestations
picked forty names. During testnet bring-up we did exactly that by accident: forty
requests named `client-1` through `client-40` moved an agent from 5 to 32, with no
keys, no money and no relationship to the agent.

It was worse than it looks, because `feeScore` was the largest of the six factors
at 30 points and was computed as attestation count divided by ten. The factor
documented as on-chain fee volume was a count of HTTP requests.

## What changed

Set `PAYMENT_VERIFICATION=required` and an attestation must carry the settlement
transaction of a real payment to the agent:

```bash
curl -X POST http://oracle/attest \
  -d '{"didHash":"0x84...","success":true,"payment":{"txHash":"0x3daf88..."}}'
```

The oracle then:

1. reads the agent's own address from the identity registry, which is part of the
   DID and cannot be repointed after registration,
2. fetches the transaction receipt and looks for transfers of the accepted asset
   to that address,
3. checks the total against `PAYMENT_MIN_AMOUNT` and the age against
   `PAYMENT_MIN_CONFIRMATIONS`,
4. takes the payer from the transfer log and uses it as the attester identity,
   ignoring anything the caller put in the `attester` field,
5. records the settlement hash so the same receipt can never be credited twice,
   and stamps the event with the block's timestamp rather than the time the receipt
   arrived,
6. computes `feeScore` from accumulated volume rather than a request count.

An attestation now costs what the agent charges. The attester is whoever paid,
established by the chain rather than asserted by the caller.

## Relationship to x402

x402 revives HTTP 402. A server answers a request with payment requirements, the
client pays, and the retry carries an `X-PAYMENT` header. On success the response
carries `X-PAYMENT-RESPONSE`, whose `transaction` field is the settlement hash.
That hash is what goes in `payment.txHash`.

The oracle verifies the settled transfer rather than re-running the facilitator
protocol. This is deliberate. Whether the payment went through x402's EIP-3009
scheme, a plain ERC-20 transfer or anything else, what lands on chain is the same
`Transfer` log, and that log is what any third party can check afterwards.
Verifying the outcome rather than the handshake keeps the oracle out of the
payment path and means it cannot be fooled by a facilitator that lies.

## Configuration

| Variable | Meaning |
|---|---|
| `PAYMENT_VERIFICATION` | `off` (default) or `required` |
| `PAYMENT_ASSET` | ERC-20 payments settle in. Required when on |
| `PAYMENT_MIN_AMOUNT` | Smallest payment that counts, in base units |
| `PAYMENT_MIN_CONFIRMATIONS` | Confirmations before a settlement is accepted |
| `PAYMENT_FEE_UNIT` | Base units of volume per point of `feeScore` |
| `PAYMENT_HALF_LIFE_DAYS` | Days after which a payment counts half. 0 disables decay |

Amounts are base units and are handled as BigInt throughout, so an 18-decimal
token does not lose precision. A missing `PAYMENT_ASSET` with verification on
stops the process at startup rather than silently disabling the check.

`off` is the default so existing testnet deployments keep working unchanged.
Mainnet should run `required`.

## Responses

| Status | Meaning |
|---|---|
| 200 | Accepted. The body echoes the verified payer and amount |
| 402 | The payment did not check out. `code` says why |
| 409 | This settlement was already credited |
| 502 | The RPC failed. Not a verdict on the payment, retry |

The 502 case matters. A node having a bad minute must not read as a caller trying
it on, so RPC failures are counted separately from rejected attestations and are
not recorded against the caller.

## Decay

Payments are stored as individual events, not a running total, because a total
cannot be aged. Each event carries the time the payment *settled*, taken from its
block, not the time its receipt was handed in. Keying off submission made a
year-old payment count as fresh, so receipts could be hoarded and released to keep
a score alive without new work, and an agent's operating span collapsed to however
fast its receipts were posted. With the settlement time, an old receipt arrives
already decayed and hoarding buys nothing. If the block cannot be read the
attestation is refused as an RPC error rather than falling back to the current
time, which would silently restore the problem. Each one is weighted by `0.5 ^ (age / half-life)` when the score
is computed, so at the default 90 days a payment counts fully today, half after
three months, a quarter after six, and about a sixteenth after a year.

This applies to `successScore` as well as `feeScore`. Both halves of the success
ratio decay together, so nine successes a year ago no longer mask a failure this
week.

Decaying a ratio is not enough on its own. A ratio is scale invariant, so ten
successes decayed to 0.44 successes out of 0.44 is still 1.0, and an agent that
went silent would hold full marks forever. The success rate therefore divides by
`total + 5` rather than `total`. Evidence has to accumulate to approach the cap,
a single observation is worth about four points instead of twenty-five, and as
decayed weight tends to zero so does the score. That is what stops a farmed score
sitting indefinitely.

Two reasons it matters. Without it the score answers "was this agent ever busy"
rather than "is it busy now", and an agent that stopped working a year ago keeps
full marks indefinitely. It also turns farmed reputation into a perishable asset:
a burst of manufactured volume evaporates unless it is renewed, so gaming the
score becomes a subscription rather than a one-off purchase.

Weights are computed as scaled integers rather than floats, because amounts are
BigInt and converting to a float to apply a fraction would discard the precision
BigInt exists to preserve on an 18-decimal token. Events whose weight falls below
a thousandth are pruned once per epoch; they cannot move an integer score and
would otherwise grow the state file without bound.

## Counterparty checks

Two rules apply once a payment verifies.

**Self-payments are refused.** If the payer is the agent's own operator or its
agent address, the attestation is rejected with `self_payment`. Paying yourself
costs only gas, because the money comes back, and the resulting attestation is
otherwise indistinguishable from a customer's. This does not stop someone funding
a second wallet, but it raises the floor from free to deliberate.

**One counterparty's evidence is capped.** Without a cap, a single wallet paying
ten times is worth exactly as much as ten wallets paying once, so a small ring is
as good as a customer base. `PAYMENT_MAX_PER_PAYER` limits any one payer to that
many points of `feeScore` and that many attestations of weight. At the default of
5, reaching the 30-point cap needs at least six distinct payers.

Capping scales a payer's successes by the same factor as its weight, so the cap
changes how much an opinion counts without changing what the opinion was. A payer
with a 50% record still reads 50% after capping.

Measured on Arc testnet with two real payers, one sending 20 tokens and one
sending 3, against a unit of one token per point:

| | Uncapped | Capped at 5 |
|---|---|---|
| `feeScore` | 23 | 8 |

## What this does not fix

The payer is verified, the payment is verified, and the amount is verified. The
*opinion* is not. Someone who genuinely pays an agent can still report
`success: false` out of spite, or pay themselves through an agent they control to
manufacture volume. Payment raises the cost of a fake attestation from zero to the
agent's price; it does not make attestations honest.

Self-dealing is the sharper of the two, and the counterparty checks above blunt it
rather than close it. Refusing the operator and agent addresses catches the lazy
version; funding a separate wallet still works. The per-payer cap then forces that
into at least six wallets to max the factor, each with its own funding trail, but
a determined attacker with capital can still build one.

Attestation state also still lives in the oracle's JSON file rather than on chain,
so the inputs to a score remain unverifiable by a third party even though each one
is now backed by a transaction they could check.
