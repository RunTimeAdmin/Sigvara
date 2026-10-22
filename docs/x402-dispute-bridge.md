# Sigvara x402 Dispute Bridge

**Status:** Captured design — not yet implemented  
**Date:** 2026-10-22  
**Context:** x402 Foundation (Linux Foundation) has no dispute or refund scheme in the base protocol. Payments are final once settled; refunds require a seller-sent transfer or third-party escrow. This is the single largest acknowledged gap in the agent-payments stack as of October 2026.

## The Problem

x402 answers "how does an agent pay?" It does not answer "what happens when the paid-for thing is wrong, late, or missing?"

- The x402 FAQ states the standard exact scheme is irreversible once executed.
- Adgentek's protocol comparison lists disputes/refunds as "not in the base scheme" for x402, while Visa/Mastercard/Stripe all carry dispute machinery.
- The Foundation's own post-launch framing names dispute handling as one of four things deciding whether x402 stays neutral infrastructure or fragments into closed rails.
- PayAI (major facilitator): "x402 is the payment primitive, not the dispute layer."
- TRM Labs: on stablecoin rails there is no chargeback; refunds must be designed in with holds, escrow, or a refund API.
- aixbt: "Dispute resolution that works in seconds/minutes" called out as an unsolved revenue opportunity.

Meanwhile the bolt-on scramble is already live: x402-trust (Arc testnet, DisputeManager with dollar-tiered tracks), vet402 (independent probe-and-publish), GenLayer (AI validators as adjudication), Termix (escrow-deliver-challenge-settle), OpenClawCash (escrow-only because x402 has no middle step).

## Sigvara's Existing Position

Sigvara already is a dispute layer — aimed at agent misbehavior rather than transaction-level delivery disputes:

- Slashable bonds (ERC-8004)
- Challenge windows
- Evaluator/attestation machinery
- Six-factor reputation score feeding gate decisions

The x402-trust protocol solves payer-versus-provider at settlement time. Sigvara solves agent-versus-agent trust over time. These overlap more than either side admits. Whoever connects them first owns the trust stack on top of the payment rail.

## The Bridge: One Narrow Integration

Do not build escrow. Make Sigvara the referee that x402's missing layer assumes exists.

### Core mechanic

1. **Settle:** An x402 payment settles on-chain (USDC, typically Base or Arc).
2. **Attest:** The seller's Sigvara attestation auto-attaches to that settlement tx as the proof-of-delivery claim. The attestation binds: seller identity, service identity, deliverable hash or response commitment, timestamp, payment tx hash.
3. **Challenge:** If the buyer disputes within the Sigvara challenge window, Sigvara's bond + evaluator set adjudicates. This is the same machinery as agent-misbehavior challenges — a new dispute *type*, not a new system.
4. **Resolve:** The outcome feeds back into (a) the seller's six-factor score and (b) a refund path that releases or claws back via a second micropayment (Circle nanopayments / x402), never a chargeback.

Design rule borrowed from GOAT Network's receipt guidance: a payment receipt makes feedback *eligible*; it must not make feedback *positive*. The attestation proves the interaction happened. The challenge window decides whether it counted.

### Why this is different from the bolt-ons

| Approach | What it adds | Gap it leaves |
|---|---|---|
| Escrow (OpenClawCash, Termix) | Hold before work | Latency; reintroduces the checkout-page problem x402 killed |
| Independent probing (vet402) | External truth on delivery | Only works for probeable HTTP endpoints; can't judge subjective quality |
| AI adjudication (GenLayer) | Machine-speed judgment | New consensus network; Sigvara would be a consumer, not the owner |
| **Sigvara bridge (this doc)** | Referee on existing bonds + score | Must define dispute types and refund semantics carefully |

## Sequence (happy path + unhappy path)

```
BUYER                         x402 FACILITATOR              SELLER (resource server)         SIGVARA
  |                                |                              |                             |
  |-- GET /resource -------------->|                              |                             |
  |<-- 402 Payment Required -------|                              |                             |
  |                                |                              |                             |
  |-- signed payment payload ----->|                              |                             |
  |                                |-- settle (USDC) ---------->|                             |
  |                                |                              |                             |
  |                                |                              |-- POST /attest ------------>|
  |                                |                              |   (settlement tx,           |
  |                                |                              |    deliverable hash,         |
  |                                |                              |    seller DID)               |
  |                                |                              |<-- attestation id ----------|
  |                                |                              |                             |
  |<-- 200 + PAYMENT-RESPONSE -----|                              |                             |
  |   (incl. sigvaraAttestation)   |                              |                             |
  |                                |                              |                             |
  |  [ buyer unhappy ]             |                              |                             |
  |                                |                              |                             |
  |-- fileChallenge(attestation) ----------------------------------------------------------->|
  |                                |                              |                             |
  |                                |                         [ challenge window open ]          |
  |                                |                              |                             |
  |                                |                    evaluators review evidence            |
  |                                |                              |                             |
  |<-- resolution: upheld --------|                              |  seller bond slashed        |
  |   refund micropayment issued  |                              |  score updated             |
  |                                |                              |                             |
  |<-- resolution: denied --------|                              |  buyer flagged             |
  |   (frivolous challenge)        |                              |  (Community factor)         |
```

## Dispute Types (initial set)

1. **Non-delivery** — settlement tx exists, no response or empty response within timeout. Strongest case; near-automatic.
2. **Malformed delivery** — response fails schema/content-type check declared in the payment requirement.
3. **Quality dispute** — response delivered but buyer claims it fails the stated spec. Subjective; requires evaluator judgment. This is where Sigvara's multi-evaluator design earns its keep (cf. GenLayer's "Optimistic Democracy" pitch, but using Sigvara's existing bonded evaluator set instead of a new network).
4. **Duplicate charge** — same payment ID presented twice (the retry-dedup problem called out by Mohammad Vazin on X). Facilitator-side, but Sigvara can record it as evidence.

## Refund Semantics

- No chargebacks. Stablecoin rails are final.
- Refund = seller-signed micropayment back to buyer, triggered by an upheld Sigvara resolution. The resolution attestation is the authorization artifact.
- For sub-cent payments (90.8% of x402 volume per BeInCrypto/AWS/Cloudflare/Chainalysis study), a full refund may cost more than the original. Options: (a) credit the buyer's Sigvara account for future purchases, (b) minimum refund threshold with credit-only below it.
- Frivolous challenges cost the buyer (bond or fee) — this is the anti-spam that makes the window usable.

## What This Does for Sigvara's Positioning

- **Differentiation:** Every other reputation system scores *after the fact* from self-reported outcomes. Sigvara becomes the system that *decides* outcomes. That is a category shift from scoreboard to referee.
- **x402 Foundation alignment:** The Foundation's four deciding questions include "whether a dispute scheme lands in the core spec" and "whether any facilitator can offer escrow and arbitration under the open standard." Sigvara is a ready-made arbitration primitive any facilitator could plug in — without waiting for the Foundation to ship one.
- **Arc wedge:** x402-trust is already deployed on Arc testnet with a DisputeManager. Sigvara's SVR mainnet target is Q4 2026 on Arc. One integration demo — pay, attest, challenge, resolve — on Arc beats any whitepaper argument. Shared chain, shared settlement asset (USDC), shared identity standard (ERC-8004).

## Open Questions / Judgment Calls

1. **Who triggers the attestation?** Seller-initiated (push) vs. oracle-detected from settlement events (pull). Push is faster but trust the seller's honesty about what was delivered; pull is slower but independently observable. Hybrid: seller pushes, oracle cross-checks settlement tx within N blocks.
2. **Challenge window length per dispute type.** Non-delivery can be short (minutes). Quality disputes need longer for evidence gathering. Dollar-tiering (x402-trust's 60h/120h/192h model) is a starting reference but may be too slow for micropayment velocity.
3. **Evaluator selection for quality disputes.** Random bonded draw vs. scope-matched specialists. Random is simpler and anti-capture; specialists are more accurate but create a guild.
4. **Minimum dispute value.** Below some threshold, adjudication cost exceeds dispute value. Credit-only or auto-deny below threshold?
5. **Cross-chain:** x402 settles on 12+ chains. Sigvara attestations on Arc. Need a canonical mapping or accept Arc-only initially.
6. **Relationship to x402-trust's DisputeManager.** Complement (Sigvara as evaluator backend) or compete (Sigvara replaces it)? Probably complement at first — their escrow vault + Sigvara's adjudication.

## Next Steps

1. Draft the `SigvaraX402Bridge` integration spec (Solidity interface + oracle hook).
2. Build the one-demo flow on Arc testnet: pay via x402, auto-attest, file a synthetic challenge, resolve, show score + refund path.
3. Publish a short public post framing Sigvara as the missing dispute layer — timed with any x402 Foundation dispute-scheme discussion.
4. File the open questions above as GitHub issues against this doc.
