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
- It reads in order, and moves on only when a whole batch of spans has been read and checked. A span the node refuses for its size, or does not answer in time, is read in halves instead (`oracle/log-spans.js`). Any other refused or malformed answer fails the whole batch, and the next poll reads it again. So the index never has a hole.
- A log outside the span asked for, from another contract, or with a malformed field fails the read rather than being stored (`normalizeLog`).

## What it answers

`GET /events` returns the logs in chain order, shaped as `eth_getLogs` returns them. Each carries `blockTimestamp`, and the answer says which blocks it covers:

```json
{ "chainId": 5042002, "fromBlock": 62662196, "toBlock": 70445597, "toBlockTime": 1793671700, "logs": [ ... ], "next": null }
```

Optional filters, all checked before use (`parseQuery`):

| Parameter | Meaning |
|---|---|
| `address` | one or more of the indexed contracts, comma separated |
| `topic0` | up to 20 event topics, comma separated |
| `topic1` | one 32-byte value, such as an agent's didHash |
| `fromBlock` | leave out older blocks |
| `limit` | at most this many logs, from 1 to 5,000 (the default) |
| `after` | the `next` cursor of an earlier answer: the logs after it |

One answer holds at most 5,000 logs and 4 MiB of them as JSON, though always one log when one matches (`PAGE_ROWS`, `PAGE_BYTES` in `oracle/event-index.js`). A longer history ends with `next`, a cursor naming its last log's block and log index; a reader asks again with `after` set to it until `next` is null. `toBlock` says the history is whole only on the answer whose `next` is null: a reader that stops at an earlier page and reads the chain from its `toBlock` misses logs. The whole testnet history, about 750 logs and 400 KB on 4 November 2026, fits in one answer, so `next` is null today. A reader takes the blocks after the last answer's `toBlock` from the chain itself, which is what the pages do (`indexLogs` in `site/assets/explorer.js`, which follows `next` for up to 20 answers). A page that gets a `toBlock` more than 100 blocks past the chain's newest does not use the answer.

A request never reaches the RPC. The index answers from memory, so traffic to the pages cannot spend the provider's credits. Each query's answer is encoded once and kept until the index moves on (`eventsAnswer`), so many requests for the same query share one copy. At most 64 answers and 32 MiB of them are kept, the oldest dropped first, so many different queries cannot make the cache grow without bound.

What is not bounded:

- **The index itself is bounded by `INDEX_MAX_LOGS`, not by the chain.** It is held in memory, about 1.1 KB a log on the heap, and anyone can add logs by calling an indexed contract. At the limit (100,000 by default, which fits the VPS container's `mem_limit` of 256 MB) the index stops reading on, keeps answering with what it has, and `/health` answers 503 with `full: true`. Pages read the blocks after the index from the chain, so they slow down rather than stop. To carry on, raise `INDEX_MAX_LOGS` and `mem_limit` together, by about 2 MB per thousand logs, and restart. A real indexer under a 300,000-log burst, with its cache full, stopped at 95,900 logs and peaked at 221 MiB, and restarted there without trouble. `scripts/check-live.mjs` fails from 80% full. Eighteen agents wrote 119 logs in the day measured on 5 November 2026, so a hundred agents would reach the limit in about five months, and an index meant for many more should not hold everything in memory.
- **The work for a filter few logs match.** An answer starts at its cursor or `fromBlock` by binary search and stops when the page is full, but a filter that matches few logs reads forward until it finds them. Distinct cursors are distinct cache entries, so they miss the cache.
- **Answers still being sent.** The cache holds at most 32 MiB, and an answer dropped from it stays in memory until a slow reader has it, or until the kernel's socket buffers do. Measured with 30 readers that asked for a page each and never read: no more than 7 MiB on top of the cache.
- **Request rates.** The live Caddyfile passes only `GET`, `HEAD` and `OPTIONS` on the two paths (`docs/operations-runbook.md`), but sets no request rate or connection limit; Caddy needs a plugin for one. The example below is the plain `reverse_proxy`. The index limits one thing itself: 120 new answers a minute per client (`TRUSTED_PROXIES` names the proxy, or all clients share that), since building an answer is what costs. Many clients at once are not limited.

All of these are fine for the testnet history, and are to be settled before the index serves a much larger one.

`GET /health` answers 200 while the index has polled in the last few minutes and is at most 3,600 blocks (about half an hour) behind the finalized head, and 503 otherwise. It also answers 503 once the index is full. It reports `toBlock`, `head`, `behind`, the number of logs, `maxLogs`, `full`, the last error with any URL removed, and the commit it runs.

## When it does not answer

The pages fall back to what they did before:

- **Agents, operators, slashes and an agent's timeline** read the Arc explorer, plus the chain after the explorer's index, and say so on the page.
- **The epochs page's last day** reads the chain.
- **The operators' last proposals** read the last 100,000 blocks from the chain.

`scripts/check-live.mjs services`, run on a schedule by `.github/workflows/live-checks.yml`, fails when `/health` does, and when the certificate for index.sigvara.xyz is near expiry.

## Running it

The live one runs on `archipelago-standby` since 3 November 2026; where everything is, and what to
do when its `/health` fails, is [operations-runbook.md, section 4](operations-runbook.md#4-event-index).
To run one, on a host with a TLS proxy, in `/docker/sigvara-index`:

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
