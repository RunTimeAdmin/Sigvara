# Runbook: bringing up a second bonded oracle operator

Stands up a checking operator alongside the primary. Read
"Running a second operator" in [README.md](./README.md) first for why a checker audits
instead of competing; this file is the sequence, not the reasoning.

Nothing here is reversible in under a week: `initiateUnbond` starts a 7-day cooldown.
Read step 8 before you start step 3.

> **On the placeholders below.** `<THING>` marks a value you substitute. In bash the
> angle brackets are redirect operators, so pasting a line with them intact fails with
> `syntax error near unexpected token` before anything runs, including any `export` on
> the same line. For keys, read them into a variable instead of editing them into the
> command, which also keeps them out of your shell history:
>
> ```bash
> read -rs -p "key: " KEY; echo
> cast send ... --private-key "$KEY"
> ```
## Addresses and parameters

Arc testnet, chain ID `5042002`. All read off chain on 20 September 2026.

| | |
|---|---|
| `SigvaraReputation` | `0x6603C96275e85F724Cdf74666b399365e4cA29ed` |
| `SigvaraOracleBond` | `0x3c9c12F27DDCa7048840eE3fbF0CAa1C547D8171` |
| `SigvaraIdentity` | `0x7e3aFC532eE5d922ab3cc3FFb510c7C8151477Dd` |
| SVR token | `0x41De2D6D55318e197a00E8f5B496eA2790e23E6c` |
| `bondAmount()` | 25,000 SVR (`25000e18`) |
| `unbondingPeriod()` | 604800 s (7 days) |
| `challengeWindow()` | 21600 s (6 hours) |
| `activeCount()` before this runbook | 1 (still 1 as of 20 Sep 2026; the primary `0x6352B8FF…` is bonded at exactly 25,000 and Active) |
| `ORACLE_ROLE` | `0x68e79a7bf1e0bc45d0a330c573bc367f9cf464fd326078812f301165fbda4ef1` |
| `DEFAULT_ADMIN_ROLE` | `0x00…00` |

Re-read them before acting rather than trusting this table:

```bash
cast call 0x3c9c12F27DDCa7048840eE3fbF0CAa1C547D8171 "bondAmount()(uint256)" --rpc-url https://rpc.testnet.arc.io
```

## Before you start

- **Separate hardware from the primary.** A checker on the same box shares its failure
  modes with the thing it is checking.
- **A different RPC provider, but only one of them actually works.** Arc testnet has
  four endpoints and they are *not* interchangeable. Measured 20 Sep 2026:

  | Provider | Historical `eth_getTransactionReceipt` | `eth_getLogs` max range | Usable |
  |---|---|---|---|
  | `rpc.testnet.arc.io` (Circle) | yes | 9,999 | yes, but it is the primary's |
  | `rpc.quicknode.testnet.arc.io` | yes | 9,999 | **yes** |
  | `rpc.blockdaemon.testnet.arc.io` | **returns null** | 9,999 | no |
  | `rpc.drpc.testnet.arc.io` | yes | **~100** | no |

  **Blockdaemon serves blocks and logs but has a truncated transaction index.** Old
  transactions resolve to `null` by hash and by receipt while their blocks resolve fine.
  Payment verification fetches the settlement transaction to read its transfer log, so a
  checker on Blockdaemon finds every agent and verifies no payment, then diverges on
  every agent for a reason that has nothing to do with the primary.

  **dRPC's free plan rejects `eth_getLogs` ranges of 1,000 blocks** while its error text
  says the limit is 10,000. 100 blocks is accepted. Scanning from `FROM_BLOCK` would take
  thousands of requests.

  So: **QuickNode**. It is the only endpoint that both serves historical receipts and
  accepts useful log ranges without being the one the primary already uses.

  The check that matters is not "do they agree on `getTotalScore`". That is an
  `eth_call` at head and all four pass it, which is exactly how Blockdaemon got
  recommended here in the first place. Test the two calls payment verification actually
  depends on:

  ```bash
  # a settlement transaction old enough to be outside any recency window
  curl -s -X POST $RPC -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_getTransactionReceipt","params":["<OLD_TX>"]}'
  # and a log range the size the scanner will actually request
  curl -s -X POST $RPC -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_getLogs","params":[{"fromBlock":"0x...","toBlock":"0x...","address":"<IDENTITY>"}]}'
  ```
- **25,000 SVR**, plus USDC for gas. USDC is the native gas token on Arc. The figure
  sits above the faucet's daily reach on purpose: `SVRToken.faucet()` mints at most
  10,000 per address per day, so the previous 1,000 was a tenth of one free claim and
  bonded nothing. Two and a half days of claims, or one call from a funded wallet.
- **Access to the `DEFAULT_ADMIN_ROLE` wallet**, for steps 4 and 5. If that is a
  multisig, those two steps are proposals, not transactions, and this runbook stalls
  until they are executed.

## 0. Raise the operator bond (once, admin)

**Already done on Arc testnet**, 20 September 2026: the floor is 25,000 and the primary
is bonded at exactly that. Kept here because the sequence is the part worth reusing, and
because mainnet will need it again.

The bond was 1,000 SVR, which on this testnet bonded nothing: `SVRToken.faucet()` mints
up to 10,000 per address per day to anyone, so the bond was a tenth of one free daily
claim and an operator could sybil the set for free. 25,000 puts it two and a half days
of claims out of reach.

**Order matters, and getting it wrong stops scoring.** `isActiveOperator` is evaluated
live:

```solidity
return op.status == Status.Active && op.bond >= bondAmount;
```

There is no grandfathering. The moment `bondAmount` exceeds the *primary's* posted bond,
`_requireBondedOracle` rejects it and every `proposeReputation` reverts with
`OracleNotBonded`. The oracle keeps running and logging hourly failures while no score
is proposed, which is a quiet way to break the protocol.

So: read the primary's bond, top it up if needed, and only then raise the floor.

```bash
# 1. what the primary has posted
cast call 0x3c9c12F27DDCa7048840eE3fbF0CAa1C547D8171   "operators(address)(uint256,uint8,uint256)" <PRIMARY_ORACLE_ADDRESS>   --rpc-url https://rpc.testnet.arc.io

# 2. if the first number is below 25000e18, top it up FROM THE PRIMARY'S WALLET first
cast send 0x41De2D6D55318e197a00E8f5B496eA2790e23E6c   "approve(address,uint256)" 0x3c9c12F27DDCa7048840eE3fbF0CAa1C547D8171 25000000000000000000000   --rpc-url https://rpc.testnet.arc.io --private-key <PRIMARY_ORACLE_KEY>
cast send 0x3c9c12F27DDCa7048840eE3fbF0CAa1C547D8171   "depositBond(uint256)" <TOP_UP_AMOUNT_WEI>   --rpc-url https://rpc.testnet.arc.io --private-key <PRIMARY_ORACLE_KEY>

# 3. only now raise the floor, from the admin wallet
cast send 0x3c9c12F27DDCa7048840eE3fbF0CAa1C547D8171   "setBondAmount(uint256)" 25000000000000000000000   --rpc-url https://rpc.testnet.arc.io --private-key <ADMIN_KEY>

# 4. confirm the primary survived the raise
cast call 0x3c9c12F27DDCa7048840eE3fbF0CAa1C547D8171 "isActiveOperator(address)(bool)"   <PRIMARY_ORACLE_ADDRESS> --rpc-url https://rpc.testnet.arc.io   # must be true
```

If step 4 returns `false`, the primary is below the new floor and is no longer scoring.
Top it up; the floor does not need to be lowered again.

Mainnet is a separate decision. 25,000 of a 1,000,000,000 supply is 0.0025%, chosen here
against a faucet rather than against what corrupting a score is worth.

## 1. Generate the checker wallet

**The box needs a signing tool first.** A bare VPS has no foundry, and this is not a
one-off need: steps 3 and 10 sign `approve`, `depositBond` and `initiateUnbond` with the
checker's own key, so whatever runs the operator has to be able to sign for its bond for
as long as it holds one.

```bash
curl -L https://foundry.paradigm.xyz | bash && ~/.foundry/bin/foundryup
```

Then, on the checker box rather than on a laptop:

```bash
cast wallet new
```

Generating elsewhere and pasting the key in works and is faster, but be clear about what
it costs: the key then exists in two places and in a second shell history. The difference
is thinner than it sounds either way, because the key has to end up in `.env` on that box
regardless; generating there makes it one copy instead of two.

If you would rather not install a toolchain, the `node:20-alpine` image the oracle already
uses can generate the pair without one. It does not solve the signing problem in step 3:

```bash
docker run --rm node:20-alpine sh -c   "npm i -q ethers@6 >/dev/null 2>&1 && node -e \"const w=require('ethers').Wallet.createRandom();console.log(w.address);console.log(w.privateKey)\""
```

This key is a distinct operator. It must not be the primary's key: two processes signing
with one key share a nonce and would serialise against each other, and an operator set
where both members are the same address is a set of one wearing two hats.

Record the address. The private key goes straight into `.env.checker` (step 6) and
nowhere else.

## 2. Fund it for gas

Send a small amount of USDC to the checker address. It pays gas for `depositBond`, for
`finalizeReputation` on scores it agrees with, and for failover proposals. It does not
pay epoch fees; see step 6.

```bash
cast balance <CHECKER_ADDRESS> --rpc-url <CHECKER_RPC>
```

## 3. Post the bond

`depositBond` uses `safeTransferFrom`, so approve first. Two transactions, both from the
checker wallet:

```bash
cast send 0x41De2D6D55318e197a00E8f5B496eA2790e23E6c \
  "approve(address,uint256)" 0x3c9c12F27DDCa7048840eE3fbF0CAa1C547D8171 25000000000000000000000 \
  --rpc-url <CHECKER_RPC> --private-key <CHECKER_KEY>

cast send 0x3c9c12F27DDCa7048840eE3fbF0CAa1C547D8171 \
  "depositBond(uint256)" 25000000000000000000000 \
  --rpc-url <CHECKER_RPC> --private-key <CHECKER_KEY>
```

Confirm the status is `Bonded` (enum: `0 None, 1 Bonded, 2 Active, 3 Exiting`):

```bash
cast call 0x3c9c12F27DDCa7048840eE3fbF0CAa1C547D8171 \
  "operators(address)(uint256,uint8,uint256)" <CHECKER_ADDRESS> --rpc-url https://rpc.testnet.arc.io
```

**This is the point of no return.** From here the bond can only leave via
`initiateUnbond` plus a 7-day wait, and it is slashable throughout.

## 4. Admit it to the operator set

From the `DEFAULT_ADMIN_ROLE` wallet. `admit` reverts with `InsufficientBond` if step 3
did not land, so it is safe to attempt.

```bash
cast send 0x3c9c12F27DDCa7048840eE3fbF0CAa1C547D8171 \
  "admit(address)" <CHECKER_ADDRESS> \
  --rpc-url https://rpc.testnet.arc.io --private-key <ADMIN_KEY>
```

Verify, and check the set actually grew:

```bash
cast call 0x3c9c12F27DDCa7048840eE3fbF0CAa1C547D8171 "isActiveOperator(address)(bool)" <CHECKER_ADDRESS> --rpc-url https://rpc.testnet.arc.io   # true
cast call 0x3c9c12F27DDCa7048840eE3fbF0CAa1C547D8171 "activeCount()(uint256)" --rpc-url https://rpc.testnet.arc.io                             # 2
```

## 5. Grant `ORACLE_ROLE`

Bonding is not authorisation. `proposeReputation` checks both: `onlyRole(ORACLE_ROLE)`
and then `_requireBondedOracle()`. From the `DEFAULT_ADMIN_ROLE` wallet:

```bash
cast send 0x6603C96275e85F724Cdf74666b399365e4cA29ed \
  "grantRole(bytes32,address)" \
  0x68e79a7bf1e0bc45d0a330c573bc367f9cf464fd326078812f301165fbda4ef1 <CHECKER_ADDRESS> \
  --rpc-url https://rpc.testnet.arc.io --private-key <ADMIN_KEY>

cast call 0x6603C96275e85F724Cdf74666b399365e4cA29ed "hasRole(bytes32,address)(bool)" \
  0x68e79a7bf1e0bc45d0a330c573bc367f9cf464fd326078812f301165fbda4ef1 <CHECKER_ADDRESS> \
  --rpc-url https://rpc.testnet.arc.io   # true
```

A checker that never proposes would not strictly need this, but then its failover half
does nothing, and the failure is invisible until the primary is already down.

## 6. Configure

Start from [`.env.checker.example`](./.env.checker.example), not from `.env.example` and
never from the primary's `.env`. It carries every value already filled in except the key,
including the scoring inputs, which must match the primary **exactly**: a different
half-life or fee unit guarantees divergence on every agent and tells you nothing about
whether the primary is honest.

Four settings are not negotiable, and the process refuses to start if the first two are
wrong:

```dotenv
ORACLE_MODE=checker
DIVERGENCE_TOLERANCE=3          # validated at startup; max 10
EPOCH_HOURS=1                   # MUST be below half the challenge window (6h)
FEE_REGISTRY_ADDRESS=           # MUST be empty
RPC_URL=https://rpc.blockdaemon.testnet.arc.io   # NOT the primary's provider
ORACLE_PRIVATE_KEY=<CHECKER_KEY>
ORACLE_STATE_PATH=/data/oracle-state.json        # its own volume, not the primary's
HOST=0.0.0.0                                     # required for the port mapping to work
ORACLE_ADMIN_TOKEN=<openssl rand -hex 32>        # required BECAUSE host is not loopback
IDENTITY_ADDRESS=0x7e3aFC532eE5d922ab3cc3FFb510c7C8151477Dd
REPUTATION_ADDRESS=0x6603C96275e85F724Cdf74666b399365e4cA29ed
```

Why those four:

- **`FEE_REGISTRY_ADDRESS` empty.** `SigvaraEpochFees.chargeEpoch` has no per-epoch
  idempotency. A checker running the fee path would debit the agent a second time for
  one scoring epoch. Startup refuses the combination outright.
- **`EPOCH_HOURS` under 3.** A proposal is only auditable while it sits in
  `pendingScores`. On a longer cadence the checker misses proposals and reports an empty
  `/divergence`, which reads as "checked, found nothing".
- **`DIVERGENCE_TOLERANCE` a plain number.** `Number('3 points')` is `NaN`, and every
  comparison against `NaN` is false. An unvalidated tolerance would not make the checker
  noisy, it would make it agree with everything. Startup rejects it, but do not rely on
  that to catch a typo you could avoid.
- **Its own state file.** Sharing the primary's would mean sharing the payment
  observations the score is computed from, which is most of what is being checked.

Do not copy the primary's `.env`. It carries the primary's key and its fee registry.

## 7. Deploy

**There are two compose files and they are not interchangeable.** Picking the wrong one
is the most likely way to waste an afternoon here.

`docker-compose.checker.vps.yml` is the one you almost certainly want. It has no build
stage; it clones `main` from GitHub inside the container on every start, the same way the
primary is deployed. Nothing on the host to check out, nothing to `git pull`, nothing to
rebuild. Copy it and your `.env` to `/docker/sigvara-checker/` on the checker box:

```bash
cd /docker/sigvara-checker && docker compose up -d
docker compose logs --tail=30 checker
```

`docker-compose.checker.yml` builds from `./oracle` and needs a repository checkout on the
host. Use it only if you actually have one.

`up -d` on first run and after any `.env` change. A plain `restart` re-runs the clone and
so does pick up new code, but it does **not** re-read `env_file`.

Because both oracles clone `main`, they run the same scoring code by construction. That
matters more than it sounds: the factor weights changed on 20 September 2026, and a
checker left on older code would disagree with the primary about every single agent while
reporting it as a divergence in the primary.

Expect in the log:

```
[oracle] CHECKER mode — audits pending proposals, tolerance 3 points. …
[oracle] bonded operator check passed (registry 0x3c9c12F2…)
```

If it says `WARNING: this wallet is not an admitted operator`, step 4 did not land.

## 7a. Seed the state BEFORE the first epoch

Do this immediately after step 7, before the checker's first epoch completes. The
ordering is the whole point of this step.

A fresh checker has no `paymentEvents`, and that is the one part of state a rescan cannot
rebuild: attestations arrive over HTTP, not from the chain. So its first epoch computes
`successScore` 0 for every agent, and `ageScore` from the calendar fallback rather than
from an activity window it does not have. It records a divergence against the primary for
both, and it is wrong on both.

That record does not go away when the next epoch agrees. `/divergence` is an append-only
log bounded per agent and pruned by age, not a current-state flag, because a committee
reviewing a disagreement needs its history. A checker cannot retract an opinion it has
since revised.

**With a watcher running, that record pages someone.** The watcher classifies a
divergence by re-reading the disputed slot: same proposal and window still open means
`actionable`, and it alerts with a `rejectReputation` instruction and a countdown. It has
no way to know the checker changed its mind, because the checker does not say so. The
alert clears when the proposal turns over and the record classifies as `superseded`,
which bounds the damage to one proposal's lifetime, but until then it is a false alarm
against the primary complete with remediation steps. This happened on the first bring-up:
the watcher's opening alert was about the checker's own empty state.

A false alert nobody can clear is how real ones get ignored. Seed first.

Re-post the settlement transactions of every payment the primary has counted. The checker
re-verifies each against the chain and re-reads the settlement time from the block, so
decay and tenure come out identical rather than approximated:

```bash
TOKEN=$(grep '^ORACLE_ADMIN_TOKEN=' .env | cut -d= -f2)
curl -s -X POST http://127.0.0.1:3031/attest \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"didHash":"<DID>","success":true,"payment":{"txHash":"<SETTLEMENT_TX>"}}'
unset TOKEN
```

A `{"error":"transaction not found or not yet mined"}` here means the RPC cannot see
historical transactions, not that the transaction is missing. Re-read the provider table
above.

## 8. Verify

```bash
curl -s http://127.0.0.1:3031/health
curl -s http://127.0.0.1:3031/divergence
```

`/divergence` should report `"mode":"checker"` and `"seesProposals": true`. If
`seesProposals` is `false`, `EPOCH_HOURS` is too long and this checker is not actually
auditing anything, whatever the empty divergence list suggests.

Then leave it for one challenge window (6 hours) and check that
`finalizeSuccesses` is climbing. A checker that agrees with everything and finalizes
nothing is not reaching the finalize branch at all.

## 9. When a divergence fires

A divergence is not proof the primary is wrong. It is a disagreement between two
independent recomputations, and the checker can be the broken one. Every entry in
[`docs/divergence-log.md`](../docs/divergence-log.md) so far was the checker's own cold
start or a known reweight skew, not misconduct.

Whatever you conclude, write it down there, including the cases where the checker was
the broken one. A checker that reports disagreements and never publishes outcomes is
worse than no checker: a reader finds an unexplained accusation against the primary and
nothing else. A log containing only vindicated findings is a marketing document.

### Triage

Set these first; every command below uses them.

```bash
DID=0x…                      # didHash from the divergence record
RPC=https://rpc.testnet.arc.io
REP=0x6603C96275e85F724Cdf74666b399365e4cA29ed
```

**0. Are they even running the same code?** The cheapest question, and it was
unanswerable until `/health` started reporting a commit.

```bash
for U in https://oracle.sigvara.xyz https://checker.sigvara.xyz; do
  printf "%-32s " "$U"
  curl -sf $U/health | grep -o '"commit":[^,}]*'
done
```

Different commits do not by themselves explain a divergence, and matching ones do not
clear anyone. What they tell you is which explanation to rule out first. The 20:31 entry
below was partly a reweight skew, two oracles applying different factor caps to the same
evidence, and that took a while to see precisely because there was no way to ask this.

`"commit":null` means the operator does not report one, which is the honest answer for a
deployment that predates this or was built another way. It is not evidence of anything.

**Do not treat a reported commit as proof.** It is whatever that operator's container put
in an environment variable. A dishonest operator prints whatever it likes, and nothing
here is verified against the code actually executing. It catches the failure that
actually happens, which is a box that missed a deploy. For adversarial questions the
evidence endpoints are the answer, because those recompute against the chain.

**1. Read the record.** `factors` names the factor that moved, which usually names the
cause.

```bash
curl -s https://checker.sigvara.xyz/divergence/$DID
```

A delta on `feeScore` or `successScore` means the two oracles saw different payments.
A delta on `ageScore` alone, with the checker *higher*, usually means the checker has no
payment events at all and fell back to the calendar curve: that is a cold start, not a
finding. See the 20:31 entry of 2026-09-20 in the log.

**2. Is the disputed proposal still live?** Past the window there is nothing to reject and
the score is already final.

```bash
cast call $REP "getPendingScore(bytes32)" $DID --rpc-url $RPC
cast call $REP "challengeWindow()(uint256)" --rpc-url $RPC
cast block latest --field timestamp --rpc-url $RPC
```

`PendingScore` nests `ReputationData`, which is seven fields (six scores plus
`lastUpdated`), so in the returndata `proposedAt` is word index 7, the eighth 32-byte
word, and `exists` is word 8. Counting the scores and stopping at six lands on
`lastUpdated`, which on a live proposal often holds the same value, so that mistake does
not announce itself.

The proposal is live while `proposedAt + challengeWindow > block.timestamp`. If the
pending slot is empty, or holds a *different* `proposedAt` than the record, the disputed
proposal has already turned over: the record is `superseded`, still visible, no longer
actionable.

**3. Diff the inputs before blaming either side.** This is the step that decides it.

These use `jq`, which is not installed on a stock Ubuntu box and was not on the first
checker host. A missing `jq` prints an error to stderr and nothing to stdout, so the
commands below produce two empty files, and the emptiness checks exist because of it.
Install it first, or the step fails by looking like agreement:

```bash
command -v jq >/dev/null || apt-get install -y jq
```

```bash
curl -sf https://oracle.sigvara.xyz/evidence/$DID  | jq -r '.evidence[].txHash' | sort > /tmp/primary.txt
curl -sf https://checker.sigvara.xyz/evidence/$DID | jq -r '.evidence[].txHash' | sort > /tmp/checker.txt

# Both non-empty, or the comparison below is meaningless.
wc -l /tmp/primary.txt /tmp/checker.txt
[ -s /tmp/primary.txt ] && [ -s /tmp/checker.txt ] && diff /tmp/primary.txt /tmp/checker.txt
```

Check the counts before reading the diff. Two empty files differ in nothing, so a missing
`jq`, a typo in the didHash or a failed request produces silence that reads exactly like
"the two oracles agree". That is the wrong way for this step to fail, because agreement
is the conclusion that ends the investigation. `curl -sf` and the `-s` guards make a
broken fetch look broken.

Comparing `evidenceRoot` is the faster first pass, and tells you something the txHash
list does not:

```bash
for U in https://oracle.sigvara.xyz https://checker.sigvara.xyz; do
  curl -sf $U/evidence/$DID | jq -r '"\(.count)\t\(.evidenceRoot)"'
done
```

Different roots with different counts is the expected shape of a fan-out gap. To tell
that from a rewrite, ask whether the checker's whole tree survives inside the primary's:

```bash
CR=$(curl -sf https://checker.sigvara.xyz/evidence/$DID | jq -r .evidenceRoot)
curl -sf https://oracle.sigvara.xyz/evidence/$DID \
  | jq --arg r "$CR" '[.evidence[] | select(.proof | index($r))] | length'
```

Non-zero means the checker's root is an internal node of the primary's tree: the primary's
evidence is the checker's plus additions, with the old leaves committed unchanged. That is
the signature of an operator that fell behind, and it is arithmetic rather than either
operator's word. A primary that had dropped or altered an earlier payment could not
produce a tree containing the old subtree root.

Worked example, the 2026-09-20 23:51 entry: primary 8 leaves under `0xd4a95f…`, checker 2
under `0xb07cdf…`, and `0xb07cdf…` appears in the proofs of 2 of the primary's 8 leaves.
Recomputing `keccak(sorted(leaf1, leaf2))` from the checker's own two leaves reproduces it
exactly.

Attestations arrive over HTTP, not from the chain, so one operator can hold a settlement
the other has never been told about. **A payment the checker is missing is not evidence
against the primary.** Verify each disputed hash against the chain yourself rather than
taking either operator's word:

```bash
cast tx <txHash> --rpc-url $RPC
```

If the transfer is real and matches the attested payer, amount and time, the primary
counted a genuine payment the checker never received. That is an attestation fan-out gap:
an operational finding about your own delivery, not misconduct. Seed the checker with the
missing settlements (step 7a) and the next epoch agrees.

The case that is *not* benign is the reverse: a hash in the primary's evidence that does
not exist on chain, or does not match the amount and payer it was attested with. That is
the one the committee exists for.

**4. Only if the disagreement survives step 3** is it a committee matter.

```bash
cast send $REP "rejectReputation(bytes32)" $DID \
  --rpc-url $RPC --private-key $COMMITTEE_KEY
```

From the `SLASHING_COMMITTEE_ROLE` wallet, inside the window.

Nothing here is automatic. The contract does not require the two oracles to agree, and
the checker cannot reject anything itself; it can only make the disagreement legible.

## 10. Backing out

```bash
docker compose -f docker-compose.checker.yml down
cast send 0x3c9c12F27DDCa7048840eE3fbF0CAa1C547D8171 "initiateUnbond()" \
  --rpc-url <CHECKER_RPC> --private-key <CHECKER_KEY>
# 7 days later:
cast send 0x3c9c12F27DDCa7048840eE3fbF0CAa1C547D8171 "withdrawBond()" \
  --rpc-url <CHECKER_RPC> --private-key <CHECKER_KEY>
```

Stopping the container is enough to stop it writing. Unbonding is only needed to get the
25,000 SVR back, and the bond stays slashable for the whole cooldown.

Governance can also force this with `removeOperator(address)` from
`DEFAULT_ADMIN_ROLE`, and should revoke `ORACLE_ROLE` at the same time. Revoking the
role alone leaves a bonded operator that cannot propose; removing the operator alone
leaves an address holding `ORACLE_ROLE` whose proposals now revert on the bond check.
Neither half is a clean removal on its own.

## 11. The watcher

A checker that records a disagreement nobody reads inside six hours has done nothing. The
watcher closes that: it polls `/divergence`, re-reads each disputed slot on chain, and
alerts while the committee can still reject, escalating as the window closes.

**It must run on a third host**, and the reason is more specific than defence in depth.
The watcher notifies on state changes only, never on a healthy poll, so nothing
downstream can distinguish a quiet watcher from a dead one. Share a host with the checker
and one failure silences both, with the silence reading as "nothing to report". An
external dead-man's switch does not rescue it either, because there is no heartbeat to
miss.

### Reaching the checker from another host

The checker publishes to `127.0.0.1:3031`. Something has to expose `/health`,
`/divergence` and `/evidence/`, and nothing else.

Use whatever already terminates 80/443 on that box. On the first deployment that was a
system nginx serving five unrelated sites, and a second server fighting it for the port
was not an improvement. nginx runs on the host and the checker publishes to host
loopback, so the proxy target is simply `127.0.0.1:3031`: no Docker networking, no shared
external network, and no reason to recreate the checker.

```bash
curl -s -o /etc/nginx/sites-available/checker.<domain> \
  https://raw.githubusercontent.com/RunTimeAdmin/Sigvara/main/oracle/nginx-checker.conf.example
ln -sf /etc/nginx/sites-available/checker.<domain> /etc/nginx/sites-enabled/
nginx -t            # NOT optional: a bad config takes down every site this nginx serves
systemctl reload nginx
certbot --nginx -d checker.<domain>
```

Point a DNS A record at the checker's host first, or certbot's challenge has nowhere to
land.

Then prove the surface is what you think it is, rather than assuming:

```bash
DID=<a didHash this checker has scored>

# /health now carries "commit": the sha the container cloned, or null.
for P in /health /divergence /divergence/$DID /evidence/$DID; do
  printf "%-22s %s\n" "$P" "$(curl -s -o /dev/null -w '%{http_code}' https://checker.<domain>$P)"
done
printf "%-22s %s\n" "/evidence/0x00" \
  "$(curl -s -o /dev/null -w '%{http_code}' https://checker.<domain>/evidence/0x00)"
for P in /attest /epoch /flag /link /metrics /score/0x00 /; do
  printf "%-22s %s\n" "$P" "$(curl -s -o /dev/null -w '%{http_code}' https://checker.<domain>$P)"
done
```

The first loop must be `200`, the last all `404`. A write path answering anything else
means the config matched more broadly than intended.

`/evidence/0x00` must be **400**, and the distinction matters. A malformed didHash is
rejected by the service, so 400 proves the request reached it. 404 there means nginx
answered instead and the `/evidence/` location is missing or misspelled. Asserting 404
would pass in both cases and test nothing, which is how a check quietly stops checking.

### Deploying it

```bash
mkdir -p /docker/sigvara-watcher && cd /docker/sigvara-watcher
curl -sO https://raw.githubusercontent.com/RunTimeAdmin/Sigvara/main/docker-compose.watcher.vps.yml
curl -s -o .env https://raw.githubusercontent.com/RunTimeAdmin/Sigvara/main/oracle/.env.watcher.example
sed -i 's|^CHECKER_URL=.*|CHECKER_URL=https://checker.<domain>|' .env
docker compose -f docker-compose.watcher.vps.yml up -d
docker compose -f docker-compose.watcher.vps.yml logs --tail=20
```

It holds no key, mounts no state and signs nothing, so this is the lowest-stakes
deployment in the system. Worst case it is noisy.

Expect on a healthy start:

```
[watcher] watching https://checker.<domain> every 300s, webhook off, read-only (no key)
```

### Set WEBHOOK_URL

`webhook off` in that line means every alert goes to a container log on a host nobody is
watching. The component exists for 3am and in that state it cannot reach anyone at 3am.
Treat an unset `WEBHOOK_URL` as an incomplete deployment rather than an optional extra.

### If its first alert fires immediately

Check the `at` timestamp on the divergence before treating it as a finding. A checker
brought up without seeding its state (step 7a) records a divergence caused by its own
empty `paymentEvents`, and that record is append-only: the checker cannot retract an
opinion it has since revised. The watcher will classify it `actionable` and alert with
remediation steps, because from the chain's point of view the proposal really is still
live and still rejectable.

It clears itself when that proposal turns over and the record classifies as `superseded`,
so the damage is bounded by one proposal's lifetime. Do step 7a first and it never
happens.
