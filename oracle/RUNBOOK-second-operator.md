# Runbook: bringing up a second bonded oracle operator

Stands up a checking operator alongside the primary. Read
"Running a second operator" in [README.md](./README.md) first for why a checker audits
instead of competing; this file is the sequence, not the reasoning.

Nothing here is reversible in under a week: `initiateUnbond` starts a 7-day cooldown.
Read step 8 before you start step 3.

## Addresses and parameters

Arc testnet, chain ID `5042002`. All read off chain on 19 Sep 2026.

| | |
|---|---|
| `SigvaraReputation` | `0x6603C96275e85F724Cdf74666b399365e4cA29ed` |
| `SigvaraOracleBond` | `0x3c9c12F27DDCa7048840eE3fbF0CAa1C547D8171` |
| `SigvaraIdentity` | `0x7e3aFC532eE5d922ab3cc3FFb510c7C8151477Dd` |
| SVR token | `0x41De2D6D55318e197a00E8f5B496eA2790e23E6c` |
| `bondAmount()` | 1000 SVR (`1000e18`) |
| `unbondingPeriod()` | 604800 s (7 days) |
| `challengeWindow()` | 21600 s (6 hours) |
| `activeCount()` before this runbook | 1 |
| `ORACLE_ROLE` | `0x68e79a7bf1e0bc45d0a330c573bc367f9cf464fd326078812f301165fbda4ef1` |
| `DEFAULT_ADMIN_ROLE` | `0x00…00` |

Re-read them before acting rather than trusting this table:

```bash
cast call 0x3c9c12F27DDCa7048840eE3fbF0CAa1C547D8171 "bondAmount()(uint256)" --rpc-url https://rpc.testnet.arc.io
```

## Before you start

- **Separate hardware from the primary.** A checker on the same box shares its failure
  modes with the thing it is checking.
- **A different RPC provider.** Arc testnet has four, and they are independent:
  `rpc.testnet.arc.io` (Circle), `rpc.blockdaemon.testnet.arc.io`,
  `rpc.drpc.testnet.arc.io`, `rpc.quicknode.testnet.arc.io`. The primary uses Circle, so
  the checker should not. Verified 19 Sep 2026: all four are live and agree on
  `getTotalScore`.
- **1000 SVR**, plus USDC for gas. USDC is the native gas token on Arc.
- **Access to the `DEFAULT_ADMIN_ROLE` wallet**, for steps 4 and 5. If that is a
  multisig, those two steps are proposals, not transactions, and this runbook stalls
  until they are executed.

## 1. Generate the checker wallet

On the checker box, not on a laptop and not through anything that logs:

```bash
cast wallet new
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
  "approve(address,uint256)" 0x3c9c12F27DDCa7048840eE3fbF0CAa1C547D8171 1000000000000000000000 \
  --rpc-url <CHECKER_RPC> --private-key <CHECKER_KEY>

cast send 0x3c9c12F27DDCa7048840eE3fbF0CAa1C547D8171 \
  "depositBond(uint256)" 1000000000000000000000 \
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

Copy `.env.example` to `.env.checker` on the checker box. Four settings are not
negotiable, and the process refuses to start if the first two are wrong:

```dotenv
ORACLE_MODE=checker
DIVERGENCE_TOLERANCE=3          # validated at startup; max 10
EPOCH_HOURS=1                   # MUST be below half the challenge window (6h)
FEE_REGISTRY_ADDRESS=           # MUST be empty
RPC_URL=https://rpc.blockdaemon.testnet.arc.io   # NOT the primary's provider
ORACLE_PRIVATE_KEY=<CHECKER_KEY>
ORACLE_STATE_PATH=/data/oracle-state.json        # its own volume, not the primary's
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

```bash
docker compose -f docker-compose.checker.yml up -d --build
docker compose -f docker-compose.checker.yml logs --tail=30 checker
```

`up -d`, not `restart`: `restart` does not re-read `env_file`.

Expect in the log:

```
[oracle] CHECKER mode — audits pending proposals, tolerance 3 points. …
[oracle] bonded operator check passed (registry 0x3c9c12F2…)
```

If it says `WARNING: this wallet is not an admitted operator`, step 4 did not land.

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
1000 SVR back, and the bond stays slashable for the whole cooldown.

Governance can also force this with `removeOperator(address)` from
`DEFAULT_ADMIN_ROLE`, and should revoke `ORACLE_ROLE` at the same time. Revoking the
role alone leaves a bonded operator that cannot propose; removing the operator alone
leaves an address holding `ORACLE_ROLE` whose proposals now revert on the bond check.
Neither half is a clean removal on its own.
