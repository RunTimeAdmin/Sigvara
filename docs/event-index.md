# Event index

The event index holds every log the four Sigvara contracts have emitted on the Arc testnet (identity, reputation, staking and the oracle bond) since they were deployed, and serves them over HTTP. The explorer pages on sigvara.xyz (agents, operators, slashes and score epochs) read their history from it.

Code: `oracle/indexer.js` (the service) and `oracle/event-index.js` (what it accepts and answers), tested by `oracle/indexer.test.js` and `oracle/event-index.test.js`. Deploy: `docker-compose.indexer.vps.yml`.

## Why it exists

A page that lists every registered agent needs the identity contract's whole history. There were two ways to get it, and both broke:

- **The public RPC** answers `eth_getLogs` over at most 10,000 blocks a call and refuses a batch of four. Sigvara's history is about 7.8 million blocks, which is close to 800 calls.
- **The Arc explorer** answers a contract's history in one request. But it allows ten requests an hour from one address, which a visitor clicking through the pages can use up in minutes. And its per-contract index stopped at block 70,337,205 on 2 November 2026, while its block list kept up. From then on /agents showed 3 of the 16 registered agents.

The index reads the same logs through Alchemy's Arc testnet RPC. That takes 10,000 blocks a call too, but ten calls in a batch, so the whole history reads in about 15 seconds. It then serves the result in one request.

## What to trust it for

It is a cache of public chain data, run by the Sigvara team:

- **It answers only which events happened.** Everything the pages show about an agent's standing (status, scores, stake, evidence roots, `verifyEvidence`) is still read from the contracts by the visitor's own browser.
- **Each log names the transaction it came from.** The bond history, the slashes and the score epochs link it. Anyone can check any entry against the chain, or run the index themselves and compare. `/events` answers any origin for that reason.
- **It cannot sign or write anything.** The worst a compromised index can do is leave an event out or add one that is not on chain. An added event would not match its transaction. A left-out event is not caught by the pages: they fill in from the chain only the blocks after the index's newest.

How it keeps the history complete (`oracle/indexer.js`, `poll`):

- It reads only blocks the RPC calls `finalized`, less 20 (`HEAD_MARGIN`, about ten seconds). Arc finalizes each block as it is made, so a block read once does not change.
- The margin is there because a provider spreads requests over several nodes. A node a block or two behind the one that named the head can answer a log read for blocks it does not have yet with what it has, and say nothing. So each batch also asks for its own last block, and a batch whose node does not have it is refused (`readSpans`).
- It reads in order, and moves on only when a whole batch of spans has been read and checked. A refused or malformed answer fails the whole batch, and the next poll reads it again. So the index never has a hole.
- A log outside the span asked for, from another contract, or with a malformed field fails the read rather than being stored (`normalizeLog`).

## What it answers

`GET /events` returns the logs in chain order, shaped as `eth_getLogs` returns them. Each carries `blockTimestamp`, and the answer says which blocks it covers:

```json
{ "chainId": 5042002, "fromBlock": 62662196, "toBlock": 70445597, "toBlockTime": 1793671700, "logs": [ ... ] }
```

Optional filters, all checked before use (`parseQuery`):

| Parameter | Meaning |
|---|---|
| `address` | one or more of the indexed contracts, comma separated |
| `topic0` | up to 20 event topics, comma separated |
| `topic1` | one 32-byte value, such as an agent's didHash |
| `fromBlock` | leave out older blocks |

A reader takes the blocks after `toBlock` from the chain itself, which is what the pages do (`indexLogs` in `site/assets/explorer.js`). A page that gets a `toBlock` more than 100 blocks past the chain's newest does not use the answer.

A request never reaches the RPC. The index answers from memory, so traffic to the pages cannot spend the provider's credits. Each query's answer is encoded once and kept until the index moves on (`eventsAnswer`), so many requests for the same query share one copy.

`GET /health` answers 200 while the index has polled in the last few minutes and is at most 3,600 blocks (about half an hour) behind the finalized head, and 503 otherwise. It reports `toBlock`, `head`, `behind`, the number of logs, the last error with any URL removed, and the commit it runs.

## When it does not answer

The pages fall back to what they did before:

- **Agents, operators, slashes and an agent's timeline** read the Arc explorer, plus the chain after the explorer's index, and say so on the page.
- **The epochs page's last day** reads the chain.
- **The operators' last proposals** read the last 100,000 blocks from the chain.

`scripts/check-live.mjs services`, run on a schedule by `.github/workflows/live-checks.yml`, fails when `/health` does, and when the certificate for index.sigvara.xyz is near expiry.

## Running it

On a host with a TLS proxy, in `/docker/sigvara-index`:

1. Copy `docker-compose.indexer.vps.yml` there. Put `SIGVARA_COMMIT=<a commit on main>` in `.env`.
2. Put the RPC URL in `./rpc_url`, one line, mode 600. For Alchemy that is `https://arc-testnet.g.alchemy.com/v2/<key>`, from an Alchemy app with Arc testnet enabled. It reaches the container as a compose secret, never as an environment variable, and the index never logs or serves it (`readRpcUrl`, `redact`).
3. Run `docker compose -f docker-compose.indexer.vps.yml up -d`. The log says `[deploy] running <hash>`, then `[indexer] caught up: <n> logs through block <n>` within a minute or two.
4. Point `index.sigvara.xyz` at the host and proxy it to `127.0.0.1:3040`. With Caddy:

   ```
   index.sigvara.xyz {
   	reverse_proxy 127.0.0.1:3040
   }
   ```

It keeps the index in the `index_data` volume, so a restart carries on from the last block read. A change of chain, start block or contract list starts it over (`resumable`), which against Alchemy takes about 15 seconds.

**Cost on Alchemy:**
- The first read of the whole history is about 80 requests.
- After that, each poll (every 30 seconds by default) is one finalized-block read, plus one log read when there are new blocks. That is roughly 3,000 to 6,000 requests a day.

**On Arc's public RPC instead,** set `INDEX_BATCH=1`. The first read is then about 800 calls, and the RPC's rate limit makes it much slower: a refused read waits for the next poll.
