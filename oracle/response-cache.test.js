'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createResponseCache } = require('./response-cache');

test('createResponseCache: builds on a miss, reuses on a hit', async () => {
  const cache = createResponseCache({ maxBytes: 1024 });
  const rev = ['a'];
  let builds = 0;
  const build = () => { builds++; return '{"n":1}'; };

  assert.equal(await cache.getAsync('k', rev, build), '{"n":1}');
  assert.equal(await cache.getAsync('k', rev, build), '{"n":1}');
  assert.equal(await cache.getAsync('k', rev, build), '{"n":1}');
  assert.equal(builds, 1, 'the expensive build should run once');
  assert.equal(cache.stats().hits, 2);
});

test('createResponseCache: a new revision rebuilds', async () => {
  // The whole invalidation story. For /evidence the revision is the payment-event
  // array, which the store replaces on every credit and every prune, so a changed
  // payment set is a changed identity and nothing has to call invalidate().
  const cache = createResponseCache({ maxBytes: 1024 });
  const before = ['p1'];
  const after = ['p1', 'p2'];

  assert.equal(await cache.getAsync('agent', before, () => 'one'), 'one');
  assert.equal(await cache.getAsync('agent', after, () => 'two'), 'two');
  // And it does not fall back to the old entry afterwards.
  assert.equal(await cache.getAsync('agent', after, () => 'three'), 'two');
});

test('createResponseCache: identity, not equality', async () => {
  // Two arrays with identical contents are different revisions. That is the safe
  // direction: a false miss costs a rebuild, a false hit serves stale evidence.
  const cache = createResponseCache({ maxBytes: 1024 });
  let builds = 0;
  const build = () => { builds++; return 'body'; };

  await cache.getAsync('k', ['same'], build);
  await cache.getAsync('k', ['same'], build);
  assert.equal(builds, 2);
});

test('createResponseCache: replacing an entry does not leak its bytes', async () => {
  const cache = createResponseCache({ maxBytes: 1024 });
  await cache.getAsync('k', ['r1'], () => 'x'.repeat(100));
  const afterFirst = cache.stats().bytes;
  await cache.getAsync('k', ['r2'], () => 'y'.repeat(100));

  assert.equal(cache.stats().entries, 1);
  assert.equal(cache.stats().bytes, afterFirst, 'the stale entry’s bytes are reclaimed');
});

test('createResponseCache: evicts least-recently-used to stay under the byte cap', async () => {
  const cache = createResponseCache({ maxBytes: 300 });
  // One shared revision object: a fresh ['r'] per call is a different identity and
  // every lookup would miss, which is what the test above pins down.
  const rev = ['r'];
  await cache.getAsync('a', rev, () => 'a'.repeat(100));
  await cache.getAsync('b', rev, () => 'b'.repeat(100));
  await cache.getAsync('c', rev, () => 'c'.repeat(100));
  assert.equal(cache.stats().entries, 3);

  // Touch 'a' so 'b' becomes the oldest, then overflow by one entry.
  await cache.getAsync('a', rev, () => { throw new Error('should be a hit'); });
  await cache.getAsync('d', rev, () => 'd'.repeat(100));

  assert.ok(cache.stats().bytes <= 300, 'stays under the cap');
  // 'b' was least recently used, so it went first; 'a' survived because it was touched.
  let rebuiltA = false;
  await cache.getAsync('a', rev, () => { rebuiltA = true; return 'a'.repeat(100); });
  assert.equal(rebuiltA, false, 'the recently used entry survived');

  // And 'b' really is the one that went.
  let rebuiltB = false;
  await cache.getAsync('b', rev, () => { rebuiltB = true; return 'b'.repeat(100); });
  assert.equal(rebuiltB, true, 'the least recently used entry was evicted');
});

test('createResponseCache: an oversized body is served but not stored', async () => {
  // One agent with an enormous payment history must not evict the entire cache to
  // hold a response nothing else can coexist with.
  const cache = createResponseCache({ maxBytes: 100 });
  const rev = ['r'];
  await cache.getAsync('small', rev, () => 's'.repeat(50));

  const huge = 'h'.repeat(500);
  assert.equal(await cache.getAsync('huge', rev, () => huge), huge, 'still served');
  assert.equal(cache.stats().entries, 1, 'not stored');

  let rebuiltSmall = false;
  await cache.getAsync('small', rev, () => { rebuiltSmall = true; return 's'.repeat(50); });
  assert.equal(rebuiltSmall, false, 'the small entry was not evicted for it');
});

test('createResponseCache: keys do not collide', async () => {
  const cache = createResponseCache({ maxBytes: 1024 });
  const rev = ['r'];
  assert.equal(await cache.getAsync('agent-1', rev, () => 'one'), 'one');
  assert.equal(await cache.getAsync('agent-2', rev, () => 'two'), 'two');
  assert.equal(await cache.getAsync('agent-1', rev, () => 'nope'), 'one');
});

test('createResponseCache: rejects a cap that would not bound anything', async () => {
  for (const bad of [0, -1, 1.5, NaN, undefined]) {
    assert.throws(() => createResponseCache({ maxBytes: bad }), TypeError);
  }
});

test('createResponseCache: measures bytes, not characters', async () => {
  // Buffer.byteLength, not .length: a multi-byte body would otherwise be undercounted
  // and the cap would not hold.
  const cache = createResponseCache({ maxBytes: 1024 });
  await cache.getAsync('k', ['r'], () => 'é'.repeat(10)); // 10 chars, 20 bytes
  assert.equal(cache.stats().bytes, 20);
});

// /evidence builds its body without holding the event loop, so two requests can now arrive while one is building.
test('getAsync: requests that arrive while a body is building wait for that build', async () => {
  const cache = createResponseCache({ maxBytes: 1024 });
  const rev = ['a'];
  let builds = 0;
  let finish;
  const build = () => { builds++; return new Promise((resolve) => { finish = () => resolve('{"n":1}'); }); };
  const first = cache.getAsync('k', rev, build);
  const second = cache.getAsync('k', rev, build);
  await new Promise((resolve) => setImmediate(resolve));
  finish();
  assert.deepEqual(await Promise.all([first, second]), ['{"n":1}', '{"n":1}']);
  assert.equal(builds, 1);
  assert.equal(await cache.getAsync('k', rev, build), '{"n":1}', 'then served from the cache');
  assert.equal(builds, 1);
});

test('getAsync: a build that finishes after one for a later revision started is served, not kept', async () => {
  const cache = createResponseCache({ maxBytes: 1024 });
  const older = ['a'];
  const newer = ['b'];
  const finishes = [];
  const build = (body) => () => new Promise((resolve) => { finishes.push(() => resolve(body)); });
  const slow = cache.getAsync('k', older, build('{"v":1}'));
  const fresh = cache.getAsync('k', newer, build('{"v":2}'));
  await new Promise((resolve) => setImmediate(resolve));
  finishes[1]();
  assert.equal(await fresh, '{"v":2}');
  finishes[0]();
  assert.equal(await slow, '{"v":1}');
  assert.equal(await cache.getAsync('k', newer, () => { throw new Error('built again'); }), '{"v":2}');
});
