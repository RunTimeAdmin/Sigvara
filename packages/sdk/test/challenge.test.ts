import { describe, it, expect } from 'vitest';
import {
  generateChallenge,
  signChallenge,
  verifyChallenge,
  parseChallengePayload,
  isChallengeExpired,
} from '../src/challenge';
import { seedToKeyPair, base58Decode } from '../src/keys';
import nacl from 'tweetnacl';

const PEER_DID = 'did:sigvara:5042002:0x0000000000000000000000000000000000000001';
const AUDIENCE = 'https://verifier.example';

describe('generateChallenge', () => {
  it('produces a well-formed payload', () => {
    const c = generateChallenge(PEER_DID, AUDIENCE);
    expect(c.payload.startsWith('SIGVARA-VERIFY-V2\n')).toBe(true);
    expect(c.audience).toBe(AUDIENCE);
    expect(c.payload).toContain(PEER_DID);
    expect(c.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(c.expiresAt).toBeGreaterThan(c.timestamp);
  });

  it('each challenge has a unique nonce', () => {
    const a = generateChallenge(PEER_DID, AUDIENCE);
    const b = generateChallenge(PEER_DID, AUDIENCE);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.payload).not.toBe(b.payload);
  });

  it('respects custom TTL', () => {
    const c = generateChallenge(PEER_DID, AUDIENCE, 60);
    expect(c.expiresAt - c.timestamp).toBe(60);
  });
});

describe('parseChallengePayload', () => {
  it('recovers the DID, nonce, and timestamp', () => {
    const { payload, nonce, timestamp } = generateChallenge(PEER_DID, AUDIENCE);
    const parsed = parseChallengePayload(payload);
    expect(parsed.did).toBe(PEER_DID);
    expect(parsed.nonce).toBe(nonce);
    expect(parsed.timestamp).toBe(timestamp);
  });

  it('throws on invalid prefix', () => {
    expect(() => parseChallengePayload('INVALID:stuff')).toThrow('Invalid challenge prefix');
  });
});

describe('signChallenge + verifyChallenge', () => {
  it('valid signature verifies', () => {
    const kp = seedToKeyPair(nacl.randomBytes(32));
    const { payload } = generateChallenge(PEER_DID, AUDIENCE);
    const sig = signChallenge(payload, kp.secretKey);
    expect(verifyChallenge(payload, sig, kp.publicKey)).toBe(true);
  });

  it('wrong key does not verify', () => {
    const kp1 = seedToKeyPair(nacl.randomBytes(32));
    const kp2 = seedToKeyPair(nacl.randomBytes(32));
    const { payload } = generateChallenge(PEER_DID, AUDIENCE);
    const sig = signChallenge(payload, kp1.secretKey);
    expect(verifyChallenge(payload, sig, kp2.publicKey)).toBe(false);
  });

  it('tampered payload does not verify', () => {
    const kp = seedToKeyPair(nacl.randomBytes(32));
    const { payload } = generateChallenge(PEER_DID, AUDIENCE);
    const sig = signChallenge(payload, kp.secretKey);
    expect(verifyChallenge(payload + 'x', sig, kp.publicKey)).toBe(false);
  });

  it('signature is 64 bytes encoded as base58', () => {
    const kp = seedToKeyPair(nacl.randomBytes(32));
    const { payload } = generateChallenge(PEER_DID, AUDIENCE);
    const sig = signChallenge(payload, kp.secretKey);
    expect(base58Decode(sig).length).toBe(64);
  });
});

describe('isChallengeExpired', () => {
  it('fresh challenge is not expired', () => {
    const { payload } = generateChallenge(PEER_DID, AUDIENCE);
    expect(isChallengeExpired(payload, 300)).toBe(false);
  });

  it('old timestamp is expired', () => {
    const oldTs = Math.floor(Date.now() / 1000) - 400;
    const payload = `SIGVARA-VERIFY:${PEER_DID}:abc123:${oldTs}`;
    expect(isChallengeExpired(payload, 300)).toBe(true);
  });

  it('malformed payload is expired', () => {
    expect(isChallengeExpired('garbage', 300)).toBe(true);
  });
});

describe('audience binding (the relay attack v2 closes)', () => {
  const AGENT_SEED = new Uint8Array(32).fill(7);

  it('a response to one verifier does not authenticate at another', () => {
    // The attack. Verifier A challenges the agent and receives a valid signature. A then
    // presents that same (payload, signature) pair to verifier B. Under v1 B accepted it,
    // because nothing in the signed bytes said who the agent was talking to, so every
    // verifier an agent authenticated to could impersonate it everywhere else.
    const kp = seedToKeyPair(AGENT_SEED);
    const forA = generateChallenge(PEER_DID, 'https://a.example');
    const signature = signChallenge(forA.payload, kp.secretKey);

    // The signature is genuinely valid — for A.
    expect(verifyChallenge(forA.payload, signature, kp.publicKey)).toBe(true);
    expect(parseChallengePayload(forA.payload).audience).toBe('https://a.example');

    // B issued its own challenge and must compare against that, not against whatever it
    // was handed. The relayed payload names A, so B rejects it on the audience alone.
    const forB = generateChallenge(PEER_DID, 'https://b.example');
    expect(parseChallengePayload(forA.payload).audience).not.toBe(
      parseChallengePayload(forB.payload).audience,
    );

    // And the signature does not carry across, because the bytes differ.
    expect(verifyChallenge(forB.payload, signature, kp.publicKey)).toBe(false);
  });

  it('an audience may be a DID, which is the agent-to-agent case', () => {
    // The first attempt at this rejected colons outside a URL scheme, which excluded
    // exactly the case the field exists for: one agent challenging another names its own
    // DID as the audience.
    const issuerDid = 'did:sigvara:5042002:0x00000000000000000000000000000000000000ff';
    const c = generateChallenge(PEER_DID, issuerDid);
    const parsed = parseChallengePayload(c.payload);
    expect(parsed.audience).toBe(issuerDid);
    expect(parsed.did).toBe(PEER_DID);
  });

  it('a colon-bearing audience round-trips without swallowing the DID', () => {
    // The bug newline delimiting fixes. Parsing a colon-delimited payload from the right
    // recovered only the last segment of a colon-bearing audience and folded the rest
    // into the DID, so both fields came back wrong while the payload still looked valid.
    for (const audience of [
      'https://verifier.example:8443/callback',
      'did:sigvara:1:0x00000000000000000000000000000000000000aa',
      'urn:example:verifier',
    ]) {
      const parsed = parseChallengePayload(generateChallenge(PEER_DID, audience).payload);
      expect(parsed.audience).toBe(audience);
      expect(parsed.did).toBe(PEER_DID);
    }
  });

  it('refuses an audience that would inject extra signed fields', () => {
    expect(() => generateChallenge(PEER_DID, 'a\nts: 9999999999')).toThrow(/newline/);
    expect(() => generateChallenge(PEER_DID, '')).toThrow(/audience is required/);
  });

  it('still parses a v1 payload, and marks it as v1', () => {
    // Published signatures must keep verifying. The version is surfaced so a caller that
    // requires an audience can refuse v1 rather than silently accepting an unbound proof.
    const parsed = parseChallengePayload(`SIGVARA-VERIFY:${PEER_DID}:deadbeef:1789000000`);
    expect(parsed.version).toBe(1);
    expect(parsed.did).toBe(PEER_DID);
    expect(parsed.nonce).toBe('deadbeef');
    expect(parsed.audience).toBeUndefined();
  });

  it('treats an unparseable payload as expired rather than fresh', () => {
    // isChallengeExpired used to match a trailing number in any string, so a payload that
    // failed every other check could still read as fresh.
    expect(isChallengeExpired('garbage')).toBe(true);
    expect(isChallengeExpired('SIGVARA-VERIFY-V2\nnope')).toBe(true);
  });
});
