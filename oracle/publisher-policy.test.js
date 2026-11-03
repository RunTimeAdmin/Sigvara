'use strict';

// What the ERC-8004 publisher posts, and when (publisher-policy.js, ADR 0008).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const {
  TAG1, utcDay, feedbackFile, encodeFeedback, planUpdate, mayPostNow, liveGateProblems, agentKey,
} = require('./publisher-policy');
const { TAG_NORMALIZERS, meanRating } = require('./external');

const DID = `0x${'ab'.repeat(32)}`;
const PUBLISHER = '0x5157000000000000000000000000000000000001';
const DAY = 86_400;

test('the loop-break: the oracle reads no tag the publisher posts under', () => {
  // Sigvara reads ERC-8004 feedback for External Trust. Its own posts must never count there.
  assert.equal(TAG1, 'sigvara');
  assert.ok(!Object.keys(TAG_NORMALIZERS).some((tag) => tag.startsWith('sigvara')), 'a sigvara tag in TAG_NORMALIZERS reopens the loop');
  assert.equal(meanRating([{ value: 100, tag: TAG1 }]), null);
});

test('feedbackFile: the spec\'s required fields, the tags, and what the value was read from', () => {
  const file = feedbackFile({
    chainId: 5042002, identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e', agentId: 7n, publisher: PUBLISHER,
    readAt: { block: 120, time: 1_793_700_000 }, spendable: 47, earned: 52, didHash: DID,
    reputation: '0x6603C96275e85F724Cdf74666b399365e4cA29ed',
    event: { kind: 'updated', txHash: `0x${'cd'.repeat(32)}`, block: 110, evidenceRoot: `0x${'ef'.repeat(32)}` },
  });
  assert.equal(file.agentRegistry, 'eip155:5042002:0x8004A818BFB912233c491871b3d84c89A494BD9e');
  assert.equal(file.agentId, 7);
  assert.equal(file.clientAddress, `eip155:5042002:${PUBLISHER}`);
  assert.equal(file.createdAt, new Date(1_793_700_000_000).toISOString());
  assert.equal(file.value, 47, 'the public value is the spendable score');
  assert.equal(file.valueDecimals, 0);
  assert.deepEqual([file.tag1, file.tag2], ['sigvara', 'score']);
  assert.equal(file.sigvara.earned, 52);
  assert.equal(file.sigvara.readAtBlock, 120);
  assert.equal(file.sigvara.event.kind, 'updated');
  assert.equal(file.sigvara.event.block, 110);
});

test('feedbackFile: a daily refresh names no event', () => {
  const file = feedbackFile({
    chainId: 1, identityRegistry: PUBLISHER, agentId: 1, publisher: PUBLISHER, readAt: { block: 1, time: 0 },
    spendable: 0, earned: 0, didHash: DID, reputation: PUBLISHER,
  });
  assert.equal(file.sigvara.event, null);
});

test('encodeFeedback: a data: URI holding the JSON, and the keccak256 of that JSON', () => {
  const file = { value: 1, tag1: 'sigvara' };
  const { uri, hash } = encodeFeedback(file);
  assert.match(uri, /^data:application\/json;base64,/);
  const json = Buffer.from(uri.split(',')[1], 'base64').toString('utf8');
  assert.deepEqual(JSON.parse(json), file);
  assert.equal(hash, ethers.keccak256(ethers.toUtf8Bytes(json)));
});

const live = (index, value) => ({ index, value: BigInt(value), valueDecimals: 0n });

test('planUpdate: no feedback yet is a post with nothing to revoke', () => {
  assert.deepEqual(planUpdate(47, []), { revoke: [], post: true });
});

test('planUpdate: the same value already live is left alone', () => {
  assert.deepEqual(planUpdate(47, [live(3, 47)]), { revoke: [], post: false });
});

test('planUpdate: a new value revokes the live one first, so one Sigvara score stays live', () => {
  assert.deepEqual(planUpdate(47, [live(3, 40)]), { revoke: [3], post: true });
});

test('planUpdate: two live, as after a post that landed late, are both revoked for a new value', () => {
  // The publisher gave up on a post, posted again, and the first landed after all.
  assert.deepEqual(planUpdate(60, [live(5, 55), live(4, 55)]), { revoke: [5, 4], post: true });
  assert.deepEqual(planUpdate(55, [live(5, 55), live(4, 55)]), { revoke: [4], post: false }, 'the same value: one is kept');
});

test('planUpdate: after a revoke that landed without its post, the retry posts without revoking again', () => {
  assert.deepEqual(planUpdate(47, []), { revoke: [], post: true });
});

test('planUpdate: no score to show (the agent is no longer linked there) revokes everything live', () => {
  assert.deepEqual(planUpdate(null, [live(2, 47)]), { revoke: [2], post: false });
  assert.deepEqual(planUpdate(null, []), { revoke: [], post: false });
});

test('agentKey: one spelling for an agent id', () => {
  assert.equal(agentKey('0897764'), '897764');
  assert.equal(agentKey(897764n), '897764');
});

test('mayPostNow: once per UTC day, except a zero after a slash', () => {
  const now = 20_000 * DAY + 3600;
  assert.equal(mayPostNow(undefined, now, false), true);
  assert.equal(mayPostNow(utcDay(now), now, false), false, 'already posted today');
  assert.equal(mayPostNow(utcDay(now) - 1, now, false), true);
  assert.equal(mayPostNow(utcDay(now), now, true), true, 'a slash goes out at once');
});

test('liveGateProblems: nothing posts until the agentWallet is the publisher, the signer signs as it, and it can pay', () => {
  const ok = { publisher: PUBLISHER, agentWallet: PUBLISHER.toUpperCase().replace('0X', '0x'), signerAddress: PUBLISHER, balance: 10n ** 18n, minBalance: 10n ** 17n };
  assert.deepEqual(liveGateProblems(ok), []);
  assert.match(liveGateProblems({ ...ok, agentWallet: '0x18CBcE50390f5f6ebe4E20Fc17833F25c8D94811' })[0], /agentWallet is 0x18CB.*not the publisher/);
  assert.match(liveGateProblems({ ...ok, agentWallet: null })[0], /has no agentWallet/);
  assert.match(liveGateProblems({ ...ok, signerAddress: null })[0], /remote signer did not answer/);
  assert.match(liveGateProblems({ ...ok, signerAddress: '0x0000000000000000000000000000000000000002' })[0], /signs as/);
  assert.match(liveGateProblems({ ...ok, balance: 0n })[0], /below the floor/);
  assert.match(liveGateProblems({ ...ok, pendingTxs: 1 })[0], /1 transaction\(s\) from the publisher are still pending/);
});
