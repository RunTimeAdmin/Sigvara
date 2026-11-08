# Treasury timelock rehearsal on Arc testnet

The treasury is a timelock the admin Safe drives ([ADR 0005](adr/0005-governance-and-emergency-powers.md),
decision 13). This is the record of running that arrangement on Arc testnet (chain 5042002) before it holds
anything real: a 2-of-3 Safe, a treasury deployed with the same command the launch checklist uses, test SVR
in it, one payment scheduled and one cancelled, and the calls that must be refused.

It is a rehearsal, not the deployment. The Safe's three owner keys are throwaway testnet keys held on one
machine, not the admin Safe's signers on their own devices, and the SVR is the testnet faucet token, which
has no value.

## What was deployed, 8 November 2026

| | Address | Transaction |
|---|---|---|
| Safe, 2 of 3 (`SafeL2` 1.4.1 from Safe's factory, Safe's own fallback handler, no module or guard) | [`0xDE519F7CBf7718Fa92E6e7eeec95308124eb9f7d`](https://explorer.testnet.arc.io/address/0xDE519F7CBf7718Fa92E6e7eeec95308124eb9f7d) | [`0x96f567a6…e5ad`](https://explorer.testnet.arc.io/tx/0x96f567a6ff40e9da6fe123b68ea38131acc499cccb64345452fc166b653ee5ad), block 71393422 |
| Treasury, `PHASE=deploy-treasury` in `script/SplitAuthority.s.sol` at main `ec3e9d1`: the Safe proposes and cancels, anyone executes, it administers itself, 172,800 seconds | [`0xF1060453820cAe3E5577792edB846a2D6931D131`](https://explorer.testnet.arc.io/address/0xF1060453820cAe3E5577792edB846a2D6931D131) | [`0x542c4fb2…b679`](https://explorer.testnet.arc.io/tx/0x542c4fb21f4caaf23b08adda8639acf792b0cbf00fd62628975d888686b1b679), block 71393461 |

The deploy and every later transaction were sent by a separate throwaway key that owns nothing in the Safe.
It claimed 1,000 test SVR from the faucet ([`0x3fa4298a…f568`](https://explorer.testnet.arc.io/tx/0x3fa4298ad69ef440a54470ee6e2dfc0c12a7f6507c580ea8c8ae2452a729f568))
and sent it to the treasury ([`0xff614fb0…2d22`](https://explorer.testnet.arc.io/tx/0xff614fb04de3b8a7136b1cbd2a77686a431243df2ffe08d7ab99977258fb2d22)).

## Payments

| | What happened | Transaction |
|---|---|---|
| A: 100 test SVR to a payee | Scheduled by the Safe, two owners signing, with 48 hours of delay. Operation `0x199ae952…d9bd`, ready from 2026-11-10 16:07:09 UTC | [`0x11dc7fd8…6c73`](https://explorer.testnet.arc.io/tx/0x11dc7fd8816bad1c5ba3e1c46f80d173899252bf9be6d20a79ed85b8fe0b6c73), block 71393502 |
| B: 50 test SVR to the same payee | Scheduled by the Safe, then cancelled by the Safe. Operation `0x510a8776…4723` reads Unset | [`0x12798ff5…bf85`](https://explorer.testnet.arc.io/tx/0x12798ff5dd6840aff5c8d31e7dfb6cf0b5ed93c0ffa746ee7024e5016ddbbf85) and [`0x10e60e6b…f356`](https://explorer.testnet.arc.io/tx/0x10e60e6b154d128578c4546090998dbb5150f4569c801e83f4b5f8aa9519f356) |

Payment A has not been executed yet. Once its delay has run, anyone may execute it; this record will be
updated with that transaction, the balances after it (the payee 100, the treasury 900) and a check that
cancelled payment B still cannot execute.

## What was refused

Each was sent as a call at block 71393523, so nothing was spent, and each reverted with the error the
contracts define for it:

| Attempt | Result |
|---|---|
| Anyone executes payment A before its delay has run | `TimelockUnexpectedOperationState`: it is not Ready |
| An owner schedules a payment directly, not through the Safe | `AccessControlUnauthorizedAccount`: the owner lacks `PROPOSER_ROLE` |
| The Safe schedules a payment with 24 hours of delay | `TimelockInsufficientDelay(86400, 172800)` |
| The Safe lowers the delay itself | `TimelockUnauthorizedCaller`: only the timelock can, through its own delay |
| The Safe moves the treasury's SVR itself | `ERC20InsufficientBalance`: the funds are the timelock's, not the Safe's |

## The checks

`scripts/check-mainnet.sh`, pointed at Arc testnet with the Safe, the treasury and the throwaway key as
`DEPLOYER` (this rehearsal has no upgrade timelock, so `TIMELOCK` was the zero address):

- `check_treasury`: every line passed. The treasury has code and is not the upgrade timelock; its delay is
  172,800; the Safe can propose and cancel and the deployer cannot propose; anyone can execute; neither the
  Safe nor the deployer is its admin; it administers itself.
- `check_treasury_queue` from block 71393460: two operations found. It failed on payment A, which was
  waiting and not listed as reviewed, and passed once its id was in `REVIEWED_TIMELOCK_OPERATIONS`.

## What this does not show

- The mainnet guard in `script/DeployOracleBond.s.sol` runs only on chain 5042, so it was not exercised here.
  `test/DeployScripts.t.sol` covers it: a plain account, a contract that does not answer as a timelock, a
  24-hour timelock and a timelock the deployer controls are refused.
- No slash was sent to this treasury. Arc testnet's bond registry keeps its own beneficiary, and changing it
  is a live configuration change. `test/TreasuryTimelock.t.sol` sends a slashed bond to a treasury timelock.
- The Safe's owners were keys on one machine. On mainnet each signer reviews and signs on their own device,
  and `check_safes` compares the owners with what they read there.
