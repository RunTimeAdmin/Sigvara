# Sigvara roadmap

As of 6 November 2026. This is the one list of what comes next. The [launch checklist](launch-checklist.md) holds the detail of each mainnet gate, and [section 8 of the whitepaper](whitepaper.md#8-roadmap) keeps the reasoning behind the main steps.

**The goal:** someone outside the team accepts or refuses an agent in production because of its Sigvara score, on mainnet.

**The number to watch:** outside consumers, meaning independent callers that act on a score in production. Today it is 0. Integrations the team runs do not count.

**The order:** each step comes after what it depends on, and dates appear only where they are real. The adoption and mainnet tracks run side by side, and neither waits for the other.

## Adoption

| Step | Finished when |
|---|---|
| Payer outcomes for Base payments ([ADR 0009](adr/0009-payments-on-base.md), section 7), then that ADR's rollout: shadow on both operators, then on from one block | A Wallet MCP x402 payment on Base Sepolia is credited by both operators, and a payer outcome signed on Base is accepted by both |
| A read-only Sigvara plugin for Coinbase's Wallet MCP, once a score describes payments those agents can make | Submitted to `coinbase/agents` |
| Design partners | One outside team has agreed to gate on a score |
| The first outside gate in production | Outside consumers reads 1, and [/integrate](https://sigvara.xyz/integrate) says so |
| Use the partner's numbers: real job sizes set how large a job a bond should back, and a score distribution figure starts | The ratio is chosen from real data |

## Mainnet

| Step | When |
|---|---|
| The adversarial [slash drill](slash-drill.md) | Day 7 from 10 November 03:46 UTC, day 21 from 24 November 03:45 UTC |
| The staking half of the contract upgrade | After the drill |
| More checks in the renounce gate ([checklist](launch-checklist.md#where-this-stands)) | After the drill |
| Testnet roles to a Safe and a timelock. Upgrades then wait 48 hours, so this follows the staking upgrade | After the two steps above |
| An ADR on who rules a contested negative outcome | Any time |
| A limit on operators' total epoch spend, and the reads an unstaked registration adds | Before agents grow |
| SVR launch through Tolly (checklist phase 3) | The owner's decision. It does not wait for the registries |
| External audit, and fixing what it finds (phase 2) | After the staking upgrade and the renounce checks, so it reads what will run |
| Registries on Arc mainnet with bonds in SVR, mainnet keepers, pinned operators (phase 4) | After the audit's fixes |

Mainnet launches with payer outcomes positive only, as [ADR 0006](adr/0006-payer-signed-outcomes.md) allows. Non-delivery cannot be used as a ground for a slash until the challenge process below exists ([ADR 0010](adr/0010-what-can-be-slashed.md)).

## After usage

| Step | What starts it |
|---|---|
| The payer challenge, and an arbiter path beyond the committee | The ADR above is accepted, a partner needs recourse, and x402's escrow and delivery-receipt work has settled enough to fit |
| Epoch fees on | Real volume (checklist phase 5) |
| The reward distributor, then staking rewards | Mainnet, then treasury inventory |
| A bond review | Any trigger in checklist phase 6, such as 250 active agents |
| Operators run by independent parties, then a drill with a dishonest primary | Someone outside will run one, and what an operator is paid in its first month is settled |

## Candidates

Ideas with a place on the list but no work under way. Each moves up when its event happens.

| Idea | What starts it | Smallest first step |
|---|---|---|
| Proof of personhood for reviewers | A partner asks for it, or real outside reviewers exist | An ADR: reviewers proven to be one person count as one cluster. Oracle side, one provider, opt-in |
| Solana payments | A partner has payers there | The same pattern as ADR 0009: read payments directly, with no bridge |
| Bond-based eligibility tiers | A partner's job sizes | Docs only. `isTrusted(agent, minScore, minBond)` already does it |
| The ERC-8004 Validation Registry | A partner or a registry user asks | Publish CounterAudit validations |
| Evidence bundles, and a `payment_verified` status in the SDK | An integrator wants to re-verify old roots | An ADR on what a bundle holds |
| A way to notice a dead watcher | Anyone outside relies on its alerts | A heartbeat from the watcher, checked from another host |

## How a new idea gets on this list

It has to answer five questions:

1. **Whose problem is it?** A named user or a measured attack, not a category.
2. **What changes?** What does an integrator's gate see differently?
3. **Which accepted decision does it touch?** Amend that first, or reshape the idea.
4. **What is the smallest version?** Can it run without a new contract?
5. **What starts it?** An event, not a date.

An example, proof of personhood:

1. A party that builds five reviewers once can point them at any number of its own agents, as the header of [`oracle/reviewers.js`](../oracle/reviewers.js) says. Nobody outside is doing this yet.
2. Up to 25 points of External Trust. Reaching all 25 would need some proven reviewers, or an opt-in changes nothing.
3. Vouching for newcomers touches [ADR 0010](adr/0010-what-can-be-slashed.md), under which a Sybil fleet that breaks no rule is not slashable, and section 1 of the whitepaper, so it stays out. Counting reviewers once touches neither.
4. It runs in the oracle, with no verifier or nullifier contract. A nullifier scoped to each agent would let one person back a whole fleet, so it needs one scope for all of Sigvara, with the agent bound in the proof's message. That makes one person's agents linkable, which is why it is opt-in. Proofs still need a public place both operators read at the snapshot.
5. A partner asks, or real outside reviewers exist.
