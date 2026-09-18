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

## What this does not fix

The payer is verified, the payment is verified, and the amount is verified. The
*opinion* is not. Someone who genuinely pays an agent can still report
`success: false` out of spite, or pay themselves through an agent they control to
manufacture volume. Payment raises the cost of a fake attestation from zero to the
agent's price; it does not make attestations honest.

Self-dealing is the sharper of the two. An operator paying their own agent inflates
volume at the cost of gas alone, since the money returns to them. Counting distinct
payers, or weighting volume by payer diversity, would blunt it. Neither is
implemented.

Attestation state also still lives in the oracle's JSON file rather than on chain,
so the inputs to a score remain unverifiable by a third party even though each one
is now backed by a transaction they could check.
