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

A simulate run prints the addresses it would have used and writes nothing. A
broadcast writes the artifact when forge runs the script locally, which is before the
transactions confirm. If a broadcast fails or is interrupted, the file can name
contracts that were never deployed, so section 5 ends with a check against the chain.
Do not use `--resume`: it runs the script again from the new nonce and rewrites the file
with addresses that do not exist. Start again instead.

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

Check that every proxy in the artifact is a proxy on this chain. The script loads ethers
from `oracle/node_modules`, so run `cd oracle && npm ci` once first. It reads each proxy's
implementation slot, exits non-zero on any that is not a proxy, and records which
implementation is live:

```bash
node scripts/record-implementations.mjs
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

- `site/assets/app.js`: the `IDENTITY`, `REPUTATION`, `SVR` and `STAKING` constants (`FEES`
  stays zero while `SigvaraEpochFees` is not deployed)
- `docs/quickstart.md` and `site/docs/quickstart.html`: the address samples
- SDK integration tests: from `packages/sdk`, export the `SIGVARA_*` variables listed in
  [arc.md](arc.md) section 4 and run `npx vitest run test/integration.test.ts`

## 8. Deploying the site

The site is static and lives on Hostinger under `sigvara.xyz`. The hosting username and the
document root are in hPanel (Websites, sigvara.xyz) and are deliberately not written here.
`site/*` maps onto the document root one-to-one, except `SECURITY.md` and `SECURITY_DEPLOYMENT_CHECKLIST.md`,
which are notes for people working in the repository and are never uploaded. Nothing deploys the site, so committing a change to `site/` does nothing
until it is uploaded, and this has been forgotten more than once. The Live checks workflow now notices: it compares every deployed file with `main`
on a schedule and fails, with an email to the owner, when they differ.

Upload individual files over TUS rather than using the static-archive deploy: the archive
replaces the entire document root, which would drop anything not in it.

**Three steps, and skipping any one of them leaves the old page live:**

1. **Bump the cache-busting version on every changed asset.** Pages reference assets as
   `assets/app.js?v=<short git hash>`, and those hashes are maintained by hand. If the
   asset changes but the query string does not, browsers and the CDN keep serving the
   cached copy forever. The asset on disk is then correct and the live page is still wrong,
   which is the confusing half of this failure.

   ```bash
   H=$(git rev-parse --short HEAD)
   # then update assets/<name>.js?v=... in every page that references the changed asset,
   # and upload those pages too
   grep -rln "app\.js?v=\|demo\.js?v=" site/*.html site/docs/*.html
   ```

2. **Upload.** Generate credentials with the hosting API's upload-URL endpoint, then for
   each file `POST` to create (expect 201) and `PATCH` the bytes (expect 204).

3. **Clear the cache.** Not optional. This edge has been observed serving a copy six days
   old against a one-hour `max-age`. An upload can return 201/204 with the live URL still
   serving the previous file.

Do the merge and the upload close together. The Live checks workflow fails in both orders:
files uploaded before the merge are ahead of `main`, and a merge before the upload leaves
`main` ahead of the files. It runs every few hours, so a gap of half a day can mean two failed runs. Running `node scripts/check-live.mjs site` after the cache clear shows what the
next run will say.

Then verify against the live URL with a cache-busting query string, rather than assuming:

```bash
curl -s "https://sigvara.xyz/assets/app.js?cb=$RANDOM" | grep -A2 'const FACTORS'
```

Checking the raw asset is necessary but not sufficient, because it bypasses the versioned
URL the page actually requests. Load the page itself and confirm the `<script src>` carries
the new hash.

**`assets/app.js` decodes the reputation struct positionally**, by word index into the
returned tuple, and carries each factor's maximum in its `FACTORS` table. Any change to
`ReputationData`'s field order, or to the `MAX_*_SCORE` constants, has to land here in the
same deploy or the app renders wrong numbers against the right contract.
