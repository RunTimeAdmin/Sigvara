'use strict';

/**
 * Challenge-response authentication for agents that are not wallets.
 *
 * Sigvara's identity model assumes an agent is an Ethereum address, because registration
 * proves control with a secp256k1 signature from that address. Most autonomous agents are
 * not wallets: an MCP server, an HTTP API, a scheduled job. They can hold a key, but
 * making them hold an *Ethereum* key and sign transactions with it to prove who they are
 * at runtime is the wrong shape.
 *
 * That is why registration also stores a raw 32-byte Ed25519 public key on chain.
 * SigvaraIdentity says it is "for off-chain challenge-response auth", ADR 0001 calls it
 * the registry's only non-redundant content, and until now nothing implemented it. The
 * key was declared and unused, so the answer to "how does a non-wallet agent prove it is
 * this DID" was written down and not available.
 *
 * This is that protocol. It is deliberately off-chain and registry-agnostic: it reads a
 * public key and verifies a signature, so it works whether the key is keyed to a
 * did:sigvara hash today or to an ERC-8004 agent id after the cutover in ADR 0001.
 *
 * ## The shape
 *
 *   1. A verifier builds a challenge with a fresh nonce and a short expiry.
 *   2. The agent signs the challenge bytes with its Ed25519 private key.
 *   3. The verifier reads the agent's ed25519PubKey from the identity registry and
 *      checks the signature against the exact bytes it issued.
 *
 * Nothing is written on chain and no gas is spent. The agent never touches an Ethereum
 * key after registration.
 *
 * ## What the challenge binds, and why each part is load-bearing
 *
 * A signature is only as good as what it commits to. Each field closes an attack:
 *
 *   version    A signature for v1 cannot be replayed if v2 changes the meaning of a
 *              field. Without it, a future format change silently revalues old
 *              signatures.
 *   chainId    The same agent address exists on every EVM chain. Without this, a
 *              signature proving identity on a testnet proves it on mainnet.
 *   registry   Anyone can deploy their own registry and register any agent address in
 *              it. Binding the registry means a signature is only valid against the
 *              registry whose key the verifier actually read.
 *   did        The agent being claimed. Obvious, and it is still the field most likely
 *              to be omitted by a hand-rolled implementation.
 *   audience   Who asked. Without it, a verifier can relay a challenge it received to a
 *              third party and impersonate the agent there. This is the field people
 *              leave out, and it turns every verifier into an attacker.
 *   nonce      Freshness. The verifier chooses it, so a captured signature cannot be
 *              replayed at the same audience later.
 *   expires    Bounds how long a leaked signature is worth anything.
 *
 * The signed payload is the canonical text below, UTF-8, exactly as built. Verification
 * re-derives it from fields the verifier already holds rather than trusting a string the
 * agent sent, so a mismatch anywhere fails rather than being negotiated.
 */

const crypto = require('node:crypto');

const VERSION = 'sigvara-auth-v1';

/// Default validity. Long enough for a slow round trip, short enough that a leaked
/// signature is stale before it is useful.
const DEFAULT_TTL_SECONDS = 300;

/// Clock skew allowed when checking expiry. Verifier and agent clocks differ, and
/// refusing a signature because the agent's clock is two seconds fast is a support
/// ticket, not a defence.
const CLOCK_SKEW_SECONDS = 30;

/// DER prefix for an Ed25519 SubjectPublicKeyInfo. Node's createPublicKey takes SPKI,
/// and the registry stores the bare 32-byte key, so the wrapper is reconstructed here.
/// Fixed bytes: SEQUENCE(SEQUENCE(OID 1.3.101.112), BIT STRING).
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

const hexToBuf = (h) => Buffer.from(String(h || '').replace(/^0x/i, ''), 'hex');

/**
 * Build the canonical challenge text. Both sides derive this; neither sends it and
 * expects the other to sign whatever arrives.
 *
 * @param {{chainId:number|string, registry:string, didHash:string, audience:string,
 *          nonce:string, expiresAt:number}} f
 * @returns {string} the exact bytes to sign, UTF-8
 */
function buildChallenge(f) {
  for (const k of ['chainId', 'registry', 'didHash', 'audience', 'nonce', 'expiresAt']) {
    if (f[k] === undefined || f[k] === null || f[k] === '') {
      throw new TypeError(`buildChallenge: ${k} is required`);
    }
  }
  if (!Number.isInteger(Number(f.expiresAt))) {
    throw new TypeError('buildChallenge: expiresAt must be a unix timestamp in seconds');
  }
  // Newline-delimited key: value, fixed order. Not JSON: two JSON encoders can order
  // keys or escape characters differently and produce different bytes for the same
  // object, which would make a valid signature fail against a different implementation.
  return [
    VERSION,
    `chainId: ${Number(f.chainId)}`,
    `registry: ${String(f.registry).toLowerCase()}`,
    `did: ${String(f.didHash).toLowerCase()}`,
    `audience: ${f.audience}`,
    `nonce: ${f.nonce}`,
    `expires: ${Number(f.expiresAt)}`,
  ].join('\n');
}

/**
 * A fresh challenge for a verifier to issue.
 *
 * The nonce is 32 bytes from the CSPRNG. The verifier must remember it until the
 * challenge expires, or replay protection is decorative: an attacker can otherwise reuse
 * one captured signature until it goes stale.
 */
function createChallenge({ chainId, registry, didHash, audience, ttlSeconds = DEFAULT_TTL_SECONDS, now = Date.now() }) {
  const nonce = crypto.randomBytes(32).toString('hex');
  const expiresAt = Math.floor(now / 1000) + Number(ttlSeconds);
  const fields = { chainId, registry, didHash, audience, nonce, expiresAt };
  return { ...fields, challenge: buildChallenge(fields) };
}

/**
 * Verify a signature over a challenge.
 *
 * Returns {ok:true} or {ok:false, reason}. A reason rather than a bare false, because
 * "the agent's clock is off" and "this is not the agent's key" need different responses
 * and a boolean makes them indistinguishable in an operator's logs.
 *
 * @param {object} o
 * @param {string} o.challenge      the exact text the verifier issued
 * @param {string} o.signature      64-byte Ed25519 signature, hex, 0x optional
 * @param {string} o.ed25519PubKey  raw 32-byte key from the registry, hex, 0x optional
 * @param {number} [o.expiresAt]    checked when given; pass what was issued
 */
function verifyChallenge({ challenge, signature, ed25519PubKey, expiresAt, now = Date.now() }) {
  if (!challenge || typeof challenge !== 'string') return { ok: false, reason: 'missing_challenge' };
  if (!challenge.startsWith(`${VERSION}\n`)) return { ok: false, reason: 'wrong_version' };

  const sig = hexToBuf(signature);
  if (sig.length !== 64) return { ok: false, reason: 'bad_signature_length' };

  const pub = hexToBuf(ed25519PubKey);
  if (pub.length !== 32) return { ok: false, reason: 'bad_pubkey_length' };
  // An unregistered agent reads back as 32 zero bytes rather than an error, and a
  // zero key is a valid curve point, so without this an agent that never registered
  // authenticates to anyone who can produce a signature under the zero key.
  if (pub.every((b) => b === 0)) return { ok: false, reason: 'unregistered_agent' };

  if (expiresAt !== undefined) {
    const nowSec = Math.floor(now / 1000);
    if (nowSec > Number(expiresAt) + CLOCK_SKEW_SECONDS) return { ok: false, reason: 'expired' };
  }

  let key;
  try {
    key = crypto.createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, pub]),
      format: 'der',
      type: 'spki',
    });
  } catch {
    return { ok: false, reason: 'bad_pubkey' };
  }

  // Ed25519 signs the message directly; the algorithm argument is null by design.
  const ok = crypto.verify(null, Buffer.from(challenge, 'utf8'), key, sig);
  return ok ? { ok: true } : { ok: false, reason: 'bad_signature' };
}

/**
 * Sign a challenge. Here so an agent implementation and its tests share one path with
 * the verifier, rather than each side reimplementing the byte layout.
 *
 * @param {string} challenge
 * @param {crypto.KeyObject|Buffer|string} privateKey PKCS8 PEM/DER, or a KeyObject
 */
function signChallenge(challenge, privateKey) {
  // Accept a KeyObject as well as PEM/DER bytes. createPrivateKey refuses a KeyObject
  // that is already a key, and generateKeyPairSync hands back exactly that, so the
  // obvious caller is the one that breaks.
  const key = (privateKey && privateKey.type === 'private')
    ? privateKey
    : crypto.createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new TypeError(`signChallenge: expected an ed25519 key, got ${key.asymmetricKeyType}`);
  }
  return crypto.sign(null, Buffer.from(challenge, 'utf8'), key).toString('hex');
}

module.exports = {
  VERSION,
  DEFAULT_TTL_SECONDS,
  CLOCK_SKEW_SECONDS,
  buildChallenge,
  createChallenge,
  verifyChallenge,
  signChallenge,
};
