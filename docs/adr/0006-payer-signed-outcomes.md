# ADR 0006: Outcomes signed by the payer

**Status:** Proposed · 2026-10-31. Design only; nothing here is built. The roadmap puts this
work after the first audit, and the shape of the escrow and receipt parts should follow what
x402 standardizes, so this is written to be revised, not to be frozen.

## Context

A payment's existence is settled. The oracle reads the transfer off the chain, takes the payer
from the log, refuses self-payments and caps any one payer's weight
([payment-backed attestations](../payment-backed-attestations.md)), and since
[ADR 0003](0003-evidence-intake.md) every operator pulls payments from the chain itself, so two
operators see the same money by construction.

A payment's *outcome* is not settled. Three things are true of it today.

**It is a credentialed service's word.** A request with no token records the payment and no
outcome. Outcomes come from a token holder such as CounterAudit, and a negative one needs a
token always, because a verified payment proves money moved and never that the work failed.
The attestation design names this as the gap it leaves: "The payer is verified, the payment is
verified, and the amount is verified. The *opinion* is not."

**It is the one input still delivered to a single operator.** ADR 0003 moved payments to pull
and left outcomes on push, because "the work was good" is not on chain. An outcome posted to the
primary never reaches the checker, which is the fan-out gap ADR 0003 removed for payments, still
open for outcomes. A credentialed outcome cannot be forwarded between operators safely either:
it is a token holder's word to one operator, and a peer repeating it is only repeating it.

**The service that reports outcomes has stopped.** Since 30 October 2026 CounterAudit's relay
lists no org in production, and the oracle's last recorded outcome is from 20 September
([CounterAudit integration](../counteraudit-integration.md)). CounterAudit's own review held the
relay back because the org reporting an outcome is usually the agent's operator, so the agent was
rating itself. CounterAudit's
signed-outcomes design (`docs/SIGNED_OUTCOMES_DESIGN.md` in that repository) keeps the relay off
until outcomes are signed by their source, and names this ADR's subject as the missing piece:
"EIP-712 payer-signed outcomes for Sigvara, until Sigvara defines the typed data."

The party whose opinion the score most needs is the one that paid. It already holds a key, because
it signed the payment. Asking it to sign the outcome too, over typed data that binds the outcome to
that payment, turns the opinion into something any operator can check without trusting whoever
carried it.

### Where x402 stands

As of October 2026 x402 v2 lists four schemes. `exact` is a fixed price: the payer signs an EIP-3009
authorization and the transfer lands as a `Transfer` from the payer to the seller. `upto` charges
actual usage up to a signed maximum, in one settlement. `batch-settlement` accumulates many requests'
vouchers against a reusable channel and settles them together. `auth-capture` is refundable: funds
move into an escrow (the Commerce Payments Protocol's `AuthCaptureEscrow`) and are later captured to
the seller, voided or refunded, and x402r adds an arbiter per payment. Delivery receipts are still
proposals.

That matters for one reason: the oracle reads the payer from the `Transfer` log. For `exact`, `upto`
and plain transfers that is the payer. For `auth-capture` the transfer to the seller comes from the
escrow contract, so by the rule as written every escrow payment reads as paid by the escrow, one
payer for all of them. That is true of today's attestations already, and this design does not fix
it; it scopes itself to the payments the rule reads correctly and leaves escrow to a second version
of the type, below.

## Decision (proposed)

### 1. The typed data

An outcome is an EIP-712 signature by the payer over:

```
EIP712Domain(string name, string version, uint256 chainId, address verifyingContract)

PaymentOutcome(
  bytes32 didHash,
  bytes32 txHash,
  address payer,
  uint8   outcome,
  bytes32 evidence,
  uint64  signedAt,
  uint64  deadline
)
```

- **Domain.** `name` is `Sigvara`, `version` is `1`, `chainId` is the chain the payment settled on,
  and `verifyingContract` is the `SigvaraReputation` proxy on that chain. A signature for the testnet
  deployment cannot be replayed against mainnet, or against a second deployment on the same chain.
- **`didHash`** is the agent the payment went to. **`txHash`** is the settlement transaction.
- **`payer`** is the sender of the payment, stated rather than recovered. An externally owned
  account's signature is checked by recovery against this address; a contract account's by calling
  `isValidSignature` on it (ERC-1271). That is the rule `SigvaraIdentity` already applies to agent
  wallets through OpenZeppelin's `SignatureChecker`, so smart accounts that pay can sign without a
  separate path.
- **`outcome`** is `1` delivered or `2` not delivered. `0` and anything above `2` are refused, and
  the values above `2` are left for the dispute types in the
  [x402 dispute bridge](../x402-dispute-bridge.md) (malformed delivery, quality). In the evidence leaf
  `1` maps to succeeded (`1`) and `2` to failed (`0`), so the leaf format does not change.
- **`evidence`** is an optional 32-byte reference the payer chooses: the hash of the response it
  received, a delivery receipt's hash once x402 defines one, or a CounterAudit packet id left-padded
  to 32 bytes. Scoring ignores it. It is committed so a later dispute can point at what the payer was
  looking at when it signed.
- **`signedAt`** and **`deadline`** are seconds.

### 2. Who submits it

Anyone. The signature is the credential, so the submitter needs no token and its identity does not
matter: the payer, the agent, the facilitator or CounterAudit can all carry it. It goes in the
existing request:

```bash
curl -X POST https://oracle.sigvara.xyz/attest \
  -H 'Content-Type: application/json' \
  -d '{"didHash":"0x84...","payment":{"txHash":"0x3daf88..."},
       "payerOutcome":{"payer":"0x5c...","outcome":2,"evidence":"0x00...","signedAt":1793400000,
                       "deadline":1793486400,"signature":"0x..."}}'
```

`success` and `payerOutcome` are mutually exclusive in one request, so there is never a question of
which one an outcome came from.

### 3. What the oracle checks

In order, refusing at the first failure with a named code, as the payment path already does:

1. The payment verifies exactly as it does today for the leg `(txHash, agent, payer)`: recipient,
   asset, minimum amount, confirmations, not a self-payment. The signer's own leg, not the largest
   one: ADR 0003 puts a token holder's outcome on the largest leg so that one report is not counted
   once per sender. A payer's signature names its own leg, so the outcome goes there.
2. The signature is valid for `payer` under the domain of the chain the payment settled on.
3. `signedAt` is not before the payment's block time, not more than a few minutes ahead of now, and
   `deadline` has not passed and is at most 30 days after `signedAt`.
4. The precedence rules below allow it.

Refusals: `payer_mismatch` (no leg from that payer to that agent in that transaction),
`bad_signature`, `outcome_window` (timing), `outcome_recorded` (precedence), and the payment codes
the endpoint already returns.

### 4. Precedence and finality

Today a recorded outcome is final. That stays true, with one exception, because the payer is the
party the work was for:

- A payer-signed outcome is final for its leg. A second signature from the same payer for the same
  leg is refused, whatever it says.
- A payer-signed outcome replaces a credentialed one on the same leg if it arrives within
  `PAYER_OUTCOME_WINDOW_DAYS` of the payment (default 14).
- A credentialed outcome never replaces a payer-signed one.

### 5. Negatives

This is the part the token was guarding, so it gets its own rules.

- Every protection payments already have applies unchanged: the minimum amount, the self-payment
  refusal, `PAYMENT_MAX_PER_PAYER` and decay. A negative costs a real payment to the agent it
  criticizes, and the per-payer cap means flooding an agent with negatives takes many funded wallets,
  each of which pays the agent first.
- `PAYER_NEGATIVE_MIN_AMOUNT`, defaulting to `PAYMENT_MIN_AMOUNT`, can raise the price of a negative
  above the price of a payment.
- `PAYER_OUTCOMES` takes `off` (default), `positive` or `both`. On a chain whose payment asset has an
  open faucet, which is the Arc testnet today, it should be `positive`: there a negative costs
  nothing, which is exactly the downgrade-anyone attack the token prevents. `both` is for a chain
  where the payment is real money.

An agent cannot contest a payer's negative under this design. That recourse is the buyer-and-seller
challenge in the dispute bridge, which is not built. Until it is, a payer's negative counts as
reported.

### 6. Every operator gets every signed outcome

Because a payer-signed outcome verifies on its own, operators can pull outcomes from each other
the way ADR 0003 has them pull payments from the chain, without the relay ADR 0003 rejected:

- Each operator serves the payer-signed outcomes it has accepted at `GET /outcomes?since=<ms>`,
  public and unauthenticated.
- Each operator imports from every other bonded operator on a schedule and puts every import
  through the checks in section 3, against its own chain view, as if it had been posted to it.
- A contract account's signature is checked with `isValidSignature` at a block, and its answer can
  change when the account rotates its owner. The operator that accepts an outcome therefore records
  the block it checked at and serves it, and an importer checks at that same block, so a later key
  rotation cannot make two honest operators disagree about a signature that was valid when given.
  An externally owned account's signature does not depend on state and needs no block.

A dishonest or broken peer can therefore fail to share an outcome, which the next import or a
direct post repairs, but it cannot inject one. Two operators holding the same chain converge on the
same payer-signed outcomes by construction. Credentialed outcomes cannot work this way, because a
peer's copy of a token holder's word is only a copy, so they stay per-operator as they are today.

The evidence leaf is unchanged. It already commits to the outcome value per payment, and
`/evidence` adds the signed payload beside each payer-signed leaf, so a verifier can check that the
committed outcome is one the payer signed. An on-chain outcome log, the "Later" row in ADR 0003,
remains the stronger end state; this gets most of its benefit with no contract change.

### 7. What CounterAudit becomes

A courier and a sealer, not an attester. A CounterAudit connector for payer-signed outcomes would
check the EIP-712 signature against the payer, seal the signed outcome in the org's chain the way it
seals the Bureau's furnisher-signed events, and forward it to every Sigvara operator. The org
allowlist and token its old relay needed do not apply, because the oracle trusts the signature, not
CounterAudit, and the self-rating problem the relay was paused for does not arise: the payer rates,
CounterAudit carries.

## Consequences

- **Outcomes stop depending on a trusted service.** A negative can come from the customer who was
  let down, and a positive from the customer who was served, without either going through an
  attester the agent's operator controls.
- **Outcomes converge across operators** for the first time, by the same argument ADR 0003 made for
  payments.
- **The rule "a recorded outcome is final" gains an exception** in favour of the payer, inside a
  window. That changes what a credentialed outcome means: provisional for 14 days.
- **The client has to sign.** An x402 buyer already holds a key and signs typed data for the
  payment; one more signature after delivery is cheap for software and invisible to a person, but it
  is new work in every buyer integration. `@sigvara/protocol-sdk` should ship the signer.

## What this does not do

- It does not prove the opinion is true, only whose it is. A payer can still be wrong, and a payer
  working with the agent can still sign positives, as today; payment, the self-payment refusal and
  the per-payer cap remain the only costs on that.
- It does not cover `auth-capture` escrow payments, `batch-settlement` channels or cross-chain
  settlement. A `version` `2` of the type would bind to the escrow's payment identifier and read the
  payer from the escrow's records, and a refunded payment could count as not delivered without a
  signature at all. That waits for x402's escrow and arbiter interfaces to settle.
- It adds no challenge, no arbiter and no refund. Those are the dispute bridge.

## Rollout

1. Oracle: the checks, the precedence rules, `PAYER_OUTCOMES`, `GET /outcomes` and peer import, all
   off by default. Like the payment scan, **on every operator or on none**: one operator accepting
   payer outcomes and another not is a delivery asymmetry.
2. Test vectors signed by an externally owned account and by an ERC-1271 mock, cross-checked against
   the contract's domain separator, plus refusal cases: wrong payer, another sender's leg, wrong chain
   or contract in the domain, before settlement, after the deadline, a second signature, a negative
   under `positive`, a forged signature arriving by peer import, and an ERC-1271 account that
   rotates its owner between acceptance and import.
3. `@sigvara/protocol-sdk`: `signPaymentOutcome` and `verifyPaymentOutcome`.
4. Arc testnet with `PAYER_OUTCOMES=positive`, then the CounterAudit connector.
5. `both` only on a chain where the payment asset costs money.

## Open questions

1. Should a payer get one revision inside the window, for example to withdraw a negative after a
   refund? The proposal says no, to keep the leaf stable and the rules short.
2. Is 14 days the right window for a payer to override a credentialed outcome?
3. What should `PAYER_NEGATIVE_MIN_AMOUNT` be on mainnet?
4. Once payer outcomes are live, should the token path for outcomes be retired, or kept for
   backfilling payments whose payers never sign?
5. Peer import or an on-chain outcome log first? This proposes import, because it needs no contract
   change before the audit.
