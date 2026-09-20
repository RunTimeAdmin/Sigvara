# SVR

SVR is the bond and fee token of the Sigvara protocol. Operators bond it to
register agents, the slashing path burns it, oracle operators post it as a
performance bond, and scoring epochs are charged in it.

This page is the canonical description. Anything about SVR that does not
appear here and on [sigvara.xyz](https://sigvara.xyz) first is not from this
project.

## Contract

| Item | Value |
|---|---|
| Network | Arc mainnet, chain ID `5042` |
| Address | _published here at launch_ |
| Symbol / name | `SVR` / Sigvara |
| Supply | 1,000,000,000, fixed at creation |
| Decimals | 18 |
| Owner / mint / pause | none |
| Launch venue | Tolly on Arc (pad `0xcad7ee36ac193bf2eddb7b3e2736c5bdb8269c8b`), Uniswap V3 pool, 1% tier, USDC quote |
| Liquidity | Whole supply seeded single-sided at launch; LP NFT held by Tolly's ownerless, collect-only fee locker `0xe20e4297759597da75c8998ee76ec900600ad920` (no withdraw path in code) |
| Pool | _published here at launch_ |

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
| Treasury | `0xeDC966e23318782c0241aBe1790bd221b8aCE867` |

The SVR launch transaction and the Arc **mainnet** registry deployment will be sent
from the deployer address above. A token or mainnet contract attributed to Sigvara
that was not created by that address is not ours. Arc testnet is deployed from a
separate address (see [deploy-testnet.md](deploy-testnet.md)) so that a testnet key
never touches anything with value. The treasury address holds protocol-owned SVR and pays the
costs listed under treasury policy; it holds nothing else.

## Distribution

There is no team allocation, no treasury allocation, no vesting and no sale.
The full supply enters the pool at launch and the only way to hold SVR is to
buy it there or earn it through the protocol.

The team's position is whatever it buys on the open market, starting at the
opening price. Every acquisition is published here: amount, transaction, the
address that holds it, and which of the four permitted purposes below it is
held against. Launch-day buys are published the same day. There are no wallets
holding SVR for the protocol that are not listed on this page.

The anti-snipe cap limits any single wallet to 3% of supply for the first 300
seconds. The team does not split buys across wallets to work around it. A
position larger than that cap is accumulated afterwards, on the open market,
disclosed as it is bought.

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
3. **Slashing-committee costs** — the operational cost of reviewing and acting
   on disputes.
4. **Staking rewards**, under the rules in the next section, and only those.

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
`minimumStake` and `epochFee` denominated in 18 decimals.

## Mainnet parameters

The figures the registries are initialized with at mainnet deploy. Both are settable
afterwards by governance, and both are deliberately different numbers doing different
jobs.

| Parameter | Value | Share of supply |
|---|---|---|
| `SigvaraOracleBond.bondAmount` | 2,500,000 SVR | 0.25% |
| `SigvaraStaking.minimumStake` | 10,000 SVR | 0.001% |
| `SigvaraEpochFees.epochFee` | 0 at launch (Bootstrap stage) | n/a |

The operator bond is what a corrupt oracle loses. `slash()` can take up to the whole of
it, so the deterrent is the full number rather than a fraction. The agent stake is a
gate on who is worth scoring, and gating onboarding is a much smaller job than deterring
an oracle, which is why it sits two orders of magnitude lower. On Arc testnet both were
1,000, which was coincidence rather than design.

Neither figure is the protocol's defence against a hostile operator set. `admit()` is
governance-gated, so operators join by vote and nobody buys their way in. What the bond
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

## Impersonation

Anyone can deploy a token called SVR or Sigvara on any launchpad. Before this
page carries an address, there is no genuine SVR. After it does, only that
address is genuine. The team never announces a contract address on social media
first; it goes here and on sigvara.xyz, then everywhere else.

## Not a promise

SVR is a utility token for bonding and fees in an early protocol with no audit
yet and a single-operator oracle. Nothing on this page is investment advice or a
forecast of value.
