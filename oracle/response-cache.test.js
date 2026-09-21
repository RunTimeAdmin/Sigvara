'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createResponseCache } = require('./response-cache');

test('createResponseCache: builds on a miss, reuses on a hit', () => {
  const cache = createResponseCache({ maxBytes: 1024 });
  const rev = ['a'];
  let builds = 0;
  const build = () => { builds++; return '{"n":1}'; };

  assert.equal(cache.get('k', rev, build), '{"n":1}');
  assert.equal(cache.get('k', rev, build), '{"n":1}');
  assert.equal(cache.get('k', rev, build), '{"n":1}');
  assert.equal(builds, 1, 'the expensive build should run once');
  assert.equal(cache.stats().hits, 2);
});

test('createResponseCache: a new revision rebuilds', () => {
  // The whole invalidation story. For /evidence the revision is the payment-event
  // array, which the store replaces on every credit and every prune, so a changed
  // payment set is a changed identity and nothing has to call invalidate().
  const cache = createResponseCache({ maxBytes: 1024 });
  const before = ['p1'];
  const after = ['p1', 'p2'];

  assert.equal(cache.get('agent', before, () => 'one'), 'one');
  assert.equal(cache.get('agent', after, () => 'two'), 'two');
  // And it does not fall back to the old entry afterwards.
  assert.equal(cache.get('agent', after, () => 'three'), 'two');
});

test('createResponseCache: identity, not equality', () => {
  // Two arrays with identical contents are different revisions. That is the safe
  // direction: a false miss costs a rebuild, a false hit serves stale evidence.
  const cache = createResponseCache({ maxBytes: 1024 });
  let builds = 0;
  const build = () => { builds++; return 'body'; };

  cache.get('k', ['same'], build);
  cache.get('k', ['same'], build);
  assert.equal(builds, 2);
});

test('createResponseCache: replacing an entry does not leak its bytes', () => {
  const cache = createResponseCache({ maxBytes: 1024 });
  cache.get('k', ['r1'], () => 'x'.repeat(100));
  const afterFirst = cache.stats().bytes;
  cache.get('k', ['r2'], () => 'y'.repeat(100));

  assert.equal(cache.stats().entries, 1);
  assert.equal(cache.stats().bytes, afterFirst, 'the stale entry’s bytes are reclaimed');
});

test('createResponseCache: evicts least-recently-used to stay under the byte cap', () => {
  const cache = createResponseCache({ maxBytes: 300 });
  // One shared revision object: a fresh ['r'] per call is a different identity and
  // every lookup would miss, which is what the test above pins down.
  const rev = ['r'];
  cache.get('a', rev, () => 'a'.repeat(100));
  cache.get('b', rev, () => 'b'.repeat(100));
  cache.get('c', rev, () => 'c'.repeat(100));
  assert.equal(cache.stats().entries, 3);

  // Touch 'a' so 'b' becomes the oldest, then overflow by one entry.
  cache.get('a', rev, () => { throw new Error('should be a hit'); });
  cache.get('d', rev, () => 'd'.repeat(100));

  assert.ok(cache.stats().bytes <= 300, 'stays under the cap');
  // 'b' was least recently used, so it went first; 'a' survived because it was touched.
  let rebuiltA = false;
  cache.get('a', rev, () => { rebuiltA = true; return 'a'.repeat(100); });
  assert.equal(rebuiltA, false, 'the recently used entry survived');

  // And 'b' really is the one that went.
  let rebuiltB = false;
  cache.get('b', rev, () => { rebuiltB = true; return 'b'.repeat(100); });
  assert.equal(rebuiltB, true, 'the least recently used entry was evicted');
});

test('createResponseCache: an oversized body is served but not stored', () => {
  // One agent with an enormous payment history must not evict the entire cache to
  // hold a response nothing else can coexist with.
  const cache = createResponseCache({ maxBytes: 100 });
  const rev = ['r'];
  cache.get('small', rev, () => 's'.repeat(50));

  const huge = 'h'.repeat(500);
  assert.equal(cache.get('huge', rev, () => huge), huge, 'still served');
  assert.equal(cache.stats().entries, 1, 'not stored');

  let rebuiltSmall = false;
  cache.get('small', rev, () => { rebuiltSmall = true; return 's'.repeat(50); });
  assert.equal(rebuiltSmall, false, 'the small entry was not evicted for it');
});

test('createResponseCache: keys do not collide', () => {
  const cache = createResponseCache({ maxBytes: 1024 });
  const rev = ['r'];
  assert.equal(cache.get('agent-1', rev, () => 'one'), 'one');
  assert.equal(cache.get('agent-2', rev, () => 'two'), 'two');
  assert.equal(cache.get('agent-1', rev, () => 'nope'), 'one');
});

test('createResponseCache: rejects a cap that would not bound anything', () => {
  for (const bad of [0, -1, 1.5, NaN, undefined]) {
    assert.throws(() => createResponseCache({ maxBytes: bad }), TypeError);
  }
});

test('createResponseCache: measures bytes, not characters', () => {
  // Buffer.byteLength, not .length: a multi-byte body would otherwise be undercounted
  // and the cap would not hold.
  const cache = createResponseCache({ maxBytes: 1024 });
  cache.get('k', ['r'], () => 'é'.repeat(10)); // 10 chars, 20 bytes
  assert.equal(cache.stats().bytes, 20);
});
