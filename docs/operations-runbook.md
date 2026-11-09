# Operations runbook

For the two oracle operators on the Arc testnet: keeping and restoring state, payer-signed
outcomes that are slow to reach the other operator, the two operators disagreeing, the event
index the explorer pages read (section 4), the ERC-8004 publisher (section 5), payment
chains (section 6), and the slash keeper (section 7). A stolen
key is [incident-operator-key.md](incident-operator-key.md); bringing up an operator is
[oracle/RUNBOOK-second-operator.md](../oracle/RUNBOOK-second-operator.md).

| | Primary | Checker |
|---|---|---|
| Public URL | `https://oracle.sigvara.xyz` | `https://checker.sigvara.xyz` |
| Host and directory | `archipelago-standby`, `/docker/sigvara-oracle` | `packrai-vps`, `/docker/sigvara-checker` |
| Compose | `docker compose -p sigvara-oracle` | `docker compose -p sigvara-checker -f docker-compose.checker.vps.yml` |
| Container | `sigvara-oracle` | `sigvara-checker` |
| State volume | `sigvara-oracle_oracle_state` | `sigvara-checker_checker_state` |
| Local port, for `/metrics` | `127.0.0.1:3030` | `127.0.0.1:3031` |

**What runs what, as of 7 November 2026.** Each public `/health` names its own commit, and that is the
one to trust when this table has gone stale.

| Service | Host | Commit | Since (UTC) |
|---|---|---|---|
| Primary oracle | `archipelago-standby` | `e3addfa` | 7 November, 03:25 |
| Checker | `packrai-vps` | `e3addfa` | 7 November, 03:24 |
| Event index | `archipelago-standby` | `b95f0aa` | 5 November, 13:31 |
| Watcher | a third host | `aa34cee` | 6 November, 08:37 |
| Policy signer | `packrai-vps` | `b95f0aa` | 5 November, 13:33 |
| ERC-8004 publisher | `archipelago-standby` | `e39ff5b` | 5 November, 11:08 |
| Slash keepers | `archipelago-standby`, `packrai-vps` | `d26ebc1` | 5 November, 15:25 and 15:26 |

Open items are listed in the [launch checklist](launch-checklist.md#where-this-stands).

Each runs the commit named by `SIGVARA_COMMIT` in its `.env`, and `/health` reports it as
`commit`. The commands below are written for the primary; on the checker use its column. The
`jq` ones need `command -v jq >/dev/null || apt-get install -y jq` first.

**Gas.** `scripts/check-live.mjs services` fails when a wallet under `wallets` in
`deployments/5042002.json` falls below its floor. Send it testnet USDC. On 4 November 2026 the primary
sent about 140 transactions a day, about 0.55 USDC, so its floor of 10 is about 18 days. The checker
usually sends none, and its floor of 1 covers proposing for every agent several times if it has to.
Each slash keeper's floor of 1 covers about 260 executions at 25 gwei.

## 1. State backup and restore

### What the state file holds

`/data/oracle-state.json` on the state volume, with `oracle-state.json.bak` beside it, which is
the save before. It holds every credited payment with its outcome, including each payer-signed
outcome and when this oracle took it (`acceptedAt`); the settlements already credited; flags,
links and attestation cooldowns; the registry, payment and ERC-8004 link scan checkpoints; and on the checker,
its divergence records. The full list is in
[oracle/README.md, State Persistence](../oracle/README.md#state-persistence).

What a restore from an older copy loses, and what comes back:

- **Payments come back from the chain.** The payment scan, on for both operators, credits again
  everything paid after the checkpoint in the restored file, without an outcome.
- **Payer-signed outcomes the other operator holds come back** by the import at the next epoch,
  except any whose deadline passed more than `PAYER_OUTCOMES_IMPORT_GRACE_HOURS` (6) before it
  runs (section 2).
- **The rest is on chain nowhere**: a token holder's outcomes, payer-signed outcomes the other
  operator does not hold, flags and resolves, links made with `POST /link`, cooldowns and
  divergence records. Only what someone sends again comes back. Links made on chain come back
  by the link scan, which a restored file resumes from its own checkpoint.

The provider's weekly disk backups are whole-machine, old, and in the same account as the
server, so they are not a substitute.

### Nightly copy, off the box

On each host, as `/root/backup-oracle-state.sh` run from root's crontab
(`30 3 * * * /root/backup-oracle-state.sh`), into a directory only root can read. Replace the two
placeholders. The private half of the `age` key must not be on either box.

```sh
#!/bin/sh
set -eu
umask 077
vol=sigvara-oracle_oracle_state      # on the checker: sigvara-checker_checker_state
out=/root/oracle-state-backups; mkdir -p "$out"
f=state-$(date +%F).tgz
docker run --rm -v "$vol":/data:ro -v "$out":/out alpine tar czf "/out/$f" -C /data .
age -r <recipient-public-key> -o "$out/$f.age" "$out/$f"
scp "$out/$f.age" <backup-host>:oracle-state/
find "$out" -name 'state-*' -mtime +14 -delete
```

It runs while the oracle does. Every save writes a temporary file and renames it into place, so
each file in the copy is one whole save. The copy holds both the state file and its `.bak`.

**Running on both operators since 1 November 2026.** Each host keeps its copies for 14 days in
`/root/oracle-state-backups`, encrypts each to the operators' `age` key and pushes it with `rsync`
to the other operator's host, into `/srv/offsite-backups/sigvara-oracle` or `sigvara-checker`.
There a key that can only write (`rrsync -wo`), from that one address, receives it, and a cron
deletes copies older than 90 days. The `age` private key is held by the project's owner, on
neither host. On 1 November both off-box copies were fetched, decrypted and found byte for byte
equal to their source. The log is `/var/log/sigvara-state-backup.log`. Neither host sends mail, so
the receiving side is checked from a third host that does: every day at 05:00 UTC it asks each
receiver, with a key that can run nothing there but a script printing the newest copy's time in each
folder, and mails the project's owner when a folder is missing, its newest copy is 25 hours old or
more, or a receiver cannot be asked (since 1 November 2026). That catches a backup that failed on
its own host as well as a push that never arrived.

### Restoring a live operator

Restore when the oracle stops at startup saying the state file `cannot be used` and to `Restore
it from a backup`, or when the volume was lost (`stateSource: "fresh"` on `/health` after a start
nobody meant as a rescan). `stateSource: "backup"` needs no restore: the `.bak` it loaded is one
save old, newer than any nightly copy.

1. **Stop it.** The oracle keeps its state in memory and rewrites the file at every save, so a
   file put in place while it runs is overwritten.
   ```bash
   cd /docker/sigvara-oracle && docker compose -p sigvara-oracle stop
   ```
2. **Keep what is there.**
   ```bash
   docker run --rm -v sigvara-oracle_oracle_state:/data:ro -v /root/oracle-state-backups:/out alpine \
     tar czf /out/pre-restore-$(date +%F-%H%M).tgz -C /data .
   ```
3. **Put the file and its `.bak` back together.** Use the newest nightly copy: the `.tgz` in
   `/root/oracle-state-backups` if the box survived, otherwise the off-box `.age`, decrypted where
   its key is (`age -d -i <identity-file> -o state-<date>.tgz state-<date>.tgz.age`) and copied
   into that directory.
   ```bash
   docker run --rm -v sigvara-oracle_oracle_state:/data -v /root/oracle-state-backups:/in alpine \
     sh -c 'rm -f /data/oracle-state.json /data/oracle-state.json.bak && tar xzf /in/state-<date>.tgz -C /data && ls -l /data'
   ```
   The VPS compose files run the oracle as root. An image built from `oracle/Dockerfile` runs as
   the unprivileged user and needs `chown -R 1000:1000 /data` after this.
4. **Start it.** It runs an epoch at once: the import from the other operator, the payment scan
   from the restored checkpoint, scoring, then a save.
   ```bash
   docker compose -p sigvara-oracle up -d
   docker logs --since 15m sigvara-oracle 2>&1 | grep -E 'state loaded|RECOVERED|payer outcomes from'
   ```
5. **Read `/health` on both.** `stateSource` must be `file` and `statePersisted` `true`, with
   `lastPersistMs` set (it is `null` until the first save after a start). Until this operator's
   `paymentScanBlock` is close to the other's, it scores from fewer payments, and a divergence
   the checker records in that time may be only this gap: triage it (section 3) before anyone
   rejects a proposal over it.
   ```bash
   for U in https://oracle.sigvara.xyz https://checker.sigvara.xyz; do
     curl -s $U/health | jq -c '{commit, stateSource, statePersisted, lastPersistMs, paymentScanBlock}'
   done
   ```
6. **Compare evidence with the other operator** once both have run an epoch since the start:
   ```bash
   for DID in $(docker exec sigvara-oracle node -e 'console.log(Object.keys(require("/data/oracle-state.json").paymentEvents).join("\n"))'); do
     for U in https://oracle.sigvara.xyz https://checker.sigvara.xyz; do
       printf '%s %-30s ' "${DID:0:10}" "$U"; curl -sf "$U/evidence/$DID" | jq -r '"\(.count)\t\(.evidenceRoot)"'
     done
   done
   ```
   The same count and root mean the same evidence. Where they differ, diff the two txHash lists
   as step 3 of [RUNBOOK-second-operator.md section 9](../oracle/RUNBOOK-second-operator.md#9-when-a-divergence-fires)
   does. The difference to expect is a token holder's outcome given after the copy was taken:
   the other operator shows `success` true or false where this one shows `null`. Post those
   again as [step 7a](../oracle/RUNBOOK-second-operator.md#7a-seed-the-state-before-the-first-epoch)
   does (port 3030 on the primary), and apply again any flag, resolve or link made since the
   copy, from your own record. Then run `node scripts/check-live.mjs outcomes` (section 2).

### Restore drill, once a quarter

On a spare machine, never on a live box. In an empty directory holding the decrypted copy, the
operator's compose file saved as `docker-compose.yml`, and a `.env` written for the drill: the
operator's settings with a new key that holds no funds and no role, and new tokens. Do not copy
the live `.env`; it holds the signing key and the write tokens.

```bash
docker volume create restore-drill_oracle_state
docker run --rm -v restore-drill_oracle_state:/data -v "$PWD":/in alpine tar xzf /in/state-<date>.tgz -C /data
docker network create sigvara-web
docker compose -p restore-drill up -d
docker logs sigvara-oracle 2>&1 | grep 'state loaded'
curl -s 127.0.0.1:3030/health
docker compose -p restore-drill down -v
```

Compose warns that the volume already exists and was not created by it; that is expected. The
drill passes when the `state loaded` line shows the counts you expect, and `/health` says
`stateSource` `file` and `statePersisted` `true` with `lastPersistMs` set. For the checker's copy
use its compose file with `-f`, the volume `restore-drill_checker_state` and port 3031. Write the
date of each successful drill here.

Last restore drill: 1 November 2026, the primary's copy. Its off-box copy (taken 19:34 UTC) was
fetched from the checker's host, decrypted on a machine that is neither operator, and run there at
commit `184bc16` with a new key and new tokens. `state loaded` showed the expected state,
`/health` said `stateSource` `file` and `statePersisted` `true`, and the agent's first 10
evidence leaves were identical to the live primary's. An 11th payment, made after the copy, came
back through the payment scan without its payer-signed outcome, as section 1 says it would. The
checker's copy the same day, at commit `ee0d989`: the same checks passed, and because the primary
held that outcome, the restored checker imported it at start and its evidence root equalled the
live checker's.

## 2. Payer-outcome import lag

### How the import runs

Each operator names the other in `PAYER_OUTCOMES_PEERS`. At the start of every epoch (hourly on
both, and once at startup), before the registry read and scoring, it reads the peer's
`GET /outcomes?since=<cursor>` page by page and puts each outcome it does not hold through the
checks of a `POST /attest`, at the block the peer recorded (`checkedAtBlock`). An epoch that
aborts at its start (a wrong chain, a clock skew) imports nothing. See
[oracle/README.md, `GET /outcomes`](../oracle/README.md#get-outcomessincems) for the checks.

Per peer per run the import stops at the first of these and carries on from there at the next
epoch. They are constants in `oracle/index.js`, not settings.

| Limit | Value | Constant |
|---|---|---|
| Outcomes checked (one already held does not count) | 200 | `IMPORT_CHECKS_PER_RUN` |
| Pages of up to 500 (not logged when reached) | 20 | `IMPORT_PAGES_PER_RUN` |
| Time | 60 seconds | `IMPORT_MS_PER_RUN` |

The cursor is kept in memory. A restart reads each peer from the start again, which costs a chain
read only for outcomes this operator does not hold. The cursor is the peer's `acceptedAt`; an item
more than five minutes ahead of this host's clock is refused (`accepted_in_future`) without moving it.

**Stalls.** An outcome that cannot be checked for a reason that is not its own (`rpc_error`,
`unknown_agent`, `unconfirmed`, `not_found`, `not_yet_confirmed`) stops that peer's import for
the run. On the third run in a row (`IMPORT_MAX_STALLS`) it is passed over and counted as
refused, and it is tried again only after a restart.

**Grace.** An import must reach this operator within `PAYER_OUTCOMES_IMPORT_GRACE_HOURS`
(default 6) of the outcome's `deadline`, measured at this node's confirmed head. Later than that
it is refused with `outcome_window`, and it stays refused: a restart reads it again and reaches
the same answer, since the head only moves forward. The payer sets the deadline, at most 30 days
after `signedAt`.

### What it shows

Once per peer per epoch, in `docker logs sigvara-oracle`:

```
[oracle] payer outcomes from https://checker.sigvara.xyz: 0 imported, 0 refused
[oracle] payer outcomes from https://checker.sigvara.xyz: 0 imported, 0 refused, stopped early (rpc_error)
```

`stopped early` names `budget` (200 checked), `time` (60 seconds) or the code of an outcome that
stalled. The other lines, each after `[oracle] `:

| Line | Meaning |
|---|---|
| `payer outcome import from <peer> failed after <n> imported: <reason>` | The peer could not be read: down, a timeout, or `GET /outcomes returned 404` when it no longer publishes |
| `payer outcome import: refused <txHash> from <peer>: <code>` | The outcome failed a check here |
| `payer outcome import: passing over <txHash> from <peer> after 3 runs (<code>)` | A stall, given up until a restart. A `refused` line follows |
| `payer outcome import: <peer> served an unusable item: <reason>` | An item not shaped as an outcome |

The counters are on `/metrics`, which the proxy does not publish:
`curl -s 127.0.0.1:3030/metrics | grep payer_outcome`. They count since the process started.

| Series | Counts |
|---|---|
| `sigvara_oracle_payer_outcomes_imported_total` | Outcomes imported |
| `sigvara_oracle_payer_outcome_import_refused_total` | Outcomes refused, unusable or passed over |
| `sigvara_oracle_payer_outcome_import_errors_total` | Runs stopped by a stall, and peers that could not be read |
| `sigvara_oracle_payer_outcome_conflicts_total` | Outcomes that differ from the one held (section 3) |

### Measuring lag

`node scripts/check-live.mjs outcomes`, from any checkout, reads every page of both operators'
`/outcomes` and matches outcomes by didHash, txHash and payer. Each operator's `acceptedAt` is
its own time of taking an outcome. For one both hold, the gap between the two is how long it
took to cross; for one held by one side only, its age is how long the other has had to import
it. The check lists a one-sided outcome as in flight while it is younger than
`OUTCOMES_LAG_HOURS` (default 2) and fails after that, and fails at once when the two hold
different values. Its summary line gives the widest gap. The Live checks workflow does not run
it: run it after a restore, after either operator was down, and when the lines or counters above
look wrong.

**Normal.** An outcome one operator takes reaches the other at its next epoch, so within about an
hour. On 1 November 2026 the checker took the first two outcomes 51 and 4 minutes after the
primary. With nothing new posted, each epoch logs `0 imported, 0 refused`.

**Not normal.** An outcome on one side only for more than two hours. `stopped early` or `failed`
on several epochs in a row. The refused or conflicts counter climbing.

### What to do

- **The peer cannot be read** (`failed after`). Get its operator to bring it back. Once it
  answers, the next epoch carries on from where the import stopped. Every outcome whose deadline
  is more than 6 hours past by then is refused here for good, so this is urgent when deadlines
  are short. Before its deadline, anyone holding an outcome's signed payload can post it to this
  operator's `POST /attest`, which needs no token for it.
- **This node stalls** (`stopped early` with `rpc_error`, `unconfirmed`, `not_found`,
  `not_yet_confirmed` or `unknown_agent`). This operator's RPC is failing or behind the peer's;
  look there first. `not_found` for an older payment can also mean the RPC has pruned the receipt
  (about 6 days on Circle's Arc endpoint and 13 on QuickNode's, measured 3 October 2026). Such an
  outcome is passed over and cannot be imported through that RPC.
- **A refusal** (`refused <txHash> from <peer>: <code>`). The codes are those of `POST /attest`
  ([oracle/README.md](../oracle/README.md#post-attest-token-required-only-for-a-negative-outcome)),
  plus `bad_checked_block` for a recorded block before the payment. Two are expected between
  honest operators: `outcome_window` past the grace, and `outcome_recorded` where this operator
  holds a token holder's outcome that the payer's can no longer replace (outside
  `PAYER_OUTCOME_WINDOW_DAYS` at this node's head, or a transaction with several paying legs).
  For any other code, compare the two operators' `commit` and their `PAYER_OUTCOMES*` and
  `PAYMENT_*` settings (`negative_not_accepted` means the peer takes "not delivered" and this
  one does not), then read the payment on chain with `cast tx <txHash>`.
- **An outcome stuck past the grace.** Once it is refused with `outcome_window`, the two
  operators differ on that payment for good: one scores the payer's outcome, the other the
  payment without it, or with a token holder's. Nothing in the code reopens it, and
  `check-live.mjs outcomes` keeps listing it. Their evidence roots for that agent now differ, so
  note the date, agent and txHash in [divergence-log.md](divergence-log.md), where a later
  divergence on that agent will be triaged.

## 3. Peer mismatch

In both kinds below, what an operator holds is final. A payer-signed outcome is final for its
leg: a second signature is refused (`outcome_recorded`), a token holder's outcome never replaces
it, and an import that disagrees with it changes nothing. A token holder's recorded outcome is
final too, except that the payer's own can replace it inside `PAYER_OUTCOME_WINDOW_DAYS` when the
payer's is the transaction's only paying leg. The
checker never overwrites or finalizes a proposal it disputes; only the committee's
`rejectReputation` acts on one. A mismatch is diagnosed and written down. Neither side's records
are rewritten to match the other's.

### Outcome conflict

A peer serves a payer-signed outcome for a leg (didHash, txHash, payer) this operator already
holds, with a different value. The import keeps what it holds, adds one to
`sigvara_oracle_payer_outcome_conflicts_total` and logs:

```
[oracle] a peer serves outcome 2 for <txHash> from <payer>; this oracle holds 1
```

The line does not name the peer; with one peer listed, it is the other operator. It is counted
before anything is checked, so it climbs whether the payer signed two outcomes or the peer
serves one nobody signed, and it is counted once each time the oracle starts, since the cursor
moves past it. To check:

1. `node scripts/check-live.mjs outcomes` lists the leg with both values.
2. Take each operator's payload for the leg from its `/outcomes` and verify the signature at its
   `checkedAtBlock` with `verifyPaymentOutcome` from `@sigvara/protocol-sdk`.
3. Both valid: the payer signed two outcomes and gave one to each operator. Each keeps its own;
   settling it is the dispute bridge's job, which is not built
   ([ADR 0006](adr/0006-payer-signed-outcomes.md), section 6). One invalid: that operator holds an
   outcome its own checks would have refused. Treat it as a finding against that operator, and
   start from its `commit` and who can reach its state volume.

Write the verdict in [divergence-log.md](divergence-log.md).

### Evidence or score disagreement

The checker re-scores each pending proposal and records a divergence when the total, or any one
factor, differs from the proposal's by more than `DIVERGENCE_TOLERANCE` (3 points). It is served
at `GET /divergence`, the watcher alerts on it while the proposal can still be rejected, and
`check-live.mjs services` fails on it in that time. Triage it with
[RUNBOOK-second-operator.md section 9](../oracle/RUNBOOK-second-operator.md#9-when-a-divergence-fires):
the commits, the record, whether the proposal is still live, then the evidence diff that decides
it. An outcome one operator holds and the other refused or has not imported yet (section 2), or
a restore (section 1), shows there as different evidence roots. Write every verdict in
[divergence-log.md](divergence-log.md).

### ERC-8004 links made on chain

With `EXTERNAL_LINK_FROM_BLOCK` set, each epoch scans the ERC-8004 registry for agents that linked
themselves (the `sigvara` metadata key). The two operators agree on a link only once both have
scanned past the day's snapshot block, so a scan that falls behind costs scoring, on purpose:

- **The scan stopped before the snapshot.** The agents named by logs it has not checked yet are
  skipped, and the log says `skipping the N agent(s) its unchecked logs name`. The rest are scored.
  The scan resumes at the log it stopped on.
- **The logs cannot even be listed, or the registry's chain cannot be read.** Nothing is scored,
  and the epoch counts as failed (`sigvara_oracle_epochs_total{status="failed"}`). While that
  lasts, the checker audits nothing either. With the setting unset, the same outage only sets the
  external factor to 0.

The scan's position is `linkScanState.cursor` in the state file, and should be the same on both
operators after an epoch each. Two cases score in a way that looks wrong but is the same on both:
an agent registered after the day's snapshot has no operator at that block, so its external factor
is 0 until the next day; and an operator that makes more than 64 claims for one agent within a day
can push out the one that applied at the snapshot on the operator that has scanned further, which
then disagrees about that agent only.

## 4. Event index

The explorer pages on sigvara.xyz read the contracts' history from the event index
([event-index.md](event-index.md)): every log of identity, reputation, staking and the oracle bond,
read through Alchemy's Arc testnet RPC and served at `https://index.sigvara.xyz`. It holds no key
that signs. If it stops, the pages fall back to the Arc explorer and say so, which is slower and
limited to ten history requests an hour per visitor.

| | |
|---|---|
| Public URL | `https://index.sigvara.xyz` (`/events`, `/health`) |
| Host and directory | `archipelago-standby`, `/docker/sigvara-index` |
| Files there | `docker-compose.yml` (the repository's `docker-compose.indexer.vps.yml`, unchanged), `docker-compose.override.yml` (joins the `sigvara-web` network), `.env` (`SIGVARA_COMMIT` and `TRUSTED_PROXIES`, the `sigvara-web` subnet), `rpc_url` (the RPC URL with its key, root, mode 600) |
| Container | `sigvara-index`, listening on `127.0.0.1:3040` |
| State volume | `sigvara-index_index_data` (the index; a restart resumes from it) |
| Proxy | the `index.sigvara.xyz` block in `/opt/countersig/Caddyfile`, which passes only `GET`, `HEAD` and `OPTIONS` on `/events` and `/health` to `sigvara-index:3040` |
| DNS | `index` A record to the host's address, in the sigvara.xyz zone |
| Watched by | `scripts/check-live.mjs services` (its `/health` and certificate), on the live-checks schedule |

**Checking it.** `curl -s https://index.sigvara.xyz/health` reports `ok`, `toBlock`, `behind` (20 in
steady state: it stays that far behind the finalized head), `logs`, `maxLogs`, `full`, `lastError`
with any URL removed, and `commit`. On the box, `docker logs sigvara-index` shows `[deploy] running <commit>` and
`[indexer] caught up`.

**Redeploying.** Copy `docker-compose.indexer.vps.yml` from the commit being deployed over
`docker-compose.yml`, checking its sha256 against git; leave the override in place. Set
`SIGVARA_COMMIT` in `.env` to that commit and run `docker compose up -d`. A plain restart does not
read `.env` again. Keep `TRUSTED_PROXIES` in `.env` at the `sigvara-web` subnet: without it, every
visitor behind the proxy shares one limit on new `/events` answers.

**When `/health` fails.**
- A `lastError` from the RPC that says the request was refused or unauthorised means the Alchemy
  key has been revoked or the app has run out of credits.
  - Put a working URL in `rpc_url` and run `docker compose up -d --force-recreate`.
  - Any provider for chain 5042002 works. On Arc's public RPC, also set `INDEX_BATCH=1`, since it
    refuses a batch of four.
- `full: true` means it holds `INDEX_MAX_LOGS` logs and has stopped reading on. It keeps answering
  with what it has, and the pages read the rest from the chain, more slowly. Raise `INDEX_MAX_LOGS`
  and `mem_limit` together, by about 2 MB per thousand logs, and restart ([event-index.md](event-index.md)).
  `check-live` fails from 80% full, so this should not come as a surprise.
- `behind` growing with no error means the poll is slow or the RPC is lagging. Read the log.
- A container that restarts in a loop: read `docker logs`. The launcher refuses a `SIGVARA_COMMIT`
  that is not 40 hex characters, and a commit it cannot fetch.

**When the Arc explorer recovers.** The pages' fallback still treats the Arc explorer's index as
stopped at block 70,337,205 (`INDEX_STALLED_AT` in `site/assets/explorer.js`). Once its v2 API
shows the identity contract's `AgentRegistered` logs in blocks 70,385,000 to 70,388,999, that line
can go, and the fallback goes back to reading only the newest blocks from the chain.

## 5. ERC-8004 publisher

`oracle/publisher.js` posts the spendable score of each agent linked on chain to the ERC-8004
Reputation Registry, tagged `sigvara` / `score`, from the address named as the `agentWallet` of
Sigvara's own registration (agent 897764). The design and David's decisions are in
[ADR 0008](adr/0008-sigvara-as-erc8004-signal-provider.md).

| | |
|---|---|
| Where | The primary's host, `/docker/sigvara-publisher`, from `docker-compose.publisher.vps.yml` and `oracle/.env.publisher.example`. One copy only, never on the checker. |
| Container | `sigvara-publisher` |
| State volume | `sigvara-publisher_publisher_state` (`/data/publisher-state.json`: the score-event and link scan positions, what is pending, and what was posted to which 8004 agent). The positions can be rebuilt from the chain; the record of where each score went cannot, and without it a score left on an 8004 agent that is no longer linked is not revoked. Back it up with the oracle state (section 1). |
| Key | None on this host. In live mode the policy signer (`oracle/signer.js`) on `packrai-vps` signs at `PUBLISH_SIGNER_URL`. On testnet its key is an encrypted keystore there (David, 3 November 2026); mainnet needs a KMS or HSM behind it |

**Shadow mode** (`PUBLISH_MODE=shadow`, the default) reads everything and sends nothing. Each run
logs `[publisher] run: N planned, 0 sent, M skipped (reason: count, ...)`, and each post it would
make as `shadow: agent <id> ← <score>`. Until an agent is linked on chain, every scored agent is
skipped as `not linked on chain`. It also says what would stop live mode, which until the steps
below are done is `the registration's agentWallet is 0x18CB...4811, not the publisher`.

**Going live**, in this order. Each step is David's go.

1. Set up the signer on `packrai-vps`, in `/docker/sigvara-signer`, from
   `docker-compose.signer.vps.yml` and `oracle/.env.signer.example`:
   - Make `secrets/` with `umask 077`, owned by uid 10001 (the user the signer runs as; no account
     on the host has it, where uid 1000 is `ubuntu`) with mode 0700, and in it `password` and
     `hmac-secret` (each `openssl rand -hex 32`), owned by uid 10001 with mode 0400. The signer
     refuses a secret anyone else can read.
   - Write `keystore.json` once with
     `docker compose run --rm -e SIGNER_ARGS="new-keystore /secrets-rw/keystore.json" -v "$PWD/secrets:/secrets-rw" signer`.
     It prints only the new address, writes the file 0400, and refuses to overwrite one.
   - Reach it only through SSH. The signer listens on `127.0.0.1:28600` and answers only `127.0.0.1` (`SIGNER_HOST`, `SIGNER_ALLOW_FROM`), so it opens no port of its own: the publisher's `signer-tunnel` service forwards to it over SSH, encrypted and to a pinned host key. On `packrai-vps`, make a user with no shell (`useradd --system --create-home --shell /usr/sbin/nologin sigvara-tunnel`) whose `~/.ssh/authorized_keys` (owned by root, mode 0644, so the account cannot change it) holds the publisher's tunnel key, usable only from the publisher's host and only for that forward:
     `from="72.62.41.138",restrict,port-forwarding,permitopen="127.0.0.1:28600",command="/bin/false" ssh-ed25519 AAAA... sigvara-publisher-tunnel`. Those options alone re-enable remote forwarding (`-R`), which would let the key listen on the host's loopback ports, so also append `oracle/sshd_config.signer-tunnel` to the end of `/etc/ssh/sshd_config`, check it as that file says, and confirm a `-R` from the key is refused. On the publisher's host, `secrets/tunnel/` (owned by root, 0700) holds `id_ed25519` (`ssh-keygen -t ed25519 -N '' -C sigvara-publisher-tunnel -f secrets/tunnel/id_ed25519`, 0400) and `known_hosts`, one line `76.13.101.31 ssh-ed25519 AAAA...` built from `/etc/ssh/ssh_host_ed25519_key.pub` on `packrai-vps` (a new host key there stops the tunnel until this is updated). No firewall rule for 28600 is needed, in ufw or in the provider's firewall (Hostinger's VPS firewall, hPanel, Security, Firewall): remove any (`ufw delete allow from 72.62.41.138 to any port 28600 proto tcp`, and the hPanel rule) once the tunnel works.
   - Start it, and check its log names that address and `127.0.0.1` as the only caller. It
     signs nothing in its first two minutes.
   - On the publisher's host, set `PUBLISHER_ADDRESS` to that address, `SIGNER_SSH` to
     `sigvara-tunnel@76.13.101.31` (the compose file points `PUBLISH_SIGNER_URL` at the tunnel), and `PUBLISH_SIGNER_SECRET` to the same secret. Keep
     `PUBLISH_MODE=shadow` until step 3.
   - Fund the address with testnet USDC above `PUBLISH_MIN_BALANCE`.

   The signer signs only:
   - `giveFeedback` on the ERC-8004 Reputation Registry, tagged `sigvara`/`score`, 0 to 100, with
     a `data:` URI holding JSON;
   - `revokeFeedback` on the same registry;
   - the `AgentWalletSet` message for agent 897764, naming itself, for the registration's owner,
     due within five minutes of the chain's clock.

   Each transaction must be type 2 with no value, at the publisher's next nonce as the chain has
   it, under the gas and fee caps, and it signs at most `SIGNER_MAX_PER_HOUR` an hour, counted
   across restarts. A compromised publisher host can make it post wrong scores at that rate, for as
   long as it is compromised, and nothing else: nothing can be signed ahead and kept for later.

   **If the publisher's host is compromised**, first delete the `sigvara-tunnel` line from that account's `authorized_keys` on `packrai-vps` and run `pkill -u sigvara-tunnel` there, since sshd reads the key only when a connection authenticates and an open tunnel otherwise stays up. That cuts the host off the signer. Then rotate the key, not just the HMAC secret: a new
   keystore, step 2 with the new address, and the old address's posts revoked by hand. Until then,
   the old key keeps posting whatever the host asks, at the capped rate.
2. Make it the registration's `agentWallet`. The publisher key signs the EIP-712 message
   `setAgentWallet` checks, and the registration's owner (the deployer) sends
   `setAgentWallet(897764, publisher, deadline, signature)`. The registry refuses a deadline more
   than five minutes ahead, so the two go in one sitting:
   1. David loads the deployer key into `D:\Sigvara\.env` with his key helper.
   2. `docker exec sigvara-publisher node agent-wallet.js` on the publisher's host, which has the
      settings and the HMAC secret, asks the signer for the signature, checks it, and prints
      `DEADLINE` and `SIGNATURE`, four minutes ahead of the chain's clock.
   3. From `D:\Sigvara`, with those two and `PUBLISHER_ADDRESS` in the environment and the
      project on the same drive: `forge script <project>/script/SetAgentWallet.s.sol:SetAgentWallet
      --root <project> --rpc-url https://rpc.testnet.arc.network --broadcast`. It checks the sender
      owns the registration, and that `getAgentWallet(897764)` is the publisher afterwards.
   4. The key helper's `-Remove`.

   Rehearsed on a fork of Arc testnet on 3 November 2026, with a throwaway key behind a stand-in
   signer: `getAgentWallet(897764)` went from the deployer to the stand-in.
3. One end-to-end cycle: set `PUBLISH_MODE=live` and `PUBLISH_ALLOW_AGENT_IDS` to one test agent
   linked on chain, and `docker compose up -d`. The first run in live mode reads every scored
   agent again. After it, read the result back:
   `cast call 0x8004B663056A597Dffe9eCcC1965A193B7388713 "getSummary(uint256,address[],string,string)(uint64,int128,uint8)" <agent> "[<publisher>]" sigvara score`
   must return a count of 1 and the agent's spendable score. Then change its score, or wait for the
   daily refresh, and check that the old feedback is revoked and the count is still 1.
4. Empty `PUBLISH_ALLOW_AGENT_IDS` and redeploy.

**When it stops posting**, the log says why:
- `posting blocked: ...` is a failed gate: the `agentWallet` changed, the signer is not answering
  or signs as another address, the balance is below the floor, or a transaction of the publisher's
  is still pending. Nothing is sent until it passes, and the agents wait. A pending transaction
  that never settles needs a look by hand: sending around it is how one update becomes two. Find
  its nonce (`cast nonce <publisher> --block pending` against `--block latest`), and once it is
  clearly stuck, have the signer replace it with a zero-value transaction from the publisher to
  itself at that nonce and a higher fee. When it has settled, the next run reads what landed, and
  revokes any duplicate it finds.
- `the link scan has not reached block ...` means the link scan failed this run. It resumes at the
  next.
- `<didHash> not published this run: ...` is one agent's read or transaction failing. It is tried
  again next run. A failed transaction also ends the run, before the next agent's revoke goes out.
  A revoke whose post failed is finished by the retry without a second revoke.

An agent that unlinks has its score revoked on the 8004 agent it was posted to, and after a slash
that 8004 agent is set to 0 whatever the link says by then.

**Rotating the key**: create a new key in the signer, repeat step 2 with it, and set
`PUBLISHER_ADDRESS` to it. Consumers that read `getAgentWallet(897764)` follow at once. The new
address has posted nothing, so the next daily refresh posts every linked agent's score from it. **Rotating the tunnel key**: make a new `secrets/tunnel/id_ed25519` as in step 1, replace the line in the `sigvara-tunnel` account's `authorized_keys`, and `docker compose up -d --force-recreate signer-tunnel`.

**Backing up its state**, before going live: append this to the primary's
`/root/backup-oracle-state.sh` (section 1), after the oracle copy's last line, so a failure here
cannot cost that one. It writes `publisher-<date>.tgz` beside the oracle's copies and pushes it to
the same off-box folder, where the same 90-day cleanup applies.

```sh
pvol=sigvara-publisher_publisher_state
if docker volume inspect "$pvol" >/dev/null 2>&1; then
  p=publisher-$(date -u +%F).tgz
  docker run --rm -v "$pvol":/data:ro -v "$out":/out node:24-alpine tar czf "/out/$p" -C /data .
  tar tzf "$out/$p" | grep -qx './publisher-state.json'
  age -r <recipient-public-key> -o "$out/$p.age" "$out/$p"
  rsync -t -e "ssh <the oracle copy's options>" "$out/$p.age" <backup-host>:/
  rm -f "$out/$p.age"
  find "$out" -name 'publisher-*' -mtime +14 -delete
fi
```

**Where the rollout stands**, on Arc testnet as of 4 November 2026 (each step David's go):

- The backup above is in the primary's script, and a test run passed at 21:14 UTC.
- Step 1: the signer runs on `packrai-vps` from `bef1068`, as `0x787f30E64d212A1d90174A832a79489dca44FE92`,
  funded with 20 testnet USDC. The publisher reached it by 22:07 UTC, once both firewalls allowed the port.
- Step 2: `setAgentWallet(897764)` went out in transaction
  `0xa5364cc4a18474cfade47120813a3c0c2be8cc694fe821ceaeb9e9b88ad22311` (block 70587267), after a simulation
  of the same call with a real signature from the signer. `getAgentWallet(897764)` returns the publisher.
- Step 3, begun: the simulation's solo agent (`0x9d7181C8676fd40E4B31510dC0E573A0C0C2fa11`) registered ERC-8004
  agent 897766 and set its `sigvara` key in its own transaction,
  `0xd0a909563bac76257223209a89a760510f78b64ac8f77707f79b1f036706941d` (block 70588560). Both operators stored
  the claim at their 23:06 UTC epoch. The publisher has run with `PUBLISH_MODE=live` and
  `PUBLISH_ALLOW_AGENT_IDS=897766` since 22:26 UTC, and its first run posted the agent's spendable score of 3 in
  `0xcb1fe00347d1fc852340744d4628e7dff7def6dc7f54d8b478cd209c793f7c0c` (block 70589310). `getSummary` returns a
  count of 1 and 3. The 00:02 UTC refresh on 4 November found it unchanged at 3, and the revoke half came at
  05:15 UTC (below).
- Step 4, ahead of that revoke: David had the allow list emptied at 00:29 UTC on 4 November. The publisher now
  posts for every agent linked on chain, and 897766 is still the only one.
- Since 00:21 UTC on 4 November the publisher runs `bd54f26`, where an agent's first link queues it, if it has had a score event since `PUBLISH_FROM_BLOCK`, so it is posted at the next run unless its 8004 agent was already posted to that day; a link that moves waits for the refresh.
- The tunnel (step 1, as it now reads), on 4 November: the `sigvara-tunnel` account and its sshd block went onto
  `packrai-vps` (David), and from the publisher's host the key opened the forward to 28600 while a forward to
  port 22, a `-R` and a command were all refused. The signer moved to `127.0.0.1` at 01:40 UTC and the publisher
  to the tunnel at 01:42, both on `68fc9ff`; a request through `signer-tunnel:28600` returned the publisher's
  address. David then removed the 28600 rules from ufw and from the hPanel firewall, and the port answers no one.
- On 4 November the publisher, its tunnel and the signer moved to `d7f2215`: the signer at 02:21 UTC, the publisher
  and tunnel at about 02:24. Both Node processes run on 24.22.1, and the tunnel's shell and `ssh` run as uid 10002
  with no capabilities. A request through `signer-tunnel:28600` returned the publisher's address, and the publisher
  kept its state.
- Step 3, finished: the primary's 05:06 UTC epoch on 4 November finalized agent 897766's score, and at 05:15 UTC the
  publisher revoked its first feedback in
  `0xea811f75fca7f6be85beb8ce4fbb6d21494a5d37927ca19a62fbe9e36a5f5a1e` (block 70637306) and posted 4 in
  `0x7039099ea6952df5aeab9feac4383dd134e0e8e3316ae36a16cdefe1cee5268d` (block 70637324). Read back: `getLastIndex`
  is 2, `readFeedback` index 1 is 3 and revoked, index 2 is 4 and live, and `getSummary` returns a count of 1 and 4.

## 6. Payment chains

A payment chain is a chain the oracle only reads payments from ([ADR 0009](adr/0009-payments-on-base.md)).
In `shadow` mode, the default, it scans and reports what it would credit, and credits nothing: no score, proposal
or evidence root changes. A shadow scan runs beside the epoch, and its reads of the scored chain grow with the number of
agents and not of payments, so a hung endpoint or a flood of payments cannot hold up a score.

**Outcomes.** A chain that is `on` also takes payer-signed outcomes for its payments, where `PAYER_OUTCOMES` is on
(ADR 0009, section 7). Each one costs a few reads of that chain's RPC. A smart wallet's outcome is imported by asking
the wallet at the block the other operator recorded, which needs a node that keeps state that far back. Until it
answers, the import tries again at the next epoch, and after three runs it passes the outcome over until a restart.

**Adding one in shadow.** One operator is enough, and the checker is the one to use: nothing needs the two to agree
while a chain counts for nothing, and a bad endpoint then reaches only one of them. Both need the same values before a
chain goes `on`. Elysium testnet's settings, in the checker's `.env`:

```
PAYMENT_CHAIN_IDS=99801
PAYMENT_CHAIN_99801_RPC_URL=https://testnet-rpc.elysium.kinetiq.xyz
PAYMENT_CHAIN_99801_ASSET=0x7D29d8047B905000459c0E80c34a26CeedcB47b2
PAYMENT_CHAIN_99801_FROM_BLOCK=22900000
PAYMENT_CHAIN_99801_FEE_UNIT=100000000
PAYMENT_CHAIN_99801_MIN_AMOUNT=10000
PAYMENT_CHAIN_99801_MODE=shadow
PAYMENT_CHAIN_99801_CHUNK=50000
PAYMENT_CHAIN_99801_MAX_BLOCKS=100000
```

Run `docker compose up -d` with the compose line from the table above; a plain restart does not read `.env`
again. The next epoch scans from `FROM_BLOCK`. The operator must run a commit with payment chains. It also needs
`PAYMENT_VERIFICATION=required`, `PAYMENT_SCAN_ENABLED=1` and `EXPECTED_CHAIN_ID`, or the process refuses to start. Base Sepolia (84532) counts on both operators. It ran in shadow from about 00:40 UTC on 7 November 2026, then went `on` at 01:54:45 UTC on the checker and 01:55:18 UTC on the primary, with asset `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, `FROM_BLOCK=55462500`, `FEE_UNIT=100000000`, `MIN_AMOUNT=10000`, `CHUNK=2000` and the default delay of 3600 seconds, through `base-sepolia-rpc.publicnode.com` on the primary and `base-sepolia.gateway.tenderly.co` on the checker. Each `.env` and state file from just before is kept as `.env.bak-pre-base-on-*` and `/root/oracle-state-backups/{checker,primary}-state-pre-base-on-*.json`.

**Checking it.** `curl -s https://checker.sigvara.xyz/health | jq .paymentChains`. Each chain reports `mode`,
`lastBlock`, `lastBlockTs` and `lastScan`, which holds `from`, `to`, `wouldCredit`, `skipped`, `reasons` and `canary`,
and `readLimited` when a step stopped at `MAX_READS`.
`canary: "unavailable"` is what a shadow scan with nothing to credit reports, because the canary needs a payment
already held on that chain. `/health` moves after each step of at most `MAX_BLOCKS` blocks and `MAX_READS` reads and not
during one, so a step with many payments can look stuck for minutes. Also check that `lastBlockTs` moves between epochs.

**When a scan fails.** The log says `payment chain 99801 scan failed`, and `/metrics` counts it in
`sigvara_oracle_payment_chain_scan_errors_total`. In shadow, scoring carries on, and the next epoch resumes from the
last block saved. With the chain `on`, an operator whose scan has not reached the chain's delay scores nothing that epoch
and finalizes nothing, until the scan catches up: `paymentChainHold` on `/health` says so, and
`sigvara_oracle_epochs_held_by_payment_chain_total` counts it. Both operators reach Base through keyless public
endpoints, so read this first when a score stops moving. A range the node refuses for its size is halved, so a dense range alone should not stop a scan. If
the same `(rpc -32005)` or similar repeats at one block, the node may word its refusal in a way `oracle/log-spans.js`
does not know: add the wording there. Lowering `CHUNK` gets it past the range in the meantime.

**Removing one.** Delete its lines from the `.env` and run `docker compose up -d`. Its cursor stays in the state file
under `99801/shadow`, where only a later scan of that chain reads it.

**Rolling back.** A shadow cursor leaves the state file at format 1, so a build from before payment chains still loads
it. That build drops the cursor. A chain that has been `on` writes format 2, which such a build refuses. Taking a chain
from `on` back to shadow has its own order: stop the checker, put the primary in shadow, wait out the challenge window,
and start the checker in shadow (`oracle/README.md`, "Switching back").

## 7. Slash keeper

`oracle/keeper.js` calls `executeSlash` once a slash's challenge deadline has passed. Execution is
permissionless, so the committee need not act twice, but nothing happens unless someone calls it, and
a fortnight after the deadline anyone may let the slash lapse with `expireSlash`.

| | |
|---|---|
| Where | Two copies, on separate hosts. The primary on `archipelago-standby` and the backup on `packrai-vps`, each in `/docker/sigvara-keeper`, from `docker-compose.keeper.vps.yml` and `oracle/.env.keeper.example` |
| Container | `sigvara-keeper` |
| State volume | `sigvara-keeper_keeper_state` (`/data/keeper-state.json`: the scan position, the slashes open and what has been alerted). It can be rebuilt from the chain, starting at `KEEPER_FROM_BLOCK` |
| Key | Its own on each host, in `.env`, mode 0600. It holds no role and only a little gas: `executeSlash` is open to anyone, so all it can lose is that gas |

**What it does each run.** It reads `SlashInitiated` to learn who to watch, then each proposal, at
chain time. For a Pending proposal past its deadline it simulates `executeSlash` first, so the
contract's own rules decide, then sends.

**What it will not do, on purpose.**

- **Execute past the lapse.** `executeSlash` has no lapse check, so the contract would still allow it
  until someone calls `expireSlash`. A slash that has sat a fortnight is a person's decision, so the
  keeper raises an alert instead. To carry one out, call `executeSlash` by hand.
- **Call `expireSlash` or `expireDispute`.** Each reinstates an agent. It alerts when a dispute needs
  a ruling, when nobody ruled on one, and when a slash has lapsed.
- **Touch an agent on `KEEPER_SKIP_AGENTS`.** Live mode will not start until that is set, even if
  only to `none`.

**Agent C of the slash drill.** The drill leaves C
(`0x30b95fc4473e5ea0f187d4955ab24bcfebd7a739a0a93c1beafd5d6445f1d93a`) to lapse on purpose
([slash-drill.md](slash-drill.md)). Its window opens on 10 November 2026 and it lapses on 24 November.
A keeper without C on its skip list would burn C's 750 SVR and spoil day 21, so keep it listed until
day 21 is done. After that it is not Pending, and the entry does nothing.

**Two copies.** `KEEPER_GRACE_SECONDS` is 0 on the primary and 3600 on the backup, so the primary goes
first and only one pays the gas. If both act, the second simulates, finds nothing Pending and sends
nothing. If its transaction was already in flight, it reverts, and all that costs is gas.

**How it is watched.**

- **From outside, on the outcome.** `scripts/check-live.mjs services`, which the Live checks workflow
  runs on a schedule, fails when a Pending slash is more than six hours past its deadline, unless it
  is on the list of slashes held on purpose. It fails too when a keeper listed under `wallets` in
  `deployments/5042002.json` is under its floor. This shares nothing with the keepers, so it is what
  notices when both are down.
- **From each keeper, by webhook.** `WEBHOOK_URL`, as the watcher uses, hears about every execution,
  a slash that is refused, a send that did not go out or did not confirm, a dispute, a lapse, low gas, half an hour stuck behind
  its own pending transaction, and six failed runs in a row (then the run that ends them).
- **On the host.** `docker ps` shows the container unhealthy when no run has finished
  for an hour.

A stopped keeper is not noticed until a slash falls due. That is the gap this design accepts: with
nothing due nothing is lost, and when one is due the check above fires with most of the fortnight left.

**Reading the log.** Each run logs
`[keeper] run at block N: 1 open, 0 waiting, 1 held, 0 lapsed, 0 disputed, 0 refused, 0 would execute, 0 executed, 0 failed, 0 blocked`.

| What it says | What it means | What to do |
|---|---|---|
| `refused`, `ReporterNotAuthorized` | The reporter has left the committee, so the contract will not execute | A current member can `cancelSlash` it, or it lapses |
| `failed`, `reverted` or `above KEEPER_MAX_FEE_GWEI` | It did not go through | It tries again every run. Raise the limit if gas has moved |
| `failed`, `was sent, with no receipt` | It may still have landed | Look the transaction up. The next run sees what happened |
| `blocked` | A transaction of its own is still pending | Wait. If it stays stuck, look at the nonce |
| `lapsed` | Nobody executed it for a fortnight | Decide: execute by hand, or `expireSlash` |

**Where it stands, on Arc testnet as of 5 November 2026.** Both are live. Neither has sent a transaction,
because no slash has fallen due, and each holds 20 USDC.

| | Primary | Backup |
|---|---|---|
| Host | `archipelago-standby` | `packrai-vps` |
| Address | `0x8e1f90a2a5042652C1B9CAe99Ab3c2e02a30F2E4` | `0x8c85b61Ed08d66FeD2a613bA50D971b4dE6c5619` |
| `KEEPER_GRACE_SECONDS` | 0 | 3600 |
| `RPC_URL` | `https://rpc.quicknode.testnet.arc.io` | `https://rpc.testnet.arc.network` |

Those endpoints differ from each other and from the other services on each host. dRPC's refuses their
10,000-block reads. `WEBHOOK_URL` is the watcher's channel, and a test alert from each arrived.

Not yet shown on the live chain: a real execution, two keepers racing, and C reading `held`, which it
should from 10 November.

**Around a drill.** Agent A of the drill is not on `KEEPER_SKIP_AGENTS`. Day 7 refiles it, so cancel
it before its deadline, as the plan does, or a keeper executes it and burns its bond. Any other slash
meant to be left alone has to be listed on both hosts first. Expect a `dropped` alert for A if a run
lands between the refile and the cancel, and `lapsed` alerts for C from both keepers from
24 November 03:45 UTC, repeating daily until `expireSlash(C)`.

**Before rewiring staking.** Resolve every Pending or Disputed slash proposal before `setStakeView`
repoints the identity registry, or before `STAKING_CORE_ROLE` is revoked from the staking contract. A
dropped proposal reinstates its agent only if that stake view says it is bonded, and every drop and every
execution calls the identity registry with that role. Without the role they revert, and the bond stays
frozen until the wiring is restored.

**Stopping them.** Set `KEEPER_MODE=shadow` in `.env` on each host and run `docker compose up -d`. They
then read and send nothing. `retrying in` in the log is normal: public RPCs refuse a burst of reads, so
the keeper waits 500 ms between log reads and tries a throttled read again.

**Rolling it out again.** Each step is David's go, and each host has to be named.

1. On each host, make `/docker/sigvara-keeper`, and copy the compose file and the example `.env` there.
   Set `SIGVARA_COMMIT`, `KEEPER_NAME` and, on the backup, `KEEPER_GRACE_SECONDS=3600`. Keep
   `KEEPER_MODE=shadow`, and generate `KEEPER_PRIVATE_KEY` with the command in the example, so the
   log names the address to fund. `chmod 600 .env`.
2. `docker compose up -d`, and read the log. It should say `shadow mode`, and each run should hold or
   wait for C and not name it as `would execute`.
3. Add both addresses under `wallets` in `deployments/5042002.json`, each with a `minUsdc` of 1, in a
   PR, and send each a few testnet USDC.
4. Set `KEEPER_MODE=live` on the primary, `docker compose up -d`, and read the log. Then the backup.

**Rehearsing.** Point it at a local fork of Arc, using Anvil's public keys, and move the fork's clock.
Rewind the state file whenever you rewind the fork, or it remembers a slash the fork has forgotten.
