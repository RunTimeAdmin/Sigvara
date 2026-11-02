# Changelog

## Unreleased

### Added: `profile: 'production'` on `SigvaraGate`

A gate built with `profile: 'production'` refuses to start unless `instances` and
`maxScoreAgeSeconds` are both set, and the error names everything missing. Left out, they default to
one process and no age limit, so a fleet that forgot `instances` replays a response admitted at one
instance at another, and a gate without a limit keeps admitting on a score the oracle stopped
refreshing. `instances: 'multiple'` still needs a `nonceStore` with an atomic `consume()`. A
`profile` other than `'production'` is refused rather than ignored. Without a profile nothing
changes.

## 1.0.0-alpha.13

### Added: payment outcomes signed by the payer

`signPaymentOutcome(signer, { chainId, reputationAddress, didHash, txHash, outcome })` signs, as an
agent's payer, whether one payment's work was delivered (ADR 0006). The result is the `payerOutcome`
a Sigvara oracle takes at `POST /attest` without a token; a wallet's v of 0 or 1 is rewritten to 27 or
28, and a signature that does not recover to the payer is an error. `verifyPaymentOutcome` checks one
the way the oracle does, by recovery or ERC-1271, and needs a provider to tell which.
`PAYMENT_OUTCOME_TYPES` (frozen) and `paymentOutcomeDomain` are exported for wallets that sign typed
data themselves. Both functions are tested against the
repository's `test/vectors/payment-outcome.json`, which a Foundry test checks against OpenZeppelin's
`EIP712` and `SignatureChecker`.

### Added: `atomicNonceStore`, and a gate that refuses to run a fleet on the default store

`atomicNonceStore(setIfAbsent)` builds a `NonceStore` from any atomic insert-if-absent, such as a
Redis `SET NX` or a database insert that does nothing on a conflict, without the SDK taking a Redis
dependency. Its `seen()` and `add()` throw, so the gate cannot fall back to the non-atomic pair.
`SigvaraGate` takes `instances: 'multiple'` for a gate that runs as more than one process, and then
refuses to start without a `nonceStore` whose `consume()` is atomic: with the in-memory default, a
response one instance admitted could be replayed at another until its challenge expired. The default
is `'single'`, so existing gates behave as before.

### Documentation: a nonce store for a fleet

The README now shows a Redis `NonceStore` with an atomic `consume()`, and what a SQL one has to do. No
code changed. The default store is still per process, which is right for one instance and wrong for
several: a response one instance accepted is accepted again by another. The tests now run two gates on
one store and show both sides of that: a store with `consume()` admits a response once between them, even
when both receive it at the same moment, and a store with only `seen()` and `add()` does not.

## 1.0.0-alpha.12

### Removed: `SigvaraAgent.signChallenge`

`agent.signChallenge(payload)` signed whatever it was handed, with no check on who the challenge was
addressed to. The audience in a challenge protects an agent from relay only if the agent checks it
before signing, so a verifier could hand an agent a payload naming a different verifier, collect the
signature and present it there as the agent. `verifySignature` refuses a relayed response after the
fact, but it cannot refuse a signature the agent was talked into giving. `signChallengeFor(payload,
audience)` has made the check since 1.0.0-alpha.10, and the blind method stayed beside it so that
existing callers kept working.

It is gone. A call does not compile in TypeScript, and in JavaScript it throws an error that names
`signChallengeFor`, so the caller learns of the change at the call.

```diff
- const signature = agent.signChallenge(challenge.payload);
+ const signature = agent.signChallengeFor(challenge.payload, verifierAudience);
```

`verifierAudience` is what the agent knows about who it is talking to: the origin it connected to, or
the other agent's DID. It is the string the verifier passes as `expectedAudience`. Code that signs a
payload it built itself passes the audience it built it for. `signChallengeFor` works from
1.0.0-alpha.10, so the change can be made before upgrading.

Not changed: the exported function `signChallenge(payload, secretKey)` takes a key the caller holds
and signs the bytes it is given, and stays.

## 1.0.0-alpha.11

### Changed: `verifySignature` requires the audience

`SigvaraVerifier.verifySignature(did, payload, signature, maxAgeSeconds, expectedAudience)` took the
audience as an optional last argument. Left out, the check of who the agent had signed for did not run,
so a verifier that held a valid response could present it to another verifier and be accepted as the
agent, and a v1 payload, which names no audience at all, was accepted too. `SigvaraGate` always passed
its audience and was not affected. The low-level call was one omitted argument away from the relayable
case, and the compiler said nothing.

The audience is now required. A call without it does not compile in TypeScript, and in JavaScript it
throws `expectedAudience is required` before the payload is read or the chain is touched. It throws
instead of returning `false` because a missing audience is a bug in the caller, and a `false` reads as an
ordinary refusal and hides it. A v1 payload is now always refused, since there is nothing in it to
check. Ask the agent for a v2 challenge: `generateChallenge(did, audience)` has made one since
1.0.0-alpha.8.

A caller that already passes the audience needs no change, and the arguments stay where they were:

```diff
- const ok = await verifier.verifySignature(did, payload, signature);
+ const ok = await verifier.verifySignature(did, payload, signature, 300, 'https://your-service.example');
```

Pass `undefined` in place of `300` to keep the default lifetime. The audience is the string you gave to
`generateChallenge`: your origin, or your own DID when one agent verifies another.

Not changed: `signChallenge` still signs whatever it is handed. Use `signChallengeFor`, which refuses a
challenge that is not addressed to the audience you name.

## 1.0.0-alpha.10

### Fixed: a challenge dated in the future never expired

`isChallengeExpired`, and with it `verifySignature` and `SigvaraGate.admit`, compared only
a challenge's age. A payload dated ahead of the verifier's clock counted as fresh for as
long as the date stayed ahead, so a signature over one dated ten years out worked for ten
years. That is how audience binding was defeated in practice: a peer the agent
authenticates to can hand it a payload naming a different verifier, and the agent signs
it (`signChallenge` does not inspect what it signs). A gate also kept such a nonce until
its far-off expiry, which stalled its pruning behind it.

A payload dated more than 60 seconds (`MAX_FUTURE_SKEW_SECONDS`) ahead is now refused as
not fresh. Challenges a gate issues itself are dated by its own clock and are unaffected.

### Changed: chain reads time out, and `admit` reads in parallel

`SigvaraVerifier` built its provider with ethers' defaults, which wait five minutes for an RPC
that has gone quiet, so a gate whose node died held every `admit` that long. Reads now give up
after 30 seconds, `DEFAULT_RPC_TIMEOUT_MS`, and `timeoutMs` on `SigvaraVerifier` and
`SigvaraGate` changes it (a positive number). The calls are single view calls, so one that takes
half a minute is not going to answer. Anyone who relied on the five-minute wait can pass it.

`SigvaraGate.admit` read the identity, then the status, then the score, one after the other. The
status and the score do not depend on each other and now go out together, so an admit costs two
round trips and not three. The answer is unchanged: standing is still named before score.

The gate's comment that an unauthenticated caller "cannot make this gate do RPC work" was not
true: checking the signature needs the agent's registered key, which is read from chain first.
The width check bounds what a malformed signature costs, and a well-sized one for a registered
agent costs one identity read. The comment and the README now say so; rate-limit callers where
the gate is exposed.

### New: `SigvaraAgent.signChallengeFor(payload, audience)`

`signChallenge` signs whatever it is handed, so the audience in a challenge protected an agent
from relay only if the verifier was honest: any verifier could pass it a payload naming a
different verifier, collect the signature, and present it there as the agent. The audience
binding is only as strong as the signer's check of it, and the signer had none.

`signChallengeFor` is that check, added beside `signChallenge` so existing callers keep
working. It signs only a v2 challenge that names this agent as the prover and names exactly
the audience the caller passes (what it knows about who it is talking to, such as the origin
it connected to or the peer's DID), and otherwise throws and signs nothing. `signChallenge`
is documented as signing blind. Prefer `signChallengeFor`.

Not changed, on purpose: a gate still admits a challenge it did not issue. A self-issued,
fresh, audience-correct, unused challenge proves possession of the key as well as an issued
one, and requiring issuance would break stateless gates. With the signer checking the
audience, what a relayed challenge could do is already refused at both ends.

### Changed: `SigvaraGate` refuses a threshold or lifetime that is not a usable number

`new SigvaraGate(...)` now throws when `threshold` is not a finite number of 0 or more, or when
`ttlSeconds` is not a positive number. Both used to be accepted. `score < NaN` is false, so a
threshold taken from `Number(process.env.X)` with `X` unset admitted every active agent that could
prove its key, whatever its score. A `NaN` lifetime made every spent nonce look expired as soon as it
was stored, so a captured proof could be replayed inside its window. Both failed open and said
nothing. A gate built from a setting that was never checked will now fail at construction.

### Changed: `SigvaraAgent` keeps its secret key in a private field

The key was a TypeScript `private` property, which is erased at compile time, so
`JSON.stringify(agent)`, a logged agent and an error reporter's snapshot all carried it. It is now a
true private field and none of them do. Code that read the key by reaching around the type system
stops working; sign with `signChallengeFor` or `signChallenge`.

Moving to this release stops the leak. It does not undo a copy that already exists. If an agent from
1.0.0-alpha.9 or earlier was ever logged, serialized, sent to an error reporter or attached to a bug
report, treat that agent's key as exposed: anyone who can read that copy can sign as the agent until the
key is rotated. Suspend the agent, rotate its public key on chain and reinstate it, as
[Key Rotation](https://github.com/RunTimeAdmin/Sigvara#key-rotation) describes.

### Changed: `SigvaraGate` also checks the bond held now

`admit` read the stored status and the matured score. The status is written when an agent is admitted,
slashed or unbonded, so a minimum stake raised afterwards left an agent Active while it held less than
the contract now asked, and the gate admitted what `SigvaraReader.isTrusted` refuses. The gate now reads
`hasMinimumStake` beside the status and the score, in the same parallel batch, and refuses an agent below
the minimum with `not_active`, which already meant "not bonded, suspended or slashed". An agent that was
admitted at an old minimum and has not topped up will be refused where it passed before.

### New: `maxScoreAgeSeconds` on `SigvaraGate`, `stale_score`, and `verifier.getScoreUpdatedAt(did)`

Nothing on chain ages a score, so one left over from an oracle outage keeps satisfying a threshold. A gate
given `maxScoreAgeSeconds` refuses a score written longer ago than that, or never, with the new reason
`stale_score`, named after standing and before the number. It is off by default, and a gate without it
makes no extra read. It must be a positive finite number, and the constructor refuses anything else for
the reason it refuses a `NaN` threshold. `getScoreUpdatedAt` is the read behind it: when the score was
last written, in unix seconds, 0 if never. Code that switches exhaustively on `AdmitReason` needs a case for
`stale_score` only if it sets the limit.

### Tests: the built package is checked for the secret key

`test/built-package.test.ts` loads `dist/` the way a consumer does and looks for the agent's seed in
`JSON.stringify`, spread and `Object.assign` copies, a structured clone, `util.inspect` with hidden
properties, `util.format` and an error message. 1.0.0-alpha.9 shipped with the key in an ordinary property
while the tests of the source passed, because TypeScript's `private` keyword is erased when it compiles;
run against that build the new test fails. `prepublishOnly` now builds and runs the tests, so a release
cannot go out without it.

## 1.0.0-alpha.9

### New: `SigvaraGate`

A gate: something that refuses work to agents without standing. `meetsThreshold` and
challenge-response had both existed for releases without a consumer, and a score nothing
refuses work over is a number in a database.

```ts
import { SigvaraGate } from '@sigvara/protocol-sdk';

const gate = new SigvaraGate({
  rpcUrl, addresses, threshold: 40,
  audience: 'https://tools.example',   // required: binds the challenge to you
});

const challenge = gate.challenge(agentDid);
// ...agent signs challenge.payload...
const result = await gate.admit(agentDid, challenge, signatureBase58);
if (!result.ok) console.log(result.reason);
```

It owns the nonce, which the README previously left to the integrator: `verifySignature`
has no memory, so a captured response replays until the challenge expires, and "track
nonces yourself" is how that gets skipped. The default store is in memory and therefore
per process; pass a `NonceStore` backed by Redis or similar behind a load balancer, and
implement its optional `consume()` so the check is atomic across instances.

Refusals say which of four things happened, because they need different responses:
`bad_proof`, `replayed`, `not_active`, `below_threshold`. Only the last is about
reputation.

This was written for the previous release, 1.0.0-alpha.8, and did not make it into that release's
published package, so until this one `SigvaraGate` was importable from the repo and missing from npm.

### New: `verifier.getTotalScore(did)`

Returns the matured score on its own. `getReputation` reads the raw factor tuple and the
total together, which is the right shape when you want the breakdown and a wasted contract
read when you want one number to compare against a threshold.

The quickstart guide called this method for some time before it existed. If you followed
it and got `TypeError: verifier.getTotalScore is not a function`, that is why; it works
now.

### Fix: `hexToBytes` rejects non-hex characters

**This can throw where earlier versions silently returned the wrong answer.** It validated
length and nothing else, so `parseInt` returned `NaN` for a bad pair and `Uint8Array`
wrote `NaN` as `0`.

The damage was in `seedToKeyPair`, where a human types or pastes 64 characters. Measured:

```
'9' x 64        -> pubkey 332ebe8d27cb7323...
'g' + '9' x 63  -> pubkey 377a39c8959a1775...   (no error)
```

One mistyped character produced a *different valid keypair*. The agent registers one
public key, signs challenges with another, and every authentication fails with nothing
pointing at the seed. The error now names the offending character and its index.

If your code was passing malformed hex and appearing to work, it was not working.

### Fix: an impossible signature width is refused before the chain read

`verifySignature` now returns `false` for a base58 signature outside 64–88 characters
without doing an identity lookup. A 64-byte Ed25519 signature cannot encode outside that
range: measured across the all-zero and all-0xff vectors, every leading-zero prefix length
and 20,000 random 64-byte values. Previously an arbitrarily long alphabet-valid string
bought an RPC round trip and an unbounded BigInt decode before failing.

### Performance: nonce pruning is proportional to what expired

`MemoryNonceStore.prune()` ran on every accepted admission and scanned the whole map, so
admitting one agent cost work proportional to how busy the gate was. It now stops at the
first live entry.


## 1.0.0-alpha.8

### Breaking: `generateChallenge` requires an audience

```diff
- const challenge = generateChallenge(agentDid);
+ const challenge = generateChallenge(agentDid, 'https://your-service.example');
```

And pass the same value back when verifying:

```diff
- await verifier.verifySignature(did, payload, signature);
+ await verifier.verifySignature(did, payload, signature, 300, 'https://your-service.example');
```

`SigvaraAgent.issueChallenge(peerDid)` is unchanged at the call site: it now names the
challenging agent as the audience automatically, which is the correct value for
agent-to-agent auth.

**Why this is worth a breaking change in alpha.** The previous challenge bound the prover
DID, a nonce and a timestamp, and nothing about who was asking. A verifier holding a valid
`(payload, signature)` pair could present that same pair to a *different* verifier and be
accepted as the agent, because the signed bytes never said who the agent was talking to.
Any verifier an agent authenticated to could impersonate it everywhere else, for the life
of the challenge. Binding the audience is the standard fix, and the reason WebAuthn signs
an `rpId` and SAML an `Audience`.

The `expectedAudience` argument to `verifySignature` is optional, so existing calls keep
compiling. They also keep accepting relayable v1 proofs, which is the thing to fix: pass
the audience.

### Challenge payload format is now newline-delimited

v2 payloads look like this, and v1 payloads still parse so published signatures keep
verifying:

```
SIGVARA-VERIFY-V2
did: did:sigvara:5042002:0x…
aud: https://your-service.example
nonce: …
ts: 1789…
```

The shape changed because v1's colon delimiting could not carry two colon-bearing fields.
It parsed from the right, which worked while the DID was the only field containing colons.
An audience is colon-bearing as well — an origin, or another DID in the agent-to-agent
case — so a colon-delimited v2 recovered only the last segment of the audience and folded
the rest into the DID, while still looking valid. Neither a DID nor a URL may contain a
newline, so the ambiguity disappears. `generateChallenge` rejects a field containing one,
so a caller cannot inject extra signed fields.

`parseChallengePayload` now returns `version: 1 | 2` and an optional `audience`. A caller
that requires an audience should refuse `version === 1` rather than accept an unbound
proof.

### Fixed: an unparseable payload read as fresh

`isChallengeExpired` matched a trailing number in any string, so a payload that failed
every other check could still report as not expired. It now parses the payload and treats
anything unparseable as expired.

### Still yours to do

`verifySignature` has no memory, so it cannot stop a replay. Record the nonces you issue,
reject one you have already seen, and drop them once past the TTL. The library does not own
your storage and cannot do this for you.

## 1.0.0-alpha.7

Initial published release: agent identity, reputation reads, staking helpers and
challenge-response authentication.
