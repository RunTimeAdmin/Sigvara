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
// The payment itself is on the node too: a read settles "not refunded" only from a node whose filter finds it.
const paid = (e) => transfer({ from: e.payer, to: AGENT, amount: BigInt(e.amount), block: Number(e.blockNumber), tx: e.txHash });
const read = (e, logs, headBlock, extra = {}) => {
  const n = node([paid(e), ...logs]);
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

test('a refund in the block after the payment cures it, though both carry the same second', async () => {
  // Five blocks a second, as on Base Sepolia: the payment in block 100 and the refund in 101 share a time.
  const sameSecond = async (n) => T0 + Math.floor(n / 5) * 1000;
  const e = negative({ ts: await sameSecond(PAID_BLOCK) });
  const { check } = await read(e, [transfer({ block: PAID_BLOCK + 1 })], 1000, { blockMs: sameSecond });
  assert.deepEqual([check.final, check.refunded, check.blockNumber], [true, true, PAID_BLOCK + 1], 'a refund in a later block is after the payment');
});

test('a settled negative keeps the hold it was read against when the hold length changes', async () => {
  const { check } = await read(negative(), [], blockAt(END) + 10);
  const e = settled(negative(), { ...check, holdEndMs: hold.holdEndMs(negative(), cfg) });
  const shorter = hold.readConfig({ PAYER_NEGATIVE_HOLD_DAYS: '3' });
  assert.equal(hold.countsFromMs(e, shorter), COUNTS, 'still the seven days its refunds were read for');
  assert.equal(hold.present([e], CHECKED_MS + 3 * DAY + hold.MARGIN_MS, shorter)[0].success, null);
});

test('present gives the same array back for the same stored events, so the caches hit', () => {
  const events = Object.freeze([positive, negative()]);
  const first = hold.present(events, CHECKED_MS, cfg);
  assert.equal(first[1].success, null);
  assert.equal(hold.present(events, CHECKED_MS + DAY, cfg), first, 'the same negatives count, so the same array');
  assert.ok(Object.isFrozen(first));
});

test('a read that fails keeps what it read before the failure', async () => {
  let calls = 0;
  const failing = async (filter) => {
    calls += 1;
    if (calls === 3) throw new Error('429 too many requests');
    return node([]).getLogs(filter);
  };
  const check = await hold.readRefund(negative(), cfg, { getLogs: failing, blockMs, asset: ASSET, agent: AGENT, headBlock: 1000, chunk: 100 });
  assert.equal(check.final, false);
  assert.equal(check.readThroughBlock, PAID_BLOCK + 199, 'through the second chunk, so the next read goes on from there');
  assert.match(check.error.message, /429/);
});

test('on Base Sepolia\'s 0.2 s blocks, 200 a read, the read reaches the hold\'s end by the time it counts', async () => {
  const BLOCK_MS = 200;
  const baseMs = async (n) => T0 + n * BLOCK_MS;
  const paidAt = 1_000_000;
  const e0 = negative({ blockNumber: paidAt, ts: T0 + paidAt * BLOCK_MS, payerOutcome: Object.freeze({ outcome: 2, checkedAtBlock: paidAt + 50, checkedAtMs: T0 + (paidAt + 50) * BLOCK_MS }) });
  const n = node([paid(e0)]);
  const countsFrom = hold.countsFromMs(e0, cfg);
  let e = e0;
  // Hourly epochs, each reading up to the block at its own time, up to the first at which the negative counts.
  for (let epoch = T0 + (paidAt + 60) * BLOCK_MS; e.refundCheck?.final !== true && epoch <= countsFrom + 3_600_000; epoch += 3_600_000) {
    if (epoch >= countsFrom) assert.fail(`not settled by ${new Date(countsFrom).toISOString()}, when it counts: read through block ${e.refundCheck?.readThroughBlock} of ${Math.ceil((hold.holdEndMs(e0, cfg) - T0) / BLOCK_MS)}`);
    const headBlock = Math.floor((epoch - T0) / BLOCK_MS);
    const check = await hold.readRefund(e, cfg, { getLogs: n.getLogs, blockMs: baseMs, asset: ASSET, agent: AGENT, headBlock, chunk: 200, epochMs: 3_600_000 });
    e = settled(e0, check);
  }
  assert.deepEqual([e.refundCheck.final, e.refundCheck.refunded], [true, false]);
});

test('a node whose filter finds nothing, not even the payment, does not settle a negative as not refunded', async () => {
  const blind = { getLogs: async () => [] };
  const check = await hold.readRefund(negative(), cfg, { getLogs: blind.getLogs, blockMs, asset: ASSET, agent: AGENT, headBlock: blockAt(END) + 10, chunk: 100_000 });
  assert.equal(check.final, false, 'its empty answers prove nothing');
  assert.equal(check.readThroughBlock, PAID_BLOCK - 1, 'and it is read again');
  assert.match(check.error.message, /did not find the payment itself/);
});

test('a hold never starts before the payer signed, whatever block it was checked at', () => {
  // Checked at a block an hour before the signature, as a peer may name one.
  const signedAt = Math.floor(CHECKED_MS / 1000) + 3600;
  const early = negative({ payerOutcome: Object.freeze({ outcome: 2, signedAt, checkedAtBlock: 200, checkedAtMs: CHECKED_MS }) });
  assert.equal(hold.holdEndMs(early, cfg), signedAt * 1000 + 7 * DAY);
  assert.equal(hold.holdEndMs(negative({ payerOutcome: Object.freeze({ outcome: 2, signedAt: Math.floor(CHECKED_MS / 1000) - 60, checkedAtBlock: 200, checkedAtMs: CHECKED_MS }) }), cfg), END,
    'from the checked block when that is later');
});
