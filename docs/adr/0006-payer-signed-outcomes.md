# ADR 0006: Outcomes signed by the payer

**Status:** Accepted as a design · 2026-10-31. Rollout 1 to 3 are built, all off by default: the
oracle's checks and precedence rules, `PAYER_OUTCOMES`, the source marking on `/evidence`,
`GET /outcomes` and peer import; the vectors in `test/vectors/payment-outcome.json`, checked on chain
by `test/PaymentOutcome.t.sol`; and the SDK's `signPaymentOutcome` and `verifyPaymentOutcome`. Testnet
(Rollout 4) is next. The open questions were decided the same day
and are recorded at the end. Public outcome retrieval and peer replication
wait on a retention review before mainnet (see Rollout). The roadmap puts the build after the
first audit, and the escrow and receipt parts should follow what x402 standardizes.

**Status update, 1 November 2026.** Rollout 1 to 4 are done. The SDK's signer is published in
`@sigvara/protocol-sdk` 1.0.0-alpha.13. Rollout 4 was applied on Arc testnet on 31 October at
23:06 UTC: both operators run `PAYER_OUTCOMES=positive` and `PAYER_OUTCOMES_PUBLISH=on`, each lists
the other in `PAYER_OUTCOMES_PEERS`, and `GET /outcomes` is public through both proxies. The first
payer-signed outcome was posted straight to `POST /attest` at 23:15 UTC
(`0xebb71faa0e0f87432793b4daaf32778a5d14594e7d1a4939662748dd076bcf6d`), and the second came through
CounterAudit's connector (section 7) at 00:02 UTC on 1 November
(`0xde612a2fb0b0a3ed6bc1de0d2212e5edcb7dd4ec15ee6b831e4a5a0a4aa8a307`). The checker imported both
at its next epoch. Rollout 5 (mainnet) and 6 (negatives) are still to come, on the conditions
under Rollout.

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

## Decision

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
  separate path. Off chain it differs only for accounts that break ERC-1271 or lean on its edges: an
  `eth_call` is not a static call, so an account that writes storage while answering is accepted
  where the static call on chain would revert; the call is capped at 2,000,000 gas; its `bytes`
  argument is padded to a whole word, where OpenZeppelin sends it unpadded; and an empty signature,
  or one over 4096 bytes, is refused before the account is asked (a Safe can approve a message on
  chain and then take an empty signature for it). The vectors record the first as an on-chain-only
  case.
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
2. `signedAt` is not before the payment's block time, not more than a few minutes ahead of now, and
   `deadline` has not passed and is at most 30 days after `signedAt`. Checked before the signature,
   which costs a chain read. "Passed" is judged at the time of the block the signature is checked
   at (section 6), not by the receiving host's clock, so an operator importing the outcome later
   reaches the same answer, and that block may be at most an hour older than `signedAt`.
3. The signature is valid for `payer` under the domain of the chain the payment settled on.
4. The precedence rules below allow it.

Refusals: `payer_mismatch` (no leg from that payer to that agent in that transaction),
`bad_signature`, `outcome_window` (timing), `outcome_recorded` (precedence), and the payment codes
the endpoint already returns.

### 4. Precedence and finality

Today a recorded outcome is final. That stays true, with one exception, because the payer is the
party the work was for:

- A payer-signed outcome is final for its leg. A second signature from the same payer for the same
  leg is refused, whatever it says. A refund or a later correction is a separate event linked to
  it, never an edit to the signed outcome or to its evidence leaf.
- A payer-signed outcome replaces a credentialed one on the same leg if it arrives within
  `PAYER_OUTCOME_WINDOW_DAYS` (default 14) of the payment's block time. It arrives when the
  operator holding the credentialed outcome checks it, at that operator's confirmed head, whether
  it was posted there or imported, so a peer cannot reopen the window by naming an old block. Two
  operators can therefore decide differently near the edge, which matters only where they hold
  different credentialed outcomes, as they already can.
- A credentialed outcome never replaces a payer-signed one.

The window is only for the immediate payment types this ADR covers. Delayed delivery, escrow and
batch settlement need rules of their own. It is not a dispute-response deadline for anyone else,
the Agent Bureau included.

### 5. Negatives

This is the part the token was guarding, so it gets its own rules.

- Every protection payments already have applies unchanged: the minimum amount, the self-payment
  refusal, `PAYMENT_MAX_PER_PAYER` and decay. A negative costs a real payment to the agent it
  criticizes, and the per-payer cap means flooding an agent with negatives takes many funded wallets,
  each of which pays the agent first.
- `PAYER_NEGATIVE_MIN_AMOUNT` starts equal to `PAYMENT_MIN_AMOUNT`, in the payment asset's base
  units, and can later raise the price of a negative above the price of a payment. There is no
  universal token amount: the payment minimum is set per deployment, and the deployed mainnet value
  is not yet verified.
- `PAYER_OUTCOMES` takes `off` (default), `positive` or `both`, and launches as `positive` on every
  chain, mainnet included. A payer's signature establishes who made a claim, not whether it is true,
  and an agent cannot contest a payer's negative under this design: that recourse is the
  buyer-and-seller challenge in the dispute bridge, which is not built. `both` waits for a challenge
  process. On a chain whose payment asset has an open faucet, which is the Arc testnet today, there
  is a second reason: a negative would cost nothing, which is the downgrade-anyone attack the token
  prevents.
- Once negatives are enabled, they are presented as payer-reported, not as verified fact.
  `/evidence` and `/outcomes` mark each outcome's source, `payer_signed` or `credentialed`, and
  anything that describes an agent's failures says who reported them. The Agent Bureau's own rules
  for negative evidence and review are separate and unchanged by this.

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
  The block is recorded for an externally owned account too: under EIP-7702 an address can gain code
  later, and whether it is checked by recovery or by ERC-1271 depends on the state at the block.

As built, an operator lists the others in `PAYER_OUTCOMES_PEERS` and imports at the start of each
epoch, before scoring. An importer refuses a recorded block before the payment or more than an
hour before `signedAt`, and waits for one past its own confirmed head. It reads the payment from
the receipt as a post does, so an outcome that reaches it after its node has pruned the receipt
cannot be imported, the same limit a direct post has. A payer with no code at the importer's head
is checked by recovery, which needs no old state; one with code needs the state at the recorded
block, so importing smart accounts' outcomes needs an archive node. An outcome that cannot be
checked for a reason that is not its own is retried for a few runs and then passed over until
the next restart, so it cannot hold up the rest.

A dishonest or broken peer can therefore fail to share an outcome, which the next import or a
direct post repairs, but it cannot inject one. It does choose the block it says it checked at.
Within the bounds above it can name an earlier block than it used: one before the deadline for a
signature it held back, or one before an account rotated away from a compromised key. A payer
dating its signature back moves the second bound with it. Both need a signature that the payer's
key at that block actually made; neither writes an outcome nobody signed, and neither reopens
the replacement window, which each operator judges at its own head. A payer that signs two different outcomes and gives one to each operator leaves them each
holding a final one. The importer counts and logs the difference and keeps what it holds;
settling it is the dispute bridge's job. Two operators holding the same chain converge on the
same payer-signed outcomes by construction. Credentialed outcomes cannot work this way, because a
peer's copy of a token holder's word is only a copy, so they stay per-operator as they are today.

The evidence leaf is unchanged. It already commits to the outcome value per payment, and
`/evidence` adds the signed payload beside each payer-signed leaf, so a verifier can check that the
committed outcome is one the payer signed. An on-chain outcome log, the "Later" row in ADR 0003,
is deferred until peer reliability or audit needs justify the extra contract surface. Neither
mechanism proves an opinion is true.

### 7. What CounterAudit becomes

**Built** (Rollout 4, 1 November 2026): CounterAudit's connector `sigvara-payment-outcome-v1`, described
in the [CounterAudit integration](../counteraudit-integration.md#payer-signed-outcomes).

A courier and a sealer, not an attester. A CounterAudit connector for payer-signed outcomes would
check the EIP-712 signature against the payer, seal the signed outcome in the org's chain the way it
seals the Bureau's furnisher-signed events, and forward it to every Sigvara operator. The org
allowlist and token its old relay needed do not apply, because the oracle trusts the signature, not
CounterAudit, and the self-rating problem the relay was paused for does not arise: the payer rates,
CounterAudit carries.

### 8. Retiring the token path for outcomes

Once payer-signed outcomes are available, the token path stops taking ordinary new outcomes. At
most a time-limited backfill remains, for payments whose payer did not sign. A backfilled outcome
is marked credentialed and operator-local: it is never served for peer import and never replaces
a payer-signed outcome. Where no trustworthy backfill exists, the payment's outcome stays
unreported (`2` in the evidence leaf), which the score already treats as neither a success nor a
failure.

**The outcomes already recorded.** From 19 September 2026 (`51adbe0`) until 22 October (`a936ddb`),
the oracle recorded the `success` of a positive, payment-backed attestation whether or not the
caller held a token. On testnet that covers every outcome either operator holds, checked on
31 October: eight, all "delivered" and all for the demo agent `0x8414ce0b…`, two paid on
18 September and six on 20 September by test wallets for the experiment in the
[divergence log](../divergence-log.md). They are the project's own traffic, and the state does not
record whether a token was used. `/evidence` labels them `credentialed`, which for these eight means
only that the payer did not sign them. They are past the replacement window, so they stay as they
are.

## Consequences

- **Outcomes stop depending on a trusted service.** A negative can come from the customer who was
  let down, and a positive from the customer who was served, without either going through an
  attester the agent's operator controls.
- **Outcomes converge across operators** for the first time, by the same argument ADR 0003 made for
  payments.
- **The rule "a recorded outcome is final" gains an exception** in favour of the payer, inside a
  window. That changes what a credentialed outcome means: provisional for 14 days from the
  payment's block time.
- **New negatives pause until a challenge process exists.** Payer negatives launch off and the token
  path keeps only a time-limited backfill, so for new payments the success factor can rise and
  cannot fall except through that backfill. That is a deliberate trade: no failure enters the score
  that its agent cannot contest. It changes little against today, since the oracle has recorded no
  outcome of either kind since 20 September, but the score should say so while it lasts.
- **The client has to sign.** An x402 buyer already holds a key and signs typed data for the
  payment; one more signature after delivery is cheap for software and invisible to a person, but it
  is new work in every buyer integration. `@sigvara/protocol-sdk` ships the signer,
  `signPaymentOutcome`.

## What this does not do

- It does not prove the opinion is true, only whose it is. A payer can still be wrong, and a payer
  working with the agent can still sign positives, as today; payment, the self-payment refusal and
  the per-payer cap remain the only costs on that.
- It does not cover `auth-capture` escrow payments, `batch-settlement` channels or cross-chain
  settlement. A `version` `2` of the type would bind to the escrow's payment identifier and read the
  payer from the escrow's records, and a refunded payment could count as not delivered without a
  signature at all. That waits for x402's escrow and arbiter interfaces to settle.
- It adds no challenge, no arbiter and no refund. Those are the dispute bridge.
- It does not settle retention. Public outcome retrieval and peer replication copy every accepted
  outcome to every operator and to anyone who asks, and a copy on another operator's host cannot be
  guaranteed deleted. The retention policy has to cover those copies, and counsel has to review how
  copies, disputes, backups and deletion requests are handled, before either runs on mainnet.

## Rollout

1. Oracle: the checks, the precedence rules, `PAYER_OUTCOMES`, `GET /outcomes` and peer import, all
   off by default. Like the payment scan, **on every operator or on none**: one operator accepting
   payer outcomes and another not is a delivery asymmetry.
2. Test vectors signed by an externally owned account and by an ERC-1271 mock, cross-checked against
   OpenZeppelin's `EIP712` domain separator at the `SigvaraReputation` proxy's address (the contract
   has no EIP-712 domain of its own; this is the one an on-chain verifier there would have), plus
   refusal cases: wrong payer, another sender's leg, wrong chain
   or contract in the domain, before settlement, after the deadline, a second signature, a negative
   under `positive`, a forged signature arriving by peer import, and an ERC-1271 account that
   rotates its owner between acceptance and import.
3. `@sigvara/protocol-sdk`: `signPaymentOutcome` and `verifyPaymentOutcome`.
4. Arc testnet with `PAYER_OUTCOMES=positive`, then the CounterAudit connector.
5. Mainnet with `positive`. There, `GET /outcomes`, the signed payloads in `/evidence` and peer
   import stay off until the retention policy covers copies held by other operators and counsel has
   reviewed how copies, disputes, backups and deletion requests are handled. This is a launch gate,
   not a follow-up. The Agent Bureau has recorded a provisional baseline: an active file keeps an
   outcome at most 24 months from the Bureau's `received_at`, a chosen product policy rather than a
   legal safe harbor, and it accepts no outside outcome until counsel has checked its obligations.
6. `both` only once a challenge process exists, with negatives presented as payer-reported.

## Decisions on the open questions

Decided 2026-10-31.

1. **No revision.** One payer-signed outcome per payer and payment leg. A refund or later correction
   is a separate, linked event, not an edit to the signed outcome or its score leaf. The Agent Bureau
   may keep its own append-only correction and dispute history, but must not imply that it changed
   Sigvara's outcome.
2. **Keep 14 days** as the initial window, measured from the payment's block time. It is the period
   in which a payer outcome can replace a credentialed one, not the Bureau's dispute-response
   deadline, and it applies only to the immediate payment types this ADR supports.
3. **`PAYER_NEGATIVE_MIN_AMOUNT` starts at `PAYMENT_MIN_AMOUNT`**, in the configured asset's base
   units, with no universal token amount. Launch with `PAYER_OUTCOMES=positive` until a challenge
   process exists, and when negatives are enabled, label them payer-reported, not verified fact.
4. **Retire the token path for ordinary new outcomes** once payer-signed outcomes are available. Keep
   at most a time-limited backfill for payments whose payer did not sign, marked credentialed and
   operator-local, never peer-imported and never replacing a payer-signed outcome. Without a
   trustworthy backfill, leave the outcome unreported.
5. **Peer import first.** Every importer rechecks the payment, the signature, the domain, the timing
   and the precedence rules, including ERC-1271 signatures at the recorded block, and import is
   enabled on all operators together. An on-chain outcome log is deferred until peer reliability or
   audit needs justify the added contract surface. Neither mechanism proves an opinion is true.
