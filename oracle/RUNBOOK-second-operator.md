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
independent recomputations, and the checker can be the broken one.

1. Read it: `curl -s http://127.0.0.1:3031/divergence/<didHash>`. `factors` says which
   factor moved, which usually says why.
2. Check whether the disputed proposal is still live: compare `proposedAt` against
   `block.timestamp + challengeWindow`. Past it, the score is already final and the
   committee's reject power has expired.
3. Compare the two oracles' inputs before blaming either. A `feeScore` or `successScore`
   gap is usually one of them having observed a payment the other has not; fetch
   `/evidence/<didHash>` from **both** and diff the payment lists.
4. Only if the disagreement survives that is it a committee matter:
   `rejectReputation(didHash)` from the `SLASHING_COMMITTEE_ROLE` wallet, inside the
   window.

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
