# ADR 0014: Answer ERC-8004 validation requests with the Sigvara score

**Status:** Accepted · 2026-11-28, the owner's choice of option D (section 3) with the answers proposed in section 9.
Rollout step 1 is built: `src/SigvaraValidator.sol`, tested on a fork of Arc testnet in
`test/SigvaraValidatorFork.t.sol`, with `script/DeployValidator.s.sol`. Code references are to main at `ba619c6`.
References to the Validation Registry are to `ValidationRegistryUpgradeable.sol` in
[erc-8004/erc-8004-contracts](https://github.com/erc-8004/erc-8004-contracts/blob/b9e466c/contracts/ValidationRegistryUpgradeable.sol)
at `b9e466c`, which reports the same version, 2.0.0, as the registries deployed on Arc.

## 1. Context

- **Sigvara uses two of ERC-8004's three registries.** In the Identity Registry it has its own registration (Arc
  testnet agent 897764), and an ERC-8004 agent links itself to its Sigvara agent with the `sigvara` metadata key
  (`oracle/link-scan.js:153-171`). In the Reputation Registry, the publisher posts each linked agent's spendable score
  as feedback ([ADR 0008](0008-sigvara-as-erc8004-signal-provider.md)). It does not use the third, the Validation
  Registry.
- **What the Validation Registry does.** The owner of an ERC-8004 agent, or an operator it approved, opens a request
  that names one validator address (`validationRequest`, lines 78-113). Only that address can answer, with a response
  from 0 to 100, an optional URI and hash, and a tag (`validationResponse`, lines 115-133). It can answer the same
  request again, and the newest answer replaces the last. `getValidationStatus(requestHash)` returns an answer and its
  `lastUpdate` (lines 135-144). `getSummary(agentId, validators, tag)` averages the newest answer of every answered
  request of the agent that matches the validators and the tag, and walks every request the agent has ever opened to
  do it (lines 146-180). Nothing can be revoked and nothing expires. A request hash can be used once in the whole
  registry (line 86), and anyone who owns an ERC-8004 agent can add to the list of requests that name a validator
  (`getValidatorRequests`, lines 187-190).
- **The spec puts stake-backed trust here.** A registration file lists the trust models an agent supports,
  `crypto-economic` among them, and the spec's examples of validation are stake-secured re-execution, zkML proofs and
  TEE oracles. It leaves incentives and slashing to each validation protocol. Sigvara's score is stake-backed twice
  over. A bonded operator proposes it, a second bonded operator recomputes it, and it is final only after a challenge
  window in which the committee can reject it ([architecture.md, "Score out"](../architecture.md#score-out)). The
  agent it describes has a bond that can be slashed, which zeroes the score
  ([ADR 0010](0010-what-can-be-slashed.md)).
- **The registry today.** Counts posted in the
  [ERC-8004 discussion thread](https://ethereum-magicians.org/t/erc-8004-trustless-agents/25098) between 15 and 27
  November 2026 found no requests on Ethereum or BNB Chain, and 18 on Base, 16 of which named the requesting agent's
  own owner or agent wallet as the validator. On Arc testnet, the registry's 50 most recent transactions (30 October to
  28 November 2026) were 33 requests, 15 of which failed, and 17 answers, each 90 or more. The most common request URI
  was a placeholder, `ipfs://bafkreiexamplevalidationrequest`.
- **On Arc.** The registry is deployed on testnet at `0x8004Cb1BF31DAf7788923b405b754f57acEB4272` and on mainnet at
  `0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58`. Like the other two registries it is an upgradeable proxy, and the
  reference repository says this part of the spec is still being revised with the TEE community.
- **The roadmap.** It lists the Validation Registry as a candidate that starts when a partner or a registry user asks,
  with CounterAudit validations as its smallest version ([roadmap.md](../roadmap.md)). This ADR settles the design
  ahead of that trigger, at the owner's request, and the owner chose to build it now (decision 1).

## 2. What any answer must keep

1. An answer is the spendable score `SigvaraReputation` holds for the linked Sigvara agent, or 0 after a slash. Nothing
   else.
2. At most one live Sigvara answer per ERC-8004 agent, so that `getSummary(agentId, [validator], "sigvara")` gives the
   current score with a count of 1, as ADR 0008's feedback does.
3. Sigvara's gas grows with linked agents, not with the requests an agent's owner chooses to open.
4. A slashed agent reads as zero on every ERC-8004 agent it was answered on, whatever happens to the link afterwards,
   as its feedback does (`oracle/publisher.js:240-244`). Only a link to another Sigvara agent replaces it, again as with
   feedback.
5. Nothing Sigvara answers feeds back into a Sigvara score.

## 3. Options considered

**A. Do nothing.** ADR 0008's feedback already carries the score. Sigvara stays absent from the registry where the spec
puts stake-backed validation, and from every count of it. Not chosen.

**B. Answer every request once.** The cheapest per request. Answers go stale, `getSummary` averages old answers with
new ones, and an agent's owner decides how many answers Sigvara pays for. Rejected.

**C. One kept request per linked agent, answered from the publisher's address.** The publisher answers the first
request that names it for each linked agent, keeps that answer current, and leaves later requests from the same agent
unanswered. The address is already named on chain (`getAgentWallet(897764)`), and no contract is needed. But the
registry binds each request to one validator address, so a rotation of the publisher key (ADR 0008, "On rotation")
strands every kept request: the new key cannot answer them, and every agent must open a new one. And an answer is
whatever the key signs. Not chosen.

**D. C, answered through a validator contract. Chosen.** A small contract, `SigvaraValidator`, is the validator that
agents name, and the publisher key operates it.

1. The owner calls `answer(requestHash, didHash, response, responseURI, responseHash)`, and the contract calls
   `validationResponse` with the tag `sigvara`.
2. It accepts an answer only when the answer is true on chain in that block. The request's ERC-8004 agent must name
   `didHash` in its `sigvara` metadata and be owned by that Sigvara agent's operator, the test a link must still pass
   whenever the oracle reads it (`claimHolds`, `oracle/external.js:278-286`), and `response` must equal
   `SigvaraReputation.getTotalScore(didHash)`. A score that moved after the publisher read it reverts the answer, and
   the publisher reads again. The `sigvara` value is read with a fixed gas allowance of 50,000, so a value an owner makes
   oversized reads as no link, at a bounded cost.
3. When the Sigvara agent it last answered for on that request is `Slashed`, it accepts an answer of 0 for that agent,
   whatever the link says.
4. `retire(requestHash, responseURI, responseHash)` answers 0 with the tag `sigvara-unlinked`. It is accepted when the
   link no longer holds, or when the same Sigvara agent's score has since been answered on another ERC-8004 agent's
   request, and never when the Sigvara agent last answered for is `Slashed`.
5. It keeps one request per ERC-8004 agent, the first one it answers, and returns it from `keptRequest(agentId)`. It
   refuses any other request for that agent, and a request hash of zero, which `keptRequest` uses to mean "none yet".
6. Ownership moves in two steps, so a new publisher key takes over the same validator address and every kept request,
   and it cannot be renounced. The constructor checks that the Validation Registry is bound to the Identity Registry it
   is given. The contract is not upgradeable. If the registry's interface changes, a new contract is deployed and agents
   open new requests.

What the contract cannot check is history. The oracle also requires that the operator owned the ERC-8004 agent when it
set the key, and when several of an operator's agents name the same Sigvara agent it takes the newest claim
(`oracle/link-scan.js:20-48` and `153-171`). Which ERC-8004 agent gets the answer is therefore the publisher's choice,
made by those rules. A stolen publisher key can delay, skip or retire answers, or answer for another agent the operator
owns that names the same Sigvara agent, such as an older claim or one a third party set up and handed over. It cannot
publish a score that `SigvaraReputation` does not hold. The cost is a contract to write, test, review and deploy, and
its reads on every answer.

**E. A contract anyone can call.** D without an owner: anyone triggers an answer, and nobody holds a key. But a
contract cannot tell which of several ERC-8004 agents that name the same didHash holds the link in force. The oracle
takes the newest claim that holds, and finding it takes the logs. Nobody would be bound to keep answers current either.
Not chosen. D keeps its checks.

**F. Validate single payments or jobs.** A request names a payment or an ERC-8183 job, and Sigvara answers whether it
settled and how the payer rated it. That is closest to the spec's examples, a check of one piece of work. It reads
untrusted request files, needs a request schema and costs gas for every job. It could come later on the same
validator. It is not part of this ADR.

## 4. What is answered, and for whom

| Field | Value |
|---|---|
| `requestHash` | the ERC-8004 agent's kept request |
| `response` | the spendable score, 0 to 100, which the contract checks against `getTotalScore(didHash)` in the block it answers in; 0 after a slash |
| `responseURI` | a `data:application/json;base64,` URI holding the file below |
| `responseHash` | `keccak256` of that JSON |
| `tag` | `sigvara`, or `sigvara-unlinked` with a response of 0 for a retired answer |

The file carries the `sigvara` object of ADR 0008's feedback file: the didHash, the `SigvaraReputation` address, the
block and time the score was read at, the spendable and earned score, and, for an answer that follows an event, that
event's transaction, block and evidence root. It adds `agentRegistry`, `agentId`, `validatorAddress`, `requestHash`
and `createdAt`. The contract checks the response, not the file. The publisher writes the file, and anyone can check it
against `SigvaraReputation` at the block it names.

- **An agent opts in once.** After linking, its owner calls `validationRequest(validator, agentId, requestURI,
  requestHash)`. The SDK gains a helper that writes a small `data:` request file, naming the agent, the validator and
  the time, and hashes it, so two requests never share a hash. Sigvara does not read `requestURI`: it is the owner's
  input, and the answer needs nothing from it.
- **Who is answered.** ERC-8004 agents linked on chain, resolved as the publisher resolves them for feedback. An agent
  that is not linked is answered once it links. Sigvara's own registration is never answered.
- **Finding requests.** The publisher reads `ValidationRequest` logs whose indexed validator is the contract, in
  windows as the link scan does, from the contract's deployment block. It does not call `getValidatorRequests`, which
  anyone can lengthen. Which request is kept follows from the chain alone (`keptRequest`), so the publisher's state for
  answers can be rebuilt from it.
- **Reading an answer.** `getSummary(agentId, [validator], "sigvara")` returns a count of 1 and the score for a linked,
  answered agent, and 0, 0 otherwise. It walks every request the agent has opened, so an agent that opens very many
  can make it costly for a contract to call. `getValidationStatus(keptRequest(agentId))` costs the same whatever the
  agent did, and its `lastUpdate` says how recent the answer is. A reader that uses it checks that `keptRequest(agentId)`
  is not zero, and that the status names that agent, this validator and the tag `sigvara`. The validator's address is published in the SDK and
  the docs, and as the metadata key `sigvaraValidator` on Sigvara's own registration.

## 5. When it answers

- On the triggers of ADR 0008's feedback: a finalized `ReputationUpdated`, a `ReputationZeroed`, an agent's first link
  found on chain, and a daily read of every answered agent. At most once per agent per UTC day, except that a slash's
  zero goes at once (`mayPostNow`, `oracle/publisher-policy.js:88-90`). An unchanged score sends nothing.
- An answer that has not changed for 7 days is sent again, so a contract can require a recent `lastUpdate`
  (decision 3).
- When a link stops holding, or the score moves to a newer ERC-8004 agent of the same operator, the publisher retires the
  old answer, unless the Sigvara agent was slashed. If the agent links again, the same request is answered again with
  `sigvara`.
- The checker never answers, for the reasons ADR 0008 gives for feedback. The publisher's caps cover answers too:
  `PUBLISH_MAX_FEE_GWEI`, the transactions per run and the balance floor.

## 6. Gas and cost

Measured on a fork of Arc testnet at block 74,570,310 on 28 November 2026, against the deployed registry, with a
747-byte answer file, calling the registry directly from the validator's address. The contract of option D adds its
reads to each answer.

| Call | Gas | At 25 gwei |
|---|---|---|
| `validationRequest`, paid by the agent | 216,492 | 0.0054 USDC |
| A first answer | 156,264 | 0.0039 USDC |
| A later answer | 82,264 | 0.0021 USDC |
| A retiring answer | 80,504 | 0.0020 USDC |

25 gwei was the gas price on Arc testnet and mainnet that day. After the retiring answer,
`getSummary(agentId, [validator], "sigvara")` returned 0, 0, as a revoke does for feedback. A second request with a
hash already used reverted. 100 linked agents answered every day would cost about 0.21 USDC a day, under half the cost
of their feedback updates (about 186,000 gas each, ADR 0008).

Through `SigvaraValidator`, on the same fork with a 33-byte file (Foundry's gas report for
`test/SigvaraValidatorFork.t.sol`): an answer took 134,049 gas at the median and 269,065 at most, for a first answer.
A retire took 139,348 at most, the most being a retire after the owner had set a 6,000-byte `sigvara` value.
Deployment took 1,153,822. A 1,000-byte file adds about 24,000 gas of calldata and log data. That puts 100 agents
answered every day at about 0.40 USDC a day, still under the cost of their feedback updates.

## 7. Consequences

- A linked agent can show an answer, in the registry the spec built for it, from a validator that is not its own
  owner. Any contract on Arc can read it with the registry's own calls, and the answer was checked on chain against
  `SigvaraReputation` when it was given.
- The validator is not yet several parties: both oracle operators are run by the same party today
  ([architecture.md, "Who checks the checker"](../architecture.md#who-checks-the-checker)).
- An agent pays about 0.005 USDC, once, to opt in. Answers exist only for agents whose owners link and then request.
  One agent is linked on chain today, the simulation's solo agent, so the first answers are for it.
- Sigvara takes on a contract and a second kind of transaction for the publisher.
- The kept requests depend on the registry's interface. A revision of this part of the spec means a new contract and
  new requests. Answers already given stay readable.
- The loop stays broken by construction. The oracle reads ERC-8004 feedback (`oracle/external.js`) and never the
  Validation Registry. If it ever reads validation answers, it must leave out this validator's and the `sigvara` tags,
  with a test, as ADR 0008 does for feedback.

## 8. Rollout

1. **Contract.** `SigvaraValidator`, with Foundry tests on a fork of Arc testnet: an answer whose response is not
   `getTotalScore`, a link that does not hold, a second request for the same agent, a retire while the link holds, a
   retire after a slash, a slash's zero after the link moved, and the two-step ownership move, each refused or allowed
   as section 3 says.
2. **Publisher.** The request scan, kept requests, answers and retires, in shadow mode first, behind the gates ADR 0008
   set for posting.
3. **Testnet.** Deploy, name the contract in Sigvara's registration, then one end-to-end cycle with the simulation's
   solo agent: a request, an answer and a new answer after a score change, each read back with `getSummary` and
   `getValidationStatus`.
4. **SDK and docs.** `requestValidation` and a read helper in the SDK; `docs/integration.md`, the candidate's row in
   `docs/roadmap.md`, and `oracle/README.md`.
5. **Mainnet** with the rest of the protocol, behind the same gates ([launch-checklist.md](../launch-checklist.md)).

## 9. Decisions (the owner, 28 November 2026)

1. **Build it now,** on Arc testnet in shadow mode first, ahead of the roadmap's trigger.
2. **Option D, the validator contract,** over option C, the publisher's own address with no contract, where a key
   rotation would strand every request and answers would not be checked on chain.
3. **A resend every 7 days** when the score has not changed, so a contract can require a recent `lastUpdate`, at about
   0.002 USDC per agent per week.
4. **The tags** `sigvara` and `sigvara-unlinked`. `sigvara` is already the feedback tag and the link key.
