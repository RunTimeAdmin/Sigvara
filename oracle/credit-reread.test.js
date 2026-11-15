'use strict';

// Reading a credit again once its block is final (credit-reread.js, docs/adr/0012-a-credit-a-reorganization-removed.md):
// which credits are read, and what each answer from the chain makes of one. Nothing is removed on an answer a node
// could give for its own reasons; the end-to-end path is in credit-reread-e2e.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { toReread, reread, paidIn } = require('./credit-reread');
const { TRANSFER_TOPIC } = require('./payments');
const { rootFor } = require('./merkle');
const { evidenceAsOf } = require('./evidence-as-of');
const paymentChains = require('./payment-chains');
const { pickCanary } = require('./payment-scan');

const ASSET = ethers.getAddress(`0x${'11'.repeat(20)}`);
const AGENT = ethers.getAddress(`0x${'22'.repeat(20)}`);
const PAYER = ethers.getAddress(`0x${'33'.repeat(20)}`);
const OTHER = ethers.getAddress(`0x${'44'.repeat(20)}`);
const TX = `0x${'ab'.repeat(32)}`;
const pad = (a) => ethers.zeroPadValue(a, 32);
const log = ({ from = PAYER, to = AGENT, value = 5_000_000n, tx = TX, asset = ASSET } = {}) => ({
  address: asset, transactionHash: tx, topics: [TRANSFER_TOPIC, pad(from), pad(to)], data: ethers.toBeHex(value, 32),
});
const credit = { txHash: TX, payer: PAYER, amount: '5000000', blockNumber: 100 };

/** A chain answering from these parts; each read is recorded. */
function chain({ receipt = null, block = { transactions: [TX] }, logs = [] } = {}) {
  const reads = [];
  return {
    reads,
    ctx: {
      agent: AGENT,
      asset: ASSET,
      getReceipt: async (h) => { reads.push(['receipt', h]); return receipt; },
      getBlock: async (n) => { reads.push(['block', n]); return block; },
      getLogs: async (f) => { reads.push(['logs', f]); return logs; },
    },
  };
}

test('toReread: the scored chain\'s credits at or below the finalized block, not read yet, oldest first', () => {
  const events = new Map([
    ['0xd1', [
      { txHash: '0x1', blockNumber: 90 },
      { txHash: '0x2', blockNumber: 120 }, // not final yet
      { txHash: '0x3', blockNumber: 95, rereadBlock: 99 }, // read before
      { txHash: '0x4', blockNumber: 50, removedAt: 1 }, // removed before
      { txHash: '0x5' }, // stored before blocks were kept
      { txHash: '0x6', blockNumber: 10, chainId: 8453 }, // a payment chain's, credited at its finalized block already
    ]],
    ['0xd2', [{ txHash: '0x7', blockNumber: 80 }]],
    ['0xd3', [{ txHash: '0x8', blockNumber: 1 }]], // no address known for this agent
  ]);
  const items = toReread(events, 100, (did) => (did === '0xd3' ? null : AGENT));
  assert.deepEqual(items.map((i) => i.e.txHash), ['0x7', '0x1']);
  assert.deepEqual(items.map((i) => i.didHash), ['0xd2', '0xd1']);
});

test('reread: a receipt in the same block with the credited transfer keeps the credit, in one read', async () => {
  const c = chain({ receipt: { status: 1, blockNumber: 100, logs: [log()] } });
  assert.deepEqual(await reread(credit, c.ctx), { kept: true });
  assert.equal(c.reads.length, 1);
});

test('reread: a receipt now in another block removes the credit (a transaction put back later is not credited again)', async () => {
  const c = chain({ receipt: { status: 1, blockNumber: 105, logs: [log()] } });
  assert.deepEqual(await reread(credit, c.ctx), { removed: 'other_block' });
});

test('reread: a receipt that reverted, or no longer holds the credited transfer, removes the credit', async () => {
  assert.deepEqual(await reread(credit, chain({ receipt: { status: 0, blockNumber: 100, logs: [] } }).ctx), { removed: 'transfer_changed' });
  const less = chain({ receipt: { status: 1, blockNumber: 100, logs: [log({ value: 4_000_000n })] } });
  assert.deepEqual(await reread(credit, less.ctx), { removed: 'transfer_changed' });
  const someoneElse = chain({ receipt: { status: 1, blockNumber: 100, logs: [log({ from: OTHER })] } });
  assert.deepEqual(await reread(credit, someoneElse.ctx), { removed: 'transfer_changed' });
});

test('reread: no receipt and a block that no longer holds the transaction removes the credit', async () => {
  const c = chain({ block: { transactions: [`0x${'cd'.repeat(32)}`] } });
  assert.deepEqual(await reread(credit, c.ctx), { removed: 'not_in_block' });
  assert.deepEqual(c.reads.map(([kind]) => kind), ['receipt', 'block']);
});

test('reread: no receipt, as a node that prunes its receipts answers, keeps a credit its block and logs still hold', async () => {
  const c = chain({ logs: [log()] });
  assert.deepEqual(await reread(credit, c.ctx), { kept: true });
  const filter = c.reads.find(([kind]) => kind === 'logs')[1];
  assert.deepEqual(filter, {
    address: ASSET, topics: [TRANSFER_TOPIC, pad(PAYER), pad(AGENT)], fromBlock: 100, toBlock: 100,
  });
});

test('reread: answers that do not settle it remove nothing', async () => {
  // The transaction is in its block but the logs come back empty: a node's answer as likely as the chain's.
  assert.ok((await reread(credit, chain({ logs: [] }).ctx)).unsure);
  // A block without its transaction list is not an empty block.
  assert.ok((await reread(credit, chain({ block: { number: 100 } }).ctx)).unsure);
  assert.ok((await reread(credit, chain({ block: null }).ctx)).unsure);
});

test('paidIn: only the payer\'s transfers of the asset to the agent in this transaction, summed', () => {
  const logs = [
    log({ value: 2n }), log({ value: 3n }),
    log({ value: 100n, from: OTHER }), log({ value: 100n, to: OTHER }),
    log({ value: 100n, asset: OTHER }), log({ value: 100n, tx: `0x${'ef'.repeat(32)}` }),
    { ...log({ value: 100n }), removed: true },
  ];
  assert.equal(paidIn(logs, { txHash: TX, payer: PAYER, agent: AGENT, asset: ASSET }), 5n);
});

// ---- what a removal does to evidence ---------------------------------------------------------------

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const ev = (i, ts, over = {}) => Object.freeze({
  txHash: `0x${String(i).padStart(2, '0').repeat(32)}`, payer: PAYER, amount: String(1000 * i), ts, success: null, blockNumber: 100 + i, ...over,
});
// How index.js's auditOptions ends a payment a reorganization removed.
const endsAt = (e) => (e.removedAt != null ? Number(e.removedAt) : Infinity);
const NO_CHAIN = paymentChains.readConfig({}, { scoredChainId: 5042002 });

test('a root made before a removal still reproduces from the state that holds it, and the next one leaves it out', () => {
  const a = ev(1, NOW - 60 * MIN);
  const b = ev(2, NOW - 50 * MIN);
  const before = rootFor([a, b]); // proposed at NOW - 30 min
  const removedB = Object.freeze({ ...b, rereadBlock: 900, removedAt: NOW - 20 * MIN, removedWhy: 'not_in_block' });
  const held = Object.freeze([a, removedB]);

  // The proposer: the same leaves before the removal, and without it from then on.
  assert.equal(rootFor(paymentChains.eventsAt(held, NOW - 30 * MIN, NO_CHAIN)), before, 'the leaf commits to none of the removal fields');
  assert.equal(rootFor(paymentChains.eventsAt(held, NOW, NO_CHAIN)), rootFor([a]));

  // The checker auditing each proposal from the same state reaches the same answer.
  const audit = (atMs, root, cuts) => evidenceAsOf(
    paymentChains.eventsAt(held, atMs, NO_CHAIN, undefined, { keepRemoved: true }), atMs, root, { endsAt, ...(cuts ? { cuts } : {}) },
  );
  assert.equal(audit(NOW - 30 * MIN, before).matchedRoot, true, 'the earlier proposal');
  assert.equal(audit(NOW, rootFor([a])).matchedRoot, true, 'the later one');
  assert.equal(audit(NOW, before).matchedRoot, false, 'a proposal after the removal that still counts it is a disagreement');

  // With payment chains on, a proposal dated after the removal whose evidence was cut before it still counted it.
  const cuts = [NOW - 19 * MIN, NOW - 20 * MIN, NOW - 21 * MIN];
  assert.equal(audit(NOW - 18 * MIN, before, cuts).matchedRoot, true);
});

test('the scan canary never points at a payment a reorganization removed', () => {
  const live = ev(1, NOW - 60 * MIN);
  const gone = ev(2, NOW - 10 * MIN, { removedAt: NOW - 5 * MIN });
  const canary = pickCanary(new Map([['0xd1', [live, gone]]]), () => AGENT);
  assert.equal(canary.txHash, live.txHash);
});

