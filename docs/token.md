# SVR

> **SVR launched on 9 November 2026.** Its only address is [`0xc79298521Ae84e7a43d20E71A2B2A1BB540E889B`](https://explorer.arc.io/address/0xc79298521Ae84e7a43d20E71A2B2A1BB540E889B) on Arc
> mainnet. The bond token on Arc testnet carries the same name, but it is a faucet ERC-20 that anyone can mint.

SVR is the bond and fee token of the Sigvara protocol. Operators bond it to
activate agents, and slashing an agent's bond burns most of it. Oracle operators
post it as a performance bond, which a slash sends to the slash beneficiary
rather than burning. Scoring epochs will be charged in it once the epoch-fee
module is deployed.

This page is the canonical description. Anything about SVR that does not
appear here and on [sigvara.xyz](https://sigvara.xyz) first is not from this
project.

## Contract

| Item | Value |
|---|---|
| Network | Arc mainnet, chain ID `5042` |
| Address | [`0xc79298521Ae84e7a43d20E71A2B2A1BB540E889B`](https://explorer.arc.io/address/0xc79298521Ae84e7a43d20E71A2B2A1BB540E889B) |
| Symbol / name | `SVR` / Sigvara |
| Supply | 1,000,000,000, fixed at creation |
| Decimals | 18 |
| Owner / mint / pause | none |
| Launch venue | Tolly on Arc (pad `0xcad7ee36ac193bf2eddb7b3e2736c5bdb8269c8b`), Uniswap V3 pool, 1% tier, USDC quote |
| Liquidity | Whole supply seeded single-sided at launch; LP NFT held by Tolly's ownerless, collect-only fee locker `0xe20e4297759597da75c8998ee76ec900600ad920` (no withdraw path in code) |
| Pool | [`0xa9Be080545C6d61529c27294512bDb3Bde67A735`](https://explorer.arc.io/address/0xa9Be080545C6d61529c27294512bDb3Bde67A735), created in the launch transaction [`0x67ac918f…d749`](https://explorer.arc.io/tx/0x67ac918fbe80bd9f4556c44f03daf739aa996b6d63d34b99201ed69b5126d749) (block 30269650, sent by the deployer to the pad); the LP NFT is #59419, held by the fee locker |

The token contract is Tolly's `TollyToken`, a plain OpenZeppelin ERC-20 with
public source ([TollyLabs/v3-contracts](https://github.com/TollyLabs/v3-contracts)).
It has no owner, no mint, no pause, no blacklist and no transfer tax; its one
deviation is an anti-snipe cap of 3% of supply per wallet for the first 300
seconds after launch, after which it is a vanilla ERC-20. That is exactly what the protocol
contracts need from a bond asset: `SigvaraStaking`, `SigvaraOracleBond` and
`SigvaraEpochFees` take the token by address at initialization and treat it as
a plain `IERC20`.

## Addresses

| Role | Address |
|---|---|
| Deployer / creator | `0x8857A7C392d1Bb1A68647c64Ce18D9AA1Fd023b0` |
| Treasury | [`0xBc6acE041434368dBD20a092425F6008bCFe50d4`](https://explorer.arc.io/address/0xBc6acE041434368dBD20a092425F6008bCFe50d4), a 48-hour timelock the admin Safe drives, deployed by the deployer on 9 November 2026 in [`0x8650c34f…faaa`](https://explorer.arc.io/tx/0x8650c34f048aad8c26a16e39db293615d53d3105b01194ba59af825d65b8faaa) |
| Admin Safe | [`0x6ba985D721925357DBf0Fa1E45037CFC3C245983`](https://explorer.arc.io/address/0x6ba985D721925357DBf0Fa1E45037CFC3C245983), 2 of 3, created through Safe's factory on 9 November 2026 in [`0xb5653334…f37b`](https://explorer.arc.io/tx/0xb565333498495839fccc24be4654f5aeb8237e30d2f82eb50cc91cbb8564f37b). The deployer is not an owner |

The SVR launch transaction was sent from the deployer address above, and the Arc
**mainnet** registry deployment will be too. A token or mainnet contract attributed to Sigvara
that was not created by that address is not ours. Arc testnet is deployed from a
separate address (see [deploy-testnet.md](deploy-testnet.md)) so that a testnet key
never touches anything with value. The treasury address holds protocol-owned SVR and pays the
costs listed under treasury policy; it holds nothing else. The admin Safe schedules every payment from it, and a payment executes 48 hours later at the earliest, so each one is public two days before it happens ([ADR 0005](adr/0005-governance-and-emergency-powers.md), decision 13). Until 8 November 2026 this table listed `0xeDC966e23318782c0241aBe1790bd221b8aCE867` as the treasury. That is a single key, it is not the treasury, and nothing should be sent to it.

## Distribution

There is no team allocation, no treasury allocation, no vesting and no sale.
The full supply enters the pool at launch and the only way to hold SVR is to
buy it there or earn it through the protocol.

The team's position is whatever it buys on the open market, starting at the
opening price. Every acquisition is published here: amount, transaction, the
address that holds it, and which of the five permitted purposes below it is
held against. Launch-day buys are published the same day. There are no wallets
holding SVR for the protocol that are not listed on this page.

The anti-snipe cap limits any single wallet to 3% of supply for the first 300
seconds. The team does not split buys across wallets to work around it. A
position larger than that cap is accumulated afterwards, on the open market,
disclosed as it is bought.

### Team acquisitions

| Date (UTC) | SVR | Paid | Transaction | Held by | Held for |
|---|---|---|---|---|---|
| 9 November 2026, 01:20:37 | 22,283,004.212403886 | 115 USDC, the first buy in the launch transaction, at the opening price | [`0x67ac918f…d749`](https://explorer.arc.io/tx/0x67ac918fbe80bd9f4556c44f03daf739aa996b6d63d34b99201ed69b5126d749) | The deployer, [`0x8857A7C392d1Bb1A68647c64Ce18D9AA1Fd023b0`](https://explorer.arc.io/address/0x8857A7C392d1Bb1A68647c64Ce18D9AA1Fd023b0) | 5,000,000 for the two oracle operator bonds (2,500,000 each, primary and checker). The other 17,283,004.212403886 is treasury inventory, locked until 9 May 2027 (below) |

### Locked

| | |
|---|---|
| Lock | [`0xE246eaF919a39d7E0ff656320f7132Ee8AfBB8FB`](https://explorer.arc.io/address/0xE246eaF919a39d7E0ff656320f7132Ee8AfBB8FB), OpenZeppelin's `VestingWallet` with a duration of zero, deployed by the deployer with [`script/LockTreasurySvr.s.sol`](../script/LockTreasurySvr.s.sol) in [`0xa62b579e…3aa5`](https://explorer.arc.io/tx/0xa62b579e9310d03dca13c7cf062c525824b17f371b60c7ec0bf4a6b862a93aa5) |
| Holds | 17,283,004.212403886 SVR, the treasury share of the first buy, sent on 9 November 2026 in [`0x3db63954…3230`](https://explorer.arc.io/tx/0x3db63954f4c8503f1f0679dca5d48c30b37f414ed29ae602ce6b12d466563230) |
| Releases | Nothing before 9 May 2027 00:00 UTC, by anyone, the deployer included. From then all of it, to the lock's owner |
| Owner | The treasury timelock, since 9 November 2026 ([`0xef44f709…f7a0`](https://explorer.arc.io/tx/0xef44f70918c7f79e2e8d83b09774325bd665a40ce1d78c6ebef5e1b5a7bbf7a0)), so the release goes to the treasury. Ownership decides where the SVR goes, never when, and changing it now takes the admin Safe and 48 hours' notice |

The other 5,000,000 SVR of the first buy is not locked. It is for the two oracle operator bonds, the primary's
and the checker's, at the 2,500,000 SVR that `SigvaraOracleBond` requires of each operator on mainnet (see Mainnet
parameters). It stays with the deployer until the mainnet registries deploy and the bonds are posted, and that
transfer is published here. Anyone can read the deployer's balance, and the lock's `start()`, `end()`, `owner()`
and `releasable(SVR)`, on chain.

## Treasury policy

The creator share of pool trading fees (64% of the 1% buy-side pool fee, paid
in USDC and credited by Tolly's fee locker) is
used to buy SVR on the open market. The treasury is also funded by direct
open-market purchases. Both are disclosed.

Treasury SVR is spent only on:

1. **Oracle operator bonds** — posting and topping up bonds under
   `SigvaraOracleBond`, including for operators that are not the team.
2. **Operator incentives** — paying admitted operators for epochs served, once
   a distribution mechanism exists. Today `distributeFees()` sends the
   non-burned fee share to a plain address and the spend is manual.
3. **Slashing-committee costs** — the operational cost of reviewing reports and
   filing slashes.
4. **Staking rewards**, under the rules in the next section, and only those.
5. **Repaying a wrongful slash.** Returning what a slash took to the operator who lost
   it, once the admin has published a finding that the slash was wrong
   ([ADR 0010](adr/0010-what-can-be-slashed.md)). Never more than the slash took, only
   from SVR the treasury already holds, and never to a team-operated agent or oracle
   operator, because the finding is a judgment and this cannot be a payment the team
   directs to itself. It is not owed, and it is disclosed like every other treasury
   movement.

Buybacks run on a published schedule, not in response to price. No fee revenue
is paid out to the team, and no treasury SVR is sold.

## Staking rewards

Not live. Nothing below can pay out before the mainnet registries exist, and
the rules are written here first so that inventory bought for the programme is
inventory for a published programme rather than a discretionary bag.

**Who can earn.** Only two roles, both of which have capital at risk:

- Agents that are `Active` in `SigvaraIdentity`, holding at least
  `minimumStake`, with no slash executed against them in the period.
- Oracle operators admitted to `SigvaraOracleBond` and returning true from
  `isActiveOperator` for the whole period, with no slash executed against them.

Holding SVR earns nothing. Providing liquidity earns nothing. The reward is for
bonded, slashable service to the protocol, and an address that has posted no
bond is not eligible on any basis.

**Where it comes from.** Treasury SVR only, bought on the open market. There is
no emission, no mint and no allocation, because `TollyToken` has no mint
function and the supply is fixed at creation. A reward programme that cannot be
funded from treasury does not run that quarter.

**How much.** At most 5% of the treasury's SVR balance per quarter, measured at
the start of the quarter. The cap is on the programme, not per recipient.

**How it is decided.** The rate, the eligibility window and the recipient set
are published before the period they apply to, not after. Rewards are not
adjusted retroactively and are not discretionary within a period.

**What this is not.** It is not a yield on holding SVR, not a staking product
for the token, and not a return the team can direct to itself. Team-operated
agents and team-operated oracle operators are eligible on exactly the same
published terms as anyone else, and their receipts are disclosed on this page
like every other treasury movement.

Audits and development are funded separately, through ecosystem grants and
CounterAudit integration revenue, not from the token.

## When the utility starts

The Sigvara registries deploy to Arc mainnet after an external audit
([docs/arc.md](arc.md), section 6). Until that deployment, SVR has no on-chain
use in the protocol. Between launch and mainnet registries it is a token with a
published roadmap and nothing else. Arc testnet keeps using the faucet
`SVRToken` for mechanics testing; testnet tokens have no value and never will.

At mainnet deploy the registries are initialized with the SVR address above,
`minimumStake` and `bondAmount` denominated in 18 decimals. `SigvaraEpochFees` is not
deployed at launch.

## Mainnet parameters

The figures the registries are initialized with at mainnet deploy. Both are settable
afterwards by governance, and both are deliberately different numbers doing different
jobs.

| Parameter | Value | Share of supply |
|---|---|---|
| `SigvaraOracleBond.bondAmount` | 2,500,000 SVR | 0.25% |
| `SigvaraStaking.minimumStake` | 10,000 SVR | 0.001% |

The mainnet deploy scripts refuse less than either figure, and `scripts/check-docs.mjs` fails the
build if this table, the scripts and `scripts/check-mainnet.sh` ever disagree.

The operator bond is what a corrupt oracle loses. `slash()` can take up to the whole of
it, so the deterrent is the full number rather than a fraction. The agent stake is a
gate on who is worth scoring, and gating onboarding is a much smaller job than deterring
an oracle, which is why it sits two orders of magnitude lower. On Arc testnet both were
1,000 until the bond was raised to 25,000 on 20 September 2026, and the match was
coincidence rather than design.

Neither figure is the protocol's defence against a hostile operator set. `admit()` takes
the admin role, so nobody buys their way in: an operator joins only when the admin
admits it. There is no on-chain vote. On Arc testnet the admin is one key, and the
handover plan moves it to a Safe. What the bond
buys is something the slashing committee can take, and capital committed across the
seven-day unbonding window.

### Why these are denominated in SVR, not dollars

A bond fixed in SVR scales with the payoff from attacking the protocol, because both
track the same thing. When Sigvara is worth more to corrupt, the bond costs more to post
and more to lose. A dollar peg would sever that link and would need governance to chase
it. The trade is that a price collapse makes the bond cheap, but it also makes corrupting
the protocol worth less, so the two move together in both directions.

### When these get revisited

Governance reviews both figures when any of the following first becomes true, and at
minimum once every two quarters regardless:

- **A single attested settlement exceeds 20% of the operator bond's market value.** This
  is the one that matters. If one settlement is worth more than the bond, a corrupt
  oracle profits by lying about that settlement and walking away from its stake, and the
  bond has stopped deterring the case it exists for.
- **Active agents pass 250.** More agents is more surface for one bad score to matter.
- **SVR's 30-day average moves more than 3x since the last review**, in either
  direction. Secondary, since the SVR denomination already tracks this, but a large move
  is worth a look rather than an assumption.

Raising `bondAmount` takes effect immediately and without grandfathering:
`isActiveOperator` reads `bond >= bondAmount` live, so any operator below the new floor
stops being able to propose at its next epoch. Incumbents are topped up first and the
floor raised second. The sequence is in
[oracle/RUNBOOK-second-operator.md](../oracle/RUNBOOK-second-operator.md), step 0.

### What these numbers are not

They are a starting point, not a derivation. The payoff from corrupting a score depends
on adoption that does not exist yet, so nobody can compute the correct bond today. 0.25%
was chosen to be real money to a small operator while staying fundable from treasury
buybacks, which pay for bonds out of 0.64% of buy volume and therefore need roughly $156
of cumulative buy volume for every $1 of bond. The review triggers above exist because
the first honest thing to say about these figures is that they will be wrong later.

## What the staking contract requires of a bond token

`SigvaraStaking.svrToken` is a plain `IERC20` chosen at initialize, so this applies to
any deployment, not just the ones described above.

**Fee-on-transfer is handled, not merely disallowed.** `depositStake` records the
measured balance delta rather than the amount requested, so a token that takes a cut in
transit credits what actually arrived. This matters even though neither deployed token
does it: crediting the requested amount would book stake the contract never received,
the gap would widen with every deposit, and it would surface only when the last
operators to withdraw found the balance short. An agent could also cross
`minimumStake` on tokens it never transferred, and that bond is what backs a slashable
claim. A requirement written in a document does not bind whoever deploys this next; two
`balanceOf` calls do.

**Rebasing tokens are not supported.** Stake is stored as a fixed amount. A balance that
changes on its own drifts from the accounting in either direction, and nothing in the
contract can detect it. Do not deploy with one.

**Outbound transfers send the recorded amount.** With a fee-on-transfer token a
withdrawal or a slash payout arrives smaller than the figure in the event. That
shortfall falls on the recipient and does not threaten the contract's solvency, which is
why it is documented rather than compensated: paying out more than was debited would
create the very shortfall the deposit path exists to prevent.

Covered by [`test/FeeOnTransfer.t.sol`](../test/FeeOnTransfer.t.sol), which deploys a
real fee-taking token and asserts the booked stake never exceeds the tokens held.

## Impersonation

Anyone can deploy a token called SVR or Sigvara on any launchpad. Before this
page carries an address, there is no genuine SVR. After it does, only that
address is genuine. The team never announces a contract address on social media
first; it goes here and on sigvara.xyz, then everywhere else.

These are the only accounts and domains the project speaks through:

| | |
|---|---|
| Site | `sigvara.xyz` |
| Source | `github.com/RunTimeAdmin/Sigvara` |
| X | `@SigvaraProtocol` |
| Security | `security@sigvara.xyz` |

Anything else claiming to be Sigvara is not, including accounts using the same
name or avatar. An unnamed "official account" protects nobody, which is why this
list exists and why it lives in the repository, where its history is public,
rather than only in a profile bio that can be edited without trace.

`countersig.network` is the pre-rename domain. It now redirects here and serves nothing
of its own. Anything still presenting that hostname as a live Sigvara site is not us.

## Not a promise

SVR is a utility token for bonding and fees in an early protocol with no audit
yet and an oracle run by one party. Nothing on this page is investment advice or a
forecast of value.
