# ADR 0008: Publish finalized scores to ERC-8004 as feedback

**Status:** Accepted · 2026-11-03, with David's decisions below. Built in `oracle/publisher.js`,
which ran in shadow mode first and since 3 November 2026 posts on testnet for one agent, as the end-to-end check ([Rollout](#rollout)).

## Context

ERC-8004's Reputation Registry holds raw feedback and leaves aggregation to whoever reads it. The
official guide ([erc-8004/best-practices, Reputation.md](https://github.com/erc-8004/best-practices/blob/main/Reputation.md))
expects most catalogs to filter feedback by "trusted signal providers": a consumer decides which
`clientAddress` it trusts for a signal, then reads only that address's feedback. A catalog that
indexes ERC-8004 today cannot see a Sigvara score at all. The score lives in `SigvaraReputation`
on Arc, which no ERC-8004 tool reads.

Publishing each finalized score as ERC-8004 feedback, from one address that Sigvara names as its
own, would make Sigvara such a provider without asking any catalog to integrate anything.

Four facts constrain how:

- **Sigvara reads ERC-8004 feedback itself.** External Trust is computed from it
  (`oracle/external.js`, `oracle/reviewers.js`), so its own posts must never feed back into it.
  CounterAudit already faced this and cut the loop with a tag the oracle ignores
  ([architecture.md, "A deliberate loop-break"](../architecture.md#a-deliberate-loop-break)).
- **The spec forbids self-rating.** "The feedback submitter MUST NOT be the agent owner or an
  approved operator for *agentId*" ([EIP-8004](https://eips.ethereum.org/EIPS/eip-8004), Reputation Registry).
- **There are two operators.** A primary proposes and a checker audits. Both cannot post, or
  every score appears twice.
- **Feedback accumulates.** `getSummary(agentId, clientAddresses, tag1, tag2)` averages every
  feedback that is not revoked, so a provider that posts daily without revoking publishes the
  mean of its history, not the current score.

## Decision

### What is posted

One feedback per linked agent per finalized score, from the publisher (below):

| Field | Value |
|---|---|
| `agentId` | the ERC-8004 agent the Sigvara agent is linked to |
| `value`, `valueDecimals` | the spendable score, `getTotalScore(didHash)`, as of the block it is read at; 0 to 100 with 0 decimals |
| `tag1`, `tag2` | `sigvara`, `score` |
| `endpoint` | empty |
| `feedbackURI` | a `data:application/json;base64,` URI holding the spec's off-chain feedback file |
| `feedbackHash` | `keccak256` of that JSON |

The spendable score is the one integrators are told to gate on
([integration.md, "Spendable and earned score"](../integration.md#spendable-and-earned-score)). The
feedback file carries the spec's required fields (`agentRegistry`, `agentId`, `clientAddress`,
`createdAt`, `value`, `valueDecimals`) and a `sigvara` object with the didHash, the
`SigvaraReputation` address, the block and time the score was read at, the earned score, and,
for a post that follows an event, that event's transaction, block and evidence root. Anyone can
check a post against `SigvaraReputation` at that block. A `data:` URI
needs no hosting and cannot change after the fact, which an `https` URL to
`/evidence/:didHash` could. The spec stores only `value`, `valueDecimals`, `tag1`, `tag2` and
the revoked flag; the URI and hash go in the event, so the file costs calldata and no storage.

Before each post, the publisher revokes its previous feedback for that agent. Exactly one Sigvara
feedback per agent is then live, and `getSummary(agentId, [publisher], "sigvara", "score")`
returns the current score with a count of 1. Measured on a fork of Arc testnet
(3 November 2026): after a revoke and a new post, `getSummary` returned count 1, value 47. Revoked
feedback stays readable with `readFeedback`, so the history is not lost.

On `ReputationZeroed`, after a slash, the publisher posts 0 the same way and does not simply
revoke. A revoke alone would leave no Sigvara signal on the agent, which reads as "never
scored", and a slashed agent should read as zero.

### The loop-break

The tag is `sigvara`. It is safe for two independent reasons, and both must stay true:

1. **The tag is not recognized.** `TAG_NORMALIZERS` in `oracle/external.js` has no `sigvara`
   entry, so `meanRating` drops the row before any reviewer is judged. The implementation adds a
   test that fails if any key of `TAG_NORMALIZERS` starts with `sigvara`, so extending the map
   cannot reopen the loop by accident. A recognized tag such as `starred` or `successrate` is
   exactly what the publisher must not use.
2. **The publisher is not a reviewer.** `reviewers.js` counts feedback only from a client that is a
   Sigvara agent, paid the rated agent and passes the bond, tenure and score rules. The publisher
   is none of these, and must never be registered as a Sigvara agent.

The `sigvara` metadata key that [pull request #173](https://github.com/RunTimeAdmin/Sigvara/pull/173) added for links is a different namespace, in
the Identity Registry rather than the Reputation Registry. Reusing the word is deliberate: both
mean "this is Sigvara's".

### The publisher

A dedicated EOA, used for nothing else. It is not the oracle's signing key, the deployer or any
operator wallet.

- **Named on chain.** It is set as the `agentWallet` of Sigvara's own ERC-8004 registration
  (Arc testnet agent 897764, registered on 3 November 2026 by
  [pull request #172](https://github.com/RunTimeAdmin/Sigvara/pull/172)'s script) with
  `setAgentWallet`: an EIP-712 signature from the publisher key, sent by the registration's
  owner. The spec asks an agent that gives feedback to use its `agentWallet` as the client
  address, and a consumer can then find the trusted address from the registration alone:
  `getAgentWallet(897764)`.
- **Not the owner of what it rates.** It owns no ERC-8004 agent and is approved for none, so the
  spec's self-rating rule never applies. The publisher skips Sigvara's own registration.
- **Custody.** The key holds only gas, and it is not on the publisher's host. The publisher asks
  an isolated remote signer on a separate host to sign each transaction (backed by a KMS or HSM on mainnet; on testnet `oracle/signer.js` with an encrypted keystore, decision 4),
  so a compromised publisher host can ask for signatures while it is compromised but cannot take
  the key away. The gas it may spend is capped. It is replaced like the signer key in
  [ADR 0004](0004-operator-custody.md), without touching anything of value: the registration's
  owner calls `setAgentWallet` with a new key, and consumers that resolve the address through
  `getAgentWallet` follow. Every post names the block its score was read at, so a false one is
  detectable by anyone, but not prevented.
- **On rotation**, the new publisher reposts the current score of every linked agent, since
  consumers that follow `getAgentWallet` stop reading the old address.

### Who posts, and when

- **One process, beside the primary.** A small publisher, separate from the oracle process,
  reads `ReputationUpdated` and `ReputationZeroed` from `SigvaraReputation`. It does not read
  oracle state, so it has no view of its own to disagree with, and it posts only finalized
  scores, which have already passed the challenge window. The checker never runs one: a second
  publisher with the same key would race the first for nonces, and one with another key would be
  a second, unnamed provider.
- **Idempotent.** It keeps a checkpoint of the last event it handled, advanced only after the post
  is confirmed. Before posting, it reads its own latest feedback for the agent
  (`getLastIndex`, `readFeedback`) and skips the post when that already holds the same value and is
  live. A restart, or a second copy started by mistake, then repeats nothing.
- **On a change, at most once per agent per UTC day, and refreshed daily.** A finalized score
  is a reason to look, and so is an agent's first link found on chain. The spendable score also changes with time alone, as a rise is released
  over days, and no event announces that, so once per UTC day the publisher reads the spendable
  score of every linked agent again. If it has not moved since the last post, nothing is sent. A
  backlog collapses to the newest reading per agent.

### Gas and failures

Measured on a fork of Arc testnet on 3 November 2026: `giveFeedback` 214,735 gas for the first
post from a new client and 149,991 after that, `revokeFeedback` 36,244. An update is a revoke and
a post, about 186,000 gas. The fork reported a gas price of 15.7 gwei, and Forge estimated 45 gwei
for a transaction that day, so an update costs 0.003 to 0.008 USDC (Arc's native USDC has 18
decimals). 100 linked agents updating every day would cost under a dollar a day.

- A failed or unconfirmed transaction leaves the checkpoint where it was, and the next run tries
  again. The revoke and the post are two transactions: if the revoke lands and the post does not,
  the agent shows no Sigvara feedback until the retry, which is the safe direction. The retry
  reads the publisher's own feedback first, so it posts without revoking twice.
- History is kept: revoked feedback stays readable, and the publisher never deletes anything.
- The publisher refuses to send when its balance is below a floor, caps the fee as the oracle does
  (`PUBLISH_MAX_FEE_GWEI`), and caps the posts per run.
- Publishing is outside scoring. If the publisher stops, scores are still proposed, checked and
  finalized; catalogs just see stale Sigvara feedback.

### Who it applies to

Only Sigvara agents linked to an ERC-8004 agent with a link made on chain (the `sigvara` metadata
key of [pull request #173](https://github.com/RunTimeAdmin/Sigvara/pull/173), live on both
operators since 3 November 2026), resolved as of the block the score is read at, with the same
rules and the same code the oracle uses. A link made with `POST /link` lives only in an
oracle's state file, and the publisher does not read oracle state, so those agents get no
feedback. When this was written on 3 November 2026 no agent was linked either way (0 links on both
operators' state files). Later that day the simulation's solo agent linked itself as ERC-8004 agent 897766, the first link made on chain.

### Rollout

1. **Shadow mode now, on testnet.** The publisher runs, reads everything it would read, and logs
   and records each post it would make, with no key and no transaction.
2. **Posting, once three gates are met:** Sigvara's registration is on chain (done: agent 897764);
   `getAgentWallet(897764)` is the publisher's address (done: block 70587267, 3 November 2026), which the publisher checks before every
   run; and one successful end-to-end cycle on testnet, a revoke and a post on one agent, read
   back with `getSummary` (begun on 3 November 2026: the first post, to agent 897766 in block 70589310; the revoke comes when its score next changes).
3. **Mainnet** stays behind the audit and the launch gates, like the rest of the protocol.

## Options considered

| | Approach | Buys | Costs |
|---|---|---|---|
| A | Do nothing; catalogs read `SigvaraReputation` if they want | Nothing to run | No ERC-8004 tool sees a Sigvara score |
| B | Post every finalized score, never revoke | One transaction per update | `getSummary` averages the history, so the published number is wrong |
| **C** | **Revoke the previous post, post the new one, on change, at most daily** | **One live, current score per agent, readable with the spec's own summary call** | **Two transactions per update, and a key to keep** |
| D | Post from the oracle's signing key, inside the epoch | No new key | Nonce contention with propose and finalize, a stolen signer also forges feedback, and the checker would need excluding by configuration |

## Consequences

- Catalogs that filter by a trusted client can show the Sigvara score with no integration, and
  verify each post against `SigvaraReputation`.
- Sigvara takes on a key and a process that cost gas every day, and a stolen publisher key can
  post false scores until it is replaced.
- The loop-break becomes a rule the code enforces with a test, not a convention.
- The on-chain link becomes the only way to be published, which is one more reason for an
  integrator to use it.
- It makes Sigvara's score readable where Arc's ERC-8004 tools already look, which is a concrete
  integration for agent commerce on Arc. It does not by itself bring catalogs or buyers, and the
  x402 dispute bridge it would pair with is designed but not built
  ([x402-dispute-bridge.md](../x402-dispute-bridge.md)).

## Decisions (David, 3 November 2026)

1. **Build now, in testnet shadow mode.** Posting is enabled after the registration, the wallet
   verification and one successful end-to-end cycle. Mainnet stays behind the audit and launch
   gates.
2. **The spendable score** (`getTotalScore`) is the public value. The earned score and the block
   and time it was read at go in the feedback file, and a daily refresh catches maturity, which
   changes without an event.
3. **Revoke-and-post**, keeping history and retrying after a partial failure.
4. **A dedicated publisher EOA** whose key is held by an isolated remote signer, backed by a KMS or
   HSM, on a separate host, with capped gas and rotation through `setAgentWallet`. For testnet, David then chose a software key in `oracle/signer.js`, an encrypted keystore on `packrai-vps` (3 November 2026); mainnet still needs the KMS or HSM.
