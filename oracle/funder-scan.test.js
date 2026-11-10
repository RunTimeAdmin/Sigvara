'use strict';

// Who first funded a wallet, read from its transfers in a span at a time (funder-scan.js): what is
// read when, what is kept, and what a reader that has not finished says.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createFunderReader, firstFunding, UNREAD, SPAN_BLOCKS } = require('./funder-scan');
const { arcTooWide } = require('./test-support/refusals');

const FLOOR = 10n ** 18n;
const addr = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const WALLET = addr(0x42);

/** A reader over `transfers` [{ from, to, value, block }], recording each read as [from, to]. */
function reader(transfers, { fail = () => null, ...opts } = {}) {
  const reads = [];
  const r = createFunderReader({
    floor: FLOOR,
    readIn: async (a, from, to) => {
      reads.push([from, to]);
      const err = fail(from, to);
      if (err) throw err;
      return transfers
        .map((t, i) => ({ from: t.from, to: t.to, value: t.value, blockNumber: t.block, logIndex: i }))
        .filter((t) => t.to === a && t.blockNumber >= from && t.blockNumber <= to);
    },
    ...opts,
  });
  return { r, reads };
}

test('firstFunding: the largest transfer reaching the floor, in the first block that has one', () => {
  const t = (from, value, blockNumber, logIndex) => ({ from: addr(from), value, blockNumber, logIndex });
  assert.equal(firstFunding([t(1, FLOOR - 1n, 5, 0), t(2, FLOOR / 2n, 6, 0), t(3, FLOOR / 2n, 6, 1)], FLOOR), null);
  const logs = [t(9, 9n * FLOOR, 8, 0), t(4, FLOOR, 7, 2), t(5, 3n * FLOOR, 7, 1), t(6, 3n * FLOOR, 7, 3), t(7, 1n, 7, 0)];
  assert.equal(firstFunding(logs, FLOOR).from, addr(5), 'the largest at block 7, the first of two equal ones, not the larger later');
});

test('asking reads nothing; a wallet is read from block 0 a span at a time, paced, and stops at its funding', async () => {
  const cap = 4 * SPAN_BLOCKS + 17;
  const funded = 2 * SPAN_BLOCKS + 5;
  const waits = [];
  const { r, reads } = reader([{ from: addr(7), to: WALLET, value: FLOOR, block: funded }], { wait: async (ms) => { waits.push(ms); } });
  assert.equal(await r.funderOf(WALLET, cap), UNREAD);
  assert.equal(reads.length, 0);
  const done = await r.readWanted({ paceMs: 500 });
  assert.deepEqual(reads, [[0, SPAN_BLOCKS - 1], [SPAN_BLOCKS, 2 * SPAN_BLOCKS - 1], [2 * SPAN_BLOCKS, 3 * SPAN_BLOCKS - 1]]);
  assert.deepEqual(waits, [500, 500], 'between reads, not before the first');
  assert.deepEqual(done, { reads: 3, left: 0, error: null });
  assert.deepEqual(await r.funderOf(WALLET, cap), { funder: addr(7), block: funded });
  // Found once, it answers for any block without another read: before the funding, nothing named one.
  assert.equal(await r.funderOf(WALLET, funded - 1), null);
  assert.deepEqual(await r.funderOf(WALLET, 10 ** 9), { funder: addr(7), block: funded });
  assert.equal(reads.length, 3);
});

test('a budget spent part way leaves the rest to the next epoch, which goes on from where it stopped', async () => {
  const { r, reads } = reader([]);
  const cap = 5 * SPAN_BLOCKS - 1;
  await r.funderOf(WALLET, cap);
  assert.deepEqual(await r.readWanted({ maxReads: 2 }), { reads: 2, left: 1, error: null });
  assert.equal(await r.funderOf(WALLET, cap), UNREAD, 'not counted until it is read to the cap');
  assert.equal(await r.funderOf(WALLET, 2 * SPAN_BLOCKS - 1), null, 'what was read already answers');
  assert.equal((await r.readWanted({ deadline: Date.now() - 1 })).reads, 0, 'nor past the time budget');
  // Saved and taken up again, as across a restart.
  const { r: after, reads: readsAfter } = reader([]);
  after.restore(JSON.parse(JSON.stringify(r.getState())));
  assert.deepEqual(await after.readWanted({ maxReads: 10 }), { reads: 3, left: 0, error: null });
  assert.deepEqual(readsAfter[0], [2 * SPAN_BLOCKS, 3 * SPAN_BLOCKS - 1], 'nothing read twice');
  assert.equal(await after.funderOf(WALLET, cap), null);
  assert.equal(reads.length, 2);
});

test('a save while a read is in flight never claims its blocks, and a failed read keeps what came before', async () => {
  let saved;
  const { r } = reader([], {
    fail: (from) => {
      if (from === SPAN_BLOCKS) saved = JSON.parse(JSON.stringify(r.getState()));
      return from === 2 * SPAN_BLOCKS ? new Error('node gone') : null;
    },
  });
  await r.funderOf(WALLET, 3 * SPAN_BLOCKS);
  const done = await r.readWanted();
  assert.equal(saved.wallets[WALLET].through, SPAN_BLOCKS - 1, 'the cursor of a save taken mid-read');
  assert.equal(done.error.message, 'node gone');
  assert.equal(done.left, 1);
  assert.equal(r.getState().wallets[WALLET].through, 2 * SPAN_BLOCKS - 1);
  assert.equal(await r.funderOf(WALLET, 3 * SPAN_BLOCKS), UNREAD);
});

test('a span the node refuses for its size is halved, and the answer is the same', async () => {
  const funded = 7_777;
  const { r, reads } = reader([{ from: addr(7), to: WALLET, value: FLOOR, block: funded }], {
    fail: (from, to) => (to - from >= 5_000 ? arcTooWide() : null),
  });
  await r.funderOf(WALLET, SPAN_BLOCKS - 1);
  assert.equal((await r.readWanted()).error, null);
  assert.deepEqual(await r.funderOf(WALLET, SPAN_BLOCKS - 1), { funder: addr(7), block: funded });
  assert.ok(reads.length > 1);
});

test('two readers that read different distances answer the same for the same block', async () => {
  const transfers = [{ from: addr(7), to: WALLET, value: FLOOR, block: 3 * SPAN_BLOCKS + 1 }];
  const near = reader(transfers).r;
  const far = reader(transfers).r;
  await near.funderOf(WALLET, SPAN_BLOCKS);
  await far.funderOf(WALLET, 10 * SPAN_BLOCKS);
  await near.readWanted();
  await far.readWanted();
  for (const cap of [0, SPAN_BLOCKS - 1, SPAN_BLOCKS]) assert.deepEqual(await near.funderOf(WALLET, cap), await far.funderOf(WALLET, cap));
  // Asked further, the nearer one reads on rather than answering from the cursor it had.
  assert.equal(await near.funderOf(WALLET, 10 * SPAN_BLOCKS), UNREAD);
  await near.readWanted();
  assert.deepEqual(await near.funderOf(WALLET, 10 * SPAN_BLOCKS), await far.funderOf(WALLET, 10 * SPAN_BLOCKS));
});

test('restore drops what this reader did not write, and that wallet is read again', async () => {
  const { r } = reader([]);
  r.restore({ wallets: {
    [WALLET]: { through: 99 },
    [addr(1)]: { through: 'ten' },
    [addr(2)]: { through: 5, funder: addr(9), block: 50 },
    NotAnAddress: { through: 5 },
  } });
  assert.deepEqual(Object.keys(r.getState().wallets), [WALLET]);
  r.restore(null);
  assert.deepEqual(r.getState(), { wallets: {} });
});
