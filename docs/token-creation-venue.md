# SVR Token Creation Venue

Short answer: it matters, and the venue is not interchangeable.

## The requirement

SVR will be consumed by contracts that live on Arc: `SigvaraStaking` and `SigvaraOracleBond` take the token by address at initialization and treat it as a plain `IERC20`, and so does `SigvaraEpochFees`, which is not deployed at launch ([ADR 0005](adr/0005-governance-and-emergency-powers.md)). The bond is the deterrent, the stake is the gate, the epoch fee will be the meter. All three accounting paths assume the token's transfers are cheap, final, and native to the same chain the registries run on.

## Why Arc, not elsewhere

- **Same-chain settlement.** A bond posted on Arc and a score written on Arc are one atomic story. If SVR lived on Ethereum mainnet and the registries on Arc, every bond check, slash, and fee charge would cross a bridge — adding latency, bridge risk, and a second failure mode to the exact mechanism that is supposed to make reputation expensive to corrupt.
- **Fee economics.** Arc's fees are designed for high-frequency micro-payments. Sigvara's monetization plan is sub-cent per-event metering through Circle nanopayments and x402. A token on a chain where a transfer costs more than the fee being collected cannot carry that model.
- **Circle's roadmap.** Circle's own positioning is that AI agents will likely be Arc's main users, with managed payments for agents launched October 2026. SVR as an Arc-native bond asset sits inside that thesis rather than adjacent to it.
- **Tolly integration.** The launch venue is Tolly on Arc with a Uniswap V3 pool, 1% tier, USDC quote, whole supply seeded single-sided, LP NFT in Tolly's ownerless collect-only fee locker. That locker has no withdraw path in code — the supply is committed, not parked.

## What a different venue would break

- **Ethereum mainnet:** correct security pedigree, wrong economics. Bond checks and slash execution would require cross-chain reads or bridges; micro-fee metering becomes uneconomical; and the token would compete with every other ERC-20 for attention instead of being the native bond asset of the chain it serves.
- **Base or Solana:** fine chains for agent tooling, but Sigvara's registries, oracle bonds, and epoch fees are already written and tested against Arc's environment. Re-homing means re-auditing and re-testing the entire staking and slashing path.
- **A random launchpad on an unrelated chain:** the impersonation and trust problem gets worse, not better. Sigvara's anti-impersonation page exists precisely because anyone can deploy a token called SVR anywhere. The defense is a single published address on a chain the protocol actually uses.

## The one real alternative

If Sigvara ever deploys registries to a second chain, SVR would need a canonical home chain plus a wrapped representation on the other — with the bond and stake accounting staying on the home chain. That is a later governance decision, not a launch decision. For Q4 2026: Arc, via Tolly, full stop.

## Cross-links

- [Launch checklist](launch-checklist.md) — Phase 3 covers the Tolly launch sequence.
- This document is the venue argument; the checklist is the execution order.
