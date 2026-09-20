'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const auth = require('./agent-auth');

const REGISTRY = '0x7e3aFC532eE5d922ab3cc3FFb510c7C8151477Dd';
const DID = '0x8414ce0bf4f1e1695193623e0a656a9439e356f8bed0b8bf249b179fe77c7e19';
const CHAIN = 5042002;

/** An agent's Ed25519 keypair, as the registry would hold it: raw 32-byte public key. */
function agentKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { privateKey, pubHex: raw.toString('hex') };
}

const issue = (over = {}) => auth.createChallenge({
  chainId: CHAIN, registry: REGISTRY, didHash: DID, audience: 'https://verifier.example', ...over,
});

// ---- the happy path --------------------------------------------------------

test('an agent holding the registered key authenticates', () => {
  const { privateKey, pubHex } = agentKeys();
  const c = issue();
  const signature = auth.signChallenge(c.challenge, privateKey);
  assert.deepEqual(
    auth.verifyChallenge({ challenge: c.challenge, signature, ed25519PubKey: pubHex, expiresAt: c.expiresAt }),
    { ok: true },
  );
});

test('the 0x prefix is optional on both the key and the signature', () => {
  const { privateKey, pubHex } = agentKeys();
  const c = issue();
  const signature = auth.signChallenge(c.challenge, privateKey);
  assert.equal(
    auth.verifyChallenge({ challenge: c.challenge, signature: `0x${signature}`, ed25519PubKey: `0x${pubHex}`, expiresAt: c.expiresAt }).ok,
    true,
  );
});

// ---- the attacks each field exists to stop ---------------------------------

test('a different key does not authenticate', () => {
  const a = agentKeys();
  const b = agentKeys();
  const c = issue();
  const signature = auth.signChallenge(c.challenge, b.privateKey);
  assert.equal(auth.verifyChallenge({ challenge: c.challenge, signature, ed25519PubKey: a.pubHex }).reason, 'bad_signature');
});

test('a signature for one audience does not work at another', () => {
  // The relay attack. Without the audience binding, any verifier that receives a valid
  // response can replay it to a third party and impersonate the agent there, so every
  // verifier becomes an attacker against every other.
  const { privateKey, pubHex } = agentKeys();
  const forA = issue({ audience: 'https://a.example' });
  const signature = auth.signChallenge(forA.challenge, privateKey);

  const forB = auth.buildChallenge({ ...forA, audience: 'https://b.example' });
  assert.equal(auth.verifyChallenge({ challenge: forB, signature, ed25519PubKey: pubHex }).reason, 'bad_signature');
});

test('a signature from another chain does not work here', () => {
  // The same agent address exists on every EVM chain. A testnet proof must not be a
  // mainnet proof.
  const { privateKey, pubHex } = agentKeys();
  const onTestnet = issue({ chainId: CHAIN });
  const signature = auth.signChallenge(onTestnet.challenge, privateKey);

  const onMainnet = auth.buildChallenge({ ...onTestnet, chainId: 1 });
  assert.equal(auth.verifyChallenge({ challenge: onMainnet, signature, ed25519PubKey: pubHex }).reason, 'bad_signature');
});

test('a signature against an attacker-deployed registry does not work here', () => {
  // Anyone can deploy a registry and register any agent address in it. The binding means
  // a signature is only valid against the registry whose key the verifier actually read.
  const { privateKey, pubHex } = agentKeys();
  const real = issue();
  const signature = auth.signChallenge(real.challenge, privateKey);

  const fake = auth.buildChallenge({ ...real, registry: '0x000000000000000000000000000000000000dEaD' });
  assert.equal(auth.verifyChallenge({ challenge: fake, signature, ed25519PubKey: pubHex }).reason, 'bad_signature');
});

test('a signature for one agent does not authenticate another', () => {
  const { privateKey, pubHex } = agentKeys();
  const forOne = issue();
  const signature = auth.signChallenge(forOne.challenge, privateKey);

  const forOther = auth.buildChallenge({ ...forOne, didHash: `0x${'ab'.repeat(32)}` });
  assert.equal(auth.verifyChallenge({ challenge: forOther, signature, ed25519PubKey: pubHex }).reason, 'bad_signature');
});

test('a captured signature goes stale', () => {
  const { privateKey, pubHex } = agentKeys();
  const c = issue({ ttlSeconds: 60 });
  const signature = auth.signChallenge(c.challenge, privateKey);

  const wellAfter = (c.expiresAt + auth.CLOCK_SKEW_SECONDS + 1) * 1000;
  assert.equal(
    auth.verifyChallenge({ challenge: c.challenge, signature, ed25519PubKey: pubHex, expiresAt: c.expiresAt, now: wellAfter }).reason,
    'expired',
  );
});

test('a small clock difference is tolerated rather than failing the agent', () => {
  const { privateKey, pubHex } = agentKeys();
  const c = issue({ ttlSeconds: 60 });
  const signature = auth.signChallenge(c.challenge, privateKey);

  const justAfter = (c.expiresAt + auth.CLOCK_SKEW_SECONDS - 1) * 1000;
  assert.equal(
    auth.verifyChallenge({ challenge: c.challenge, signature, ed25519PubKey: pubHex, expiresAt: c.expiresAt, now: justAfter }).ok,
    true,
  );
});

test('an unregistered agent cannot authenticate with the zero key', () => {
  // The registry returns 32 zero bytes for an agent that was never registered, not an
  // error. Zero is a valid curve point, so without an explicit check an attacker who
  // produces a signature under it authenticates as an agent that does not exist.
  const c = issue();
  assert.equal(
    auth.verifyChallenge({ challenge: c.challenge, signature: '00'.repeat(64), ed25519PubKey: '00'.repeat(32) }).reason,
    'unregistered_agent',
  );
});

// ---- malformed input fails closed ------------------------------------------

test('malformed input is refused with a reason, never accepted', () => {
  const { pubHex } = agentKeys();
  const c = issue();
  const cases = [
    [{ challenge: '', signature: '00'.repeat(64), ed25519PubKey: pubHex }, 'missing_challenge'],
    [{ challenge: 'not-a-sigvara-challenge', signature: '00'.repeat(64), ed25519PubKey: pubHex }, 'wrong_version'],
    [{ challenge: c.challenge, signature: 'abcd', ed25519PubKey: pubHex }, 'bad_signature_length'],
    [{ challenge: c.challenge, signature: '00'.repeat(64), ed25519PubKey: 'abcd' }, 'bad_pubkey_length'],
  ];
  for (const [input, reason] of cases) {
    const r = auth.verifyChallenge(input);
    assert.equal(r.ok, false);
    assert.equal(r.reason, reason);
  }
});

test('a challenge for a future version is refused, not guessed at', () => {
  const { privateKey, pubHex } = agentKeys();
  const c = issue();
  const v2 = c.challenge.replace(auth.VERSION, 'sigvara-auth-v2');
  const signature = auth.signChallenge(v2, privateKey);
  assert.equal(auth.verifyChallenge({ challenge: v2, signature, ed25519PubKey: pubHex }).reason, 'wrong_version');
});

// ---- the canonical form ----------------------------------------------------

test('buildChallenge is byte-stable and case-normalised', () => {
  // Two implementations must produce identical bytes or valid signatures fail across
  // them. Address and did casing is the likeliest source of an invisible mismatch.
  const f = { chainId: CHAIN, registry: REGISTRY, didHash: DID, audience: 'x', nonce: 'ff', expiresAt: 1789000000 };
  const a = auth.buildChallenge(f);
  const b = auth.buildChallenge({ ...f, registry: REGISTRY.toUpperCase().replace('0X', '0x'), didHash: DID.toUpperCase().replace('0X', '0x') });
  assert.equal(a, b);
  assert.equal(a, auth.buildChallenge(f));
});

test('buildChallenge refuses to omit a field rather than signing a weaker claim', () => {
  const f = { chainId: CHAIN, registry: REGISTRY, didHash: DID, audience: 'x', nonce: 'ff', expiresAt: 1789000000 };
  for (const k of Object.keys(f)) {
    const missing = { ...f };
    delete missing[k];
    assert.throws(() => auth.buildChallenge(missing), TypeError, `omitting ${k} must throw`);
  }
});

test('createChallenge issues a fresh 32-byte nonce every time', () => {
  const seen = new Set();
  for (let i = 0; i < 50; i++) {
    const c = issue();
    assert.match(c.nonce, /^[0-9a-f]{64}$/);
    assert.equal(seen.has(c.nonce), false, 'nonce repeated');
    seen.add(c.nonce);
  }
});

test('signChallenge refuses a key that is not ed25519', () => {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  assert.throws(() => auth.signChallenge(issue().challenge, privateKey), /expected an ed25519 key/);
});
