# Deploying to Arc testnet

Chain ID `5042002`. Gas is USDC. This is the runbook for the first deployment;
`docs/arc.md` has the network background and the upgrade procedure.

Run every command from the repository root with `lib/` populated (see
[docs/arc.md](arc.md) section 1).

## Before you start

**Read this first.** Both structural findings from the security scan of
17 September 2026 are now closed.

An agent could hold Active status with zero collateral and so be permanently
unslashable. Identity checks the bond before letting an agent become Active,
reputation refuses to score an unbonded agent, and registration now leaves an
agent `PendingBond` rather than Active until a deposit clears the floor.

Registration proved no control of the agent address, so anyone could claim an
address they did not own and choose the key verifiers would check. The agent
address must now sign for its own registration, and the digest binds the chain,
the registry, the operator and the Ed25519 key.

The registries are UUPS proxies, so both fixes land as upgrades on these same
addresses rather than a redeploy.

## 1. Addresses and keys

| Role | Address | Notes |
|---|---|---|
| Deployer (testnet) | `0x18CBcE50390f5f6ebe4E20Fc17833F25c8D94811` | Keeps `DEFAULT_ADMIN_ROLE` and `UPGRADER_ROLE` on every contract |
| Treasury | `0xeDC966e23318782c0241aBe1790bd221b8aCE867` | Not used by this deployment |
| Oracle | choose one | The wallet the oracle service signs with |
| Committee | choose one | `SLASHING_COMMITTEE_ROLE` |

The testnet deployer is deliberately a different address from the one in
[docs/token.md](token.md), which is reserved for the mainnet SVR launch and the
mainnet registry deployment. Keeping them apart means a testnet key, which is
handled far more casually, never touches anything that matters on mainnet.

Use three distinct addresses. If the oracle or the committee is the deployer,
one key can propose a score, slash the agent it just scored, and upgrade the
contracts that did it, which leaves no independent party in the optimistic
model at all. The script prints a loud warning on testnet when that happens and
refuses to run at all on mainnet.

## 2. Fund the deployer

Get testnet USDC from [faucet.circle.com](https://faucet.circle.com), selecting
Arc testnet. A full deploy is three implementations, three proxies, a token and
five role grants: about **0.45 USDC** at 45 gwei. A few USDC covers it many
times over.

```bash
cast balance 0x18CBcE50390f5f6ebe4E20Fc17833F25c8D94811 --rpc-url arc_testnet --ether
```

## 3. Simulate

Never broadcast a first deploy without simulating it. Export the key in your own
shell; it must not be written to a file in the repository.

Run from the repository root, not from a subdirectory: `forge` resolves
`foundry.toml`, the RPC aliases and the `deployments/` path relative to it.

PowerShell:

```powershell
cd D:\Sigvara
$env:DEPLOYER_PRIVATE_KEY = "0x..."
$env:ORACLE_ADDRESS       = "0x..."
$env:COMMITTEE_ADDRESS    = "0x..."
$env:MINIMUM_STAKE        = "1000000000000000000000"   # 1,000 SVR

forge script script/Deploy.s.sol --rpc-url arc_testnet -vvvv
```

bash:

```bash
cd /d/Sigvara
export DEPLOYER_PRIVATE_KEY=0x...
export ORACLE_ADDRESS=0x...
export COMMITTEE_ADDRESS=0x...
export MINIMUM_STAKE=1000000000000000000000   # 1,000 SVR

forge script script/Deploy.s.sol --rpc-url arc_testnet -vvvv
```

Clear the key from the shell when you are done: `Remove-Item Env:DEPLOYER_PRIVATE_KEY`
in PowerShell, `unset DEPLOYER_PRIVATE_KEY` in bash.

Check the printed roles and periods, and confirm there is no role-separation
warning.

A simulate run prints the addresses it would have used and writes nothing. The
artifact is only touched on a real broadcast, so there is no file to clean up
between the two runs and no way to commit an address that does not exist.

## 4. Broadcast

```bash
forge script script/Deploy.s.sol --rpc-url arc_testnet --broadcast -vvvv
```

Add `--legacy` if fee estimation misbehaves. Record the deploy block, which the
oracle needs as `FROM_BLOCK`:

```bash
cast block-number --rpc-url arc_testnet
```

## 5. Verify what landed

```bash
# From deployments/5042002.json
cast call <staking>    "minimumStake()(uint256)"    --rpc-url arc_testnet
cast call <staking>    "challengePeriod()(uint256)" --rpc-url arc_testnet
cast call <staking>    "unbondingPeriod()(uint256)" --rpc-url arc_testnet
cast call <reputation> "challengeWindow()(uint256)" --rpc-url arc_testnet
```

Confirm the role wiring, which is what makes the system function:

```bash
# staking holds STAKING_CORE_ROLE on identity and reputation
cast call <identity>   "hasRole(bytes32,address)(bool)" $(cast keccak "STAKING_CORE_ROLE") <staking> --rpc-url arc_testnet
cast call <reputation> "hasRole(bytes32,address)(bool)" $(cast keccak "STAKING_CORE_ROLE") <staking> --rpc-url arc_testnet
cast call <reputation> "hasRole(bytes32,address)(bool)" $(cast keccak "ORACLE_ROLE") <oracle> --rpc-url arc_testnet
cast call <staking>    "hasRole(bytes32,address)(bool)" $(cast keccak "SLASHING_COMMITTEE_ROLE") <committee> --rpc-url arc_testnet
```

Then commit the artifact produced by the **broadcast** run:

```bash
git add deployments/5042002.json && git commit -m "deploy: Arc testnet (5042002)"
```

## 6. Point the oracle at it

Copy `oracle/.env.example` to `oracle/.env` and set `RPC_URL`,
`IDENTITY_ADDRESS`, `REPUTATION_ADDRESS`, `FROM_BLOCK` (deploy block minus a
small buffer) and `ORACLE_PRIVATE_KEY` (the wallet holding `ORACLE_ROLE`, funded
with USDC for gas). Set `ORACLE_ADMIN_TOKEN` with `openssl rand -hex 32`: the
service refuses to start on a non-loopback bind without it.

Run it locally for a few epochs before putting it on a VPS. It is far cheaper to
debug, and it validates the whole loop against a real chain:

```bash
cd oracle && npm ci && node index.js
```

## 7. Update the surfaces that read the addresses

Once `deployments/5042002.json` exists, these stop being placeholders:

- `site/app.html` — the four `0x0000…` constants at the top of `assets/app.js`
- `docs/quickstart.md` and `site/docs/quickstart.html` — the `0x…` samples
- SDK integration tests — export `SIGVARA_*` and run `npx vitest run test/integration.test.ts`
