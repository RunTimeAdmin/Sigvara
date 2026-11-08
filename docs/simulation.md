# Testnet simulation

**Status:** running since 2 November 2026, and it stops by itself on 30 November.
[sigvara.xyz/simulation](https://sigvara.xyz/simulation) shows where it is, day by day, and
[what changed during the run](#what-changed-during-the-run) is recorded below.

When this was built, Sigvara on Arc testnet had three registered agents, two of them its own, and two oracle operators,
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

It does not exercise recorded failures (that needs `PAYER_OUTCOMES=both`), outcomes carried through
CounterAudit, or agents that do real work. Those are the next phase, each needing an oracle
configuration change. An ERC-8004 link and a Base payment have each been tried on one agent, by hand
and beside the run, as the next section says.

A score earned in the simulation measures the simulation. Read it as evidence the protocol works,
never as evidence anyone wants it.

## What changed during the run

The simulation's own program has not changed. The protocol around it has, and one of its agents has
been used for tests by hand. Read the results on 30 November against this list.

| Date (UTC) | Run day | What changed | What it does to the numbers |
|---|---|---|---|
| 3 November | 1 | The solo agent registered ERC-8004 agent 897766 and set its `sigvara` key ([runbook, section 5](operations-runbook.md)) | Nothing in its Sigvara score. The publisher posts that score to ERC-8004, and this is the only agent it posts for |
| 4 November | 2 | Reputation upgraded to `f35cbc6` ([#199](https://github.com/RunTimeAdmin/Sigvara/pull/199)) | Each finalize used to throw away the fraction of a point built up since the last, which gave about 3.4 points a day in place of 4. Compare maturity rates from this day on |
| 5 November | 3 | Reputation upgraded to `dcad617` ([#218](https://github.com/RunTimeAdmin/Sigvara/pull/218)) | A score's age now runs from its proposal and not its finalize. Score values do not change |
| 7 November | 5 | Payments on Base Sepolia count on both operators | Below |

### Base Sepolia, from 7 November

Both operators now also count payments that settle on Base Sepolia
([ADR 0009](adr/0009-payments-on-base.md)). They scanned it in shadow from about 00:40 UTC, then went
`on` from block 55462500, the checker at 01:54:45 UTC and the primary at 01:55:18 UTC. The simulation's
customers still pay in SVR on Arc testnet, so for the cast this adds a second chain to scan and no
payments.

It does add a way for scoring to pause. An operator whose scan of a chain that is `on` has fallen
behind scores nothing that epoch, and both operators read Base through keyless public endpoints. A
gap in the run's scores from 7 November on may be that and not the simulation: `paymentChainHold` on
each operator's `/health` says so, and `sigvara_oracle_epochs_held_by_payment_chain_total` counts it.

Two payments were made by hand to test the whole path, both to the solo agent. The first came from a
plain key:

- **Agent:** `0x9d7181C8676fd40E4B31510dC0E573A0C0C2fa11`, ERC-8004 agent 897766.
- **Payer:** `0x537Ae120b37374336E53B74855bF5B3a692387D3`, a Sigvara test wallet. It is not in the
  cast or in `simulation.json`, so the explorer's evidence check shows a payer the cast does not list.
- **Payment:** 0.02 Base Sepolia USDC in
  [`0x222ce350…cd2f087`](https://sepolia.basescan.org/tx/0x222ce3503e8d6c768f09efb0cebb8fe029fd1075aba0dafdd017ca929760f087),
  block 55477277, about 02:08 UTC.
- **Outcome:** "delivered", signed with that wallet's key on chain 84532. `POST /attest` answered 503
  `unconfirmed` until the block was finalized, and the primary accepted it at 02:31:00 UTC, checked at
  block 55478313. The agent's attestations went from 45 to 46.
- **Counted:** the one-hour delay passed at about 03:08:48 UTC. At 03:12 UTC both operators listed the
  payment among the agent's 61, with the same leaf (`0x01fb5744…eccba99`) and the same root
  (`0xc382a1c0…afde068e`). The checker had imported the outcome at 02:54:56 UTC, at the same checked
  block.
- **First epochs:** the 02:55 UTC epochs were the first to scan past the payment. Both operators reached
  the same Base block, 55485014, and the primary proposed and finalized as usual. Neither held, and the
  checker recorded no divergence.
- **Score:** 38 on the primary at 03:12 UTC, from 46 attestations and 15 payers, one of each from this
  payment. It moves no whole point: the success factor reads 13 at 45 of 45 and at 46 of 46, and
  0.02 USDC is a 5,000th of a fee point at `FEE_UNIT=100000000`.

The first proposal to hold that payment came at 07:25:47 UTC, once the agent's proposal from 00:41 UTC had
finalized: a score of 39, with root `0xe26d882f…f1646769`, over 64 of the 65 payments then listed. The
checker's 08:24 UTC epoch checked it and recorded no divergence. It finalized in the primary's 14:25 UTC
epoch, the first finalized root to hold a Base payment. At 15:31 UTC the reputation contract's
`verifyEvidence` confirmed the payment against that root, and refused the same proof with the amount
changed by one unit.

A second payment tested a smart wallet the same day:

- **Payer:** `0xEac45FCb608fFd7dde69BF5A591B27C991963df0`, a Base Account held by the Sigvara team. It is
  not in the cast or in `simulation.json` either.
- **Payment:** 0.02 Base Sepolia USDC in
  [`0xa8bc7ab1…cf72c3de`](https://sepolia.basescan.org/tx/0xa8bc7ab19c11d758f3caa0207b91ce0af5154506b0b897cb131ed13fcf72c3de),
  block 55630927, about 10:40 UTC. The payment also deployed the account on Base Sepolia.
- **Outcome:** "delivered", signed by the account. The signature is 640 bytes, checked through ERC-1271.
  The primary accepted it at 11:04:09 UTC, with `signer: contract`, checked at block 55632945, and the
  checker imported it at about 11:24:32 UTC at the same block.
- **Counted:** at 11:44 UTC both operators listed it among the agent's 69, with the same leaf
  (`0xdc4ecb81…1742f8a7`) and the same root (`0x72144b3d…fbe7af30`).
- **Proposal:** the proposal of 14:25:48 UTC holds both Base payments: a score of 40, with root
  `0xa98b3383…5affee3`, over 70 of the 73 payments then listed. The checker's 15:24 UTC epoch recorded no
  divergence. Its window closes at 20:25:48 UTC.
- **Score:** 40 on the primary at 15:31 UTC, from 55 attestations and 16 payers. Compare the solo agent with
  the other steady agents knowing it has these two extra payers.

Both are Sigvara paying itself in free test USDC, so they test the mechanism and say nothing about
demand. Circle's faucet also sent the same agent 20 USDC at block 55457467, about 01:02 UTC. Both
shadow scans reported that as the one payment they would credit, which is how shadow was checked, and
since it came before `FROM_BLOCK` it counts for nothing.

Not tested by these: a Wallet MCP x402 payment, which rollout step 4 names, since both were plain USDC
transfers; an outcome carried through CounterAudit (CounterAudit#97 is merged and not deployed); and any
volume.

The explorer's evidence check reads these payments: at 03:13 UTC it rebuilt all 61 leaves and matched the
served root. The SDK's `evidenceLeaf` builds the same leaf from 1.0.0-alpha.17, published that morning.
Before it, `sigvara_verify_evidence` reported this agent's served root as differing, read against the live
list at 03:13 UTC as one leaf of 61. In 1.0.0-alpha.17 that tool still fails on this agent, with `Could not
read the chain`: it confirms up to 100 payments at a pace the public RPC refuses. 1.0.0-alpha.18 confirms them in one read through Multicall3. That says nothing about
the agent.

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
