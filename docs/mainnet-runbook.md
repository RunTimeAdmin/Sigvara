# Arc mainnet runbook

The sequence for deploying the Sigvara registries to Arc mainnet (chain ID `5042`) and
handing them to their governance: what to run, what the output must say, and what to do
when it does not. It is written against the scripts in `script/` as they are today. Where
a script is safe on testnet and wrong on mainnet, the step says so.

Every step marked **Broadcast** spends real USDC and cannot be taken back. Run them
yourself, in your own terminal. A private key goes into your own shell, through `read -rs`
or a `--interactive` prompt, and nowhere else: not into a file, not into a chat, not into
a ticket.

**Status.** Rehearsed on 21 October 2026 on a local fork of Arc mainnet (Foundry
1.6.0-rc1), following sections 4 to 8 and 12 command by command with Safes created
through the canonical factory. A review of this file against the scripts and contracts
found two blockers, both now stated in section 2 and gated in section 1, and several
smaller faults, all fixed. Nothing here has run on mainnet, and nothing should until the
gates below are true.

All commands are bash (Git Bash on Windows is fine), run from the repository root. The
network background is in [arc.md](arc.md), the testnet version of this deployment is
[deploy-testnet.md](deploy-testnet.md), and the launch sequence this belongs to is
[launch-checklist.md](launch-checklist.md).

## 1. Gates

Do not start until every line is true. Each one protects something that cannot be
repaired afterwards.

| Gate | How you know |
|---|---|
| The external audit is finished, its findings are fixed and the report is published | Launch checklist, Phase 2. The audited commit is tagged, and the tree you deploy from is that tag. |
| SVR is live on mainnet and its address is published in [token.md](token.md) | Launch checklist, Phase 3. Section 5 checks the token on chain. |
| The admin delay is decided and someone has signed it off | Section 2. As built, the timelock does not bind the admin Safe. |
| Both Safes exist on mainnet and each has executed one transaction | A zero-value transaction from the Safe to itself, visible on the explorer. Finding out that a Safe cannot execute here is cheap now and expensive in section 7. |
| Each signer has confirmed, on their own device, the Safe's address and its owner list. The committee Safe is 3-of-5, the admin Safe has a threshold of 2 or more, and the deployer key owns neither | `check_safes` in sections 5 and 7 compares the chain to the lists the signers gave you. Nothing else here can tell their Safe from a lookalike. |
| A rehearsal of sections 5 to 8 and 12 passed on a fork | Section 4. |
| The parameters in section 2 are confirmed | Five of them are script defaults that nobody has costed. |
| Every signer needed for sections 7 and 8 is reachable in the same sitting | Both sections stall on a signature. |

If a Safe will be created through the canonical Safe 1.4.1 factory instead of the Safe web
app (check that the app lists Arc mainnet), the factory and singleton are deployed on
mainnet at the addresses used in `test/SplitAuthorityFork.t.sol`. Code was present at both
on 21 October 2026.

## 2. Decide first

### Parameters

| Parameter | Value | Env var | Where it comes from |
|---|---|---|---|
| `minimumStake` | 10,000 SVR | `MINIMUM_STAKE` | [token.md](token.md#mainnet-parameters) |
| `bondAmount` | 2,500,000 SVR | `ORACLE_BOND_AMOUNT` | token.md |
| `epochFee` | 0 (Bootstrap) | `EPOCH_FEE` | token.md |
| staking `challengePeriod` | 7 days, 604800 | `CHALLENGE_PERIOD` | script default |
| staking `unbondingPeriod` | 21 days, 1814400 | `UNBONDING_PERIOD` | script default |
| reputation `challengeWindow` | 6 hours, 21600 | `SCORE_CHALLENGE_WINDOW` | script default |
| `maturityRatePerDay` | 4 | `MATURITY_RATE_PER_DAY` | script default |
| operator `unbondingPeriod` | 7 days, 604800 | `ORACLE_UNBONDING` | script default |
| timelock delay | 48 hours, 172800 | `TIMELOCK_MIN_DELAY` | readiness review (48 hours minimum) |

[arc.md](arc.md#parameters-at-initialization) says of the script defaults that they exist
"to make the mechanics runnable, not because anyone costed them". Confirm each one now.
After the handover every parameter except the timelock delay changes by a Safe
transaction, and the delay changes only through the timelock itself.
`scripts/check-mainnet.sh` asserts the values in this table, so change them there too if
you choose differently. The amounts are written for an 18-decimal token. SVR has 18;
section 5 checks it.

### Wallets

| Role | What it is | Holds at the end |
|---|---|---|
| Deployer | The address in [token.md](token.md#addresses) | Nothing. Keep the key offline. |
| Oracle | A fresh EOA, hot key on the oracle host | `ORACLE_ROLE` on reputation and epochFees, and the operator bond |
| Committee | A 3-of-5 Safe | `SLASHING_COMMITTEE_ROLE` on reputation and staking, `SLASHER_ROLE` on oracleBond |
| Admin Safe | A Safe, threshold 2 or more | `DEFAULT_ADMIN_ROLE` on all five contracts |
| Timelock | `TimelockController`, deployed in section 7 | `UPGRADER_ROLE` on all five contracts |
| Treasury | The address in token.md | Slashed operator bonds, and the epoch fee reward pool |

"The five" below means `identity`, `reputation`, `staking`, `oracleBond` and `epochFees`.

token.md tells the public that a mainnet contract not created by the deployer address is
not ours. So that key also creates the Reader (section 6) and every later implementation
(section 12). Until section 7 it is admin and upgrader of all five, which is the window to
keep short. Afterwards it holds no role and needs no hot storage.

### The timelock does not bind the admin Safe

As `SplitAuthority.s.sol` builds it, the admin Safe holds `DEFAULT_ADMIN_ROLE` and the
timelock holds `UPGRADER_ROLE`. No contract names a different admin for the upgrader role,
so the Safe can grant itself `UPGRADER_ROLE` in one transaction and upgrade in the next.
On a fork both went through at once. The 48 hours delay upgrades that go through the
timelock. They do not stop the Safe from going around it.

Everything else the admin Safe does is immediate too: grant any role (including the
committee role to itself, which would let it cancel a slash filed against it),
`setSlashBeneficiary`, `setChallengeWindow` (no floor, so zero is allowed), identity's
`setStakeView` (any contract), `setOperatorBond(0x0)`, `setMinimumStake`, the operator
bond's `setUnbondingPeriod` (no floor), `setEpochFee` and `setRewardPool`. The signer
threshold is the only control on any of it. That is why the gates ask for a threshold of
two or more, and why the signers should be different people on different hardware.

This is not what the readiness review asked for. Its mandatory item 2 puts
`DEFAULT_ADMIN_ROLE` behind the timelock as well, and the header of `SplitAuthority.s.sol`
says the code cannot change without notice, which is true only of an honest Safe. There
are two ways to close the gap and neither is part of this runbook. Move admin behind the
timelock, which needs a change to the script and makes every lever in section 11 take 48
hours. Or change the contracts so `UPGRADER_ROLE` administers itself, which has to be in
the code the auditors see. Decide, and write down who signed it off, before section 7.

## 3. Where the scripts differ on mainnet

| Script | What it does | What this runbook does about it |
|---|---|---|
| `Deploy.s.sol` | With `SVR_ADDRESS` unset it deploys the faucet `SVRToken` (any address may mint up to 10,000 a day) and carries on. The role guard does not notice. | Step 6.1 compares the printed `SVR Token` to the published address and stops on any difference. |
| `Deploy.s.sol`, `DeployOracleBond.s.sol` | `MINIMUM_STAKE` and `ORACLE_BOND_AMOUNT` default to 1,000 SVR. Mainnet is 10,000 and 2,500,000. | Both are set explicitly, and `check_core` and `check_bond_and_fees` assert them. |
| `Deploy.s.sol` | Never calls `SigvaraStaking.initializeV2`, which stays callable by the admin once, with any value. It sets the unbonding period to zero where `setUnbondingPeriod` refuses anything under a day. | Step 6.3 uses it up with 21 days. `check_core` asserts that it has run. |
| `Deploy.s.sol`, `DeployOracleBond.s.sol` | They write the artifact when forge runs the script locally, which is before it sends anything. A broadcast that fails leaves the artifact naming contracts that may not exist. Their comments and [deploy-testnet.md](deploy-testnet.md) say the opposite. | Section 11: after any interrupted run, check the chain, and if it does not pass, start again with the artifact moved aside. |
| `forge script --resume` | Runs the script again against the deployer's new nonce and rewrites the artifact with addresses that were never deployed. The contracts land where the first run said. Observed on the fork. | Do not use it. |
| `DeployEpochFees.s.sol` | No mainnet role guard: `ORACLE_ADDRESS` and `REWARD_POOL` default to the deployer. It also never writes its proxy to the artifact. | Both are set explicitly. Step 6.5 records the address by hand. |
| `SplitAuthority.s.sol` | Skips any contract missing from the artifact, so an unrecorded `epochFees` would leave the deployer admin and upgrader of it, with no message. It prints `export TIMELOCK= 0x...` with a space in it. | Step 7.1 requires the plan to list all five. `check_authority` names all five. Type the export yourself. |
| `DeployOracleBond.s.sol`, `DeployEpochFees.s.sol` | Their usage headers show `--verify`. Arc has no explorer entry in `foundry.toml`, and adding one breaks `forge script` ([arc.md](arc.md#what-is-different-about-arc)). | Never pass `--verify`. `check_code` is the evidence instead. |
| `Upgrade.s.sol` | Its header says it can produce calldata for the timelock. It does not: it broadcasts with the key it is given, and after step 7.5 the deployer holds no upgrader role. | Section 12 upgrades through the timelock with `cast`. |
| `forge script` output | Prints USDC amounts as ETH. | Nothing to do. Arc's native token is USDC. |

## 4. Rehearse on a fork

A rehearsal finds out whether your parameters, your environment and your Safe addresses
work, for the price of a few minutes. Fork mainnet, work in a throwaway copy of the
repository so the rehearsal artifact cannot reach your commit, and use anvil's test
accounts for every key.

```bash
# terminal 1: mainnet state, held locally. It reads from the public endpoint and sends nothing to it.
anvil --fork-url https://rpc.mainnet.arc.io --port 8546

# terminal 2
git clone . ../sigvara-rehearsal && cp -r lib ../sigvara-rehearsal/lib && cd ../sigvara-rehearsal
(cd oracle && npm ci)
export RPC=http://127.0.0.1:8546 RPC_URL=http://127.0.0.1:8546
```

Anvil prints ten accounts and their keys. They are public, and bots sweep them on every
real chain, so use them in this terminal only and send nothing real to those addresses.
Export the ones below from the startup output as `ADDR_n` and `KEY_n`: account 0 is the
deployer, 1 the oracle, 3 the treasury, and 4 to 9 own the Safes.

The things that do not exist yet need stand-ins. The token is the faucet `SVRToken`, owned
by the treasury account so it can mint the bond later (`--constructor-args` must be the
last flag, because anything after it is swallowed). The Safes come from the canonical
factory, which is on mainnet.

```bash
forge create --rpc-url $RPC --private-key $KEY_3 --broadcast src/SVRToken.sol:SVRToken --constructor-args $ADDR_3
export SVR=0x...         # "Deployed to"

FACTORY=0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67    # canonical Safe 1.4.1
SINGLETON=0x41675C099F32341bf84BFc5382aF534df5C7461a
Z=0x0000000000000000000000000000000000000000
mksafe() {   # mksafe "[owner,owner,...]" threshold salt -> prints the new Safe's address
  local init
  init=$(cast calldata "setup(address[],uint256,address,bytes,address,address,uint256,address)" "$1" "$2" $Z 0x $Z $Z 0 $Z)
  cast call $FACTORY "createProxyWithNonce(address,bytes,uint256)(address)" $SINGLETON "$init" "$3" --rpc-url $RPC
  cast send $FACTORY "createProxyWithNonce(address,bytes,uint256)" $SINGLETON "$init" "$3" --private-key $KEY_0 --rpc-url $RPC >/dev/null
}
as_safe() {  # as_safe <safe> <to> <calldata>: send from the Safe's own address, fork only
  cast rpc anvil_setBalance "$1" 0x56BC75E2D63100000 --rpc-url $RPC >/dev/null
  cast rpc anvil_impersonateAccount "$1" --rpc-url $RPC >/dev/null
  cast send --unlocked --from "$1" "$2" "$3" --rpc-url $RPC
}

export COMMITTEE=$(mksafe "[$ADDR_4,$ADDR_5,$ADDR_6,$ADDR_7,$ADDR_8]" 3 1)
export SAFE=$(mksafe "[$ADDR_5,$ADDR_6,$ADDR_9]" 2 2)
export COMMITTEE_OWNERS=$ADDR_4,$ADDR_5,$ADDR_6,$ADDR_7,$ADDR_8 SAFE_OWNERS=$ADDR_5,$ADDR_6,$ADDR_9 SAFE_THRESHOLD=2
export DEPLOYER=$ADDR_0 ORACLE=$ADDR_1 TREASURY=$ADDR_3 DEPLOYER_PRIVATE_KEY=$KEY_0
```

Then run sections 5 to 8 and 12 against `$RPC` with those values. Four substitutions:

- Skip the `read` prompts, and replace each `--interactive` with `--private-key $KEY_n` for
  the right account. A prompt needs a terminal, and a script cannot answer it.
- Wherever a step has a Safe sign, use `as_safe`.
- Wherever the treasury funds the operator, mint from the stand-in token:
  `cast send $SVR "mint(address,uint256)" $ORACLE $(cast to-wei 2500000) --private-key $KEY_3 --rpc-url $RPC`.
- To wait out the timelock, move the fork's clock:
  `cast rpc evm_increaseTime 172801 --rpc-url $RPC && cast rpc evm_mine --rpc-url $RPC`.

The stand-in token's total supply is 0, so that one line of section 5 will not match, and
nothing else should differ. Finish with the fork test, which drives the same handover with
a Safe created through Arc's own factory and checks what the deployer can no longer do:

```bash
forge test --match-path test/SplitAuthorityFork.t.sol --fork-url https://rpc.testnet.arc.io -vv
```

It passed 6 of 6 on 21 October 2026. One of the six now returns early, because the slash
it replays has since executed, and none of them covers `epochFees`, which testnet does not
have. Do not read the 6 as more coverage than it is.

Gas measured on the fork on 21 October 2026, for everything the deployer sends in
sections 6 and 7: about 16 million gas in about 35 transactions, under 0.6 USDC at the
37 gwei that was the highest price seen. The Safe transactions cost extra, paid by whoever
executes them. Fund the deployer with a few USDC and no more.

## 5. Pre-flight

Nothing here sends a transaction. Start from a fresh clone at the audited tag with the
pinned libraries ([arc.md](arc.md#1-prerequisites)). Deploying from anything else risks
shipping code nobody audited, and `check_code` only proves something if the tree is the
audited one.

```bash
export TAG=...      # the audited tag
git clone --branch $TAG https://github.com/RunTimeAdmin/Sigvara.git sigvara-mainnet && cd sigvara-mainnet
git clone --depth 1 --branch v5.6.1 https://github.com/OpenZeppelin/openzeppelin-contracts.git lib/openzeppelin-contracts
git clone --depth 1 --branch v5.6.1 https://github.com/OpenZeppelin/openzeppelin-contracts-upgradeable.git lib/openzeppelin-contracts-upgradeable
git clone --depth 1 https://github.com/foundry-rs/forge-std.git lib/forge-std
(cd oracle && npm ci)
forge build
```

`lib/` is not in git, so the audited commit does not cover the OpenZeppelin code compiled
into every implementation. Print what you have:

```bash
git -C lib/openzeppelin-contracts rev-parse HEAD
git -C lib/openzeppelin-contracts-upgradeable rev-parse HEAD
git -C lib/openzeppelin-contracts status --porcelain
git -C lib/openzeppelin-contracts-upgradeable status --porcelain
```

The first two must be the commits the auditors reviewed (ask them for the dependency list
if the report does not name it). The last two must print nothing. Section 6.7 records both
commits in the artifact.

Then edit this block and paste it. The owner lists and the threshold are copied from what
each signer reads on their own device, never from the chain.

```bash
export RPC=arc_mainnet
export SVR=0x...         # token.md
export DEPLOYER=0x...    # token.md
export ORACLE=0x...
export COMMITTEE=0x...   # the 3-of-5 Safe
export SAFE=0x...        # the admin Safe
export TREASURY=0x...    # token.md
export SAFE_OWNERS=0x...,0x...,0x...
export SAFE_THRESHOLD=2
export COMMITTEE_OWNERS=0x...,0x...,0x...,0x...,0x...

record() {   # record key value [key value ...]: set keys in the artifact
  node -e 'const f="deployments/5042.json",a=JSON.parse(require("fs").readFileSync(f,"utf8"));for(let i=1;i<process.argv.length;i+=2){const k=process.argv[i],v=process.argv[i+1];a[k]=k==="deployBlock"?Number(v):v}require("fs").writeFileSync(f,JSON.stringify(a,null,2)+"\n")' "$@"
}
source scripts/check-mainnet.sh
```

The checks read the proxy addresses from `deployments/5042.json` and leave them in your
shell as `IDENTITY`, `REPUTATION`, `STAKING`, `BOND` and `FEES`, which later sections use.
In a new terminal, repeat this block and run
`load_artifact identity reputation staking oracleBond epochFees` to set them again.

The tree is the audited commit, and nothing will be overwritten:

```bash
git status --porcelain          # prints nothing
git rev-parse HEAD              # is the audited commit
ls deployments/5042.json        # must say No such file: Deploy.s.sol overwrites it
```

Every variable is set and well formed, and the five roles are five different addresses.
An empty variable would otherwise drop out of the later commands without a word:

```bash
for v in SVR DEPLOYER ORACLE COMMITTEE SAFE TREASURY SAFE_OWNERS SAFE_THRESHOLD COMMITTEE_OWNERS; do [ -n "${!v}" ] || echo "UNSET $v"; done   # prints nothing
for v in SVR DEPLOYER ORACLE COMMITTEE SAFE TREASURY; do cast to-check-sum-address "${!v}" >/dev/null || echo "BAD $v"; done   # prints nothing
printf '%s\n' $DEPLOYER $ORACLE $COMMITTEE $SAFE $TREASURY | tr A-F a-f | sort | uniq -d   # prints nothing
```

The chain and the money:

```bash
cast chain-id --rpc-url $RPC                   # 5042
cast balance $DEPLOYER --ether --rpc-url $RPC  # a few USDC, not a treasury
```

SVR is the token you think it is. Every amount in the protocol assumes 18 decimals, and
the bond token cannot be changed after `initialize`:

```bash
cast code $SVR --rpc-url $RPC | wc -c               # more than 3, which is what an address with no code prints
cast call $SVR "symbol()(string)" --rpc-url $RPC    # "SVR"
cast call $SVR "decimals()(uint8)" --rpc-url $RPC   # 18
cast call $SVR "totalSupply()(uint256)" --rpc-url $RPC   # 1000000000000000000000000000
```

The Safes are the ones the signers confirmed:

```bash
check_safes
```

Last, the key. It is read into your shell and checked against the address you expect:

```bash
read -rs -p "deployer key: " DEPLOYER_PRIVATE_KEY; echo; export DEPLOYER_PRIVATE_KEY
cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY"       # must print $DEPLOYER
```

**Stop if** any answer differs from the comment beside it or any check prints FAIL.

## 6. Deploy

All of section 6 is run by the deployer. Each script is simulated first and broadcast
second. A simulation sends nothing and writes nothing. `--slow` sends one transaction at
a time and waits for each, which suits a chain where the later calls depend on the
earlier ones. Add `--legacy` to any broadcast if fee estimation fails.

### 6.1 Simulate the core

```bash
export SVR_ADDRESS=$SVR ORACLE_ADDRESS=$ORACLE COMMITTEE_ADDRESS=$COMMITTEE
export MINIMUM_STAKE=$(cast to-wei 10000)
export CHALLENGE_PERIOD=604800 SCORE_CHALLENGE_WINDOW=21600 UNBONDING_PERIOD=1814400 MATURITY_RATE_PER_DAY=4

forge script script/Deploy.s.sol --rpc-url $RPC
```

The output must show: `Chain: 5042`; `SVR Token:` equal to `$SVR`; `Oracle:` and
`Committee:` equal to yours; `Min stake (wei): 10000000000000000000000`; the four
periods from section 2; `Dry run: deployments artifact not written.`

**Stop if** `SVR Token` is any other address, a line starts with `!!`, the script reverts
with `RolesNotSeparated`, or any value differs.

### 6.2 Broadcast the core

```bash
export FROM_BLOCK=$(cast block-number --rpc-url $RPC); echo $FROM_BLOCK   # write it down: the oracle starts here
forge script script/Deploy.s.sol --rpc-url $RPC --broadcast --slow
```

Nothing relevant exists before `FROM_BLOCK`. The script writes `deployments/5042.json`
before it sends its first transaction (section 3), so a run that fails leaves that file
naming contracts that may not exist. Section 11 says what to do then.

### 6.3 Use up the spare initializer, then check the core

`SigvaraStaking.initializeV2` was written for proxies deployed before unbonding existed,
and the deploy script never calls it. Until someone does, the admin can call it once with
any value, including zero. Use it up with the intended period (**Broadcast**). The prompt
asks for the deployer key:

```bash
load_artifact identity reputation staking
cast send $STAKING "initializeV2(uint256)" 1814400 --interactive --rpc-url $RPC
check_core
```

**Stop if** anything prints FAIL. Nothing has been deposited, so the answer is to abandon
this set and redeploy (section 11).

### 6.4 Operator bond registry

```bash
export SLASHER_ADDRESS=$COMMITTEE SLASH_BENEFICIARY=$TREASURY
export ORACLE_BOND_AMOUNT=$(cast to-wei 2500000) ORACLE_UNBONDING=604800

forge script script/DeployOracleBond.s.sol --rpc-url $RPC
```

The simulation must show `Slasher` equal to the committee, `Slash beneficiary` equal to the
treasury, `Bond amount (wei): 2500000000000000000000000` and `Unbonding (s): 604800`.
Then, **Broadcast**:

```bash
forge script script/DeployOracleBond.s.sol --rpc-url $RPC --broadcast --slow
```

It ends with `Recorded in: deployments/5042.json`.

### 6.5 Epoch fee registry

```bash
export IDENTITY_ADDRESS=$(node -p "require('./deployments/5042.json').identity")
export REWARD_POOL=$TREASURY EPOCH_FEE=0

forge script script/DeployEpochFees.s.sol --rpc-url $RPC
```

The simulation must show `Oracle` equal to the oracle wallet, `Reward pool` equal to the
treasury and `Epoch fee (wei): 0`. Then, **Broadcast**:

```bash
forge script script/DeployEpochFees.s.sol --rpc-url $RPC --broadcast --slow
```

This script does not record its address. Copy `EpochFees proxy` from the output and record
it now, before anything reads the artifact:

```bash
record epochFees 0x...    # the EpochFees proxy
```

### 6.6 The Reader

Stateless, no roles, nothing the protocol reads from. Deployed by the same key because of
the attribution rule in section 2.

```bash
export REPUTATION_ADDRESS=$(node -p "require('./deployments/5042.json').reputation")
export STAKING_ADDRESS=$(node -p "require('./deployments/5042.json').staking")
forge script script/DeployReader.s.sol --rpc-url $RPC                      # simulate
forge script script/DeployReader.s.sol --rpc-url $RPC --broadcast --slow   # Broadcast
record reader 0x...       # the Reader address it printed
```

`SMOKE_AGENT` needs a registered agent, and there is none yet. Run the smoke read after the
first registration instead.

### 6.7 Record who holds what, and check

```bash
record deployBlock ${FROM_BLOCK:?set it from 6.2} commit $(git rev-parse HEAD) openzeppelin $(git -C lib/openzeppelin-contracts rev-parse HEAD) openzeppelinUpgradeable $(git -C lib/openzeppelin-contracts-upgradeable rev-parse HEAD) oracle $ORACLE committee $COMMITTEE treasury $TREASURY
```

`FROM_BLOCK` is the block from 6.2. In a new terminal, type the number you wrote down in
its place. Then:

```bash
check_bond_and_fees
check_authority $DEPLOYER $DEPLOYER    # before the handover the deployer holds admin and upgrader on all five
```

Copy `deployments/5042.json` and the `broadcast/` folder somewhere safe. Do not copy
`cache/`: forge keeps run details there that are not for sharing. All three are untracked
until section 10.

**Stop if** anything prints FAIL.

## 7. Hand over authority

`script/SplitAuthority.s.sol` moves `DEFAULT_ADMIN_ROLE` to the admin Safe and
`UPGRADER_ROLE` to a new timelock, in phases, and only the last one cannot be undone. The
deployer gives authority away before it drops any, and `renounce` reads the chain and
refuses unless the replacements are demonstrably in place. The header of the script
explains why each phase exists. Section 2 says what the result does and does not
guarantee.

### 7.1 Plan

```bash
check_safes
PHASE=plan SAFE=$SAFE forge script script/SplitAuthority.s.sol --rpc-url $RPC
```

`check_safes` again, because the next phases give a Safe real power. The plan must list
all five contracts, each with `admin deployer` and `upgrader deployer`, and a Safe
threshold of 2 or more with at least 3 owners, and no `WARNING` line.

**Stop if** it lists fewer than five. A name missing from the artifact is skipped
silently, and that contract would keep the deployer as its admin.

### 7.2 Deploy the timelock (Broadcast)

```bash
export TIMELOCK_MIN_DELAY=172800
PHASE=deploy-timelock SAFE=$SAFE forge script script/SplitAuthority.s.sol --rpc-url $RPC --broadcast --slow
```

Read the address from the `address` line, then type the export yourself:

```bash
export TIMELOCK=0x...
record safe $SAFE timelock $TIMELOCK
check_timelock
```

`check_timelock` confirms the 48 hour delay, that only the Safe proposes and cancels, that
anyone may execute once the delay has run, and that the timelock administers itself.

### 7.3 The deployer grants admin to the Safe (Broadcast)

```bash
PHASE=grant-admin SAFE=$SAFE forge script script/SplitAuthority.s.sol --rpc-url $RPC --broadcast --slow
```

Five lines of `granted admin on ...`. Running it again prints `already admin`. Admin takes
effect at once, so this is the step where a wrong Safe address is expensive: whoever
controls it could revoke the deployer's roles and hold all five contracts. That is why
`check_safes` passed in 7.1 against the signers' own lists.

### 7.4 The Safe grants upgrader to the timelock

This step is the proof that the Safe works on this chain. It is also the one the
deployer cannot do for it.

```bash
PHASE=safe-calldata SAFE=$SAFE TIMELOCK=$TIMELOCK forge script script/SplitAuthority.s.sol --rpc-url $RPC
```

It prints five entries: the same calldata, a different `to` each. Each signer should
check the data on their own machine rather than trust the screen they were sent:

```bash
cast calldata "grantRole(bytes32,address)" $(cast keccak "UPGRADER_ROLE") $TIMELOCK
```

In the Safe app's Transaction Builder, create the five transactions (one batch is fine,
value 0), collect the threshold of signatures and execute. Then run the same command
again. It must end with `All grants landed.`

**Stop if** the Safe cannot execute or any entry still shows as pending. Do not renounce.

### 7.5 The deployer drops its authority (Broadcast, irreversible)

```bash
PHASE=renounce CONFIRM=yes-drop-the-deployer SAFE=$SAFE TIMELOCK=$TIMELOCK \
  forge script script/SplitAuthority.s.sol --rpc-url $RPC --broadcast --slow
```

It first checks the chain for each of these and refuses if one is missing: the Safe has
code, is not the deployer and is not controlled by it alone, the timelock has a delay and
the Safe as proposer, every one of the five has admin on the Safe and upgrader on the
timelock. A refusal (`SafeMissingAdmin`, `TimelockMissingUpgrader`, `DeployerCanActAlone`
and the others in the script) means the chain is not in the state you think it is. Fix the
state. Never edit the check. It does not check who owns the Safe. `check_safes` did.

```bash
check_authority $SAFE $TIMELOCK
check_holders
unset DEPLOYER_PRIVATE_KEY
```

`check_authority` asks about named addresses: on all five, the admin must be the Safe, the
upgrader the timelock, and the deployer, oracle and committee must hold neither.
AccessControl cannot list its members, so `hasRole` cannot see an address nobody thought
to name. `check_holders` can. It replays every role grant and revoke from the deploy block
and fails on any holder that is not expected, on all five and on the timelock. Allow about
a minute for each day of chain history on the public endpoint, which caps `eth_getLogs` at
10,000 blocks. Run it again after anything that touches roles.

## 8. Seat the operator, then record and verify the code

### 8.1 The operator posts its bond (Broadcast, locks real SVR)

The oracle wallet needs 2,500,000 SVR and gas. How the treasury funds it is token policy,
outside this file. Then, from the operator's own machine. `--interactive` asks for the key
without echoing it and keeps it out of the process list, which `--private-key` does not:

```bash
AMOUNT=$(cast to-wei 2500000)
cast send $SVR "approve(address,uint256)" $BOND $AMOUNT --interactive --rpc-url $RPC
cast send $BOND "depositBond(uint256)" $AMOUNT --interactive --rpc-url $RPC
cast call $BOND "operators(address)(uint256,uint8,uint256)" $ORACLE --rpc-url $RPC
```

The last call must start with 2500000000000000000000000 and then `1`, which is `Bonded`.
A bond below `bondAmount` cannot be admitted, and a bond posted in the wrong amount comes
back only through `initiateUnbond`, the 7 day wait and `withdrawBond`.

### 8.2 The Safe admits it, then turns the requirement on

Two Safe transactions, in this order. Turning the requirement on stops every oracle that
has not bonded and been admitted, so it goes second.

```bash
cast calldata "admit(address)" $ORACLE               # to: the oracleBond proxy
cast calldata "setOperatorBond(address)" $BOND       # to: the reputation proxy
```

Then:

```bash
cast call $BOND "isActiveOperator(address)(bool)" $ORACLE --rpc-url $RPC    # true
check_core $BOND
```

Do not start the oracle before this step is done. Running with the requirement unset is a
working state, but it is the state in which nothing is at risk for scoring falsely.

### 8.3 Record the implementations and check the code

```bash
CHAIN_ID=5042 node scripts/record-implementations.mjs
CHAIN_ID=5042 node scripts/record-implementations.mjs --check    # artifact matches chain
check_code
```

The first reads each proxy's ERC-1967 implementation slot off the chain and writes it to
the artifact, which is how a later upgrade that nobody recorded gets noticed. The script
refuses an endpoint that reports a different chain from the artifact's. `RPC_URL` points
it somewhere other than the public endpoint if that throttles.

`check_code` is what stands in for explorer source verification: each implementation's
runtime code equals what this tree builds, with the contract's own address masked out
because it is stored in the code as an immutable. It proves the code is this source only
if the tree is the audited commit and the libraries are the audited ones, so run it from
that tag with the checks in section 5 passed.

## 9. Bring up the oracle

[oracle/README.md](../oracle/README.md) is the reference. The second-operator runbook
([oracle/RUNBOOK-second-operator.md](../oracle/RUNBOOK-second-operator.md)) is the
model for hosting, with one warning: its tables hold testnet addresses and testnet
provider measurements, so take the structure and measure again.

A new compose project, a new volume and a new state file. The testnet oracle's state
(attestations, scan cursor) means nothing on mainnet. Exactly one primary instance runs
per chain.

| Setting | Mainnet value |
|---|---|
| `RPC_URL` | A provider, not the public endpoint. Before choosing, run the receipt and `eth_getLogs` checks from the second-operator runbook against it: providers prune the transaction index at different depths. |
| `IDENTITY_ADDRESS`, `REPUTATION_ADDRESS` | From `deployments/5042.json` |
| `FEE_REGISTRY_ADDRESS` | The `epochFees` proxy. At `epochFee` 0 gating stays off. |
| `FROM_BLOCK` | The block written down in 6.2 |
| `ORACLE_PRIVATE_KEY` | The oracle wallet, funded with USDC for gas |
| `ORACLE_ADMIN_TOKEN` | `openssl rand -hex 32` |
| `PAYMENT_VERIFICATION` | `required` ([oracle/README.md](../oracle/README.md): "what mainnet should run") |
| `PAYMENT_ASSET` | Arc's USDC ERC-20, the address in `oracle/.env.example`. Symbol USDC and 6 decimals on mainnet on 21 October 2026. Only transfers made through the ERC-20 emit a `Transfer` from that address. A plain native send emits none from it ([arc.md](arc.md) checklist, measured 3 October 2026), so those settlements are invisible to verification. Settle that question, see [ecosystem.md](ecosystem.md#what-it-means-for-the-oracle), before turning `required` on. |
| `PAYMENT_FEE_UNIT` | Calibrate before launch. The default was never tested against real money (see `.env.example`). |
| `EXTERNAL_RPC`, `EXTERNAL_IDENTITY_ADDRESS`, `EXTERNAL_REPUTATION_ADDRESS` | Mainnet's ERC-8004 pair, noted in `.env.example` |
| `EPOCH_HOURS` | `.env.example` calls 24 the production cadence. Set it against the 6 hour challenge window and against a checker's `seesProposals` rule (second-operator runbook, step 8). |

At start the log must say that the bonded operator check passed. The oracle prints that
line, or a warning that the wallet is not an admitted operator, only when reputation has
an `operatorBond` set. No line about bonds at all means `setOperatorBond` did not land. A
warning means the wallet was not admitted. Either way section 8.2 is unfinished.

A checker is a second bonded operator and needs its own 2,500,000 SVR bond. Bring it up
before the first agent registers and there is nothing to seed. If it joins later, step 7a
of the second-operator runbook is not optional.

## 10. Publish

1. Commit `deployments/5042.json`. It now carries the five proxies, `svrToken`, the
   `reader`, `safe`, `timelock`, `committee`, `oracle`, `treasury`, `deployBlock`,
   `commit`, the two OpenZeppelin commits and `implementations`. Tag the deployed commit.
2. Publish the transaction hashes from `broadcast/` with explorer links, as the slash
   drill log does, so anyone can follow the deployment without trusting a table.
3. Put the addresses where the testnet ones are: [README.md](../README.md), [token.md](token.md),
   the site constants, the SDK defaults. Order matters: addresses are published before any
   announcement, never after ([launch-checklist.md](launch-checklist.md), Phase 3).
4. `node scripts/check-docs.mjs` reads only the testnet artifact. It will not notice a
   stale mainnet address in the docs. Check them by hand against the artifact until the
   script learns chain 5042.
5. After the first agent registers, read it through the Reader with `SMOKE_AGENT` set, as
   the last proof that the registries and the Reader agree.

## 11. Abort and rollback

| Where you are | What stopping costs | What to do |
|---|---|---|
| A simulation shows something unexpected | Nothing | Stop. Fix the environment and simulate again. |
| A broadcast was interrupted: the RPC dropped, confirmations stalled, or a transaction reverted | Gas already spent | Do not use `--resume` (section 3). Run the checks. If every address in the artifact has code and they pass, the first run wrote the right artifact and you are done. If not, move `deployments/5042.json` and `broadcast/` into the incident note, and start section 6 again from 6.1. What did land is an orphan holding no value: list its addresses in the note so no one mistakes it for the deployment. |
| `check_core` or `check_bond_and_fees` fails after a deploy | One deploy's gas | The deployer still holds everything and nothing has been deposited. Abandon this set, move the artifact aside and redeploy. Never repair a set by hand, and never edit the artifact to point at one. |
| The Safe's transaction in 7.4 does not execute | Nothing | Stop before `renounce`. The deployer still holds admin and upgrader. |
| `renounce` refuses | Nothing | The chain is not in the state you think it is. Fix the state. |
| After `renounce` | Irreversible | The admin Safe and the timelock are the authority for good. The rest of this section is what they can do. |

### What remains after the handover

Each of these is a Safe transaction unless it says otherwise.

| Need | Lever |
|---|---|
| Stop the oracle proposing | `revokeRole(ORACLE_ROLE, oracle)` on reputation and on epochFees. Scores already proposed finalize after the window unless the committee rejects them with `rejectReputation`. |
| Take an operator out of the active set | `removeOperator(operator)` on oracleBond. It moves the operator to unbonding and does not seize the bond. Seizing is the committee's `slash(operator, amount)`. |
| Stop the bond requirement gating proposals | `setOperatorBond(0x0)` on reputation. This weakens the guarantee and is for a deliberate emergency only. Reverse it with `setOperatorBond` and the oracleBond address. |
| Stop charging | `setEpochFee(0)` |
| Change a parameter | `setMinimumStake` and `setChallengeWindow` (no floor on either), staking `setChallengePeriod` (not below 3 days) and `setUnbondingPeriod` (not below 1 day), oracleBond `setUnbondingPeriod` (no floor), `setBondAmount` (not zero) |
| A committee key or Safe is compromised | `revokeRole` for the old holder and `grantRole` for a new Safe, on reputation, staking and oracleBond. A slash already filed keeps the deadline it was filed with unless the committee cancels it. |
| A bad upgrade is scheduled | The Safe cancels it on the timelock, section 12. |
| A bad upgrade has run | A corrective upgrade takes the full timelock delay. |
| The admin Safe's signers are compromised | No lever. The Safe can grant itself any role and upgrade at once (section 2), and neither the committee nor the timelock checks it. Signer security is the whole control. |

**No contract has a pause switch.** A flaw that lets funds move cannot be frozen, and a
patch through the timelock takes 48 hours to land. The levers above reach roles and
parameters, not token movement. The readiness review lists an incident response plan as
open, and this section is not that plan.

## 12. Upgrades after the handover

Every registry is a UUPS proxy, and after section 7 the timelock is the only holder of
`UPGRADER_ROLE`. An upgrade made through it waits 48 hours in public and then anyone may
execute it. The admin Safe can still go around it (section 2). `Upgrade.s.sol` cannot do
this any more, so the steps are `cast` calls. Rehearsed on the fork on 21 October 2026.

Before anything is scheduled, run the in-repo upgrade tests and, for a layout change, a fork
test against mainnet, as [arc.md](arc.md#5-upgrading-a-deployed-proxy) describes. A layout
mistake never reverts. It reinterprets live data.

```bash
# 1. The new implementation. Any funded key can deploy it, and the deployer key is the one to
#    use (section 2). The prompt asks for it.
forge create --rpc-url $RPC --interactive --broadcast src/SigvaraStaking.sol:SigvaraStaking
export NEWIMPL=0x...     # Deployed to

# 2. Check it now, before anyone signs, not after the delay has run
check_new_implementation $NEWIMPL SigvaraStaking

# 3. What the timelock will run, and a one-off salt
ZERO=0x0000000000000000000000000000000000000000000000000000000000000000
DATA=$(cast calldata "upgradeToAndCall(address,bytes)" $NEWIMPL 0x)    # 0x, or the reinitializer call
SALT=$(cast keccak "staking-upgrade-2026-11-01")
cast calldata "schedule(address,uint256,bytes,bytes32,bytes32,uint256)" $STAKING 0 $DATA $ZERO $SALT 172800
```

The Safe sends that calldata to `$TIMELOCK` (to: the timelock, value 0). Then:

```bash
ID=$(cast call $TIMELOCK "hashOperation(address,uint256,bytes,bytes32,bytes32)(bytes32)" $STAKING 0 $DATA $ZERO $SALT --rpc-url $RPC)
cast call $TIMELOCK "getOperationState(bytes32)(uint8)" $ID --rpc-url $RPC    # 1 waiting, 2 ready, 3 done
```

Publish the new implementation's address and the source diff at once, because the delay
exists to give everyone that notice. When the state reads 2:

```bash
cast send $TIMELOCK "execute(address,uint256,bytes,bytes32,bytes32)" $STAKING 0 $DATA $ZERO $SALT --interactive --rpc-url $RPC
CHAIN_ID=5042 node scripts/record-implementations.mjs      # appends the old implementation to history
check_code
```

Two things the script used to do and the timelock does not. The dependency check in
`Upgrade.s.sol` (identity before reputation and staking, [arc.md](arc.md#5-upgrading-a-deployed-proxy))
is gone, and once an operation is ready anyone may execute it, in any order. Upgrades that
depend on one another go through one `scheduleBatch`, or the later one is scheduled with
the earlier one's operation id as its predecessor in place of `$ZERO`.

To withdraw a scheduled upgrade, the Safe sends `cancel(bytes32)` with `$ID` to the
timelock. Executing early reverts with `TimelockUnexpectedOperationState`. The Safe
calling `upgradeToAndCall` directly reverts with `AccessControlUnauthorizedAccount`, but
only until it grants itself the role.

## 13. Known gaps

This runbook does not close these.

- The admin Safe can bypass the timelock (section 2). There is no pause switch and no
  incident response plan (section 11).
- Explorer source verification is not documented for Arc. Until it is, `check_code` and
  the commit recorded in the artifact are the evidence that an address runs this source.
- One bonded operator at launch unless a checker is seated. A checker needs its own
  2,500,000 SVR, which is 0.25% of supply and which [arc.md](arc.md#6-mainnet-5042) says
  keeps a five-operator set within the treasury's reach.
- The oracle key is a hot key on a VPS. The readiness review recommends HSM-backed keys.
- No mainnet monitoring beyond what the oracle logs. The watcher alerts on divergence
  between two operators, and with one there is nothing for it to compare.
- `scripts/check-docs.mjs` does not know chain 5042 (section 10).
