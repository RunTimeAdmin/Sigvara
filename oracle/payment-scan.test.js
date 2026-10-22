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

test('decodeTransfer refuses a log the asset did not emit', () => {
  // The getLogs filter names the asset, but that is the RPC's promise. A provider that
  // returned another token's Transfer would otherwise be credited as a payment.
  const log = { ...transfer(PAYER, AGENT, 500n), address: ASSET };
  assert.equal(scan.decodeTransfer(log, ASSET).from, PAYER);
  assert.equal(scan.decodeTransfer(log, ASSET.toLowerCase()).from, PAYER, 'case does not matter');
  assert.equal(scan.decodeTransfer({ ...log, address: STRANGER }, ASSET), null);
  assert.equal(scan.decodeTransfer({ ...log, address: undefined }, ASSET), null);
  // Array.prototype.map passes an index as the second argument; it is not an asset.
  assert.equal([log].map(scan.decodeTransfer)[0].from, PAYER);
});

test('decodeTransfer refuses an ERC-721 Transfer, a removed log and a malformed amount', () => {
  const log = transfer(PAYER, AGENT, 500n);
  // Four topics is ERC-721: the third indexed topic is a token id, not a recipient.
  assert.equal(scan.decodeTransfer({ ...log, topics: [...log.topics, w(7n)] }), null);
  // Reorganised away after the RPC served it.
  assert.equal(scan.decodeTransfer({ ...log, removed: true }), null);
  assert.equal(scan.decodeTransfer({ ...log, removed: false }).amount, '500');
  // BigInt('0x') throws, which used to take the whole scan down at that range.
  assert.equal(scan.decodeTransfer({ ...log, data: '0x' }), null);
  assert.equal(scan.decodeTransfer({ ...log, data: undefined }), null);
  assert.equal(scan.decodeTransfer({ ...log, data: '0x' + '00'.repeat(64) }), null, 'more than one word');
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

// This replaced a test asserting that the earliest log in a transaction named the payer.
// Choosing one sender to stand for several was the problem, not which one got chosen: the
// attested path chose the largest contributor instead, so the same transaction credited a
// different payer depending on which route saw it, and payer identity drives the per-payer
// cap, the distinct counterparty count, propagation and the self-payment check. Two honest
// operators could diverge over it, which is evidence for the slashing committee.
//
// Grouping by sender removes the choice. Nothing selects a payer any more.
test('each sender in a transaction is credited separately', () => {
  const tx = '0x' + 'ee'.repeat(32);
  const { credits } = plan([
    transfer(STRANGER, AGENT, 100n, { tx, logIndex: 5 }),
    transfer(PAYER, AGENT, 400n, { tx, logIndex: 1 }),
  ]);
  assert.equal(credits.length, 2, 'two payers, two credits');
  const byPayer = Object.fromEntries(credits.map((c) => [c.payer, c.amount]));
  assert.equal(byPayer[PAYER], '400');
  assert.equal(byPayer[STRANGER], '100');
});

test('several logs from one sender are still one credit', () => {
  // A split settlement from a single counterparty is one payment, so the legs are summed
  // rather than counted twice against the per-payer cap.
  const tx = '0x' + 'ef'.repeat(32);
  const { credits } = plan([
    transfer(PAYER, AGENT, 100n, { tx, logIndex: 0 }),
    transfer(PAYER, AGENT, 400n, { tx, logIndex: 3 }),
  ]);
  assert.equal(credits.length, 1);
  assert.equal(credits[0].payer, PAYER);
  assert.equal(credits[0].amount, '500');
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

test('an unparseable confirmation setting falls back to the floor', () => {
  // Math.max(6, NaN) is NaN, which made safeHead NaN and the scan silently a no-op.
  assert.equal(scan.readConfig({ PAYMENT_SCAN_CONFIRMATIONS: 'six' }).confirmations, scan.MIN_SCAN_CONFIRMATIONS);
  assert.equal(scan.readConfig({ PAYMENT_MIN_CONFIRMATIONS: '12x' }).confirmations, scan.MIN_SCAN_CONFIRMATIONS);
  assert.equal(scan.safeHead(100, scan.readConfig({ PAYMENT_SCAN_CONFIRMATIONS: 'six' }).confirmations), 94);
  assert.equal(scan.readConfig({ PAYMENT_SCAN_CONFIRMATIONS: '12' }).confirmations, 12, 'a valid value still raises it');
});

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

// ---------------------------------------------------------------------------
// Canary: an empty scan has to be proved, not believed
// ---------------------------------------------------------------------------

const eventsFor = (pairs) => new Map(pairs);

test('pickCanary chooses the newest payment of an agent whose address is known', () => {
  const c = scan.pickCanary(
    eventsFor([[DID, [{ txHash: '0xaa' }, { txHash: '0xbb' }]]]),
    () => AGENT,
  );
  assert.equal(c.recipient, AGENT);
  assert.equal(c.txHash, '0xbb', 'newest, because an old settlement may fall outside a pruned node');
});

test('pickCanary skips an agent whose address is unknown', () => {
  const c = scan.pickCanary(
    eventsFor([['0xunknown', [{ txHash: '0xaa' }]], [DID, [{ txHash: '0xbb' }]]]),
    (d) => (d === DID ? AGENT : null),
  );
  assert.equal(c.didHash, DID);
});

test('pickCanary returns null when there is nothing to point at', () => {
  // A fresh operator has no prior payment. There is then no canary, and the verdict
  // must be "unavailable" rather than a pass that never ran.
  assert.equal(scan.pickCanary(eventsFor([]), () => AGENT), null);
  assert.equal(scan.pickCanary(eventsFor([[DID, []]]), () => AGENT), null);
  assert.equal(scan.pickCanary(eventsFor([[DID, [{}]]]), () => AGENT), null);
});

test('the canary filter has the same shape as the scan filter, narrowed to one block', () => {
  // Same shape is the whole point. A canary that queried differently would prove the
  // canary works and say nothing about the scan.
  const f = scan.canaryFilter(ASSET, AGENT, 500);
  assert.equal(f.address, ASSET);
  assert.equal(f.topics[0], scan.TRANSFER_TOPIC);
  assert.equal(f.topics[1], null);
  assert.equal(f.topics[2].length, 1);
  assert.equal(f.fromBlock, 500);
  assert.equal(f.toBlock, 500, 'one block: the answer is already known');
});

test('canaryVerdict passes when the known transaction comes back', () => {
  const tx = '0x' + 'ab'.repeat(32);
  assert.equal(scan.canaryVerdict([{ transactionHash: tx }], tx), 'passed');
  assert.equal(scan.canaryVerdict([{ transactionHash: tx.toUpperCase() }], tx), 'passed');
});

test('canaryVerdict fails when the filter finds nothing', () => {
  // The loud case. The query mechanism does not work, so an empty scan carries no
  // information and must not be reported as a quiet range.
  const tx = '0x' + 'ab'.repeat(32);
  assert.equal(scan.canaryVerdict([], tx), 'failed');
  assert.equal(scan.canaryVerdict([{ transactionHash: '0x' + 'cd'.repeat(32) }], tx), 'failed');
});

test('canaryVerdict treats a non-array response as failure, not as empty', () => {
  // An RPC that answers with something unexpected has not told us the range was quiet.
  assert.equal(scan.canaryVerdict(null, '0xaa'), 'failed');
  assert.equal(scan.canaryVerdict(undefined, '0xaa'), 'failed');
});

test('pickCanary: hands back the stored block so no receipt lookup is needed', () => {
  // The reason this exists: both live endpoints prune eth_getTransactionReceipt, so
  // locating a settlement by hash stops working while locating it by block never does.
  const did = '0x' + 'c7'.repeat(32);
  const events = eventsFor([[did, [
    { txHash: '0x' + 'd1'.repeat(32), blockNumber: 64100000 },
    { txHash: '0x' + 'd2'.repeat(32), blockNumber: 64200000 },
  ]]]);
  const c = scan.pickCanary(events, () => AGENT);
  assert.equal(c.txHash, '0x' + 'd2'.repeat(32), 'newest settlement');
  assert.equal(c.blockNumber, 64200000);
});

test('pickCanary: reports a null block for events stored before it was kept', () => {
  const did = '0x' + 'c8'.repeat(32);
  const events = eventsFor([[did, [{ txHash: '0x' + 'd3'.repeat(32) }]]]);
  const c = scan.pickCanary(events, () => AGENT);
  assert.equal(c.blockNumber, null, 'so the caller knows to fall back to the receipt');
});

// ---------------------------------------------------------------------------
// Pacing
//
// Measured against both live endpoints on 3 Oct 2026. The limiter is a bucket of about
// 60 requests, not a simple rate: back-to-back calls are refused ~60% of the time, 250ms
// apart clears the first 60 calls and then fails every one after, and 500ms apart
// sustains 72 of 72. So a long catch-up needs a pace, and the pace has to hold for the
// whole run rather than just the opening burst.
//
// Without one, a cold scan of 2.5M blocks is ~255 consecutive calls. readWithBackoff
// allows four attempts, so one chunk exhausting them throws out of the scan, leaves the
// checkpoint unadvanced, and retries the entire run next epoch: a standing hot loop.
// ---------------------------------------------------------------------------

test('scanRange: waits between calls, but not before the first or after the last', async () => {
  const waits = [];
  const calls = [];
  await scan.scanRange(
    {
      readLogs: (f) => { calls.push(f.fromBlock); return []; },
      asset: ASSET,
      paceMs: 500,
      sleep: (ms) => { waits.push(ms); },
    },
    [AGENT], 1000, 4000, 1000,
  );
  assert.deepEqual(calls, [1000, 2000, 3000, 4000], 'four chunks');
  assert.deepEqual(waits, [500, 500, 500], 'three gaps, one fewer than the calls');
});

test('scanRange: a single call never waits', async () => {
  const waits = [];
  await scan.scanRange(
    { readLogs: () => [], asset: ASSET, paceMs: 500, sleep: (ms) => waits.push(ms) },
    [AGENT], 1000, 1500, 10000,
  );
  assert.deepEqual(waits, [], 'steady state is one chunk an epoch, so pacing must cost nothing');
});

test('scanRange: paces across recipient batches too, since the limiter counts calls', async () => {
  // More than MAX_RECIPIENTS_PER_CALL forces a second batch, and that second batch is
  // another request against the same bucket.
  const many = Array.from({ length: 60 }, (_, i) => `0x${String(i + 1).padStart(40, '0')}`);
  const waits = [];
  let n = 0;
  await scan.scanRange(
    { readLogs: () => { n += 1; return []; }, asset: ASSET, paceMs: 500, sleep: (ms) => waits.push(ms) },
    many, 1000, 1500, 10000,
  );
  assert.equal(n, 2, 'two recipient batches');
  assert.equal(waits.length, 1, 'and one gap between them');
});

test('readConfig: pace defaults to the measured sustainable rate', () => {
  assert.equal(scan.readConfig({}).paceMs, 500);
  assert.equal(scan.readConfig({ PAYMENT_SCAN_PACE_MS: '0' }).paceMs, 0, 'opt out explicitly');
  assert.equal(scan.readConfig({ PAYMENT_SCAN_PACE_MS: '1500' }).paceMs, 1500);
  assert.equal(scan.readConfig({ PAYMENT_SCAN_PACE_MS: 'nonsense' }).paceMs, 500, 'unparseable falls back');
});

// ---------------------------------------------------------------------------
// Edges of the pure helpers
// ---------------------------------------------------------------------------

test('decodeTransfer: topics that are not an array are not a Transfer', () => {
  assert.equal(scan.decodeTransfer({ topics: 'nope' }), null);
  assert.equal(scan.decodeTransfer({}), null);
});

test('decodeTransfer: carries the position on chain and checksums both parties', () => {
  const log = transfer(PAYER, AGENT, 7n, { tx: '0x' + 'dd'.repeat(32), block: 42, logIndex: 3 });
  log.topics = [log.topics[0], log.topics[1].toLowerCase(), log.topics[2].toLowerCase()];
  const t = scan.decodeTransfer(log);
  assert.equal(t.txHash, '0x' + 'dd'.repeat(32));
  assert.equal(t.blockNumber, 42);
  assert.equal(t.logIndex, 3);
  assert.equal(t.from, PAYER, 'checksummed');
  assert.equal(t.to, AGENT, 'checksummed');
});

test('decodeTransfer: amounts beyond 2^53 survive as exact strings', () => {
  const big = 10n ** 30n + 1n;
  assert.equal(scan.decodeTransfer(transfer(PAYER, AGENT, big)).amount, big.toString());
});

test('planCredits: null entries from decodeTransfer are ignored', () => {
  const { credits, skipped } = plan([
    { topics: [] },
    transfer(PAYER, AGENT, 500n),
  ]);
  assert.equal(credits.length, 1);
  assert.equal(skipped.length, 0);
});

test('planCredits: defaults credit everything to a known agent', () => {
  // No operatorOf, isUsed or minAmount: nothing is refused but self-payment.
  const decoded = [transfer(PAYER, AGENT, 1n), transfer(AGENT, AGENT, 1n, { tx: '0x' + 'ee'.repeat(32) })]
    .map(scan.decodeTransfer);
  const { credits, skipped } = scan.planCredits(decoded, {
    didHashOf: (a) => (a === AGENT ? DID : null),
  });
  assert.equal(credits.length, 1);
  assert.equal(credits[0].amount, '1');
  assert.deepEqual(skipped.map((s) => s.reason), ['self_payment']);
});

test('planCredits: exactly the minimum is credited', () => {
  const { credits } = plan([transfer(PAYER, AGENT, 100n)]);
  assert.equal(credits.length, 1);
  assert.equal(credits[0].amount, '100');
});

test('planCredits: the minimum applies to the summed payment, not each log', () => {
  const tx = '0x' + 'f1'.repeat(32);
  const { credits, skipped } = plan([
    transfer(PAYER, AGENT, 60n, { tx, logIndex: 0 }),
    transfer(PAYER, AGENT, 40n, { tx, logIndex: 1 }),
  ]);
  assert.equal(skipped.length, 0);
  assert.equal(credits[0].amount, '100');
});

test('planCredits: grouping ignores the case of the transaction hash', () => {
  const tx = '0x' + 'ab'.repeat(32);
  const a = scan.decodeTransfer(transfer(PAYER, AGENT, 60n, { tx }));
  const b = { ...scan.decodeTransfer(transfer(PAYER, AGENT, 40n, { tx })), txHash: tx.toUpperCase().replace('0X', '0x') };
  const { credits } = scan.planCredits([a, b], {
    didHashOf: (x) => (x === AGENT ? DID : null),
  });
  assert.equal(credits.length, 1);
  assert.equal(credits[0].amount, '100');
});

test('planCredits: isUsed is asked about the exact (tx, agent, payer) triple', () => {
  const seen = [];
  plan([transfer(PAYER, AGENT, 500n, { tx: '0x' + '12'.repeat(32) })], {
    isUsed: (...args) => { seen.push(args); return false; },
  });
  assert.deepEqual(seen, [['0x' + '12'.repeat(32), DID, PAYER]]);
});

test('planCredits: the operator check ignores address case', () => {
  const { credits, skipped } = plan([transfer(OPERATOR, AGENT, 500n)], {
    operatorOf: () => OPERATOR.toLowerCase(),
  });
  assert.equal(credits.length, 0);
  assert.equal(skipped[0].reason, 'self_payment');
});

test('planCredits: an agent with no known operator is still checked for paying itself', () => {
  const { credits, skipped } = plan([transfer(PAYER, AGENT, 500n), transfer(AGENT, AGENT, 500n, { tx: '0x' + '34'.repeat(32) })], {
    operatorOf: () => null,
  });
  assert.equal(credits.length, 1);
  assert.equal(credits[0].payer, PAYER);
  assert.deepEqual(skipped.map((s) => s.reason), ['self_payment']);
});

test('planCredits: the refusal checks run in a fixed order', () => {
  // Already credited wins over below-minimum and self-payment, so a replay is always
  // reported as a replay.
  const { skipped } = plan([transfer(AGENT, AGENT, 1n)], { isUsed: () => true });
  assert.equal(skipped[0].reason, 'already_credited');
  const r2 = plan([transfer(AGENT, AGENT, 1n)]);
  assert.equal(r2.skipped[0].reason, 'below_minimum');
});

test('planCredits: a skip names the transaction, agent, payer and amount', () => {
  const tx = '0x' + '56'.repeat(32);
  const { skipped } = plan([transfer(PAYER, AGENT, 5n, { tx })]);
  assert.deepEqual(skipped, [{ txHash: tx, didHash: DID, payer: PAYER, amount: '5', reason: 'below_minimum' }]);
});

test('planCredits: one transaction paying two agents credits each', () => {
  const OTHER = addr('6');
  const DID2 = '0x' + 'cd'.repeat(32);
  const tx = '0x' + '78'.repeat(32);
  const { credits } = scan.planCredits(
    [transfer(PAYER, AGENT, 200n, { tx }), transfer(PAYER, OTHER, 300n, { tx, logIndex: 1 })].map(scan.decodeTransfer),
    { didHashOf: (a) => (a === AGENT ? DID : a === OTHER ? DID2 : null) },
  );
  assert.deepEqual(credits.map((c) => [c.didHash, c.amount]).sort(), [[DID, '200'], [DID2, '300']].sort());
});

test('planCredits: the credited block is the first log seen for the group', () => {
  const tx = '0x' + '9a'.repeat(32);
  const { credits } = plan([
    transfer(PAYER, AGENT, 100n, { tx, block: 7 }),
    transfer(PAYER, AGENT, 100n, { tx, block: 7, logIndex: 1 }),
  ]);
  assert.equal(credits[0].blockNumber, 7);
});

test('blockRanges: an empty span yields no ranges, a one-block chunk yields one per block', () => {
  assert.deepEqual(scan.blockRanges(10, 9, 100), []);
  assert.deepEqual(scan.blockRanges(5, 7, 1), [[5, 5], [6, 6], [7, 7]]);
  assert.deepEqual(scan.blockRanges(5, 5, 1000), [[5, 5]]);
});

test('recipientBatches: no agents is no batches, and the cap is exact', () => {
  assert.deepEqual(scan.recipientBatches([]), []);
  const fifty = Array.from({ length: scan.MAX_RECIPIENTS_PER_CALL }, (_, i) => i);
  assert.equal(scan.recipientBatches(fifty).length, 1);
  assert.equal(scan.recipientBatches([...fifty, 50]).length, 2);
  assert.deepEqual(scan.recipientBatches([1, 2, 3], 2), [[1, 2], [3]]);
});

test('safeHead never goes below zero on a young chain', () => {
  assert.equal(scan.safeHead(3, 6), 0);
  assert.equal(scan.safeHead(6, 6), 0);
  assert.equal(scan.safeHead(7, 6), 1);
});

test('checkpointAfter: several unresolved credits stop short of the earliest', () => {
  assert.equal(scan.checkpointAfter([{ blockNumber: 180 }, { blockNumber: 150 }, { blockNumber: 199 }], 100, 200), 149);
});

test('readConfig: the scan-specific settings win over the shared ones', () => {
  const cfg = scan.readConfig({
    PAYMENT_SCAN_FROM_BLOCK: '900', FROM_BLOCK: '500',
    PAYMENT_SCAN_CHUNK: '250', LOG_CHUNK_SIZE: '1000',
  });
  assert.equal(cfg.fromBlock, 900);
  assert.equal(cfg.chunkSize, 250);
});

test('readConfig: defaults with nothing set', () => {
  const cfg = scan.readConfig({});
  assert.equal(cfg.fromBlock, 0);
  assert.equal(cfg.chunkSize, 2000);
});

test('readConfig: chunk size is at least one block', () => {
  assert.equal(scan.readConfig({ PAYMENT_SCAN_CHUNK: '0' }).chunkSize, 1);
  assert.equal(scan.readConfig({ PAYMENT_SCAN_CHUNK: '-5' }).chunkSize, 1);
});

test('readConfig: an empty or negative pace does not remove pacing by accident', () => {
  assert.equal(scan.readConfig({ PAYMENT_SCAN_PACE_MS: '' }).paceMs, scan.DEFAULT_SCAN_PACE_MS, 'empty falls back');
  assert.equal(scan.readConfig({ PAYMENT_SCAN_PACE_MS: '-100' }).paceMs, 0, 'negative clamps to zero');
});

test('pickCanary: skips empty and hashless events and moves on to the next agent', () => {
  const OTHER = addr('7');
  const events = new Map([
    ['0x01', []],
    ['0x02', [null, { amount: '1' }]],
    ['0x03', [{ txHash: '0xfeed', blockNumber: 12 }]],
  ]);
  const got = scan.pickCanary(events, () => OTHER);
  assert.deepEqual(got, { didHash: '0x03', recipient: OTHER, txHash: '0xfeed', blockNumber: 12 });
});

test('pickCanary: a non-integer block is reported as null', () => {
  const events = new Map([['0x01', [{ txHash: '0xfeed', blockNumber: '12' }]]]);
  assert.equal(scan.pickCanary(events, () => AGENT).blockNumber, null);
});

test('canaryFilter: accepts a lowercase recipient and pads it like the scan does', () => {
  const f = scan.canaryFilter(ASSET, AGENT.toLowerCase(), 9);
  assert.deepEqual(f.topics[2], [wa(AGENT)]);
});

test('canaryVerdict: matching ignores case and tolerates null entries', () => {
  const tx = '0x' + 'ab'.repeat(32);
  assert.equal(scan.canaryVerdict([null, { transactionHash: tx.toUpperCase().replace('0X', '0x') }], tx), 'passed');
  assert.equal(scan.canaryVerdict([{ transactionHash: '0x01' }], tx), 'failed', 'a different transaction is not the canary');
});

test('scanRange: no recipients or an empty span makes no calls', async () => {
  let n = 0;
  const readLogs = () => { n += 1; return []; };
  await scan.scanRange({ readLogs, asset: ASSET, sleep: () => {} }, [], 0, 100, 10);
  await scan.scanRange({ readLogs, asset: ASSET, sleep: () => {} }, [AGENT], 101, 100, 10);
  assert.equal(n, 0);
});

test('scanRange: uses the default pace when none is given, and returns every log in order', async () => {
  const waits = [];
  const logs = await scan.scanRange(
    { readLogs: (f) => [{ from: f.fromBlock }], asset: ASSET, sleep: (ms) => waits.push(ms) },
    [AGENT], 0, 29, 10,
  );
  assert.deepEqual(logs.map((l) => l.from), [0, 10, 20]);
  assert.deepEqual(waits, [scan.DEFAULT_SCAN_PACE_MS, scan.DEFAULT_SCAN_PACE_MS]);
});

test('scanRange: each filter is padded and inclusive at both ends', async () => {
  const calls = [];
  await scan.scanRange(
    { readLogs: (f) => { calls.push(f); return []; }, asset: ASSET, paceMs: 0, sleep: () => {} },
    [AGENT], 5, 12, 4,
  );
  assert.deepEqual(calls.map((c) => [c.fromBlock, c.toBlock]), [[5, 8], [9, 12]]);
  assert.deepEqual(calls[0].topics[2], [wa(AGENT)]);
});

test('scanRange: a failing read propagates rather than returning a partial scan', async () => {
  await assert.rejects(
    scan.scanRange(
      { readLogs: (f) => { if (f.fromBlock > 0) throw new Error('rate limited'); return []; }, asset: ASSET, paceMs: 0 },
      [AGENT], 0, 19, 10,
    ),
    /rate limited/,
  );
});

// ---------------------------------------------------------------------------
// The scan's pre-check and the store agree
// ---------------------------------------------------------------------------

test('planCredits with the store as isUsed: a credited payment is refused the next time', () => {
  const store = require('./store');
  const tx = '0x' + 'a7'.repeat(32);
  const opts = {
    didHashOf: (a) => (a === AGENT ? DID : null),
    isUsed: store.isCredited,
  };
  const decoded = [transfer(PAYER, AGENT, 500n, { tx, block: 77 })].map(scan.decodeTransfer);

  const first = scan.planCredits(decoded, opts);
  assert.equal(first.credits.length, 1);
  const c = first.credits[0];
  assert.equal(store.creditPayment(c.didHash, c.txHash, c.amount, c.payer, c.success, 1_000, null, c.blockNumber), true);

  const stored = store.getPaymentEvents(DID).find((e) => e.txHash === tx);
  assert.equal(stored.success, null, 'a pulled payment carries no outcome');
  assert.equal(stored.blockNumber, 77);
  assert.equal(stored.payer, PAYER);

  const second = scan.planCredits(decoded, opts);
  assert.equal(second.credits.length, 0);
  assert.equal(second.skipped[0].reason, 'already_credited');
});

test('planCredits with the store as isUsed: a second payer in the same transaction is still new', () => {
  const store = require('./store');
  const tx = '0x' + 'b8'.repeat(32);
  const OTHER_PAYER = addr('8');
  assert.equal(store.creditPayment(DID, tx, '500', PAYER, null, 1_000), true);

  const { credits, skipped } = scan.planCredits(
    [transfer(PAYER, AGENT, 500n, { tx }), transfer(OTHER_PAYER, AGENT, 600n, { tx, logIndex: 1 })].map(scan.decodeTransfer),
    { didHashOf: (a) => (a === AGENT ? DID : null), isUsed: store.isCredited },
  );
  assert.deepEqual(credits.map((x) => x.payer), [OTHER_PAYER]);
  assert.deepEqual(skipped.map((x) => [x.payer, x.reason]), [[PAYER, 'already_credited']]);
});

// ---------------------------------------------------------------------------
// Zero-value transfers
// ---------------------------------------------------------------------------
//
// A zero-value Transfer is not a small payment. On a standard ERC-20 anyone can emit one
// naming any sender (transferFrom with a value of 0 needs no allowance), so crediting it
// credited a counterparty that never paid anything. It is refused whatever the minimum.

test('planCredits: a zero-value transfer is skipped as zero_value, whatever the minimum', () => {
  for (const minAmount of [0n, 100n]) {
    const { credits, skipped } = plan([transfer(STRANGER, AGENT, 0n)], { minAmount });
    assert.equal(credits.length, 0, `minimum ${minAmount}`);
    assert.deepEqual(skipped.map((s) => s.reason), ['zero_value'], `minimum ${minAmount}`);
  }
});

test('planCredits: a zero-value leg beside a real payment credits only the real one', () => {
  const { credits, skipped } = plan([
    transfer(PAYER, AGENT, 500n, { logIndex: 0 }),
    transfer(STRANGER, AGENT, 0n, { logIndex: 1 }),
  ]);
  assert.deepEqual(credits.map((c) => c.payer), [PAYER]);
  assert.deepEqual(skipped.map((s) => s.reason), ['zero_value']);
});
