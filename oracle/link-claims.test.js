'use strict';

// Links made on chain (link-claims.js): what a MetadataSet log claims, how claims are kept, and
// which apply at a snapshot. End-to-end runs of the scan are in links-on-chain.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  LINK_KEY, MAX_CLAIMS_PER_AGENT, claimFromLog, addClaim, candidatesAt, isBefore, scanCovers,
} = require('./link-claims');

const DID = `0x${'ab'.repeat(32)}`;
const OTHER = `0x${'cd'.repeat(32)}`;
const claim = (agentId, block, logIndex = 0, didHash = DID) => ({ didHash, agentId, block, logIndex });

test('the key is sigvara', () => {
  assert.equal(LINK_KEY, 'sigvara');
});

test('claimFromLog: a 32-byte value claims that didHash, lowercased, with the id as text', () => {
  assert.deepEqual(
    claimFromLog({ agentId: 7n, value: DID.toUpperCase().replace('0X', '0x'), blockNumber: 120, logIndex: 3 }),
    { didHash: DID, agentId: '7', block: 120, logIndex: 3 },
  );
});

test('claimFromLog: a value of any other length claims nothing, including the empty one that clears the key', () => {
  for (const value of ['0x', `0x${'ab'.repeat(20)}`, `0x${'ab'.repeat(33)}`, 'sigvara', null, undefined]) {
    assert.equal(claimFromLog({ agentId: 7n, value, blockNumber: 1, logIndex: 0 }), null, String(value));
  }
});

test('candidatesAt: each 8004 agent once, by its newest claim, newest first', () => {
  const claims = {};
  addClaim(claims, claim('7', 10));
  addClaim(claims, claim('8', 20));
  addClaim(claims, claim('7', 30, 1));
  addClaim(claims, claim('9', 15, 0, OTHER));
  assert.deepEqual(candidatesAt(claims, DID), ['7', '8']);
  assert.deepEqual(candidatesAt(claims, DID, 25), ['8', '7'], 'at block 25, 7\'s newest claim is the one at 10');
  assert.deepEqual(candidatesAt(claims, DID, 19), ['7'], 'a claim made after the snapshot does not apply to it');
  assert.deepEqual(candidatesAt(claims, DID, 9), []);
  assert.deepEqual(candidatesAt(claims, DID.toUpperCase().replace('0X', '0x')), ['7', '8']);
  assert.deepEqual(candidatesAt(claims, `0x${'ee'.repeat(32)}`), []);
  assert.deepEqual(candidatesAt(null, DID), [], 'before the first scan');
});

test('a claim repeated after the snapshot leaves the snapshot\'s answer as it was', () => {
  // Agent 7 claims at block 100 and sets the same value again at 200; the snapshot is at 150. An
  // operator that has scanned to 160 and one that has scanned to 260 must agree about block 150.
  const behind = addClaim({}, claim('7', 100));
  const ahead = addClaim(addClaim({}, claim('7', 100)), claim('7', 200));
  assert.deepEqual(candidatesAt(behind, DID, 150), ['7']);
  assert.deepEqual(candidatesAt(ahead, DID, 150), ['7']);
});

test('addClaim: an agent keeps its newest claims, up to the cap', () => {
  const claims = {};
  for (let i = 1; i <= MAX_CLAIMS_PER_AGENT + 2; i++) addClaim(claims, claim(String(i), i));
  assert.equal(claims[DID].length, MAX_CLAIMS_PER_AGENT);
  assert.equal(claims[DID][0].agentId, '3');
  assert.equal(claims[DID].at(-1).agentId, String(MAX_CLAIMS_PER_AGENT + 2));
});

test('isBefore: by block, then by position in the block', () => {
  const cursor = { block: 100, logIndex: 3 };
  assert.equal(isBefore({ blockNumber: 99, logIndex: 9 }, cursor), true);
  assert.equal(isBefore({ blockNumber: 100, logIndex: 2 }, cursor), true);
  assert.equal(isBefore({ blockNumber: 100, logIndex: 3 }, cursor), false, 'the cursor is the first position not yet read');
  assert.equal(isBefore({ blockNumber: 101, logIndex: 0 }, cursor), false);
});

test('scanCovers: a block is covered once the scan is past it, or when it is before the scan\'s start', () => {
  assert.equal(scanCovers(null, 100, 99), true, 'nothing before the start is ever read');
  assert.equal(scanCovers(null, 100, 100), false);
  assert.equal(scanCovers({ block: 150, logIndex: 0 }, 100, 150), false);
  assert.equal(scanCovers({ block: 151, logIndex: 0 }, 100, 150), true);
  assert.equal(scanCovers({ block: 150, logIndex: 4 }, 100, 150), false, 'part of block 150 is still unread');
  assert.equal(scanCovers({ block: 500, logIndex: 0 }, 100, 150), true);
});
