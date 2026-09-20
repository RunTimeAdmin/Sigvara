# Changelog

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
