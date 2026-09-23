'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const scan = require('./payment-scan');

const addr = (n) => ethers.getAddress('0x' + String(n).repeat(40).slice(0, 40));
const AGENT = addr('1');
const PAYER = addr('2');
const OPERATOR = addr('3');
const STRANGER = addr('4');
const ASSET = addr('5');
const DID = '0x' + 'ab'.repeat(32);

const w = (v) => ethers.zeroPadValue(ethers.toBeHex(v), 32);
const wa = (a) => ethers.zeroPadValue(a, 32);

const transfer = (from, to, amount, { tx = '0x' + 'cc'.repeat(32), block = 100, logIndex = 0 } = {}) => ({
  topics: [scan.TRANSFER_TOPIC, wa(from), wa(to)],
  data: w(amount),
  transactionHash: tx,
  blockNumber: block,
  logIndex,
});

const plan = (logs, over = {}) =>
  scan.planCredits(logs.map(scan.decodeTransfer), {
    didHashOf: (a) => (a.toLowerCase() === AGENT.toLowerCase() ? DID : null),
    operatorOf: () => OPERATOR,
    minAmount: 100n,
    ...over,
  });

// ---------------------------------------------------------------------------
// Decoding: the payer comes off the chain, never from a caller
// ---------------------------------------------------------------------------

test('decodeTransfer reads both parties out of the topics', () => {
  const t = scan.decodeTransfer(transfer(PAYER, AGENT, 500n));
  assert.equal(t.from, PAYER);
  assert.equal(t.to, AGENT);
  assert.equal(t.amount, '500');
});

test('decodeTransfer ignores anything that is not a Transfer', () => {
  assert.equal(scan.decodeTransfer({ topics: [ethers.id('Approval(address,address,uint256)')], data: '0x' }), null);
  assert.equal(scan.decodeTransfer({ topics: [] }), null);
  assert.equal(scan.decodeTransfer(null), null);
});

test('decodeTransfer refuses a Transfer whose parties are not indexed', () => {
  // Without indexed topics the payer would have to be decoded from data, and a
  // non-standard token is not the place to start trusting a layout.
  const odd = { topics: [scan.TRANSFER_TOPIC], data: w(1n), transactionHash: '0x1', blockNumber: 1 };
  assert.equal(scan.decodeTransfer(odd), null);
});

// ---------------------------------------------------------------------------
// What gets credited
// ---------------------------------------------------------------------------

test('a payment to a registered agent is credited with no outcome', () => {
  const { credits } = plan([transfer(PAYER, AGENT, 500n)]);
  assert.equal(credits.length, 1);
  assert.equal(credits[0].didHash, DID);
  assert.equal(credits[0].payer, PAYER);
  assert.equal(credits[0].amount, '500');
  // The heart of ADR 0003: money moving is on chain, how the work went is not.
  assert.equal(credits[0].success, null);
});

test('transfers to someone who is not a registered agent are not ours', () => {
  const { credits, skipped } = plan([transfer(PAYER, STRANGER, 500n)]);
  assert.equal(credits.length, 0);
  assert.equal(skipped.length, 0, 'not a skip: it was never a candidate');
});

test('several transfers in one transaction are one payment', () => {
  // Matches what verifyPayment already does with a receipt: one settlement transaction
  // is one payment, whatever number of Transfer events it contains. Crediting each log
  // separately would also collide with the tx-hash dedupe and silently lose all but one.
  const tx = '0x' + 'dd'.repeat(32);
  const { credits } = plan([
    transfer(PAYER, AGENT, 300n, { tx, logIndex: 0 }),
    transfer(PAYER, AGENT, 200n, { tx, logIndex: 1 }),
  ]);
  assert.equal(credits.length, 1);
  assert.equal(credits[0].amount, '500');
});

test('the earliest log in a transaction names the payer', () => {
  // A transaction that forwards the money onward afterwards must not relabel who paid.
  const tx = '0x' + 'ee'.repeat(32);
  const { credits } = plan([
    transfer(STRANGER, AGENT, 100n, { tx, logIndex: 5 }),
    transfer(PAYER, AGENT, 400n, { tx, logIndex: 1 }),
  ]);
  assert.equal(credits[0].payer, PAYER);
});

// ---------------------------------------------------------------------------
// What gets refused, and why it is named rather than dropped
// ---------------------------------------------------------------------------

test('an agent paying itself is refused', () => {
  const { credits, skipped } = plan([transfer(AGENT, AGENT, 500n)]);
  assert.equal(credits.length, 0);
  assert.equal(skipped[0].reason, 'self_payment');
});

test('the operator paying its own agent is refused', () => {
  // Costs only gas, and the money comes straight back. Same rule the attested path
  // already applies; pulling must not become the cheap way around it.
  const { credits, skipped } = plan([transfer(OPERATOR, AGENT, 500n)]);
  assert.equal(credits.length, 0);
  assert.equal(skipped[0].reason, 'self_payment');
});

test('a payment below the minimum is refused', () => {
  const { credits, skipped } = plan([transfer(PAYER, AGENT, 99n)]);
  assert.equal(credits.length, 0);
  assert.equal(skipped[0].reason, 'below_minimum');
});

test('a transaction already credited is refused, so attest and scan cannot double-count', () => {
  // The same settlement can arrive by both doors. Whichever gets there first wins and
  // the other must be a no-op, or every attested payment would be counted twice the
  // moment scanning is enabled.
  const tx = '0x' + 'ff'.repeat(32);
  const { credits, skipped } = plan([transfer(PAYER, AGENT, 500n, { tx })], {
    isUsed: (h) => h.toLowerCase() === tx.toLowerCase(),
  });
  assert.equal(credits.length, 0);
  assert.equal(skipped[0].reason, 'already_credited');
});

test('every refusal is named, because a silent filter reads as an agent nobody paid', () => {
  const { skipped } = plan([
    transfer(AGENT, AGENT, 500n, { tx: '0x' + '11'.repeat(32) }),
    transfer(PAYER, AGENT, 1n, { tx: '0x' + '22'.repeat(32) }),
  ]);
  assert.deepEqual(skipped.map((s) => s.reason).sort(), ['below_minimum', 'self_payment']);
  for (const s of skipped) assert.ok(s.txHash && s.didHash, 'a refusal must be traceable');
});

// ---------------------------------------------------------------------------
// Scanning mechanics
// ---------------------------------------------------------------------------

test('safeHead stays behind the tip, so a reorg cannot strand a credit', () => {
  // A credit records the tx hash as used. If the block were reorganised away there
  // would be a credit for a transaction that no longer exists, and no way back.
  assert.equal(scan.safeHead(1000, 1), 999);
  assert.equal(scan.safeHead(1000, 12), 988);
  assert.equal(scan.safeHead(3, 10), 0, 'never negative');
});

test('block ranges are chunked inclusively and cover the whole span', () => {
  assert.deepEqual(scan.blockRanges(0, 25, 10), [[0, 9], [10, 19], [20, 25]]);
  assert.deepEqual(scan.blockRanges(5, 5, 10), [[5, 5]]);
  assert.deepEqual(scan.blockRanges(10, 5, 10), [], 'an empty span scans nothing');
});

test('recipients are batched, so a growing registry cannot overflow the topic filter', () => {
  // An over-long topic filter does not fail loudly. It returns nothing, which looks
  // exactly like a set of agents with no income.
  const many = Array.from({ length: 120 }, (_, i) => addr(String(i % 10)));
  const batches = scan.recipientBatches(many, 50);
  assert.deepEqual(batches.map((b) => b.length), [50, 50, 20]);
  assert.equal(batches.flat().length, many.length);
});

test('scanRange queries every recipient batch across every block chunk', async () => {
  const calls = [];
  const readLogs = async (filter) => { calls.push(filter); return []; };
  const recipients = Array.from({ length: 60 }, (_, i) => addr(String(i % 10)));

  await scan.scanRange({ readLogs, asset: ASSET }, recipients, 0, 19, 10);

  assert.equal(calls.length, 4, '2 recipient batches x 2 block chunks');
  for (const c of calls) {
    assert.equal(c.address, ASSET);
    assert.equal(c.topics[0], scan.TRANSFER_TOPIC);
    assert.equal(c.topics[1], null, 'the sender is unconstrained');
    assert.ok(Array.isArray(c.topics[2]), 'recipients are an OR-list on the `to` topic');
  }
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

test('scanning is off unless explicitly enabled', () => {
  // Enabling it changes scores: an operator that has been missing payments starts
  // counting them. That is the point, and not something to discover by surprise.
  assert.equal(scan.readConfig({}).enabled, false);
  assert.equal(scan.readConfig({ PAYMENT_SCAN_ENABLED: 'true' }).enabled, false, 'only "1" enables it');
  assert.equal(scan.readConfig({ PAYMENT_SCAN_ENABLED: '1' }).enabled, true);
});

test('config falls back to the existing scan settings', () => {
  const cfg = scan.readConfig({ FROM_BLOCK: '500', LOG_CHUNK_SIZE: '1000' });
  assert.equal(cfg.fromBlock, 500);
  assert.equal(cfg.chunkSize, 1000);
  assert.equal(cfg.confirmations, scan.MIN_SCAN_CONFIRMATIONS, 'the floor applies when nothing is set');
});

// ---------------------------------------------------------------------------
// Confirmations: an unattended scan is more careful than a deliberate attestation
// ---------------------------------------------------------------------------

test('confirmations cannot be set below the floor', () => {
  // An attestation is a deliberate act by someone who watched the transaction settle.
  // A scan credits unattended, every epoch, with nobody looking, so the shallow default
  // the attested path uses is not good enough for it.
  assert.equal(scan.readConfig({ PAYMENT_MIN_CONFIRMATIONS: '1' }).confirmations, scan.MIN_SCAN_CONFIRMATIONS);
  assert.equal(scan.readConfig({ PAYMENT_SCAN_CONFIRMATIONS: '0' }).confirmations, scan.MIN_SCAN_CONFIRMATIONS);
  assert.ok(scan.MIN_SCAN_CONFIRMATIONS >= 6);
});

test('confirmations can be raised, and the scan-specific setting wins', () => {
  assert.equal(scan.readConfig({ PAYMENT_SCAN_CONFIRMATIONS: '24' }).confirmations, 24);
  assert.equal(scan.readConfig({ PAYMENT_MIN_CONFIRMATIONS: '12' }).confirmations, 12);
  assert.equal(
    scan.readConfig({ PAYMENT_SCAN_CONFIRMATIONS: '30', PAYMENT_MIN_CONFIRMATIONS: '12' }).confirmations,
    30,
  );
});

// ---------------------------------------------------------------------------
// The checkpoint may not step over a block that was not resolved
// ---------------------------------------------------------------------------

test('a fully resolved range checkpoints at the end of it', () => {
  assert.equal(scan.checkpointAfter([], 100, 200), 200);
});

test('the checkpoint stops one block short of the earliest unresolved block', () => {
  // The scan only moves forward. Advancing past a payment that could not be credited
  // would lose it for good, which is what the first version of this did while carrying
  // a comment claiming it was "left for next time".
  assert.equal(scan.checkpointAfter([{ blockNumber: 150 }], 100, 200), 149);
  assert.equal(scan.checkpointAfter([{ blockNumber: 180 }, { blockNumber: 150 }], 100, 200), 149,
    'the earliest one decides, not the last seen');
});

test('nothing is committed when the first block of the range is unresolved', () => {
  // from - 1 would move the checkpoint backwards. Null means the whole range is retried.
  assert.equal(scan.checkpointAfter([{ blockNumber: 100 }], 100, 200), null);
});

test('an unresolved block below the range does not drag the checkpoint backwards', () => {
  assert.equal(scan.checkpointAfter([{ blockNumber: 50 }], 100, 200), null);
});
