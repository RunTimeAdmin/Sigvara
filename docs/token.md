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

The team's position is whatever the launch-day buy takes at the opening price.
That amount, the address that holds it and what it is for (the first oracle
operator bond and operator incentives) are published here on launch day.

## Treasury policy

The creator share of pool trading fees (64% of the 1% buy-side pool fee, paid
in USDC and credited by Tolly's fee locker) is
used to buy SVR on the open market. Purchased SVR goes to the protocol
treasury address above and is spent only on oracle bonds, operator
incentives and slashing-committee costs. Buybacks run on a published schedule,
not in response to price. No fee revenue is paid out to the team.

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

## Impersonation

Anyone can deploy a token called SVR or Sigvara on any launchpad. Before this
page carries an address, there is no genuine SVR. After it does, only that
address is genuine. The team never announces a contract address on social media
first; it goes here and on sigvara.xyz, then everywhere else.

## Not a promise

SVR is a utility token for bonding and fees in an early protocol with no audit
yet and a single-operator oracle. Nothing on this page is investment advice or a
forecast of value.
