# Sigvara Arc Mainnet Launch Checklist

Sequenced by gate, not by date. The wider plan, adoption included, is the [roadmap](roadmap.md). Slip any item rather than skip the gate it protects.

## Where this stands

As of 6 November 2026. Everything runs on Arc testnet, and nothing is on mainnet. What runs where is in the
[runbook](operations-runbook.md). There has been no external audit, and nobody outside the team gates on a score yet.

**In progress, with dates.**
- The adversarial slash drill: day 7 from 10 November 03:46 UTC and day 21 from 24 November 03:45 UTC
  ([slash-drill.md](slash-drill.md)).
- The slash keepers went live on 5 November. C should read `held` from 10 November, and neither has yet
  executed a real slash.
- The publisher has not yet posted through the policy signer's new rule, which requires the feedback hash
  to match its file. Three earlier real posts all pass it.

**Open before mainnet.**
- An external audit, and fixing what it finds (Phase 2).
- The staking half of the contract upgrade batch, on testnet after the drill: a cap on the challenge period
  below the dispute period, refusing the admin as a slash's victim and a zero-amount withdrawal. The
  reputation and oracle bond halves went in on 5 November.
- The handover: moving testnet roles to a Safe and a timelock, after the drill, since `executeSlash` needs
  the reporter still on the committee.
- A review of retention by counsel, before public outcome retrieval and peer import on mainnet.
- The operators' spending as agents grow: a limit on total epoch spend, and the reads an unstaked registration adds.

**Open, and not blocking mainnet.**
- Design partners, the first users from outside the team.
- The challenge process for negative outcomes. Mainnet launches with payer outcomes positive only
  ([ADR 0006](adr/0006-payer-signed-outcomes.md)), and non-delivery cannot be used as a ground for a slash until
  it exists ([ADR 0010](adr/0010-what-can-be-slashed.md)). The ADR on who rules comes first.
- The reward distributor stays a draft until mainnet.
- Moving the testnet compose files to the mainnet pattern (a file secret, read-only, non-root).
- A way to notice a dead watcher. It alerts on changes only, so a watcher that has stopped looks like one with
  nothing to report.
- A wiki pass whenever `main` moves.

## Phase 1 — Prove the mechanism (testnet, weeks 1–2)

- [x] **Live slash drill on a throwaway agent.** Done. A throwaway was registered at exactly `minimumStake` (1,000 SVR on testnet), `initiateSlash` was filed from the committee key on 20 September 2026, and `executeSlash` was called permissionlessly on 3 October 2026 after the seven-day challenge window. The log carries the filing and execution transactions with explorer links and says first that it was a drill; the registration, bond and claim transactions are not listed. The demo agent was not targeted: `Slashed` is terminal.
- [x] **Publish the drill log** at `docs/slash-drill-log.md` and link it from the whitepaper roadmap, item 2. Done.
- [x] **Disclose the self-administered property**: all three drill keys are held by one operator. That is a property of the drill, not a governance proof. The log and the whitepaper both say so.

## Phase 2 — External audit (weeks 2–6, overlaps Phase 1)

- [ ] **Engage an external auditor** for the Sigvara registries (`SigvaraIdentity`, `SigvaraStaking`, `SigvaraReputation`, `SigvaraOracleBond`). `SigvaraEpochFees` is left out of launch and of this audit ([ADR 0005](adr/0005-governance-and-emergency-powers.md)). Audits and development are funded separately from the token — ecosystem grants and CounterAudit integration revenue, not SVR.
- [ ] **Fix findings, re-audit critical items** before any mainnet deployment transaction is signed.
- [ ] **Publish the audit report** on sigvara.xyz and in the repo. A token with no audit and an oracle run by one party is exactly what a skeptic attacks first.

## Phase 3 — SVR token launch on Tolly (Arc)

Launched 9 November 2026 at 01:20:37 UTC: [`0xc79298521Ae84e7a43d20E71A2B2A1BB540E889B`](https://explorer.arc.io/address/0xc79298521Ae84e7a43d20E71A2B2A1BB540E889B), pool `0xa9Be080545C6d61529c27294512bDb3Bde67A735`, launch transaction [`0x67ac918f…d749`](https://explorer.arc.io/tx/0x67ac918fbe80bd9f4556c44f03daf739aa996b6d63d34b99201ed69b5126d749) from the deployer through the pad. The first buy and what it is held for are in [token.md](token.md#team-acquisitions); the 5,000,000 SVR for the two oracle operator bonds stays with the deployer until they are posted, and the treasury share, 17,283,004 SVR, is locked until 9 May 2027 in [`0xE246eaF9…B8FB`](https://explorer.arc.io/address/0xE246eaF919a39d7E0ff656320f7132Ee8AfBB8FB).

- [x] **Confirm deployer address** `0x8857A7C392d1Bb1A68647c64Ce18D9AA1Fd023b0` is the sole creator; anything attributed to Sigvara not created by it is not ours.
- [x] **Seed the Uniswap V3 pool** (1% tier, USDC quote) with the whole 1B supply single-sided. LP NFT goes to Tolly's ownerless collect-only fee locker — no withdraw path in code.
- [x] **Publish the token address** on `docs/token.md` and sigvara.xyz *before* any social announcement. Never announce on social first.
- [x] **Anti-snipe cap** (3% of supply per wallet, first 300 seconds) is the only deviation from vanilla ERC-20. After 300 seconds it is a plain token — exactly what the bond contracts require.
- [x] **Team position**: whatever is bought on the open market at the opening price, disclosed same-day. No split buys to work around the cap.
- [ ] **Treasury buybacks** run on a published schedule from the 64% creator share of buy-side fees (paid in USDC via the fee locker), not in response to price. No fee revenue paid to the team; no treasury SVR sold.

## Phase 4 — Mainnet registry deployment (gated on Phase 2)

- [ ] **Deploy registries to Arc mainnet** (chain ID 5042) initialized with the SVR address, `minimumStake` = 10,000 SVR, and `bondAmount` = 2,500,000 SVR. The deploy scripts refuse less than either on this chain ([ADR 0005](adr/0005-governance-and-emergency-powers.md), decision 11). `SigvaraEpochFees` is not deployed at launch.
- [ ] **Make the treasury a timelock before the bond registry.** Create the admin Safe first, then run `PHASE=deploy-treasury` in `script/SplitAuthority.s.sol` and pass the address it prints as `SLASH_BENEFICIARY` to `script/DeployOracleBond.s.sol`, which refuses a plain account on this chain. Publish the address in `docs/token.md`. After `PHASE=deploy-timelock`, run `check_treasury` and, with `TREASURY_FROM_BLOCK` set to a block before the treasury was deployed, `check_treasury_queue` from `scripts/check-mainnet.sh` ([ADR 0005](adr/0005-governance-and-emergency-powers.md), decision 13). The same steps were rehearsed on Arc testnet: [treasury-rehearsal.md](treasury-rehearsal.md).
- [ ] **Hand the authority over in the order `script/SplitAuthority.s.sol` documents, and check the holders before the step that cannot be undone.** The script needs all four registries in `deployments/5042.json` and stops at one that is missing, zero or without code. `PHASE=renounce` also refuses a timelock with a delay under 48 hours, one the Safe cannot propose to or cancel on, one that not everyone can execute on or that the Safe or the deployer administers, and a Safe with a threshold under 2. Those are the timelock's and the Safe's own answers, so phases 3 and 5 also refuse a `TIMELOCK` whose code is not the `TimelockController` that `PHASE=deploy-timelock` deploys (the metadata solc appends is ignored, because it depends on where the sources were read; if it refuses a timelock that phase 2 built, run the phase from the commit that deployed it) or that the deployer did not create (a constructor can set state that the code does not show), and a `SAFE` that is an EIP-7702 delegated account. The owners and threshold are the Safe's own answers too, and Safe's code reads who may act from storage that its getters list only in part, so phase 5 believes them only from a Safe proxy running code Safe published (1.3.0, 1.4.1 or 1.5.0, each at Safe's own address with the code hash Safe lists, the implementation read from the proxy's storage) that Safe's factory created, with Safe's code running its setup and that setup delegating to nothing but Safe's SafeToL2Setup pointed at another of Safe's implementations, and only one that came out of its setup running SafeL2 and still runs it: pass the factory as `SAFE_FACTORY` and the creation transaction's input as `SAFE_CREATION_CALL`, and the script works out the address. It refuses a Safe with a module enabled, because a module acts as the Safe without its owners, one that keeps the deployer as a module, one with a guard, which can refuse every transaction the Safe makes, and one with a fallback handler that is not Safe's own, which answers ERC-1271 for it. Any other `SAFE` is refused. It also refuses a registry with a reinitializer still open, which the admin could call once with no delay. What the Safe has done since it was created is in its log, not its state, so `PHASE=renounce` also refuses to run without a passing report from `scripts/check-before-renounce.mjs` that is under an hour old and that neither the Safe nor the deployer has made a transaction since (a hard gate, the owner's decision of 2026-11-02). That script replays the role grants (`check-role-holders.mjs` with `BEFORE_RENOUNCE=1`) and the Safe's log from the block it was made in: no DelegateCall except to Safe's MultiSendCallOnly, no module ever enabled or acting, no implementation change after creation, owners and threshold as the log gives them, no on-chain approval still waiting, and one logged transaction for every nonce. It also lists every proxy the deployer created, from its nonce, and fails on one the artifact does not name unless its address is in `REVIEWED_UNRECORDED_PROXIES`. The Safe must be a SafeL2 from its creation, whose log records each transaction's operation. Two of the signers still review every Safe transaction before it is signed, phase 4's included, each on their own device. Run `check_timelock` and `check_safes` from `scripts/check-mainnet.sh` before it as well: the Safe's owners are the one thing they check that the script cannot, because they come from what the signers read on their own devices. After the Safe has removed the deployer's admin and before `PHASE=renounce`, run `SAFE=.. TIMELOCK=.. COMMITTEE=.. ORACLE=.. GUARDIAN=.. SAFE_CREATION_BLOCK=.. node scripts/check-before-renounce.mjs`; the renounce takes its report and nothing less. It reads the role holders, the Safe and the timelock's queue at one finalized block, and fails while any timelock operation is still waiting or ready unless its id is in `REVIEWED_TIMELOCK_OPERATIONS`: anyone may execute one once its delay has run, so it lands after the handover. Give the renounce the same list; it reads every operation's state again just before it broadcasts. AccessControl cannot list holders, so a second upgrader is visible only in the grant history it replays. Run `scripts/check-role-holders.mjs` with the same addresses and without `BEFORE_RENOUNCE` after the renounce ([ADR 0005](adr/0005-governance-and-emergency-powers.md)). The replay starts at the artifact's `deployBlock`, which `script/Deploy.s.sol` writes: leave it as written, because a later block hides the grants before it.
- [ ] **Run an execution keeper.** Slash execution is permissionless on purpose, so nothing executes a slash
  unless someone does: a funded, redundant job that calls `executeSlash` as soon as a window closes, and
  watches for `expireSlash` and `expireDispute`. `oracle/keeper.js` is that job ([runbook, section 7](operations-runbook.md#7-slash-keeper)). It skips a proposal whose reporter has left the
  committee, because `executeSlash` reverts with `ReporterNotAuthorized` for it
  ([ADR 0005](adr/0005-governance-and-emergency-powers.md), decision 12). A slash that is not executed within 14 days of its deadline
  lapses and has to be filed again after the cooldown ([ADR 0005](adr/0005-governance-and-emergency-powers.md),
  decision 7). It also races its own expiry: until `expireSlash` lands, execution is still allowed. Running
  on Arc testnet since 5 November 2026; mainnet needs its own pair, funded with their own keys.
- [ ] **Initialize oracle bonds** for admitted operators. `admit()` takes the admin role, so nobody buys their way in; there is no on-chain vote. The bond is what a corrupt oracle can lose.
- [ ] **Pin and rehearse the operator deployment.** Operators run a pinned commit (`SIGVARA_REF` in `docker-compose.mainnet.yml`), never a branch. Each `.env` is mode 600 and the key is a file secret. State is copied off the box nightly and the restore drill in [operations-runbook.md](operations-runbook.md) has been run once. The key-compromise sequence in [incident-operator-key.md](incident-operator-key.md) has been walked through with the Safe signers.
- [ ] **Confirm Arc's finality on mainnet before one confirmation counts.** `PAYMENT_MIN_CONFIRMATIONS=1` in `oracle/.env.mainnet.example` assumes a block cannot be reorganized once it is served. That is Arc's documented design and not something this repository tests ([payment-backed-attestations.md](payment-backed-attestations.md#configuration)). Read a block's hash, read the same block number again ten blocks later, and repeat across a day: the hashes must match. If one ever differs, raise `PAYMENT_MIN_CONFIRMATIONS` and `PAYMENT_SCAN_CONFIRMATIONS` before a payment counts.
- [ ] **Verify impersonation guidance**: only the published address is genuine SVR. `countersig.network` redirects to sigvara.xyz and serves nothing.

## Phase 5 — Flip monetization on

- [ ] **Deploy the epoch-fee module and set `epochFee` > 0** once real volume exists. The module is left out of launch and of the first audit ([ADR 0005](adr/0005-governance-and-emergency-powers.md)); its charge moves into the proposal transaction, and it is audited before it is deployed. This is when metered monetization (verification lookups, bond checks, challenge windows via Circle nanopayments/x402 at sub-cent rates) turns on. Bootstrap at zero is deliberate — charging before utility exists is the POAP mistake.
- [ ] **Meter per-event fees** aligned with the Circle x401+x402 demo pricing precedent.
- [ ] **Staking rewards stay off** until treasury buybacks have built inventory. Cap: 5% of treasury SVR balance per quarter, published before the period, not after. Only bonded agents and bonded oracle operators are eligible — holding SVR earns nothing.

## Phase 6 — Bond governance (ongoing, min. every 2 quarters)

Review `bondAmount` and `minimumStake` when any of these first become true:
- A single attested settlement exceeds 20% of the operator bond's market value.
- Active agents pass 250.
- SVR's 30-day average moves more than 3x since the last review.

Raising `bondAmount` takes effect immediately, no grandfathering: incumbents topped up first, floor raised second.

## What these numbers are not

They are a starting point, not a derivation. The payoff from corrupting a score depends on adoption that does not exist yet. The review triggers exist because the first honest thing to say about these figures is that they will be wrong later.
