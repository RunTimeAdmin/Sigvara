'use strict';
// ADR 0011: a payer's "not delivered" is held, then counts unless the agent refunded the payer in full.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const hold = require('./negative-hold');
const merkle = require('./merkle');
const { TRANSFER_TOPIC } = require('./payments');

const DAY = 86_400_000;
const cfg = hold.readConfig({});
const ASSET = '0x' + '11'.repeat(20);
const OTHER_ASSET = '0x' + '12'.repeat(20);
const AGENT = '0x' + 'aa'.repeat(20);
const PAYER = '0x' + 'bb'.repeat(20);
const STRANGER = '0x' + 'cc'.repeat(20);
const pad = (a) => ethers.zeroPadValue(ethers.getAddress(a), 32);

// One block a second from T0, so block n is T0 + n seconds.
const T0 = Date.UTC(2026, 10, 1);
const blockMs = async (n) => T0 + n * 1000;
const blockAt = (ms) => Math.floor((ms - T0) / 1000);

const PAID_BLOCK = 100;
const CHECKED_MS = T0 + 200 * 1000;
const negative = (over = {}) => Object.freeze({
  txHash: '0x' + '01'.repeat(32), payer: PAYER, amount: '1000000', ts: T0 + PAID_BLOCK * 1000, blockNumber: PAID_BLOCK,
  success: false, payerOutcome: Object.freeze({ outcome: 2, checkedAtBlock: 200, checkedAtMs: CHECKED_MS }), ...over,
});
const positive = Object.freeze({ txHash: '0x' + '02'.repeat(32), payer: STRANGER, amount: '5', ts: T0, blockNumber: 1, success: true });
const END = CHECKED_MS + 7 * DAY;
const COUNTS = END + hold.MARGIN_MS;

// A node's getLogs: filters by address and by each non-null topic, as eth_getLogs does.
function node(logs) {
  let calls = 0;
  return {
    get calls() { return calls; },
    getLogs: async ({ address, topics, fromBlock, toBlock }) => {
      calls += 1;
      return logs.filter((l) => l.address.toLowerCase() === address.toLowerCase()
        && l.blockNumber >= fromBlock && l.blockNumber <= toBlock
        && topics.every((t, i) => t == null || t === l.topics[i]));
    },
  };
}
const transfer = ({ from = AGENT, to = PAYER, amount = 1000000n, block, asset = ASSET, tx = '0x' + 'ee'.repeat(32) }) => ({
  address: asset, topics: [TRANSFER_TOPIC, pad(from), pad(to)], data: ethers.toBeHex(amount, 32),
  blockNumber: block, transactionHash: tx, index: 0,
});
const read = (e, logs, headBlock, extra = {}) => {
  const n = node(logs);
  return hold.readRefund(e, cfg, { getLogs: n.getLogs, blockMs, asset: ASSET, agent: AGENT, headBlock, chunk: 100_000, ...extra })
    .then((check) => ({ check, calls: n.calls }));
};
const settled = (e, check) => Object.freeze({ ...e, refundCheck: Object.freeze(check) });

test('the hold is seven days from the block the signature was checked at, and counts an hour after', () => {
  assert.equal(cfg.holdMs, 7 * DAY);
  assert.equal(hold.holdEndMs(negative(), cfg), END);
  assert.equal(hold.countsFromMs(negative(), cfg), COUNTS);
  assert.throws(() => hold.readConfig({ PAYER_NEGATIVE_HOLD_DAYS: '0' }), /from 1 to 30/);
  assert.throws(() => hold.readConfig({ PAYER_NEGATIVE_HOLD_DAYS: '2.5' }), /whole number/);
});

test('a held negative reads as not reported, and counts once read past the hold with no refund', async () => {
  const { check } = await read(negative(), [], blockAt(END) + 10);
  assert.deepEqual(check, { final: true, refunded: false, readThroughBlock: blockAt(END) + 10 });
  const e = settled(negative(), check);
  assert.equal(hold.present([e], COUNTS - 1, cfg)[0].success, null, 'still held a millisecond before it counts');
  assert.equal(hold.present([e], COUNTS, cfg)[0].success, false, 'counts from the margin after the hold');
  assert.equal(hold.present([negative()], COUNTS + DAY, cfg)[0].success, null, 'never counts without a finished read');
});

test('a full refund inside the hold cures it, for good', async () => {
  const { check } = await read(negative(), [transfer({ block: blockAt(END) - 60 })], blockAt(END) + 10);
  assert.equal(check.final, true);
  assert.equal(check.refunded, true);
  assert.equal(check.blockNumber, blockAt(END) - 60);
  assert.equal(hold.present([settled(negative(), check)], COUNTS + 30 * DAY, cfg)[0].success, null);
});

test('a refund found before the hold ends settles it at once', async () => {
  const { check } = await read(negative(), [transfer({ block: 300 })], 400);
  assert.deepEqual([check.final, check.refunded], [true, true]);
});

test('a partial refund does not cure', async () => {
  const { check } = await read(negative(), [transfer({ amount: 999999n, block: 300 })], blockAt(END) + 10);
  assert.deepEqual([check.final, check.refunded], [true, false]);
});

test('a refund from another address, to another address or in another asset does not cure', async () => {
  const logs = [
    transfer({ from: STRANGER, block: 300 }),
    transfer({ to: STRANGER, block: 301 }),
    transfer({ asset: OTHER_ASSET, block: 302 }),
  ];
  const { check } = await read(negative(), logs, blockAt(END) + 10);
  assert.deepEqual([check.final, check.refunded], [true, false]);
});

test('a refund after the hold ends, or before the payment, does not cure', async () => {
  const late = await read(negative(), [transfer({ block: blockAt(END) + 1 })], blockAt(END) + 10);
  assert.deepEqual([late.check.final, late.check.refunded], [true, false]);
  const early = await read(negative(), [transfer({ block: PAID_BLOCK })], blockAt(END) + 10);
  assert.deepEqual([early.check.final, early.check.refunded], [true, false], 'not after the payment settled');
});

test('a read that has not reached the hold\'s end is not settled, and goes on from where it stopped', async () => {
  const first = await read(negative(), [], 500, { chunk: 100, maxReads: 2 });
  assert.deepEqual(first.check, { final: false, refunded: null, readThroughBlock: 299 });
  assert.equal(first.calls, 2);
  const next = await read(settled(negative(), first.check), [transfer({ block: 450 })], 500, { chunk: 100, maxReads: 2 });
  assert.deepEqual([next.check.final, next.check.refunded, next.check.blockNumber], [true, true, 450]);
});

test('a due negative whose read is not finished holds the agent; one that is settled does not', async () => {
  assert.equal(hold.unresolvedAt([negative()], COUNTS - 1, cfg).length, 0, 'not due yet');
  assert.equal(hold.unresolvedAt([negative()], COUNTS, cfg).length, 1, 'due and unread');
  const { check } = await read(negative(), [], blockAt(END) + 10);
  assert.equal(hold.unresolvedAt([settled(negative(), check)], COUNTS, cfg).length, 0);
  assert.equal(hold.toRead([settled(negative(), check)]).length, 0);
});

test('a negative recorded without its block\'s time never counts', () => {
  const e = negative({ payerOutcome: Object.freeze({ outcome: 2, checkedAtBlock: 200 }) });
  assert.equal(hold.countsFromMs(e, cfg), Infinity);
  assert.equal(hold.present([e], Date.now(), cfg)[0].success, null);
});

test('two operators that read the same chain commit to the same root', async () => {
  const atMs = COUNTS + DAY;
  const a = settled(negative(), (await read(negative(), [], blockAt(END) + 10)).check);
  // The importing operator checked at the same block, so it has the same time, and reads the same chain.
  const b = settled(negative(), (await read(negative(), [], blockAt(END) + 999)).check);
  assert.equal(merkle.rootFor(hold.present([positive, a], atMs, cfg)), merkle.rootFor(hold.present([positive, b], atMs, cfg)));
  // Held, the root is the one over the payment with no outcome reported.
  assert.equal(merkle.rootFor(hold.present([positive, negative()], CHECKED_MS, cfg)),
    merkle.rootFor([positive, { ...negative(), success: null }]));
});

test('with no payer negative the events pass through untouched', () => {
  const events = [positive, Object.freeze({ ...positive, txHash: '0x' + '03'.repeat(32), success: null })];
  assert.equal(hold.present(events, Date.now(), cfg), events);
  assert.equal(hold.toRead(events).length, 0);
});
