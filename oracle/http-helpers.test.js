'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readBody, readCredentials, identifyCaller, mayAttestUnauthenticated, parseScorePath, rateLimited, RATE_MAX, RATE_WINDOW_MS, clientKey, adminTokenPolicyError, rateBucketCount, runningCommit } = require('./http-helpers');

// Minimal fake matching the subset of http.IncomingMessage that readBody uses:
// an EventEmitter with data/end/error events plus a destroy() method.
function makeFakeRequest() {
  const req = new EventEmitter();
  req.destroy = () => req.emit('destroyed');
  return req;
}

// -------------------------------------------------------------------------
// identifyCaller — the same cases the single-token isAuthorized covered, plus the
// multi-credential behaviour that replaced it.
// -------------------------------------------------------------------------

const one = new Map([['admin', 'secret']]);

test('identifyCaller: nothing configured -> auth disabled', () => {
  // Old behaviour for local runs, and why adminTokenPolicyError refuses a non-loopback
  // bind in this state. Named rather than `true` so a log line cannot be mistaken for
  // an authorised one.
  assert.equal(identifyCaller({}, new Map()), 'unauthenticated');
  assert.equal(identifyCaller({ authorization: 'garbage' }, new Map()), 'unauthenticated');
});

test('identifyCaller: configured, missing header -> null', () => {
  assert.equal(identifyCaller({}, one), null);
});

test('identifyCaller: configured, wrong token -> null', () => {
  assert.equal(identifyCaller({ authorization: 'Bearer wrong' }, one), null);
});

test('identifyCaller: configured, correct token -> the credential name', () => {
  assert.equal(identifyCaller({ authorization: 'Bearer secret' }, one), 'admin');
});

test('identifyCaller: a header without the Bearer prefix does not match', () => {
  assert.equal(identifyCaller({ authorization: 'secret' }, one), null);
});

test('identifyCaller: names the credential that presented, not just that one did', () => {
  // The point of the change: a write can be attributed to a service.
  const many = new Map([['admin', 'a'], ['counteraudit', 'b'], ['hoodscan', 'c']]);
  assert.equal(identifyCaller({ authorization: 'Bearer a' }, many), 'admin');
  assert.equal(identifyCaller({ authorization: 'Bearer b' }, many), 'counteraudit');
  assert.equal(identifyCaller({ authorization: 'Bearer c' }, many), 'hoodscan');
});

test('identifyCaller: revoking one credential leaves the others working', () => {
  // The reason per-service tokens exist at all. Removing counteraudit must not
  // require rotating hoodscan.
  const after = new Map([['admin', 'a'], ['hoodscan', 'c']]);
  assert.equal(identifyCaller({ authorization: 'Bearer b' }, after), null, 'revoked');
  assert.equal(identifyCaller({ authorization: 'Bearer c' }, after), 'hoodscan', 'unaffected');
});

test('identifyCaller: a token valid for one name is not valid under another', () => {
  const many = new Map([['admin', 'a'], ['counteraudit', 'b']]);
  assert.notEqual(identifyCaller({ authorization: 'Bearer b' }, many), 'admin');
});

test('identifyCaller: no credentials object at all is treated as unconfigured', () => {
  assert.equal(identifyCaller({}, null), 'unauthenticated');
  assert.equal(identifyCaller({}, undefined), 'unauthenticated');
});

// -------------------------------------------------------------------------
// readCredentials
// -------------------------------------------------------------------------

test('readCredentials: ORACLE_ADMIN_TOKEN still works, as `admin`', () => {
  // Dropping it would lock the operator out of a running oracle at the next restart.
  const c = readCredentials({ ORACLE_ADMIN_TOKEN: 'x' });
  assert.deepEqual([...c], [['admin', 'x']]);
});

test('readCredentials: collects ORACLE_TOKEN_<NAME>, lowercased', () => {
  const c = readCredentials({ ORACLE_TOKEN_COUNTERAUDIT: 'b', ORACLE_TOKEN_HoodScan: 'c' });
  assert.deepEqual([...c.keys()].sort(), ['counteraudit', 'hoodscan']);
});

test('readCredentials: ignores empty values and unrelated variables', () => {
  // An empty variable is how a credential gets revoked without deleting the line, so
  // it must not register as a usable token.
  const c = readCredentials({ ORACLE_TOKEN_GONE: '', ORACLE_ADMIN_TOKEN: '', PATH: '/bin', ORACLE_STATE_PATH: '/data/x' });
  assert.equal(c.size, 0);
});

test('readCredentials: nothing configured yields an empty map, not a crash', () => {
  assert.equal(readCredentials({}).size, 0);
});

// -------------------------------------------------------------------------
// adminTokenPolicyError, with credentials
// -------------------------------------------------------------------------

test('adminTokenPolicyError: per-service tokens alone satisfy it', () => {
  // An oracle configured with no ORACLE_ADMIN_TOKEN at all must still start.
  assert.equal(adminTokenPolicyError('0.0.0.0', new Map([['counteraudit', 'b']])), null);
});

test('adminTokenPolicyError: an empty credential map on a public bind is refused', () => {
  const err = adminTokenPolicyError('0.0.0.0', new Map());
  assert.match(err, /no write credentials/);
});

// -------------------------------------------------------------------------
// readBody
// -------------------------------------------------------------------------

test('readBody: parses a valid JSON body', async () => {
  const req = makeFakeRequest();
  const promise = readBody(req);
  req.emit('data', Buffer.from('{"didHash":"0xabc","success":true}'));
  req.emit('end');

  const body = await promise;
  assert.deepEqual(body, { didHash: '0xabc', success: true });
});

test('readBody: empty body resolves to an empty object', async () => {
  const req = makeFakeRequest();
  const promise = readBody(req);
  req.emit('end');

  const body = await promise;
  assert.deepEqual(body, {});
});

test('readBody: invalid JSON rejects', async () => {
  const req = makeFakeRequest();
  const promise = readBody(req);
  req.emit('data', Buffer.from('not json'));
  req.emit('end');

  await assert.rejects(promise, /Invalid JSON/);
});

test('readBody: oversized body destroys the request and rejects', async () => {
  const req = makeFakeRequest();
  let destroyed = false;
  req.on('destroyed', () => { destroyed = true; });

  const promise = readBody(req, 10); // 10-byte limit for this test
  req.emit('data', Buffer.from('this is way more than ten bytes'));

  await assert.rejects(promise, /too large/);
  assert.equal(destroyed, true);
});

test('readBody: chunks are reassembled in order', async () => {
  const req = makeFakeRequest();
  const promise = readBody(req);
  req.emit('data', Buffer.from('{"didHash":'));
  req.emit('data', Buffer.from('"0xabc"}'));
  req.emit('end');

  const body = await promise;
  assert.deepEqual(body, { didHash: '0xabc' });
});

// -------------------------------------------------------------------------
// parseScorePath
// -------------------------------------------------------------------------

test('parseScorePath: valid path returns the didHash', () => {
  const didHash = '0x' + 'a'.repeat(64);
  assert.equal(parseScorePath(`/score/${didHash}`), didHash);
});

test('parseScorePath: wrong hex length returns null', () => {
  assert.equal(parseScorePath('/score/0x1234'), null);
});

test('parseScorePath: missing 0x prefix returns null', () => {
  assert.equal(parseScorePath(`/score/${'a'.repeat(64)}`), null);
});

test('parseScorePath: unrelated path returns null', () => {
  assert.equal(parseScorePath('/health'), null);
});

// -------------------------------------------------------------------------
// rateLimited
// -------------------------------------------------------------------------

test('rateLimited: allows up to the max, then blocks within the window', () => {
  const key = 'ip-a';
  const now = 1_000_000;
  for (let i = 0; i < RATE_MAX; i++) {
    assert.equal(rateLimited(key, now), false, `request ${i + 1} should pass`);
  }
  assert.equal(rateLimited(key, now), true, 'the (max+1)th request is blocked');
});

test('rateLimited: window reset clears the count', () => {
  const key = 'ip-b';
  const now = 2_000_000;
  for (let i = 0; i < RATE_MAX; i++) rateLimited(key, now);
  assert.equal(rateLimited(key, now), true, 'blocked at the cap');
  assert.equal(rateLimited(key, now + 60_001), false, 'allowed again after the window');
});

test('rateLimited: buckets for keys that never return are swept', () => {
  // The leak: a bucket is replaced when its own key comes back, so a busy client stays
  // bounded on its own. A key seen once and never again was not, and on the public
  // routes that meant one resident entry per client address ever observed, at a rate an
  // unauthenticated caller chooses.
  const now = 10_000_000;
  // The first call sweeps (nothing has swept yet in this process) and only then
  // inserts, so the earlier tests' expired buckets are already gone and the 500 stand
  // alone. Asserting a delta instead of the count was wrong for exactly that reason:
  // the sweep under test removed the baseline the delta was measured from.
  for (let i = 0; i < 500; i++) rateLimited(`one-shot-${i}`, now);
  assert.equal(rateBucketCount(), 500, 'the one-shot keys are resident');

  // A request in a later window triggers the sweep. The 500 are gone; the caller that
  // just arrived remains.
  rateLimited('later', now + RATE_WINDOW_MS + 1);
  assert.equal(rateBucketCount(), 1, 'only the live bucket survives');
});

test('rateLimited: the sweep does not run more than once per window', () => {
  // It is a full pass, so doing it on every request would trade a leak for a scan.
  const now = 20_000_000;
  rateLimited('sweep-a', now);
  rateLimited('sweep-b', now + 1);
  assert.equal(rateBucketCount(), 2, 'no sweep within the window');
});

test('rateLimited: separate keys have independent buckets', () => {
  const now = 3_000_000;
  for (let i = 0; i < RATE_MAX; i++) rateLimited('ip-c', now);
  assert.equal(rateLimited('ip-c', now), true, 'ip-c is capped');
  assert.equal(rateLimited('ip-d', now), false, 'ip-d is unaffected');
});

test('adminTokenPolicyError: loopback binds may run without a token', () => {
  assert.equal(adminTokenPolicyError('127.0.0.1', ''), null);
  assert.equal(adminTokenPolicyError('localhost', ''), null);
  assert.equal(adminTokenPolicyError('::1', ''), null);
});

test('adminTokenPolicyError: a non-loopback bind without a token is refused', () => {
  // The message names both ways to configure one now, since ORACLE_ADMIN_TOKEN is no
  // longer the only option.
  const err = adminTokenPolicyError('0.0.0.0', '');
  assert.match(err, /no write credentials/);
  assert.match(err, /ORACLE_ADMIN_TOKEN/);
  assert.match(err, /ORACLE_TOKEN_/);
  assert.match(err, /HOST=0.0.0.0/);
});

test('adminTokenPolicyError: any bind is fine once a token is set', () => {
  assert.equal(adminTokenPolicyError('0.0.0.0', 'secret'), null);
});

// --- clientKey -------------------------------------------------------------
// The oracle sits behind a reverse proxy, so the socket address is 127.0.0.1 for
// every caller. Getting this wrong in either direction is a real failure: trust the
// header too much and anyone mints unlimited buckets, trust it too little and one
// abuser rate-limits the whole internet.

const asReq = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });

test('clientKey: a direct connection uses its socket address', () => {
  assert.equal(clientKey(asReq('203.0.113.7')), '203.0.113.7');
});

test('clientKey: a direct caller cannot spoof a different key with X-Forwarded-For', () => {
  const req = asReq('203.0.113.7', { 'x-forwarded-for': '198.51.100.1' });
  assert.equal(clientKey(req), '203.0.113.7', 'the header is ignored off loopback');
});

test('clientKey: a proxied request is keyed on the forwarded address, not loopback', () => {
  assert.equal(clientKey(asReq('127.0.0.1', { 'x-forwarded-for': '198.51.100.1' })), '198.51.100.1');
  assert.equal(clientKey(asReq('::1', { 'x-forwarded-for': '198.51.100.2' })), '198.51.100.2');
  assert.equal(clientKey(asReq('::ffff:127.0.0.1', { 'x-forwarded-for': '198.51.100.3' })), '198.51.100.3');
});

test('clientKey: two proxied clients get separate buckets', () => {
  const a = clientKey(asReq('127.0.0.1', { 'x-forwarded-for': '198.51.100.1' }));
  const b = clientKey(asReq('127.0.0.1', { 'x-forwarded-for': '198.51.100.2' }));
  assert.notEqual(a, b, 'otherwise one abuser locks out every visitor');
});

test('clientKey: a client-supplied X-Forwarded-For cannot win a fresh bucket', () => {
  // The proxy appends the real address, so the header arrives as "spoofed, real".
  // Reading the first entry would let one attacker mint a new bucket per request.
  const req = asReq('127.0.0.1', { 'x-forwarded-for': '10.0.0.1, 198.51.100.9' });
  assert.equal(clientKey(req), '198.51.100.9');

  const flood = ['a', 'b', 'c'].map(s =>
    clientKey(asReq('127.0.0.1', { 'x-forwarded-for': `${s}, 198.51.100.9` })));
  assert.deepEqual(flood, ['198.51.100.9', '198.51.100.9', '198.51.100.9'],
    'every spoof attempt lands in the same bucket');
});

test('clientKey: a proxied request with no forwarded header falls back to the socket', () => {
  assert.equal(clientKey(asReq('127.0.0.1')), '127.0.0.1');
  assert.equal(clientKey(asReq('127.0.0.1', { 'x-forwarded-for': '   ' })), '127.0.0.1');
});

test('clientKey: a request with no socket is keyed, not crashed', () => {
  assert.equal(clientKey({}), 'unknown');
  assert.equal(clientKey(undefined), 'unknown');
});

// --- mayAttestUnauthenticated ----------------------------------------------
// Decides who may write to the score without a token. A positive attestation is
// self-credentialing because the payment behind it is verified against the chain;
// a negative one is not, because successScore is successful/(total+prior) and the
// payment proves money moved, never that the work failed.

test('mayAttestUnauthenticated: a positive, payment-verified claim needs no token', () => {
  assert.equal(mayAttestUnauthenticated(true, true), true);
});

test('mayAttestUnauthenticated: a negative claim always needs the token', () => {
  // The griefing case. Without this, anyone who sends the agent one faucet token
  // can lower its score, and on testnet that token is free.
  assert.equal(mayAttestUnauthenticated(false, true), false);
});

test('mayAttestUnauthenticated: nothing is open when payments are not verified', () => {
  // With verification off the attester is whatever the caller types, so there is no
  // credential at all and the token is the only control left.
  assert.equal(mayAttestUnauthenticated(true, false), false);
  assert.equal(mayAttestUnauthenticated(false, false), false);
});

test('mayAttestUnauthenticated: truthy is not true', () => {
  // This decides an authorisation question, so `success: "no"` must not slip through
  // as a positive the way a plain truthiness check would let it.
  for (const v of ['yes', 'no', 'false', 1, -1, [], {}, 'true']) {
    assert.equal(mayAttestUnauthenticated(v, true), false, `${JSON.stringify(v)} must not count as true`);
  }
});

test('mayAttestUnauthenticated: missing or empty values need the token', () => {
  for (const v of [undefined, null, 0, '', NaN, false]) {
    assert.equal(mayAttestUnauthenticated(v, true), false, `${String(v)} must not count as true`);
  }
});

test('mayAttestUnauthenticated: paymentsRequired must be exactly true', () => {
  // payments.required() returns a boolean today. If it ever returns a truthy config
  // object instead, this must fail closed rather than open the endpoint.
  assert.equal(mayAttestUnauthenticated(true, 'required'), false);
  assert.equal(mayAttestUnauthenticated(true, 1), false);
  assert.equal(mayAttestUnauthenticated(true, {}), false);
});

// -------------------------------------------------------------------------
// runningCommit
// -------------------------------------------------------------------------

test('runningCommit: reports a 40-hex sha', () => {
  const sha = '8bddc60f1e2a3b4c5d6e7f8091a2b3c4d5e6f708';
  assert.equal(runningCommit({ SIGVARA_COMMIT: sha }), sha);
});

test('runningCommit: null when the deployment did not say', () => {
  // Explicitly null rather than absent, so an operator that does not report stays
  // distinguishable from one too old to have the field at all.
  assert.equal(runningCommit({}), null);
  assert.equal(runningCommit({ SIGVARA_COMMIT: '' }), null);
  assert.equal(runningCommit({ SIGVARA_COMMIT: '   ' }), null);
});

test('runningCommit: refuses anything that is not a sha', () => {
  // The value comes from `git rev-parse HEAD` inside the container. When that fails it
  // writes its complaint to the variable, and publishing "fatal: not a git repository"
  // as this operator's version would be worse than publishing nothing.
  const bad = [
    'fatal: not a git repository',
    '8bddc60',                                    // short sha
    '8bddc60f1e2a3b4c5d6e7f8091a2b3c4d5e6f7089',  // 41
    '8BDDC60F1E2A3B4C5D6E7F8091A2B3C4D5E6F708',   // upper
    'main',
    '$SIGVARA_COMMIT',                            // escaping went wrong in compose
  ];
  for (const v of bad) {
    assert.equal(runningCommit({ SIGVARA_COMMIT: v }), null, `should reject: ${v}`);
  }
});

test('runningCommit: tolerates surrounding whitespace from a captured command', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  assert.equal(runningCommit({ SIGVARA_COMMIT: `\n${sha}\n` }), sha);
});
