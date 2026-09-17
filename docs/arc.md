# Arc Deployment

Sigvara contracts are EVM-generic (`block.chainid` is baked into every DID), so
moving to Arc is deploy configuration plus a few chain facts you have to respect.
This guide targets **Arc testnet** (`5042002`) now and **Arc mainnet** (`5042`)
with SVR as the bond asset ([token.md](token.md)).

| Network | Chain ID | Public RPC | Explorer | Faucet |
|---|---|---|---|---|
| Arc testnet | `5042002` | `https://rpc.testnet.arc.io` | [explorer.testnet.arc.io](https://explorer.testnet.arc.io) | [faucet.circle.com](https://faucet.circle.com) |
| Arc mainnet | `5042` | `https://rpc.mainnet.arc.io` | [explorer.arc.io](https://explorer.arc.io) | none |

Official docs: [Connect to Arc](https://docs.arc.io/arc/references/connect-to-arc).
Alchemy, QuickNode, dRPC and Blockdaemon also serve Arc; use one of those for
oracle indexing rather than the public endpoint.

## What is different about Arc

**USDC is gas.** There is no ETH. The deployer, the oracle wallet and every
operator who registers an agent pays fees in USDC. At the EVM level the native
balance has 18 decimals, so `cast balance --ether` prints USDC and `msg.value`
math is unchanged. Do not confuse this with ERC-20 USDC, which has 6 decimals
on every other chain: Arc's docs are explicit that the native balance and the
ERC-20 view of USDC are the same balance, not two.

**What this means for the bond token.** The staking, oracle-bond and epoch-fee
contracts take the bond token by address at initialization. On Arc the obvious
"established asset" is USDC itself, but whether the ERC-20 interface to the
native balance is usable as an `IERC20` bond, and at which address and decimals,
is something to verify on testnet before you design around it. Until then the
testnet uses the faucet `SVRToken`.

**Fee estimation.** Arc is EIP-1559 style in practice, but if `forge script`
fails at the fee-estimation step, retry with `--legacy`.

**Explorer verification.** `explorer.arc.io` verification flow is not documented
in this repo yet. Do not add `[etherscan]` entries for `5042` / `5042002` to
`foundry.toml` until Foundry ships chain metadata for Arc; unknown chain IDs
break `forge script`.

## 1. Prerequisites

Foundry (`forge`, `cast`), the Solidity libs cloned into `lib/` (gitignored, same
as CI), and `DEPLOYER_PRIVATE_KEY` exported in your shell (never commit it):

```bash
git clone --depth 1 --branch v5.6.1 https://github.com/OpenZeppelin/openzeppelin-contracts.git lib/openzeppelin-contracts
git clone --depth 1 --branch v5.6.1 https://github.com/OpenZeppelin/openzeppelin-contracts-upgradeable.git lib/openzeppelin-contracts-upgradeable
git clone --depth 1 https://github.com/foundry-rs/forge-std.git lib/forge-std
```

Then confirm the chain and fund the deployer:

```powershell
pwsh scripts/check-arc.ps1 -Deployer 0xYourDeployer
```

Get testnet USDC from [faucet.circle.com](https://faucet.circle.com) (select Arc
testnet). A full `Deploy.s.sol` run is three implementations, three proxies, a
token and five role grants; a few USDC of gas covers it many times over.

## 2. Deploy the protocol (testnet)

```bash
# Simulate first (no broadcast)
forge script script/Deploy.s.sol --rpc-url arc_testnet -vvvv

# Broadcast — writes deployments/5042002.json
forge script script/Deploy.s.sol --rpc-url arc_testnet --broadcast -vvvv
```

Note: the simulate step also writes `deployments/5042002.json`, with addresses that
were never broadcast. Delete it before the real run, and only commit the file
produced by `--broadcast`.

Optional role overrides (`ORACLE_ADDRESS`, `COMMITTEE_ADDRESS`, `MINIMUM_STAKE`,
`CHALLENGE_PERIOD`, `SCORE_CHALLENGE_WINDOW`, `UNBONDING_PERIOD`) are documented
in the header of `script/Deploy.s.sol`.

Record the deploy block: `cast block-number --rpc-url arc_testnet`. The oracle
needs it as `FROM_BLOCK`.

## 3. Point the oracle at Arc

Copy `oracle/.env.example` to `oracle/.env`, then set:

```bash
RPC_URL=https://rpc.testnet.arc.io   # or your Alchemy / QuickNode Arc URL
IDENTITY_ADDRESS=0x...               # from deployments/5042002.json
REPUTATION_ADDRESS=0x...
FROM_BLOCK=<deploy block minus a small buffer>
LOG_CHUNK_SIZE=2000
EPOCH_HOURS=1
ORACLE_PRIVATE_KEY=0x...             # must hold ORACLE_ROLE on Reputation; fund it with USDC
```

The ERC-8004 external-score feed (`EXTERNAL_RPC`, `EXTERNAL_IDENTITY_ADDRESS`,
`EXTERNAL_REPUTATION_ADDRESS`) is a separate read against Base Sepolia and does
not depend on Arc. Leave it as-is.

## 4. SDK live integration tests

```bash
cd packages/sdk
export SIGVARA_RPC_URL=https://rpc.testnet.arc.io
export SIGVARA_CHAIN_ID=5042002
export SIGVARA_IDENTITY_ADDRESS=0x...
export SIGVARA_REPUTATION_ADDRESS=0x...
export SIGVARA_STAKING_ADDRESS=0x...
export SIGVARA_OPERATOR_PRIVATE_KEY=0x...   # funded with USDC; registers a test agent

npx vitest run test/integration.test.ts
```

DIDs minted here look like `did:sigvara:5042002:0x...`; the chain ID is part of
the identity, so the same key on Arc mainnet is a different DID.

## 5. Upgrading a deployed proxy

Every registry is a UUPS proxy gated on `UPGRADER_ROLE`, so an upgrade is the
most dangerous operation in the system. `script/Upgrade.s.sol` deploys a fresh
implementation, reads the proxy address out of `deployments/<chainId>.json`,
records the ERC-1967 implementation slot before and after, and reverts if the
slot did not move.

```bash
# Simulate first. TARGET is identity | reputation | staking | oracleBond | epochFees.
TARGET=staking forge script script/Upgrade.s.sol --rpc-url arc_testnet -vvvv

TARGET=staking forge script script/Upgrade.s.sol --rpc-url arc_testnet --broadcast -vvvv
```

`oracleBond` and `epochFees` are deployed by their own scripts and are not in
the artifact, so pass `PROXY=0x...` for those. When the new implementation adds
state that must not start at zero, pass `INIT_CALLDATA` with the encoded
reinitializer call so it lands in the same transaction as the upgrade.

Run `forge test --match-contract UpgradeTest` before broadcasting. Those tests
cover the half the slot-pinning tests do not: that the upgrade executes, that
only `UPGRADER_ROLE` can execute it, and that stakes, scores and queued
withdrawals read back unchanged afterwards.

On mainnet `UPGRADER_ROLE` belongs to the governance timelock, so this script is
used to simulate and to produce the calldata, not to broadcast.

## 6. Mainnet (5042)

Not before: an external audit and a real slashing
committee multisig in `COMMITTEE_ADDRESS`. Mechanically it is the same command
with `--rpc-url arc_mainnet` and real USDC for gas.

## Checklist

- [ ] `pwsh scripts/check-arc.ps1` returns `5042002`
- [ ] deployer funded from faucet.circle.com
- [ ] `forge script script/Deploy.s.sol --rpc-url arc_testnet --broadcast`
- [ ] `deployments/5042002.json` committed
- [ ] oracle `.env` pointed at Arc, `ORACLE_ROLE` confirmed, first epoch scored
- [ ] SDK integration tests green against Arc
- [ ] verify whether native USDC exposes a usable `IERC20` for bonds (address, decimals)
