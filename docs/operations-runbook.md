# Operations runbook

For the two oracle operators on the Arc testnet: keeping and restoring state, payer-signed
outcomes that are slow to reach the other operator, and the two operators disagreeing. A stolen
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

Each runs the commit named by `SIGVARA_COMMIT` in its `.env`, and `/health` reports it as
`commit`. The commands below are written for the primary; on the checker use its column. The
`jq` ones need `command -v jq >/dev/null || apt-get install -y jq` first.

## 1. State backup and restore

### What the state file holds

`/data/oracle-state.json` on the state volume, with `oracle-state.json.bak` beside it, which is
the save before. It holds every credited payment with its outcome, including each payer-signed
outcome and when this oracle took it (`acceptedAt`); the settlements already credited; flags,
links and attestation cooldowns; the registry and payment scan checkpoints; and on the checker,
its divergence records. The full list is in
[oracle/README.md, State Persistence](../oracle/README.md#state-persistence).

What a restore from an older copy loses, and what comes back:

- **Payments come back from the chain.** The payment scan, on for both operators, credits again
  everything paid after the checkpoint in the restored file, without an outcome.
- **Payer-signed outcomes the other operator holds come back** by the import at the next epoch,
  except any whose deadline passed more than `PAYER_OUTCOMES_IMPORT_GRACE_HOURS` (6) before it
  runs (section 2).
- **The rest is on chain nowhere**: a token holder's outcomes, payer-signed outcomes the other
  operator does not hold, flags and resolves, links, cooldowns and divergence records. Only what
  someone sends again comes back.

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
equal to their source. The log is `/var/log/sigvara-state-backup.log`; neither host sends mail, so
read it, or check that a copy for each day exists on the receiving host.

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
read only for outcomes this operator does not hold.

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
