'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readBody, isAuthorized, parseScorePath, rateLimited, RATE_MAX, clientKey, adminTokenPolicyError } = require('./http-helpers');

// Minimal fake matching the subset of http.IncomingMessage that readBody uses:
// an EventEmitter with data/end/error events plus a destroy() method.
function makeFakeRequest() {
  const req = new EventEmitter();
  req.destroy = () => req.emit('destroyed');
  return req;
}

// -------------------------------------------------------------------------
// isAuthorized
// -------------------------------------------------------------------------

test('isAuthorized: no admin token configured -> always authorized', () => {
  assert.equal(isAuthorized({}, ''), true);
  assert.equal(isAuthorized({ authorization: 'garbage' }, ''), true);
});

test('isAuthorized: token configured, missing header -> unauthorized', () => {
  assert.equal(isAuthorized({}, 'secret'), false);
});

test('isAuthorized: token configured, wrong header -> unauthorized', () => {
  assert.equal(isAuthorized({ authorization: 'Bearer wrong' }, 'secret'), false);
});

test('isAuthorized: token configured, correct bearer header -> authorized', () => {
  assert.equal(isAuthorized({ authorization: 'Bearer secret' }, 'secret'), true);
});

test('isAuthorized: header without Bearer prefix does not match', () => {
  assert.equal(isAuthorized({ authorization: 'secret' }, 'secret'), false);
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
  const err = adminTokenPolicyError('0.0.0.0', '');
  assert.match(err, /ORACLE_ADMIN_TOKEN is unset/);
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
