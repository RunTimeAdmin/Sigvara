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
| Launch venue | Archemist on Arc, Uniswap V3 pool |
| Pool | _published here at launch_ |

The token contract is the standard one Archemist deploys. It has no owner, no
mint function and no admin surface, which is exactly what the protocol
contracts need from a bond asset: `SigvaraStaking`, `SigvaraOracleBond` and
`SigvaraEpochFees` take the token by address at initialization and treat it as
a plain `IERC20`.

## Distribution

There is no team allocation, no treasury allocation, no vesting and no sale.
The full supply enters the pool at launch and the only way to hold SVR is to
buy it there or earn it through the protocol.

The team's position is whatever the launch-day buy takes at the opening price.
That amount, the address that holds it and what it is for (the first oracle
operator bond and operator incentives) are published here on launch day.

## Treasury policy

The creator share of pool trading fees, credited by the Archemist locker, is
used to buy SVR on the open market. Purchased SVR goes to the protocol
treasury address (published here) and is spent only on oracle bonds, operator
incentives and slashing-committee costs. Buybacks run on a published schedule,
not in response to price. No fee revenue is paid out to the team.

Audits and development are funded separately, through ecosystem grants and
CounterAudit integration revenue, not from the token.

## When the utility starts

The Sigvara registries deploy to Arc mainnet after an external audit
([docs/arc.md](arc.md), section 5). Until that deployment, SVR has no on-chain
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
