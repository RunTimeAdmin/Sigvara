# Sigvara Q4 Arc Mainnet Launch Checklist

Sequenced against the Q4 2026 SVR mainnet milestone. Dates are targets, not commitments — slip any item rather than skip the gate it protects.

## Phase 1 — Prove the mechanism (testnet, weeks 1–2)

- [ ] **Live slash drill on a throwaway agent.** Fork test passes, but the real drill has never run against a non-demo identity. Register a throwaway at exactly `minimumStake` (1,000 SVR on testnet), file `initiateSlash` from the committee key, let the seven-day challenge window elapse, call `executeSlash` permissionlessly, claim proceeds, publish every tx hash with explorer links. State first in the write-up that it was a drill. Do **not** target the demo agent — `Slashed` is terminal.
- [ ] **Publish the drill log** at `docs/slash-drill-log.md` and link it from the whitepaper roadmap, item 2.
- [ ] **Disclose the self-administered property**: all three drill keys are held by one operator. That is a property of the drill, not a governance proof. Say so in the write-up.

## Phase 2 — External audit (weeks 2–6, overlaps Phase 1)

- [ ] **Engage an external auditor** for the Sigvara registries (`SigvaraIdentity`, `SigvaraStaking`, `SigvaraReputation`, `SigvaraOracleBond`, `SigvaraEpochFees`). Audits and development are funded separately from the token — ecosystem grants and CounterAudit integration revenue, not SVR.
- [ ] **Fix findings, re-audit critical items** before any mainnet deployment transaction is signed.
- [ ] **Publish the audit report** on sigvara.xyz and in the repo. A token with no audit and a single-operator oracle is exactly what a skeptic attacks first.

## Phase 3 — SVR token launch on Tolly (Arc)

- [ ] **Confirm deployer address** `0x8857A7C392d1Bb1A68647c64Ce18D9AA1Fd023b0` is the sole creator; anything attributed to Sigvara not created by it is not ours.
- [ ] **Seed the Uniswap V3 pool** (1% tier, USDC quote) with the whole 1B supply single-sided. LP NFT goes to Tolly's ownerless collect-only fee locker — no withdraw path in code.
- [ ] **Publish the token address** on `docs/token.md` and sigvara.xyz *before* any social announcement. Never announce on social first.
- [ ] **Anti-snipe cap** (3% of supply per wallet, first 300 seconds) is the only deviation from vanilla ERC-20. After 300 seconds it is a plain token — exactly what the bond contracts require.
- [ ] **Team position**: whatever is bought on the open market at the opening price, disclosed same-day. No split buys to work around the cap.
- [ ] **Treasury buybacks** run on a published schedule from the 64% creator share of buy-side fees (paid in USDC via the fee locker), not in response to price. No fee revenue paid to the team; no treasury SVR sold.

## Phase 4 — Mainnet registry deployment (gated on Phase 2)

- [ ] **Deploy registries to Arc mainnet** (chain ID 5042) initialized with the SVR address, `minimumStake` = 10,000 SVR, `bondAmount` = 2,500,000 SVR, `epochFee` = 0 (Bootstrap stage).
- [ ] **Initialize oracle bonds** for admitted operators. `admit()` is governance-gated — nobody buys their way in. The bond is what a corrupt oracle can lose.
- [ ] **Verify impersonation guidance**: only the published address is genuine SVR. `countersig.network` redirects to sigvara.xyz and serves nothing.

## Phase 5 — Flip monetization on

- [ ] **Set `epochFee` > 0** once real volume exists. This is when metered monetization (verification lookups, bond checks, challenge windows via Circle nanopayments/x402 at sub-cent rates) turns on. Bootstrap at zero is deliberate — charging before utility exists is the POAP mistake.
- [ ] **Meter per-event fees** aligned with the Circle/Proof x401+x402 demo pricing precedent (Proof bills $1.50 per identity verification).
- [ ] **Staking rewards stay off** until treasury buybacks have built inventory. Cap: 5% of treasury SVR balance per quarter, published before the period, not after. Only bonded agents and bonded oracle operators are eligible — holding SVR earns nothing.

## Phase 6 — Bond governance (ongoing, min. every 2 quarters)

Review `bondAmount` and `minimumStake` when any of these first become true:
- A single attested settlement exceeds 20% of the operator bond's market value.
- Active agents pass 250.
- SVR's 30-day average moves more than 3x since the last review.

Raising `bondAmount` takes effect immediately, no grandfathering: incumbents topped up first, floor raised second.

## What these numbers are not

They are a starting point, not a derivation. The payoff from corrupting a score depends on adoption that does not exist yet. The review triggers exist because the first honest thing to say about these figures is that they will be wrong later.
