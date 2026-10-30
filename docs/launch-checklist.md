# Sigvara Q4 Arc Mainnet Launch Checklist

Sequenced against the Q4 2026 SVR mainnet milestone. Dates are targets, not commitments — slip any item rather than skip the gate it protects.

## Phase 1 — Prove the mechanism (testnet, weeks 1–2)

- [x] **Live slash drill on a throwaway agent.** Done. A throwaway was registered at exactly `minimumStake` (1,000 SVR on testnet), `initiateSlash` was filed from the committee key on 20 September 2026, and `executeSlash` was called permissionlessly on 3 October 2026 after the seven-day challenge window. The log carries the filing and execution transactions with explorer links and says first that it was a drill; the registration, bond and claim transactions are not listed. The demo agent was not targeted: `Slashed` is terminal.
- [x] **Publish the drill log** at `docs/slash-drill-log.md` and link it from the whitepaper roadmap, item 2. Done.
- [x] **Disclose the self-administered property**: all three drill keys are held by one operator. That is a property of the drill, not a governance proof. The log and the whitepaper both say so.

## Phase 2 — External audit (weeks 2–6, overlaps Phase 1)

- [ ] **Engage an external auditor** for the Sigvara registries (`SigvaraIdentity`, `SigvaraStaking`, `SigvaraReputation`, `SigvaraOracleBond`). `SigvaraEpochFees` is left out of launch and of this audit ([ADR 0005](adr/0005-governance-and-emergency-powers.md)). Audits and development are funded separately from the token — ecosystem grants and CounterAudit integration revenue, not SVR.
- [ ] **Fix findings, re-audit critical items** before any mainnet deployment transaction is signed.
- [ ] **Publish the audit report** on sigvara.xyz and in the repo. A token with no audit and an oracle run by one party is exactly what a skeptic attacks first.

## Phase 3 — SVR token launch on Tolly (Arc)

- [ ] **Confirm deployer address** `0x8857A7C392d1Bb1A68647c64Ce18D9AA1Fd023b0` is the sole creator; anything attributed to Sigvara not created by it is not ours.
- [ ] **Seed the Uniswap V3 pool** (1% tier, USDC quote) with the whole 1B supply single-sided. LP NFT goes to Tolly's ownerless collect-only fee locker — no withdraw path in code.
- [ ] **Publish the token address** on `docs/token.md` and sigvara.xyz *before* any social announcement. Never announce on social first.
- [ ] **Anti-snipe cap** (3% of supply per wallet, first 300 seconds) is the only deviation from vanilla ERC-20. After 300 seconds it is a plain token — exactly what the bond contracts require.
- [ ] **Team position**: whatever is bought on the open market at the opening price, disclosed same-day. No split buys to work around the cap.
- [ ] **Treasury buybacks** run on a published schedule from the 64% creator share of buy-side fees (paid in USDC via the fee locker), not in response to price. No fee revenue paid to the team; no treasury SVR sold.

## Phase 4 — Mainnet registry deployment (gated on Phase 2)

- [ ] **Deploy registries to Arc mainnet** (chain ID 5042) initialized with the SVR address, `minimumStake` = 10,000 SVR, and `bondAmount` = 2,500,000 SVR. The deploy scripts refuse less than either on this chain ([ADR 0005](adr/0005-governance-and-emergency-powers.md), decision 11). `SigvaraEpochFees` is not deployed at launch.
- [ ] **Hand the authority over in the order `script/SplitAuthority.s.sol` documents, and check the holders before the step that cannot be undone.** The script needs all four registries in `deployments/5042.json` and stops at one that is missing, zero or without code. `PHASE=renounce` also refuses a timelock with a delay under 48 hours, one the Safe cannot propose to or cancel on, one that not everyone can execute on or that the Safe or the deployer administers, and a Safe with a threshold under 2. Those are the timelock's and the Safe's own answers, so phases 3 and 5 also refuse a `TIMELOCK` whose code is not the `TimelockController` that `PHASE=deploy-timelock` deploys (the metadata solc appends is ignored, because it depends on where the sources were read; if it refuses a timelock that phase 2 built, run the phase from the commit that deployed it) or that the deployer did not create (a constructor can set state that the code does not show), and a `SAFE` that is an EIP-7702 delegated account. Phase 5 also refuses a `SAFE` that cannot be asked for its threshold, unless `CONFIRM_UNINSPECTABLE_SAFE=yes-i-checked-the-threshold` says the threshold and the owners were read some other way. Run `check_timelock` and `check_safes` from `scripts/check-mainnet.sh` before it as well: the Safe's owners are the one thing they check that the script cannot, because they come from what the signers read on their own devices. After the Safe has removed the deployer's admin and before `PHASE=renounce`, run `BEFORE_RENOUNCE=1 SAFE=.. TIMELOCK=.. COMMITTEE=.. ORACLE=.. GUARDIAN=.. node scripts/check-role-holders.mjs` and proceed only if it passes: AccessControl cannot list holders, so a second upgrader is visible only in the grant history this replays. Run the same command without `BEFORE_RENOUNCE` after the renounce ([ADR 0005](adr/0005-governance-and-emergency-powers.md)). The replay starts at the artifact's `deployBlock`, which `script/Deploy.s.sol` writes: leave it as written, because a later block hides the grants before it.
- [ ] **Run an execution keeper.** Slash execution is permissionless on purpose, so nothing executes a slash
  unless someone does: a funded, redundant job that calls `executeSlash` as soon as a window closes, and
  watches for `expireSlash` and `expireDispute`. It skips a proposal whose reporter has left the
  committee, because `executeSlash` reverts with `ReporterNotAuthorized` for it
  ([ADR 0005](adr/0005-governance-and-emergency-powers.md), decision 12). A slash that is not executed within 14 days of its deadline
  lapses and has to be filed again after the cooldown ([ADR 0005](adr/0005-governance-and-emergency-powers.md),
  decision 7). It also races its own expiry: until `expireSlash` lands, execution is still allowed.
- [ ] **Initialize oracle bonds** for admitted operators. `admit()` is governance-gated — nobody buys their way in. The bond is what a corrupt oracle can lose.
- [ ] **Pin and rehearse the operator deployment.** Operators run a pinned commit (`SIGVARA_REF` in `docker-compose.mainnet.yml`), never a branch. Each `.env` is mode 600 and the key is a file secret. State is copied off the box nightly and the restore drill in [incident-operator-key.md](incident-operator-key.md) has been run once. The key-compromise sequence in the same file has been walked through with the Safe signers.
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
