# ADR 0009: Count payments that settle on Base, starting with Base Sepolia

**Status:** Accepted · 2026-11-03, with David's decisions below. Rollout step 1 is built for payments,
off by default (`oracle/payment-chains.js`): sections 1 to 6 and 8. Section 7, payer-signed outcomes
for a payment chain's payments, is not built yet; until it is, the outcome paths look for a payment on
the scored chain only.

## Context

Sigvara scores an agent partly on the payments it receives, and it only looks for them on Arc. ADR 0003 made
each operator find payments itself by scanning ERC-20 `Transfer` logs to registered agent
addresses, and ADR 0006 let the payer sign an outcome for a payment that settled. Both read one
chain: the one that holds the identities, the bonds and the scores.

Most agent payments do not settle there. On 3 November 2026:

- **Coinbase's x402 facilitator does not serve Arc.** Its network table lists Base, Base Sepolia,
  Polygon, Arbitrum, Monad, World, World Sepolia, Solana and Solana Devnet
  ([CDP x402 facilitator](https://docs.cdp.coinbase.com/x402/network-support.md)). Coinbase says
  the facilitator has processed more than $28 million of payment volume across Base and Solana.
- **Coinbase's agent wallet pays on Base only.** Wallet MCP, the server that gives Claude, ChatGPT
  and other agent apps a Coinbase wallet, "supports USDC payments on Base using the `exact`, `upto`,
  and `auth-capture` schemes"
  ([Wallet MCP skill](https://docs.cdp.coinbase.com/coinbase-for-agents/wallet-mcp/skill.md)).
  Coinbase for Agents, the exchange-account connector at `agents.coinbase.com/mcp`, pays x402 data
  sellers from a user's Coinbase USDC balance, in the US, capped at $5 a payment and $50 a day.
- **Even on Arc, a USDC payment does not count yet.** The testnet deployment scores SVR, and USDC
  on Arc emits its `Transfer` logs in a way the scanner cannot use as it stands
  ([ecosystem.md](../ecosystem.md)).

So a payment an agent receives through Coinbase's stack today cannot reach its Sigvara score,
however real it is. The external ERC-8004 feed read Base Sepolia until 22 September 2026, when it
was repointed to Arc ([arc.md](../arc.md)); payment evidence has never been read there.

Base is also the easier chain to read. USDC on Base is an ordinary ERC-20: an x402 `exact` or
`upto` payment is one `Transfer` from the payer to the seller's `payTo`, which is the shape ADR 0003
scans for and the case ADR 0006 says the payer rule reads correctly. Read from the chain on
3 November 2026:

| | Base Sepolia | Base |
|---|---|---|
| Chain id | 84532 | 8453 |
| USDC | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| `symbol()`, `decimals()`, `version()` | USDC, 6, 2 | USDC, 6, 2 |
| Block time | 0.2 s | 2 s |
| `finalized` behind `latest` | 5,157 blocks, about 17 minutes | 435 blocks, about 14.5 minutes |
| Public RPC `eth_getLogs` | limited to a 200-block range | rate-limited on the first call ("request limit reached") |

## Decision

### 1. A scored chain and payment chains

The oracle keeps one **scored chain**, Arc, where identities, bonds, proposals and scores live.
It gains a list of **payment chains** it reads payment evidence from. The scored chain is always
on the list. Base Sepolia is the first addition, on testnet only. Base mainnet is decided with the
mainnet launch, not here.

Each payment chain has its own RPC, payment asset, fee unit, scan cursor and canary (ADR 0003's
check that an empty scan is really empty). With no payment chains configured the oracle behaves
exactly as it does today.

### 2. What counts on Base

The rules ADR 0003 and `payment-scan.js` apply on Arc, unchanged:

- a `Transfer` of the chain's payment asset to the agent's registered address, with exactly three
  topics, emitted by the asset itself;
- the payer read from the log, never from a caller;
- payments to oneself refused, where the sender is the agent's address or its operator;
- one payment per transaction, recipient and payer, credited once;
- `success: null`, because a payment says money moved and nothing about how the work went.

x402's facilitator submits the transaction, so the transaction's sender is the facilitator. The
log's `from` is still the payer, which is why the log and not the transaction is read.

`auth-capture` and `batch-settlement` payments reach the seller from an escrow or channel
contract, so under this rule every such payment reads as paid by that contract, one payer for all
of them. That is ADR 0006's known gap and is not fixed here. Under the per-payer cap it undercounts
rather than inflates: the whole escrow is worth one payer's share.

### 3. Whose address it is

A Base payment counts only when the agent's registered address belongs to the same key on Base as
on Arc. That is true when the address has no code on either chain, or only an EIP-7702 delegation
designator (`0xef0100` followed by an address): an account derived from a key is the same account
on every chain.

It is not true of a contract. `SigvaraIdentity` accepts an ERC-1271 signature at registration, so
an agent's address can be a Safe or a smart account, and the same address on another chain may be
undeployed or deployed by somebody else. Whoever controls it there could pay it from many wallets
and lift the agent's fee score, and once negative outcomes are on (ADR 0006 keeps them off), sign
"not delivered" outcomes against an agent they never paid. So a payment on a payment chain to an
address with code other than a delegation designator, on either chain, is skipped with the reason
`contract_recipient`. The code is read at the payment's block there and at the agent's registration
block on the scored chain, so the answer does not depend on when an operator scanned. A later
change can let such an agent bind an address on Base with a signature checked there.

The x402 seller must take payment at its registered address. A `payTo` that differs from it is a
payment to somebody else.

### 4. Finality

A fixed confirmation count means nothing across chains: the scanner's floor of 6 blocks is
12 seconds on Base and 1.2 seconds on Base Sepolia. On a payment chain other than the scored
chain the scan credits up to the chain's `finalized` block, which on 3 November ran about 15 to 17
minutes behind the head. An hourly epoch absorbs that. Arc keeps its confirmation rule.

### 5. Units and caps

Each payment chain names its own asset and fee unit, and every amount is converted into fee units
before evidence from different chains is combined. Arc testnet scores SVR and Base Sepolia pays
USDC, so their raw amounts cannot be added.

The per-payer cap applies to an address across all chains. One wallet is one payer on Arc and on
Base, and must not take its share once per chain. A contract that happens to share an address on
two chains is counted as one payer too, which can only undercount.

`payments.js` already warns that a fee unit of 100 USDC a point is almost certainly too small once
real USDC is scored, and has to be recalibrated first. x402 payments are usually cents, so they earn
little fee volume under any unit near that.
What a Base payment adds is the payment itself: a counterparty, recency and a settled payment a
payer can sign an outcome for.

### 6. Evidence that names its chain

Every payment event records the chain it settled on. It is identified by chain, transaction,
recipient and payer, and the set of credited payments is keyed the same way.

The evidence leaf (`merkle.js`) commits to the transaction hash, payer, amount, settlement time and
outcome, and a verifier rebuilds it from the chain. A Base leaf adds the chain id so the verifier
knows which chain to read. Arc leaves keep their current encoding, so every root already published
still verifies. `/evidence`, the checker's evidence-as-of reading, the state file and backups carry
the chain id; an event stored without one is an Arc event.

### 7. Payer-signed outcomes for Base payments

The typed data and the SDK stay as they are. The domain is already defined as Sigvara, version 1,
on the chain the payment settled on, with the reputation proxy as `verifyingContract`. A payer who
paid on Base Sepolia signs with chain id 84532, which `signPaymentOutcome` takes as an argument
today. That is also the chain the payer's wallet is connected to, which matters: MetaMask, for one,
refuses typed data whose domain names a different chain.

The outcome request gains an optional `chainId`, defaulting to the scored chain. The oracle looks
up the payment, reads the payer's code and asks ERC-1271 on that chain. This is what lets a smart
wallet such as a Coinbase Smart Wallet sign: its `isValidSignature` exists only where it is
deployed, and a payer that paid from it has deployed it. Peer import, the public outcome feed and
CounterAudit's forwarder carry the field.

Nothing on chain checks outcomes today. A contract can only check an outcome whose domain names its
own chain, so the parity that ADR 0006's Foundry test shows with OpenZeppelin's `EIP712` would not
extend to a Base-domain outcome checked by a contract on Arc.

### 8. Two operators

Both operators read every payment chain with their own RPC. A proposal's evidence covers Base
payments finalized by the proposal's snapshot time. An operator whose Base cursor has not reached
the snapshot neither proposes nor finalizes for that epoch, and `/health` says which chain held it
back. Scoring without Base would make two honest operators disagree, and a disagreement is
evidence for the slashing committee. The ERC-8004 link scan makes the same choice when it cannot
list its logs: the epoch scores nothing.

Both operators enable a payment chain from the same block, as they did with
`EXTERNAL_LINK_FROM_BLOCK`, so neither credits payments the other cannot see.

## Options considered

- **Wait for x402 on Arc.** Some sellers on Arc accept x402 already, but Coinbase's facilitator
  and wallet do not, and nothing says they will. Sigvara would stay blind to where agents are paid.
- **Relay Base payments into Arc.** Somebody posts Base receipts to the oracle or to a contract on
  Arc. That is the delivery-by-somebody that ADR 0003 removed, and its failure is silent.
- **Move Sigvara to Base.** Out of scope. Arc is the deployment and the mainnet target.
- **Read Base through an indexer API** such as Blockscout or a provider's transfers endpoint.
  Faster, but it is a third party's account of the chain. `eth_getLogs` against a node is the
  chain's own answer, and an indexer can stay a fallback for a catch-up.

## Consequences

- A payment an agent receives on Base, from a Coinbase agent wallet or any other x402 client,
  enters its score with nothing asked of Coinbase or the payer.
- Smart-wallet payers on Base can sign outcomes.
- It is the precondition for the follow-ups the Coinbase review found: publishing scores to the
  ERC-8004 registries on Base (ADR 0008 posts on Arc), and a read-only Sigvara plugin for Wallet
  MCP. Both are worth doing only once a score describes payments those agents can make.
- Each operator needs its own Base RPC. The public endpoints are not enough: Base Sepolia's limits
  `eth_getLogs` to 200 blocks, and at 0.2 s blocks an hour is 18,000 blocks, so 90 calls per batch
  of 50 agents.
- An agent registered at a contract address gets nothing from Base until a binding exists.
- Base Sepolia USDC is free from Circle's faucet, so evidence there is as cheap to manufacture as
  SVR is on Arc testnet. It tests the mechanism, not the economics.
- The state file, the evidence leaf for Base events, the outcome request and peer import all
  change format. The Bureau's funding screen reads Arc's explorer only and would need Base too
  before it screens a Base payment.

## What this does not do

- It does not count Base mainnet, Solana, Polygon or any other chain. Base comes first because
  Coinbase's wallet pays only there. The list is configuration, so adding a chain is a decision
  rather than a rewrite, but each one needs its own check of how its asset emits `Transfer`.
- It does not fix escrow payments (`auth-capture`, `batch-settlement`). That is ADR 0006's version 2.
- It does not let a contract-address agent bind a Base address.
- It does not move identities, bonds or scores off Arc, or let Base payments change a bond.
- It does not switch Arc's payment asset from SVR to USDC. That decision is in
  [ecosystem.md](../ecosystem.md) and is separate.

## Rollout

1. **Build, off by default.** Payment chains in configuration, the scan per chain, the
   `contract_recipient` rule, finality by tag, fee units per chain, the chain-tagged leaf, and the
   optional `chainId` on outcomes. Shared test vectors for a Base leaf and a Base-domain outcome,
   as ADR 0006 has for its outcomes.
2. **Shadow on both operators.** Scan Base Sepolia, report what would be credited and skipped, and
   credit nothing. Compare the two operators' reports.
3. **Enable on both from one block.** Both operators set the same `FROM_BLOCK`, older than the
   chain's finality lag and younger than its delay, and restart within what is left of the delay,
   the checker first. Nothing from the chain counts until the delay has passed, so neither disputes the
   other while they differ. Switching back has no safe order with a checker running: stop the checker,
   put the primary in shadow, wait out the challenge window, and start the checker in shadow
   (`oracle/README.md`).
4. **End to end.** A Wallet MCP x402 payment on Base Sepolia to a registered agent, its credit on
   both operators, then a payer outcome signed on Base and accepted by both.

## Decisions (David, 3 November 2026)

1. **Base Sepolia is the first payment chain, on testnet only.**
2. **Agents registered at a contract address are skipped on Base** (`contract_recipient`) until
   they can bind a Base address with a signature checked there. Counting them would accept that
   somebody else may control the address on Base.
3. **An operator whose Base scan is behind the snapshot neither proposes nor finalizes** that
   epoch, rather than scoring without Base and asking the checker to tolerate the gap.
4. **Base mainnet is decided at the mainnet launch**, not now.
5. **Each operator brings its own Base RPC provider.** No shared endpoint, so one provider's
   outage or wrong answer cannot hold back or mislead both operators at once.

## Elysium testnet, in shadow (David, 4 November 2026)

Elysium testnet (chain 99801, Kinetiq's Arbitrum Orbit L2 settling to HyperEVM) is added as a payment chain in
shadow only, on the checker alone. It credits nothing and changes no score. It is configuration, as "What this does
not do" says a new chain should be, and this is the check of its asset that section asks for. Measured against
the public RPC on 4 November 2026:

- **`Transfer` logs.** USDC at `0x7D29d8047B905000459c0E80c34a26CeedcB47b2` has 6 decimals and is Arbitrum's standard
  gateway token, bridged from HyperEVM testnet. It emits ordinary ERC-20 `Transfer` logs, which `decodeTransfer` reads.
- **Finality.** The `finalized` tag works and moves in jumps, 46 seconds to about 5 minutes behind the head. That is
  well inside the default delay of an hour.
- **Reads.** A block takes about 97 ms, so about 37,000 an hour. A recipient-filtered `eth_getLogs` over 2,000,000 blocks
  answered in 0.3 seconds, one filter took 50 recipients, `eth_getCode` answered a million blocks back, and 90 calls
  with no pause drew no refusal. The cap is 10,000 logs an answer. `CHUNK=50000` stays under it even if every USDC
  transfer on the chain went to an agent, at the 1,127 per 10,000 blocks measured.
- **The scan.** `scanChain` over 90,000 blocks for the 18 registered agents took about 1.5 seconds and found no payment.
  With other addresses posing as agents, a contract had its 3,038 payments skipped as `contract_recipient`, and an
  account with no code showed 2,993 it would credit, with nothing credited. That second scan took 11 minutes, one
  `getBlock` for each block with a payment.

That last measurement is why a chain in shadow is scanned beside the epoch rather than in it. Anyone can send an agent
many small payments on a testnet, and a shadow chain, which counts for nothing, must not be able to hold up a score. So
those payments must not spend the scored chain's RPC either: a scan reads a recipient's code there once an agent, not once a payment.

Open before it could go `on`, and none of it matters in shadow:

- **A flood of payments.** A chain that is `on` is still scanned inside the epoch, so payments to an agent across many
  blocks slow that epoch by a read a block. This holds for Base Sepolia too, and needs a bound before either goes
  `on`. Elysium's logs carry `blockTimestamp`, which would avoid those reads there.
- **Whether bridged USDC counts.** It is a gateway token on this chain, not issued by Circle.
- **A provider per operator.** The checker reads the public endpoint. A chain that counts needs both operators, each
  with its own provider (decision 5).
- **An endless answer.** ethers reads a whole response with no size limit, so a hostile endpoint might exhaust an
  operator's memory. This has not been tested. It is one reason shadow runs on one operator.
- **Mainnet.** Its chain id, RPC and contracts are published at launch, and decision 1's testnet-only posture holds.
