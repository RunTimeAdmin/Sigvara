import nacl from 'tweetnacl';
import { randomBytes } from 'crypto';
import { base58Encode, base58Decode } from './keys';
import type { Challenge, ParsedChallenge } from './types';

const DEFAULT_TTL = 300;

const V1_PREFIX = 'SIGVARA-VERIFY:';
const V2_HEADER = 'SIGVARA-VERIFY-V2';

// v1: SIGVARA-VERIFY:{proverDid}:{nonce}:{timestamp}          — accepted, deprecated
//
// v2, newline-delimited:
//
//   SIGVARA-VERIFY-V2
//   did: {proverDid}
//   aud: {audience}
//   nonce: {nonce}
//   ts: {timestamp}
//
// ## Why v2 exists
//
// v1 bound the DID, a nonce and a timestamp, and nothing about who was asking. A verifier
// holding a valid (payload, signature) pair could present that same pair to a different
// verifier and be accepted as the agent, because nothing in the signed bytes said which
// verifier the agent was talking to. Every verifier an agent authenticated to could
// impersonate it everywhere else, for the life of the challenge. Binding the audience is
// the standard fix, and the reason WebAuthn signs an rpId and SAML an Audience.
//
// ## Why newlines and not more colons
//
// v1 could parse from the right because exactly one field contained colons — the DID —
// and it sat leftmost. An audience is colon-bearing too: an origin like
// https://example.com, or in agent-to-agent auth another DID. Two colon-containing fields
// in a colon-delimited string cannot be split unambiguously, and the first attempt at this
// silently mis-parsed A2A challenges, recovering only the last segment of the audience as
// the audience and folding the rest into the DID. Forbidding colons in the audience would
// have "fixed" it by excluding the DID case the field exists for.
//
// Newlines carry no such ambiguity: neither a DID nor a URL may contain one. The parser
// rejects any field value containing a newline rather than trying to be clever about it.

export function generateChallenge(
  proverDid: string,
  audience: string,
  ttlSeconds = DEFAULT_TTL,
): Challenge {
  if (!audience) {
    throw new Error(
      'generateChallenge: audience is required. It names the verifier, so a response cannot ' +
      'be relayed to a different one. Use a stable identifier you control: your origin ' +
      '(https://example.com), or your own DID when one agent challenges another.',
    );
  }
  assertNoNewline('audience', audience);
  assertNoNewline('proverDid', proverDid);

  const nonce = randomHex(16);
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = [
    V2_HEADER,
    `did: ${proverDid}`,
    `aud: ${audience}`,
    `nonce: ${nonce}`,
    `ts: ${timestamp}`,
  ].join('\n');
  return { payload, nonce, timestamp, audience, expiresAt: timestamp + ttlSeconds };
}

// Returns a base58-encoded Ed25519 signature over the UTF-8 challenge payload.
export function signChallenge(payload: string, secretKey: Uint8Array): string {
  const messageBytes = new TextEncoder().encode(payload);
  const sigBytes = nacl.sign.detached(messageBytes, secretKey);
  return base58Encode(sigBytes);
}

// Verifies a base58-encoded Ed25519 signature against the challenge payload.
export function verifyChallenge(
  payload: string,
  signatureBase58: string,
  publicKey: Uint8Array
): boolean {
  const messageBytes = new TextEncoder().encode(payload);
  const sigBytes = base58Decode(signatureBase58);
  if (sigBytes.length !== 64) return false;
  return nacl.sign.detached.verify(messageBytes, sigBytes, publicKey);
}

export function parseChallengePayload(payload: string): ParsedChallenge {
  if (payload.startsWith(`${V2_HEADER}\n`)) return parseV2(payload);
  if (payload.startsWith(V1_PREFIX)) return parseV1(payload);
  throw new Error('Invalid challenge prefix');
}

function parseV2(payload: string): ParsedChallenge {
  const lines = payload.split('\n');
  if (lines.length !== 5) throw new Error('Malformed challenge payload');

  const field = (line: string, key: string): string => {
    const want = `${key}: `;
    if (!line.startsWith(want)) throw new Error(`Malformed challenge payload: expected ${key}`);
    return line.slice(want.length);
  };

  const did = field(lines[1], 'did');
  const audience = field(lines[2], 'aud');
  const nonce = field(lines[3], 'nonce');
  const timestamp = parseInt(field(lines[4], 'ts'), 10);

  if (!did) throw new Error('Malformed challenge payload: empty did');
  if (!audience) throw new Error('Malformed challenge payload: empty audience');
  if (!nonce) throw new Error('Malformed challenge payload: empty nonce');
  if (isNaN(timestamp)) throw new Error('Challenge payload has invalid timestamp');

  return { did, nonce, timestamp, audience, version: 2 };
}

// Timestamp and nonce are the last two segments; everything before is the DID, which
// contains colons internally. Kept so signatures made against the published v1 format
// still verify.
function parseV1(payload: string): ParsedChallenge {
  const body = payload.slice(V1_PREFIX.length);

  const lastColon = body.lastIndexOf(':');
  if (lastColon === -1) throw new Error('Malformed challenge payload');
  const timestamp = parseInt(body.slice(lastColon + 1), 10);
  if (isNaN(timestamp)) throw new Error('Challenge payload has invalid timestamp');

  const rest = body.slice(0, lastColon);
  const secondLastColon = rest.lastIndexOf(':');
  if (secondLastColon === -1) throw new Error('Malformed challenge payload');
  const nonce = rest.slice(secondLastColon + 1);
  const did = rest.slice(0, secondLastColon);

  return { did, nonce, timestamp, version: 1 };
}

export function isChallengeExpired(payload: string, maxAgeSeconds = DEFAULT_TTL): boolean {
  let timestamp: number;
  try {
    timestamp = parseChallengePayload(payload).timestamp;
  } catch {
    // Unparseable is treated as expired: the safe direction, and the previous regex
    // matched a trailing number in any string at all, so a payload that failed every
    // other check could still read as fresh.
    return true;
  }
  return Math.floor(Date.now() / 1000) - timestamp > maxAgeSeconds;
}

function assertNoNewline(field: string, value: string): void {
  if (/[\r\n]/.test(value)) {
    // A newline would let a caller inject extra fields into the signed payload and have
    // them parsed as real ones.
    throw new Error(`generateChallenge: ${field} may not contain a newline`);
  }
}

function randomHex(bytes: number): string {
  const arr: Uint8Array =
    typeof globalThis.crypto !== 'undefined' && globalThis.crypto.getRandomValues
      ? globalThis.crypto.getRandomValues(new Uint8Array(bytes))
      : randomBytes(bytes); // Node.js fallback for environments without a global crypto object
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
