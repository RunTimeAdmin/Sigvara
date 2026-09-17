# archive/token-launch

Shelved token-launch material. Nothing in this folder is compiled (Foundry only
builds `src/`, `script/` and `test/`) and nothing here is deployed.

- `src/SVR.sol` — fixed-supply ERC-20 with hardcoded allocation buckets
- `src/SigvaraPublicSale.sol`, `src/TeamVesting.sol`, `src/TreasuryVesting.sol` — sale and vesting
- `script/DeployMainnet.s.sol`, `script/DeployPublicSale.s.sol` — TGE deploy scripts
- `test/` — the tests for the above
- `docs/tokenomics.md`, `docs/oracle-first.md` — the earlier token model and the July 2026 decision to defer it

Whether the protocol's bond asset becomes a purpose-built token or a standard
one is undecided. The live contracts (`SigvaraStaking`, `SigvaraOracleBond`,
`SigvaraEpochFees`) take the bond token by address at initialization, so either
answer is deploy configuration, not a code change. To bring any of this back,
move the files into `src/`, `script/` and `test/` and fix the relative imports.
