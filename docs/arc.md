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

### Where it runs

The testnet oracle runs on a dedicated VPS as a Docker Compose project with
`restart: unless-stopped`, cloning this repository at container start, so a push to
`main` reaches it on the next restart. The host is deliberately not named here: it
holds the oracle signing key, and nothing about operating the protocol requires a
reader to know which machine it is.

The read and write halves of the service are reachable differently, on purpose. The
process publishes its port on host loopback only, and the host firewall drops it, so
nothing reaches the service directly. A reverse proxy then republishes three paths at
`oracle.sigvara.xyz`: `/health`, `/score/:didHash` and `/evidence/:didHash`. Those are
unauthenticated by design — evidence nobody can fetch is evidence nobody can audit, and
the point of publishing a Merkle root is that a third party can re-derive it. Every
other path, including `/attest`, `/flag`, `/link`, `/epoch` and `/metrics`, is not
proxied and answers 404, so the write surface is still reachable only from a shell on
the box. The read paths are rate-limited per caller, not because they are sensitive but
because `/score` costs several chain reads and `/evidence` rebuilds a Merkle tree.

It used to run as `node index.js` on a desktop. That is worth naming rather than
quietly fixing: a reputation oracle whose liveness depends on a laptop staying awake
is a single point of failure that no amount of on-chain design makes up for, and it
was already demonstrated once — an unclean shutdown took the oracle down for fourteen
hours and corrupted the repository's git metadata in the same moment.

Two operational notes:

- **Only one instance may run at a time.** They share the oracle wallet, so two
  instances submit transactions with colliding nonces.
- **`paymentEvents` is the only state that cannot be recovered by rescanning.**
  Attestations arrive over HTTP, so a fresh state file loses them and every
  payment-derived factor collapses to zero. They can be re-seeded by re-posting the
  settlement hashes to `/attest`: the oracle re-verifies each against the chain and
  re-reads the settlement time from the block, so decay and tenure come out
  identical. Everything else — the log scan cursor, the agent set — rebuilds itself.

## 4. SDK live integration tests

Addresses below are the live Arc testnet deployment, from
`deployments/5042002.json`. The operator key needs USDC for gas and SVR for the
stake, since the test registers a real agent.

PowerShell:

```powershell
cd packages\sdk
$env:SIGVARA_RPC_URL            = "https://rpc.testnet.arc.io"
$env:SIGVARA_CHAIN_ID           = "5042002"
$env:SIGVARA_IDENTITY_ADDRESS   = "0x7e3aFC532eE5d922ab3cc3FFb510c7C8151477Dd"
$env:SIGVARA_REPUTATION_ADDRESS = "0x6603C96275e85F724Cdf74666b399365e4cA29ed"
$env:SIGVARA_STAKING_ADDRESS    = "0xA69d62B2a6774D21A2c15d5d83b27277eD31d35B"
$env:SIGVARA_OPERATOR_PRIVATE_KEY = "0x..."

npx vitest run test/integration.test.ts
```

bash:

```bash
cd packages/sdk
export SIGVARA_RPC_URL=https://rpc.testnet.arc.io
export SIGVARA_CHAIN_ID=5042002
export SIGVARA_IDENTITY_ADDRESS=0x7e3aFC532eE5d922ab3cc3FFb510c7C8151477Dd
export SIGVARA_REPUTATION_ADDRESS=0x6603C96275e85F724Cdf74666b399365e4cA29ed
export SIGVARA_STAKING_ADDRESS=0xA69d62B2a6774D21A2c15d5d83b27277eD31d35B
export SIGVARA_OPERATOR_PRIVATE_KEY=0x...

npx vitest run test/integration.test.ts
```

DIDs minted here look like `did:sigvara:5042002:0x...`; the chain ID is part of
the identity, so the same key on Arc mainnet is a different DID.

## 4b. Oracle operator bonds

`SigvaraOracleBond` records who has posted a performance bond as an oracle operator,
and lets governance admit, eject and partially slash them. It is deployed by its own
script, which merges the proxy address into `deployments/<chainId>.json` under
`oracleBond`.

Use three distinct addresses. If the deployer is also the slasher and the payee, one
key can seize an operator's bond and send it to itself, which is the opposite of what
a performance bond is for. The script warns on testnet and refuses on mainnet.

PowerShell:

```powershell
$env:SVR_ADDRESS       = "0x41De2D6D55318e197a00E8f5B496eA2790e23E6c"
$env:SLASHER_ADDRESS   = "0x..."   # governance or the committee, not the deployer
$env:SLASH_BENEFICIARY = "0x..."   # where seized bonds go, not the deployer
forge script script/DeployOracleBond.s.sol --rpc-url arc_testnet -vvvv              # simulate
forge script script/DeployOracleBond.s.sol --rpc-url arc_testnet --broadcast -vvvv
```

A dry run prints the address it would have used and writes nothing. The artifact is
only touched on a real broadcast, so there is no cleanup step between the two and no
way to commit an address that does not exist. Commit what the broadcast produced.

### Making the bond bite

Deploying the registry changes no behaviour on its own. `SigvaraReputation` has to be
pointed at it, after which proposing a score requires the caller to be an admitted,
bonded operator as well as holding `ORACLE_ROLE`. The role says who may speak; the
bond is what they lose for speaking falsely.

**Order matters.** Turning this on stops every oracle that has not bonded and been
admitted, so do it last:

1. The oracle wallet acquires the bond token and calls `depositBond(amount)`. On
   testnet the token has a public faucet: `faucet(10000e18)`, once per wallet per day.
   This leaves the operator at status `Bonded`, which is not yet enough.
2. The admin calls `admit(operator)`, moving it to `Active`. Note this is
   `DEFAULT_ADMIN_ROLE`, the deployer, not the committee. The committee holds
   `SLASHER_ROLE`, which is the power to take a bond, not to grant standing.
3. Only then point reputation at the registry.

```bash
cast send <oracleBond proxy> "admit(address)" <oracle wallet>   --private-key $DEPLOYER_KEY --rpc-url arc_testnet
```

```bash
cast send <reputation proxy> "setOperatorBond(address)" <oracleBond proxy>   --private-key $ADMIN_KEY --rpc-url arc_testnet
```

Passing the zero address turns the requirement back off, which is why this is a plain
setter and not another initializer: unset is a safe working state.

Check where you stand before flipping it. `bondOf` being non-zero is not the same as
being admitted, and only the second one lets an oracle propose:

```bash
cast call <oracleBond proxy> "isActiveOperator(address)(bool)" <oracle wallet> --rpc-url arc_testnet
```

The oracle service reads this at startup and warns if the wallet cannot propose, so a
misordered rollout shows up at boot rather than as a silent hourly failure.

Finalization stays permissionless. It is mechanical and cannot change the number, and
gating it would let an operator's exit strand every score it had already proposed.

## 5. Upgrading a deployed proxy

Every registry is a UUPS proxy gated on `UPGRADER_ROLE`, so an upgrade is the
most dangerous operation in the system. `script/Upgrade.s.sol` deploys a fresh
implementation, reads the proxy address out of `deployments/<chainId>.json`,
records the ERC-1967 implementation slot before and after, and reverts if the
slot did not move.

Every command here needs `DEPLOYER_PRIVATE_KEY` in the environment as well, and
must run from the repository root. `TARGET` is
`identity | reputation | staking | oracleBond | epochFees`.

PowerShell:

```powershell
$env:TARGET = "staking"
forge script script/Upgrade.s.sol --rpc-url arc_testnet -vvvv              # simulate
forge script script/Upgrade.s.sol --rpc-url arc_testnet --broadcast -vvvv
```

bash:

```bash
export TARGET=staking
forge script script/Upgrade.s.sol --rpc-url arc_testnet -vvvv              # simulate
forge script script/Upgrade.s.sol --rpc-url arc_testnet --broadcast -vvvv
```

The proxy address is read from `deployments/<chainId>.json` under the target's own
key. On Arc testnet that file carries `oracleBond` as well as the three core
registries, so only `epochFees` — which has never been deployed — needs
`PROXY=0x...`. When the new implementation adds state that must not start at zero,
pass `INIT_CALLDATA` with the encoded reinitializer call so it lands in the same
transaction as the upgrade.

**Rehearse against a fork before broadcasting.** The simulation proves the
transaction succeeds; it does not prove the storage still means what it did. A
layout mistake never reverts, it silently reinterprets live data, and the in-memory
upgrade tests cannot catch that because they build their own fixtures rather than
reading the chain. Fork Arc at head, prank as the upgrader, move the proxies, and
assert the real agent, bond and score survive. That check is what caught a mapping
declared one line too high, which would have moved `operatorBond` into an empty slot
where it reads zero — the "bonded-operator check disabled" mode, reached by an
upgrade that reverted nothing and logged nothing.

### The reputation identity binding

`SigvaraReputation` now reads `SigvaraIdentity` before accepting a score, so it can
refuse writes for a didHash that was never registered and for an agent that has been
slashed. The registry address lives in new storage that `initialize` never set, and
the check is deliberately fail-closed: until `initializeV3` runs, every proposal
reverts with `IdentityRegistryNotSet`.

That makes the calldata mandatory rather than optional. Upgrade without it and the
oracle stops scoring until you follow up, which is noisy but harmless; there is no
path where the check is silently skipped.

PowerShell:

```powershell
$env:TARGET        = "reputation"
$env:INIT_CALLDATA = "0x3101cfcb0000000000000000000000007e3afc532ee5d922ab3cc3ffb510c7c8151477dd"
forge script script/Upgrade.s.sol --rpc-url arc_testnet -vvvv              # simulate
forge script script/Upgrade.s.sol --rpc-url arc_testnet --broadcast -vvvv
```

bash:

```bash
export TARGET=reputation
export INIT_CALLDATA=0x3101cfcb0000000000000000000000007e3afc532ee5d922ab3cc3ffb510c7c8151477dd
forge script script/Upgrade.s.sol --rpc-url arc_testnet -vvvv              # simulate
forge script script/Upgrade.s.sol --rpc-url arc_testnet --broadcast -vvvv
```

The calldata above is `initializeV3(address)` against the Arc testnet identity proxy.
Regenerate it for any other deployment:

```bash
cast calldata "initializeV3(address)" <identity proxy>
```

Confirm it took effect before trusting the oracle again:

```bash
cast call <reputation proxy> "identityRegistry()(address)" --rpc-url arc_testnet
```

### The collateral binding, and why the order matters

`SigvaraIdentity` refuses to move an agent to Active unless it holds `minimumStake`,
which it reads from `SigvaraStaking`. `SigvaraStaking` in turn only reinstates a still
bonded agent when a slash proposal is dropped, and calls the new
`clearSlashSuspension` otherwise. The two contracts have to be upgraded together, and
identity has to go first.

Taking staking first breaks everything: the new implementation calls
`clearSlashSuspension`, which does not exist on the old identity, so every path that
drops a proposal reverts. Taking identity first leaves a much narrower gap, where the
old staking still reinstates unconditionally and would revert only for an agent that
is under-collateralised with a proposal being dropped. Check for live proposals before
starting and the gap is empty.

Step 1, identity, with the wiring calldata:

```powershell
$env:TARGET        = "identity"
$env:INIT_CALLDATA = "0x29b6eca9000000000000000000000000a69d62b2a6774d21a2c15d5d83b27277ed31d35b"
forge script script/Upgrade.s.sol --rpc-url arc_testnet -vvvv              # simulate
forge script script/Upgrade.s.sol --rpc-url arc_testnet --broadcast -vvvv
```

Step 2, staking, which needs no calldata. Clear `INIT_CALLDATA` or it will be sent
again to the wrong contract:

```powershell
$env:TARGET        = "staking"
$env:INIT_CALLDATA = ""
forge script script/Upgrade.s.sol --rpc-url arc_testnet -vvvv              # simulate
forge script script/Upgrade.s.sol --rpc-url arc_testnet --broadcast -vvvv
```

The calldata is `initializeV2(address)` against the Arc testnet staking proxy.
Regenerate it for any other deployment with
`cast calldata "initializeV2(address)" <staking proxy>`, and confirm it landed:

```bash
cast call <identity proxy> "stakeView()(address)" --rpc-url arc_testnet
```

### The bond requirement

`SigvaraReputation` now refuses to score an agent holding less than `minimumStake`.
It reads the bond through the identity registry's stake view, so there is one wiring
point rather than two that could disagree. Nothing new needs initializing, but
identity must already have been through its own `initializeV2`, or every proposal
reverts with `StakeViewNotSet`.

Upgrade reputation on its own, no calldata:

```powershell
$env:TARGET        = "reputation"
$env:INIT_CALLDATA = ""
forge script script/Upgrade.s.sol --rpc-url arc_testnet -vvvv              # simulate
forge script script/Upgrade.s.sol --rpc-url arc_testnet --broadcast -vvvv
```

Expect existing unbonded agents to stop being scored the moment this lands. That is
the point, but check who it affects before broadcasting:

```bash
cast call <staking proxy> "hasMinimumStake(bytes32)(bool)" <didHash> --rpc-url arc_testnet
```

### Score maturity

An earned score becomes spendable over time rather than at once. `getTotalScore`
now returns the matured value and `getEarnedScore` returns the raw one, so anything
reading the old function gets the conservative number without changing.

A rate of 0 means no maturity, which is what an upgraded proxy has until
`initializeV4` runs. That is a working state, not a broken one, so this upgrade is
safe to land in two steps if you want to watch it. New deployments get it from the
deploy script, overridable with `MATURITY_RATE_PER_DAY`.

```powershell
$env:TARGET        = "reputation"
$env:INIT_CALLDATA = "0xf903488b0000000000000000000000000000000000000000000000000000000000000004"
forge script script/Upgrade.s.sol --rpc-url arc_testnet -vvvv              # simulate
forge script script/Upgrade.s.sol --rpc-url arc_testnet --broadcast -vvvv
```

That calldata is `initializeV4(4)`: four points a day, so a perfect score takes 25
days to become fully spendable. Regenerate for another rate with
`cast calldata "initializeV4(uint256)" <points>`, and check what landed:

```bash
cast call <reputation proxy> "maturityRatePerDay()(uint256)" --rpc-url arc_testnet
```

Expect every existing agent to read 0 immediately after the rate is set, then climb.
The anchor starts from what was spendable at the last finalize, which is zero for an
agent that has never had one since the upgrade.

Run `forge test --match-contract UpgradeTest` before broadcasting. Those tests
cover the half the slot-pinning tests do not: that the upgrade executes, that
only `UPGRADER_ROLE` can execute it, and that stakes, scores and queued
withdrawals read back unchanged afterwards.

On mainnet `UPGRADER_ROLE` belongs to the governance timelock, so this script is
used to simulate and to produce the calldata, not to broadcast.

### Proof of control, PendingBond and evidence roots

Deployed 19 Sep 2026 to `identity`, `staking` and `reputation`, in that order.

`registerAgent` now takes a third argument: a signature from the agent address over
`registrationDigest(agentAddress, operator, ed25519PubKey)`. Without it anyone could
register an address they did not control and choose the public key verifiers would
check against it. The digest is returned **unprefixed** on purpose — a standard signer
applies the EIP-191 prefix itself, and returning it pre-prefixed makes every wallet
double-prefix and produce signatures the contract rejects.

Registration now mints `PendingBond` rather than `Active`. An unbonded agent cannot be
slashed, so it was accruing standing while being unaccountable by construction. The
first `depositStake` that carries it over `minimumStake` activates it, and nothing ever
returns to `PendingBond`.

Every proposal carries a Merkle root over the evidence behind it, readable from
`evidenceRoots(didHash)` once finalized and checkable through
`verifyEvidence(didHash, leaf, proof)`. `proposeReputation` gained the root as a third
parameter, so **the oracle must be upgraded in step with the reputation proxy** — an
oracle on the old two-argument ABI cannot propose to the new contract, and the reverse
reverts on every epoch.

The leaf commits to the settlement time in **seconds**, matching the block timestamp a
verifier reads off the chain. The oracle stores that time in milliseconds internally,
because the decay arithmetic works in milliseconds, and converts at the boundary. That
unit is load-bearing: committing to milliseconds was self-consistent and unverifiable,
so an honest oracle and an honest verifier computed different roots.

### The oracle bond binds, and the operator index is constant time

Deployed 19 Sep 2026 to `identity`, `staking` and `oracleBond`. `reputation` was
byte-identical to what was already deployed and was deliberately left alone.

`SigvaraOracleBond.isActiveOperator` now reads the bond as well as the status. `admit`
checks `bond >= bondAmount` once, at admission, so raising the requirement demoted
nobody: an operator let in at 1,000 kept proposing after the bar moved to 10,000, and
governance could only tighten the rule by removing each incumbent by hand.
`setBondAmount(0)` is refused for the same reason `setStakeView` refuses zero — a gate
that looks configured and admits everyone should not be reachable by passing an empty
argument.

**Check the operator's headroom before you raise the bar.** An operator sitting exactly
at `bondAmount` qualifies by equality, and any slash at all will then stop it proposing
at the next epoch, silently:

```bash
cast call <oracleBond proxy> "bondOf(address)(uint256)" <oracle wallet> --rpc-url arc_testnet
cast call <oracleBond proxy> "bondAmount()(uint256)" --rpc-url arc_testnet
cast call <oracleBond proxy> "isActiveOperator(address)(bool)" <oracle wallet> --rpc-url arc_testnet
```

`SigvaraIdentity` records each agent's position in its operator's list, so removal on
the transfer path is constant time instead of a linear scan. The scan was justified by
a comment saying an operator's list is short; nothing enforced that, and registration
became free once agents started at `PendingBond`, so an operator who registered enough
of them could push the removal past the block gas limit and lose the ability to transfer
any agent at all. Agents registered before this fall back to the scan. `getOperatorAgents`
still returns the whole list for existing consumers; `operatorAgentCount` and
`getOperatorAgentsPaged` are there for callers that cannot afford an unbounded return.

`initiateWithdrawal` reverts with `InsufficientStake` rather than an arithmetic panic
when you ask for more than you hold.

### Implementation history

Proxy addresses never change; these are the implementations behind them, newest first.

| Proxy | Implementation | Released |
|---|---|---|
| `identity` | `0xb2616f4a449726b195951b6a576aba6847e174ef` | 19 Sep, operator index |
| | `0x95d8592e7681550bee0c3e06c275ac1b94c873c6` | 19 Sep, proof of control + PendingBond |
| | `0x486b1c2230c80a77dbec68835ff5b58eccd164ab` | 18 Sep, operator transfer |
| `staking` | `0x3501f936f629dbc2e97ae0717c501456ca8215e0` | 19 Sep, narrowed coupling |
| | `0x28c23b766c2dabb5f2930905a5eeb660919b71ef` | 19 Sep, PendingBond activation |
| `reputation` | `0x0dc80134817e6fea978c06497f48391371a8413d` | 19 Sep, evidence roots |
| | `0xea5940bc23d7bf82113316dd03a3b1bb1bc2f084` | 18 Sep, maturity |
| `oracleBond` | `0xf8464144726850d222a06b85a230c8030673b933` | 19 Sep, bond binds on read |
| | `0x826fc09041a8a678b06336a253c55bd84f1fdc50` | 18 Sep, initial |

Read the current one straight from the proxy rather than trusting this table:

```bash
cast storage <proxy> 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc --rpc-url arc_testnet
```

## 6. Mainnet (5042)

Not before: an external audit and a real slashing
committee multisig in `COMMITTEE_ADDRESS`. Mechanically it is the same command
with `--rpc-url arc_mainnet` and real USDC for gas.

### Parameters at initialization

The testnet figures are testnet figures. The `Deploy.s.sol` defaults exist to make the
mechanics runnable, not because anyone costed them. Mainnet values and the policy behind
them are in [token.md](token.md#mainnet-parameters):

| Parameter | Testnet | Mainnet | Share of supply |
|---|---|---|---|
| `bondAmount` | 25,000 SVR | 2,500,000 SVR | 0.25% |
| `minimumStake` | 1,000 SVR | 10,000 SVR | 0.001% |
| `epochFee` | 0 | 0 at launch | n/a |

Two things worth carrying into the deploy.

**The bond is not the sybil defence.** `admit()` is `DEFAULT_ADMIN_ROLE`, so the operator
set is joined by vote and nobody buys their way in. What the bond buys is something the
committee can take, and `slash()` caps only at the bond itself, so the whole amount is at
risk rather than some fraction of it.

**The treasury has to be able to buy these.** Bonds are funded from buybacks off 64% of a
1% buy-side pool fee, which is 0.64% of buy volume, so every $1 of bond needs roughly
$156 of cumulative buy volume before the treasury can seat an operator. At 1% of supply
per operator that is about $15.6M of volume each at a $10M FDV, which in practice means
never running more than the operator you launched with. 0.25% keeps a five-operator set
inside reach.

### Raising a live bond

`isActiveOperator` reads `bond >= bondAmount` at call time, with no grandfathering, so
raising the floor above an incumbent's posted bond stops it proposing at its next epoch
while the service keeps running and logging failures. Top incumbents up first, raise
second, verify third. Full sequence in
[oracle/RUNBOOK-second-operator.md](../oracle/RUNBOOK-second-operator.md), step 0.

```bash
cast call <oracleBond proxy> "operators(address)(uint256,uint8,uint256)" <operator> --rpc-url arc_mainnet
cast send <oracleBond proxy> "setBondAmount(uint256)" <new floor wei> --private-key $ADMIN_KEY --rpc-url arc_mainnet
cast call <oracleBond proxy> "isActiveOperator(address)(bool)" <operator> --rpc-url arc_mainnet   # must stay true
```

## Checklist

- [ ] `pwsh scripts/check-arc.ps1` returns `5042002`
- [ ] deployer funded from faucet.circle.com
- [ ] `forge script script/Deploy.s.sol --rpc-url arc_testnet --broadcast`
- [ ] `deployments/5042002.json` committed
- [ ] oracle `.env` pointed at Arc, `ORACLE_ROLE` confirmed, first epoch scored
- [ ] SDK integration tests green against Arc
- [ ] verify whether native USDC exposes a usable `IERC20` for bonds (address, decimals)
- [ ] mainnet `bondAmount` and `minimumStake` set per [token.md](token.md#mainnet-parameters),
      not left at the `Deploy.s.sol` testnet defaults
