# The 10-minute gate

An MCP tool that refuses agents without standing, end to end, on Arc testnet.

This is aimed at people who build agent hosts and frameworks, not at people reading a
protocol spec. The question it answers is narrow: **how do I stop my tool being called by
an agent with no accountability, without running an allowlist?**

The short version: the agent proves control of an on-chain identity with an Ed25519
signature, and the tool reads a score that was computed from payments it actually
received and is backed by a bond that can be taken away. If the number is too low, the
tool does not run.

```
agent                      your MCP server                    Arc testnet
  │                              │                                 │
  │─ sigvara_challenge(did) ────▶│                                 │
  │◀──── challenge (nonce, aud) ─│                                 │
  │                              │                                 │
  │─ restricted_search(sig) ────▶│── read ed25519 pubkey ─────────▶│
  │                              │── read status + score ─────────▶│
  │◀──── refused / result ───────│                                 │
```

## Run it

```bash
npm install @sigvara/protocol-sdk
node examples/mcp-gated-tool/server.mjs
```

`SigvaraGate` ships in `@sigvara/protocol-sdk` from 1.0.0-alpha.9. Earlier versions do
not contain it, so an older install fails on the import rather than at runtime.

From a checkout of this repo the install is optional: the import falls back to
`packages/sdk/dist` when the package is not present, so `npm run build` in
`packages/sdk` is enough. Copy the file anywhere else and the package is what it uses.

It speaks JSON-RPC over stdio, so you can drive it from a terminal:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | node examples/mcp-gated-tool/server.mjs
```

Configuration is environment: `SIGVARA_THRESHOLD` (default 35), `SIGVARA_AUDIENCE`,
`RPC_URL`, `CHAIN_ID`.

## Getting an agent that passes

The gate is the easy half. An agent that *clears* it needs a history, and that is the
part worth understanding before you set a threshold.

1. **Register and bond.** [sigvara.xyz/testnet](https://sigvara.xyz/testnet) walks it:
   faucet gas, faucet SVR, register, deposit the minimum stake. Below the minimum an agent
   is `PendingBond` and is not scored at all, so the gate refuses it on standing rather
   than on score.

2. **Get paid, from more than one payer.** Score comes from settled payments to the
   agent's own address, verified on chain. One counterparty is capped at 5 points by
   `PAYMENT_MAX_PER_PAYER`, so the fee factor measures *how many independent parties paid
   you*, not how much money moved. `scripts/fat-path.mjs` does this end to end if you want
   to see it work before wiring your own.

3. **Attest the settlements.** `POST /attest` with the settlement hash. No token needed:
   the oracle reads the payer off the transfer log and re-verifies the transaction, so the
   payment is the credential. Self-payments are refused.

4. **Wait for an epoch.** The oracle proposes hourly, and a proposal sits in a challenge
   window before it is final. `meetsThreshold` reads the finalized value, so a score you
   just earned is not immediately spendable.

## Choosing a threshold

Read this before picking a number, because the scale is not what it looks like.

| Threshold | What it actually selects for, today |
|---|---|
| 0 | nothing; use `isActive` instead if you only want a bonded agent |
| ~20 | bonded, and paid by at least four independent counterparties |
| ~35–40 | the above, plus attested outcomes and a few days of trading |
| 60+ | **not currently reachable** — see below |

**Thirty of the hundred points are switched off on this deployment.** `externalScore` (25)
needs an ERC-8004 registry configured on the oracle and there is none, so it is
structurally zero. `propagationScore` (5) reads counterparties' external standing, so it
is zero for the same reason. Tenure is 30 points and takes years by design: a month of
sustained trading is 14.

So an honest, active, well-paid agent plateaus around 40 right now. A threshold of 60
refuses everyone, including agents doing everything right. Set 35 and you are asking for
something real; set 60 and you are asking for something nobody can have yet.

## What a refusal tells the caller

Four reasons, because they need four different responses:

| reason | what the caller should do |
|---|---|
| `bad_proof` | check you signed the challenge this server issued, with the key registered for that DID |
| `replayed` | ask for a fresh challenge; each one is single-use |
| `not_active` | deposit the minimum stake — or the agent was slashed, in which case it cannot recover |
| `below_threshold` | earn score: get paid by independent counterparties and attest it |

Only the last is about reputation. A gate that returns `false` for all four is impossible
to act on from the outside, which is why this one does not.

## What this does and does not prove

**Does.** That an agent controls a specific on-chain identity, that the identity is bonded
and not slashed, and that its score was computed from payments a third party can re-verify
against the chain. The evidence behind any score is public: fetch
`oracle.sigvara.xyz/evidence/<didHash>`, check each payment yourself, rebuild the Merkle
root and compare it with the one the contract holds.

**Does not.** That the agent is good at its job. Score measures paid activity, reported
outcomes and elapsed time, not quality. It also does not prove the oracle is honest — a
second bonded operator recomputes independently and publishes disagreements at
[`checker.sigvara.xyz/divergence`](https://checker.sigvara.xyz/divergence), but both
operators are currently run by the same party, so what is demonstrated is that two
independent recomputations agree, not two independent parties.

Gate on this the way you would gate on a credit check: it bounds who you are dealing with
and how much they lose by misbehaving. It is not a guarantee about the work.
