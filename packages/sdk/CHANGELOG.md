# Changelog

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

This was written for the previous release and did not make it into the published
package, so `SigvaraGate` has been importable from the repo and missing from npm.

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
