# Lineage: the Robinhood Chain testnet run

Sigvara is the continuation of Countersig Network. Before the move to Arc, the
same protocol (identity, reputation, staking, epoch fees, oracle, SDK) ran as a
public testnet on Robinhood Chain. This page records that run so it can be
cited. Everything below was read from the chain and its explorer on
17 September 2026; the original repository is
[RunTimeAdmin/countersig-network](https://github.com/RunTimeAdmin/countersig-network).

## Deployment

| Item | Value |
|---|---|
| Network | Robinhood Chain testnet, chain ID `46630` |
| Deployed | 15 July 2026, 02:40 UTC, block `90338571` |
| Deployer | `0xfB38fA3C085FD9D06564524855d00E098ae0c450` |
| Identity proxy | [`0xCCF2Fd69c07EDFbc3C215cfD31e2F20FC208A16C`](https://explorer.testnet.chain.robinhood.com/address/0xCCF2Fd69c07EDFbc3C215cfD31e2F20FC208A16C) |
| Reputation proxy | [`0xbB0c9C2DF28af31905dEfEa04c80372C0909f1bF`](https://explorer.testnet.chain.robinhood.com/address/0xbB0c9C2DF28af31905dEfEa04c80372C0909f1bF) |
| Staking proxy | [`0x7281cf35ae9Bf56EAF5B1d0C2C8e167e50BCEC75`](https://explorer.testnet.chain.robinhood.com/address/0x7281cf35ae9Bf56EAF5B1d0C2C8e167e50BCEC75) |
| Epoch-fee registry proxy | [`0x9a9b6A49f3FE1C02Fb1b5cB7f2911Add0ce2e2bb`](https://explorer.testnet.chain.robinhood.com/address/0x9a9b6A49f3FE1C02Fb1b5cB7f2911Add0ce2e2bb), deployed 16 July 2026 |
| Testnet bond token | `CSIG`, [`0x7E44aF56d14EBfd16D5D7Ba4F011b5206d487D55`](https://explorer.testnet.chain.robinhood.com/address/0x7E44aF56d14EBfd16D5D7Ba4F011b5206d487D55), faucet token, 1,000 minted |
| Creation transactions | identity `0x36fd2ea5…8430`, reputation `0x0aeadd94…7405`, staking `0x1923d98a…e88d`, fee registry `0x9130edb6…c18c` |

Live parameters as read on 17 September 2026: minimum stake 1,000 CSIG,
slash challenge period 7 days, unbonding period 21 days, score challenge window
30 minutes (testnet setting; Arc uses 6 hours), epoch fee 0.

A legacy Sepolia deployment from 30 June 2026 preceded it (identity
`0xD738A4cBe525d214f86059A8328786f072D6fbe1`, reputation
`0x0613C561C5003D7948Ea09dE2C1895965A5c3F27`, staking
`0x60347640d46B55E7dafFA8F385bc55eE2D77ee85`).

## What ran

- **Reputation oracle, hourly epochs.** The oracle wallet `0xCBD43312…` called
  `proposeReputation` and `finalizeReputation` every hour. The reputation
  contract shows 2,470 transactions between deployment and the last epoch on
  14 August 2026, 18:19 UTC: roughly 1,200 scoring epochs over 30 days.
- **Registered agents.** Three agents registered through the identity
  registry, at blocks `90339181`, `90758493` and `90820089`. Their scores were
  written every epoch; the last finalized values on chain are 24 and 63 out
  of 100, consistent with the six-factor model's ramp-up curve for agents
  with a few weeks of age and mixed activity.
- **Attestation and flag feeds.** CounterAudit consumed scores and fed
  work-outcome attestations back; HoodScan reported red-verdict deployers as
  community flags. Both are described in the Countersig README and were the
  inputs behind the success and community factors.
- **SDK.** `@countersig/protocol-sdk` was published to npm and used for the
  live integration tests against this deployment.
- **Not exercised.** No bonds were deposited on testnet (the staking proxy has
  only its deployment transaction) and no slash was filed. The slashing path
  is covered by the Foundry suite and by the interactive demo, not by this run.

## What changed on the way to Arc

- Contracts renamed from Countersig to Sigvara; storage layouts unchanged.
- Score challenge window set to 6 hours for Arc (was 30 minutes on testnet).
- Slash exit-dodge closed via the unbonding queue (Countersig PR 19,
  22 July 2026), which is why `executeSlash` sweeps queued withdrawals.
- Identity layer adopted ERC-8004 as the canonical registry; the on-chain
  Ed25519 key and slash status remain Sigvara's extension.
- Bond token moved from the faucet `CSIG` to a deploy-time address so the
  same scripts serve testnet and mainnet.

## Caveats

- The Robinhood testnet contracts are not source-verified on the explorer.
  Bytecode and the broadcast records in the Countersig repository are the
  evidence.
- The `0xcb89…` agent's final score (24) and the `0x65a6…` agent's (63) are
  point-in-time reads; the deployment is dormant since 14 August 2026 and
  may be reset by the network at any time.
