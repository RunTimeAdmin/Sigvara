'use strict';

const test = require('node:test');
const assert = require('node:assert');
const badge = require('./badge');

test('an unscored agent is never rendered as zero', () => {
  // getTotalScore returns 0 for "scored zero" and for "never finalized" alike. A badge
  // that collapses them accuses an agent nobody has looked at yet.
  const unscored = badge.valueFor({ kind: 'unscored' });
  const zero = badge.valueFor({ kind: 'scored', score: 0 });

  assert.notStrictEqual(unscored.text, zero.text);
  assert.strictEqual(unscored.text, 'not yet scored');
  assert.strictEqual(unscored.color, badge.NEUTRAL, 'unknown must not render as bad');
  assert.strictEqual(zero.text, '0 / 100');
});

test('score bands are inclusive at the boundary', () => {
  assert.strictEqual(badge.colorForScore(75), badge.colorForScore(100), '75 is the green band');
  assert.notStrictEqual(badge.colorForScore(74), badge.colorForScore(75));
  assert.strictEqual(badge.colorForScore(50), badge.colorForScore(74));
  assert.notStrictEqual(badge.colorForScore(49), badge.colorForScore(50));
  assert.notStrictEqual(badge.colorForScore(24), badge.colorForScore(25));
});

test('a slashed agent says so rather than showing a number', () => {
  const v = badge.valueFor({ kind: 'slashed' });
  assert.strictEqual(v.text, 'slashed');
  assert.match(v.color, /^#b91c1c$/, 'slashed is the red band');
});

test('the SVG is self-contained and declares its width', () => {
  const svg = badge.renderBadge({ kind: 'scored', score: 72 });

  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /width="\d+" height="20"/);
  assert.ok(svg.includes('72 / 100'));
  // Loaded through <img> on a third party page: nothing external can resolve there.
  assert.ok(!/<script/i.test(svg), 'no script');
  assert.ok(!svg.includes('http://') || svg.indexOf('http://www.w3.org') === svg.lastIndexOf('http://'),
    'the only http reference is the SVG namespace');
  assert.ok(!/<image|xlink:href|@import|<foreignObject/i.test(svg), 'no external references');
});

test('the SVG defines no element ids, so many can share one document', () => {
  // Two badges inlined in one page collided on a clipPath id: url(#id) resolves to the
  // first match in the DOCUMENT, so every badge after the first was clipped to the first
  // one's width and lost the end of its text. It looked correct in isolation and broke
  // on exactly the page the badge is for, a list of agents.
  const svgs = [
    badge.renderBadge({ kind: 'scored', score: 92 }),
    badge.renderBadge({ kind: 'unregistered' }),
  ];
  for (const svg of svgs) {
    assert.ok(!/\sid=/.test(svg), `must not define an id: ${svg.slice(0, 120)}`);
    assert.ok(!/url\(#/.test(svg), 'must not reference a document-scoped id');
  }

  // And concatenating them must not introduce a shared reference either.
  const combined = svgs.join('');
  assert.strictEqual((combined.match(/url\(#/g) || []).length, 0);
});

test('the SVG carries an accessible name', () => {
  const svg = badge.renderBadge({ kind: 'scored', score: 72 });
  assert.match(svg, /role="img"/);
  assert.match(svg, /aria-label="sigvara: 72 \/ 100"/);
  assert.match(svg, /<title>sigvara: 72 \/ 100<\/title>/);
});

test('width grows with the longest state so text cannot overflow', () => {
  const widthOf = (svg) => Number(/width="(\d+)"/.exec(svg)[1]);

  const short = widthOf(badge.renderBadge({ kind: 'scored', score: 7 }));
  const long = widthOf(badge.renderBadge({ kind: 'unregistered' }));
  assert.ok(long > short, `"not registered" (${long}) must be wider than "7 / 100" (${short})`);
});

test('badge paths accept an address and reject anything else', () => {
  assert.strictEqual(
    badge.parseBadgePath('/badge/0x18CBcE50390f5f6ebe4E20Fc17833F25c8D94811.svg'),
    '0x18CBcE50390f5f6ebe4E20Fc17833F25c8D94811',
  );
  assert.strictEqual(badge.parseBadgePath('/badge/0x18cbce50390f5f6ebe4e20fc17833f25c8d94811.svg'),
    '0x18cbce50390f5f6ebe4e20fc17833f25c8d94811', 'lowercase is fine');

  assert.strictEqual(badge.parseBadgePath('/badge/0x123.svg'), null, 'too short');
  assert.strictEqual(badge.parseBadgePath('/badge/0x18CBcE50390f5f6ebe4E20Fc17833F25c8D94811'), null, 'no extension');
  assert.strictEqual(badge.parseBadgePath('/badge/../../etc/passwd.svg'), null, 'traversal');
  assert.strictEqual(badge.parseBadgePath('/badge/0xZZ8CBcE50390f5f6ebe4E20Fc17833F25c8D948.svg'), null, 'non-hex');
  assert.strictEqual(badge.parseBadgePath('/score/0x18CBcE50390f5f6ebe4E20Fc17833F25c8D94811.svg'), null, 'wrong route');
});

test('cache returns a value inside its TTL and drops it after', () => {
  let clock = 1000;
  const cache = badge.createBadgeCache({ ttlMs: 100, now: () => clock });

  cache.set('a', 'first');
  assert.strictEqual(cache.get('a'), 'first');

  clock += 99;
  assert.strictEqual(cache.get('a'), 'first', 'still inside the window');

  clock += 1; // exactly at expiry
  assert.strictEqual(cache.get('a'), undefined, 'expiry is not inclusive');
  assert.strictEqual(cache.size(), 0, 'an expired entry is dropped, not merely hidden');
});

test('cache is bounded, and refreshing a key does not make it the next evicted', () => {
  let clock = 0;
  const cache = badge.createBadgeCache({ ttlMs: 10_000, maxEntries: 3, now: () => clock });

  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('c', 3);
  cache.set('a', 99); // refresh the oldest: it should move to the back
  cache.set('d', 4);  // evicts one

  assert.strictEqual(cache.size(), 3);
  assert.strictEqual(cache.get('b'), undefined, 'b was the oldest after a was refreshed');
  assert.strictEqual(cache.get('a'), 99, 'a survived because it was refreshed');
  assert.strictEqual(cache.get('c'), 3);
  assert.strictEqual(cache.get('d'), 4);
});

test('an address supplied by a stranger cannot grow the cache without bound', () => {
  const cache = badge.createBadgeCache({ maxEntries: 50 });
  for (let i = 0; i < 5000; i++) cache.set(`0x${i}`, i);
  assert.strictEqual(cache.size(), 50);
});
