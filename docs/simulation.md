# Testnet simulation

**Status:** built and installed on 2 November 2026. It starts when its treasury is funded with
testnet gas; [the explorer](https://sigvara.xyz/agents) shows what it has done since.

Sigvara on Arc testnet has three registered agents, two of them its own, and two oracle operators,
both its own. Nothing outside depends on a score yet. A protocol with that little traffic cannot
show that its scoring, maturity, divergence checks and slashing behave as designed under load. So
`sim/` runs a small agent economy on testnet for four weeks: 20 agents, 40 paying customers, a Sybil
ring, and two slashes.

**It is a simulation, and says so everywhere.** Every address it controls is published in
[`deployments/5042002.simulation.json`](../deployments/5042002.simulation.json) and served as
[`sigvara.xyz/simulation.json`](https://sigvara.xyz/simulation.json). The explorer reads that file,
marks those agents "simulated" and counts them apart from everyone else. None of this activity is
outside demand, and nothing written about Sigvara should cite it as such. That rule comes from the
project's launch guardrails: do not manufacture the activity your metrics measure, and do not let a
simulation pass for traction.

## The cast

Built by `sim/src/cast.mjs` from a fixed seed, so it is the same on every run.

| Group | Agents | Behaviour |
|---|---|---|
| steady-a, steady-b, solo | 9 | Deliver 95% of jobs, 10 to 40 SVR a job |
| mixed | 2 mediocre, 2 failing | Deliver 70% and 30% of jobs; customers drift away from the failing ones |
| late | 4 | Register on days 7, 10, 14 and 18, so tenure differs |
| ring | 3 | A Sybil ring from day 3: six wallets the ring's operator funds pay only the ring, 50 to 100 SVR a job |

Forty customers each make two to four jobs a day across a handful of favourite agents. A delivered
job gets a payer-signed "delivered" outcome posted to the oracle's `/attest` (85% of the time; not
every customer bothers). A job that is not delivered gets no outcome at all, because Arc testnet
accepts only positive outcomes from payers (`PAYER_OUTCOMES=positive`); a failing agent shows up as
fewer outcomes and fewer customers, not as recorded failures. Over the four weeks the plan comes to
about 4,400 payments.

Every wallet comes from one mnemonic by role and index (`sim/src/wallets.mjs`). Agents and their
operators register and bond through the published SDK, as an integrator would.

## Enforcement

The ring is the slash target, and the slashes are real proceedings on the real contracts:

- **Day 10:** the committee files a slash against the first ring agent, naming the evidence in plain
  text. Nobody disputes it, and the simulation executes it once the challenge window closes.
- **Day 12:** the committee files against the second ring agent. The ring's operator disputes it
  within the hour, and the admin rules.

Filing and ruling need the committee and admin keys, which the simulation does not hold. It writes
the exact `cast` commands for those steps to its manual-steps file when they are due; it disputes
and executes on its own. The victim named in each slash is the simulation's treasury, so the
victim's quarter returns to the simulation.

## What it can and cannot show

It exercises registration, bonding, payment scanning, payer-signed outcomes, scoring, maturity,
both operators' agreement, the explorer's evidence check, and a disputed and an undisputed slash.

It does not exercise recorded failures (that needs `PAYER_OUTCOMES=both`), ERC-8004 links (the
oracle's `/link` needs a credential), outcomes carried through CounterAudit, or agents that do real
work. Those are the next phase, each needing an oracle configuration change.

A score earned in the simulation measures the simulation. Read it as evidence the protocol works,
never as evidence anyone wants it.

## Running it

```bash
cd sim && npm ci
node src/run.mjs plan 24        # the next day's actions, no keys or chain needed
node --test                     # the cast and the plan
```

On the host, with the mnemonic in a root-only file:

```bash
SIM_MNEMONIC_FILE=/keys/sim-mnemonic SIM_STATE_FILE=/data/state.json \
SIM_MANUAL_FILE=/data/manual-steps.md SIM_PAUSE_FILE=/data/pause \
node src/run.mjs loop
```

- `registry` prints every address the simulation controls; that output is what gets published.
- `tick` carries out the current hour; `loop` ticks every five minutes until the 28 days are up,
  then stops by itself.
- While the pause file exists, nothing is sent.
- State records every action it has taken, so a restart never repeats one. Setup is retried until it
  succeeds; a job belongs to its hour and is skipped, not made up, if that hour passes.
- The treasury pays for gas. The month needs about 15 USDC of testnet gas, from
  [Circle's faucet](https://faucet.circle.com). SVR comes from the token's own faucet.

It only ever acts on its own cast: every payment goes to a cast agent, and enforcement touches
only the ring.
