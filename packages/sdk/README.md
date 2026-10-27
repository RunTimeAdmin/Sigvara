# @sigvara/protocol-sdk

TypeScript SDK for the Sigvara protocol: on-chain agent identity, computed
reputation, staked accountability, and Ed25519 challenge-response
authentication between agents. Successor to `@countersig/protocol-sdk`.

```bash
npm install @sigvara/protocol-sdk
```

Runtime dependencies are `ethers` v6 and `tweetnacl`. Node 18 or newer.

Use the newest release. On 1.0.0-alpha.9 and earlier an agent object carries its secret key in an
ordinary property, so `JSON.stringify(agent)` or logging one includes it; never log or serialize an
agent from those versions.

> **This README describes the repository.** npm has 1.0.0-alpha.9, and the items under
> Unreleased in [CHANGELOG.md](CHANGELOG.md) are not in it: `signChallengeFor`, the 30 second
> read timeout and the parallel status and score read, the fix for a challenge dated in the
> future, the checks on a gate's `threshold` and `ttlSeconds`, the gate's check of the bond held
> now and its optional `maxScoreAgeSeconds`, and `SigvaraAgent` keeping its
> secret key in a private field. On alpha.9, `signChallenge` signs whatever it is handed, so
> check the payload's audience yourself before you sign, and the secret key is an ordinary
> property, so `JSON.stringify(agent)` or logging an agent includes it.

> **Upgrading from 1.0.0-alpha.7:** `generateChallenge` now takes an audience as its
> second argument, and every existing call site needs it.
>
> ```diff
> - const challenge = generateChallenge(agentDid);
> + const challenge = generateChallenge(agentDid, 'https://your-service.example');
> ```
>
> Without it, a verifier holding a valid response could present that same response to a
> different verifier and be accepted as the agent. Pass the same audience to
> `verifySignature` as its fifth argument; omitting it still compiles and still accepts
> the relayable older proofs. Full detail in [CHANGELOG.md](CHANGELOG.md).
>
> **This does not make you replay-proof.** The audience stops a response being reused at
> a *different* verifier. Reuse at *yours* is stopped by remembering the nonce, and the
> SDK cannot do that for you — see
> [What the SDK still needs from you](#what-the-sdk-still-needs-from-you).

## What it does

- **Agent identity.** Generate an Ed25519 keypair, derive the agent's
  `did:sigvara:<chainId>:<address>` and its on-chain `didHash`, and register
  the agent from the operator wallet, with a proof of control signed by the
  agent address.
- **Agent-to-agent auth.** Issue a challenge to a peer, sign one with the
  agent's key, and verify a signature against the public key stored on chain.
- **Reads.** Identity, status, six-factor reputation, `meetsThreshold`, stake
  and minimum-stake checks, and a W3C DID Document built from chain state.
- **Stake.** `depositStake` handles the ERC-20 approval and the deposit in one
  call, and is what moves a newly registered agent from `PendingBond` to
  `Active`.
- **A gate.** `SigvaraGate` turns the reads above into one decision: issue a
  challenge, admit or refuse, and say which reason applies. It owns
  the nonce, so replay protection is not left to the caller.

Scores come in two forms. The earned score is what the oracle last finalized; the total
score is the matured one, which climbs toward it over time and is what `meetsThreshold`
checks. A newly bonded agent has earned a score before it can spend it.

## Quick start

```typescript
import { SigvaraAgent, SigvaraVerifier, registerAgent, depositStake, generateChallenge } from '@sigvara/protocol-sdk';
import { ethers } from 'ethers';

const RPC = 'https://rpc.testnet.arc.io';
const CHAIN_ID = 5042002; // Arc testnet
const addresses = { identity: '0x…', reputation: '0x…', staking: '0x…' }; // deployments/5042002.json

// Operator side: create, register and bond an agent
const { agent, privateKey } = SigvaraAgent.generate({ agentAddress: '0xAgent…', chainId: CHAIN_ID });
const operator = new ethers.Wallet(process.env.OPERATOR_KEY!, new ethers.JsonRpcProvider(RPC));

// The agent address must prove control of itself. Pass a signer for it, or
// { signature } if it was signed elsewhere (HSM, Safe, any ERC-1271 contract).
const agentSigner = new ethers.Wallet(process.env.AGENT_KEY!); // a signer for agent.agentAddress
await registerAgent(operator, agent.agentAddress, agent.publicKeyBytes32, addresses.identity, { agentSigner });

// Registration leaves the agent PendingBond. This deposit is what activates it.
await depositStake(operator, agent.didHash, 1000n * 10n ** 18n, addresses.staking);

// Counterparty side: challenge the agent, verify the signature, read status and score
const verifier = new SigvaraVerifier({ rpcUrl: RPC, addresses, chainId: CHAIN_ID });
// The second argument is the audience: who is asking. Pass a stable identifier you
// control, normally your own origin. It is signed, so the agent's response proves it was
// talking to *you* and cannot be relayed onward by anyone who receives it.
const challenge = generateChallenge(agent.did, 'https://your-service.example');
// Done by the agent, returned to the counterparty. signChallengeFor refuses a challenge that is not
// addressed to the verifier the agent means to prove itself to, which is what stops a verifier from
// collecting a signature meant for someone else. (signChallenge signs whatever it is handed.)
const signature = agent.signChallengeFor(challenge.payload, 'https://your-service.example');

// Pass the same audience back when verifying. Without it the check still runs, but an
// unbound v1 payload would be accepted, which is the relayable case.
const ok = await verifier.verifySignature(
  agent.did, challenge.payload, signature, 300, 'https://your-service.example',
);
const trusted = ok && (await verifier.isActive(agent.did)) && (await verifier.meetsThreshold(agent.did, 40));
```

Signature validity, status and score are separate reads. Combining them correctly is
easy to get subtly wrong, so there is a piece that does it.

## Refusing work: `SigvaraGate`

```typescript
import { SigvaraGate } from '@sigvara/protocol-sdk';

const gate = new SigvaraGate({
  rpcUrl: RPC, addresses, chainId: CHAIN_ID,
  threshold: 40,
  audience: 'https://your-service.example', // required, and signed into every challenge
});

// 1. hand the challenge to the agent
const challenge = gate.challenge(agentDid);

// 2. the agent signs challenge.payload and returns the signature

// 3. decide
const result = await gate.admit(agentDid, challenge, signature);
if (!result.ok) {
  // 'bad_proof' | 'replayed' | 'not_active' | 'stale_score' | 'below_threshold'
  return refuse(result.reason);
}
```

The reasons are separate because they need different responses. `bad_proof` means
nothing was proven. `replayed` means a valid signature arrived twice. `not_active`
means a real, proven agent that is unbonded, suspended or slashed, and telling that
caller to earn more points would be wrong. "Unbonded" is the bond held now against the
minimum stake in force now, not the status stored when the agent was admitted: a minimum
raised since leaves an agent marked Active while it holds less than the contract asks, and
the gate reads the bond for that reason. `stale_score` appears only if you set
`maxScoreAgeSeconds`. Only `below_threshold` is about reputation, and it carries the score
so you can say how short they were.

**A score nobody has refreshed.** Nothing on chain ages a score, so one left over from an
oracle outage keeps passing a threshold. Set `maxScoreAgeSeconds` to refuse a score written
longer ago than that, or never, with `stale_score`; choose a few times your oracle's epoch,
and it is measured against your host's clock. Unset, a score is trusted however old it is.
It costs one more read per admission. The same check exists on chain as
`SigvaraReader.isTrustedFresh`, which is not deployed anywhere yet.

The constructor refuses a `threshold` that is not a finite number of 0 or more, and a
`ttlSeconds` or `maxScoreAgeSeconds` that is not a positive number. A `NaN` threshold, for example
`Number(process.env.THRESHOLD)` with the variable unset, would otherwise admit every active
agent that can prove its key, whatever its score.

The proof is checked before the status or the score is read, so a caller who cannot prove an
identity cannot make your gate read either, and a failed proof does not consume the nonce, so
nobody can lock out a challenge's legitimate holder by spending it with garbage. Checking the
proof does cost one read of the agent's registered key, because the key it is checked against lives
on chain: rate-limit callers where the gate is exposed.

Reads give up after 30 seconds (`timeoutMs` on `SigvaraGate` and `SigvaraVerifier` changes it;
ethers' own default is five minutes), and the status, the bond and the score are read together.

**The default nonce store is per process.** It is correct for one instance and wrong for
a fleet: two processes do not share a set, so a response accepted by one replays against
the other. Pass a `NonceStore` backed by Redis or your database, and implement its
optional `consume(nonce, expiresAt)` as an atomic insert-if-absent (`SET NX`, a unique
index, a conditional put). `seen` then `add` is two round trips, and two concurrent
requests carrying the same nonce can both observe it unspent before either writes.

Full protocol documentation, the reputation model and the contract addresses live in the
repository.

### What the SDK still needs from you

**An audience you control.** `SigvaraGate` requires one at construction and refuses to
be built without it. It is signed into every challenge and is what stops a response you
received being presented to somebody else as proof the agent was talking to them. Use one
stable value per service, normally your origin, not one per request.

**A shared nonce store, if you run more than one instance.** The gate remembers nonces so
you do not have to, which is the one thing this section used to say the library could not
do. The default store is in memory and therefore per process; see the note above for what
a distributed one has to implement.

**Using `verifySignature` directly still leaves the nonce to you.** It has no memory by
design, so if you are not going through the gate, store the nonces you issue, reject one
you have seen, and drop them past the TTL.

## Links

- Repository: https://github.com/RunTimeAdmin/sigvara (this package is `packages/sdk`)
- Site and docs: https://sigvara.xyz
- License: MIT
