'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const ix = require('./event-index');

const A = '0x' + 'aa'.repeat(20);
const B = '0x' + 'bb'.repeat(20);
const T0 = '0x' + '01'.repeat(32);
const T1 = '0x' + '02'.repeat(32);
const DID = '0x' + 'cd'.repeat(32);
const TX = (n) => '0x' + n.toString(16).padStart(64, '0');
const raw = (block, i = 0, over = {}) => ({
  address: A.toUpperCase().replace('0X', '0x'),
  topics: [T0, DID],
  data: '0x',
  blockNumber: '0x' + block.toString(16),
  logIndex: '0x' + i.toString(16),
  transactionHash: TX(block * 10 + i),
  blockTimestamp: '0x' + (1000 + block).toString(16),
  removed: false,
  ...over,
});
const ctx = { addresses: new Set([A, B]), from: 100, to: 199 };

// --- planSpans ----------------------------------------------------------------------

test('planSpans: contiguous, inclusive, at most LOG_SPAN blocks each', () => {
  const spans = ix.planSpans(100, 25099);
  assert.deepEqual(spans, [[100, 10099], [10100, 20099], [20100, 25099]]);
  for (const [a, b] of spans) assert.ok(b - a + 1 <= ix.LOG_SPAN);
  assert.deepEqual(ix.planSpans(5, 5), [[5, 5]]);
  assert.deepEqual(ix.planSpans(6, 5), []);
});

// --- normalizeLog -------------------------------------------------------------------

test('normalizeLog: lowercases and keeps the fields a reader needs', () => {
  const l = ix.normalizeLog(raw(150, 3, { data: '0xABCD' }), ctx);
  assert.equal(l.address, A);
  assert.equal(l.blockNumber, '0x96');
  assert.equal(l.logIndex, '0x3');
  assert.equal(l.data, '0xabcd');
  assert.equal(l.blockTimestamp, '0x' + (1150).toString(16));
  assert.equal('removed' in l, false);
});

test('normalizeLog: refuses an answer that is not what was asked', () => {
  const bad = [
    raw(99), raw(200),                                    // outside the span
    raw(150, 0, { address: '0x' + 'cc'.repeat(20) }),     // another contract
    raw(150, 0, { removed: true }),
    raw(150, 0, { topics: ['0x1234'] }),
    raw(150, 0, { topics: [T0, T0, T0, T0, T0] }),
    raw(150, 0, { data: '0xzz' }),
    raw(150, 0, { data: '0xabc' }),                       // odd length
    raw(150, 0, { transactionHash: '0x12' }),
    raw(150, 0, { blockNumber: 'ninety' }),
    raw(150, 0, { blockTimestamp: 'soon' }),
    null,
  ];
  for (const r of bad) assert.ok(ix.normalizeLog(r, ctx) instanceof Error, JSON.stringify(r));
});

test('normalizeLog: a log without blockTimestamp is kept, for the indexer to time', () => {
  const r = raw(150);
  delete r.blockTimestamp;
  const l = ix.normalizeLog(r, ctx);
  assert.ok(!(l instanceof Error));
  assert.equal(l.blockTimestamp, undefined);
});

// --- appendLogs ---------------------------------------------------------------------

test('appendLogs: moves forward without holes, sorts, and keeps a log once', () => {
  const index = ix.createIndex({ chainId: 1, fromBlock: 100, addresses: [B, A] });
  assert.equal(index.toBlock, 99);
  assert.deepEqual(index.addresses, [A, B]);
  const l = (b, i) => ix.normalizeLog(raw(b, i), { ...ctx, to: 1000 });
  ix.appendLogs(index, [l(150, 1), l(120, 0), l(150, 0)], 199, 1199);
  assert.deepEqual(index.logs.map((x) => [parseInt(x.blockNumber, 16), parseInt(x.logIndex, 16)]), [[120, 0], [150, 0], [150, 1]]);
  assert.equal(index.toBlock, 199);
  assert.equal(index.toBlockTime, 1199);
  ix.appendLogs(index, [], 299);
  assert.equal(index.toBlock, 299);
  assert.equal(index.toBlockTime, null, 'a time for another block is not carried over');
  assert.throws(() => ix.appendLogs(index, [l(250, 0)], 399), /outside 300 to 399/);
  assert.throws(() => ix.appendLogs(index, [], 200), /back from 299/);
  assert.equal(index.logs.length, 3);
});

// --- resumable ----------------------------------------------------------------------

test('resumable: only an index for the same chain, start block and contracts', () => {
  const cfg = { chainId: 5, fromBlock: 100, addresses: [A, B] };
  const saved = ix.createIndex(cfg);
  assert.equal(ix.resumable(saved, { ...cfg, addresses: [B.toUpperCase().replace('0X', '0x'), A] }), true);
  assert.equal(ix.resumable(saved, { ...cfg, chainId: 6 }), false);
  assert.equal(ix.resumable(saved, { ...cfg, fromBlock: 50 }), false);
  assert.equal(ix.resumable(saved, { ...cfg, addresses: [A] }), false);
  assert.equal(ix.resumable({ ...saved, logs: 'x' }, cfg), false);
  assert.equal(ix.resumable(null, cfg), false);
});

// --- parseQuery and selectLogs ------------------------------------------------------

test('parseQuery: optional filters, each shape-checked', () => {
  const indexed = new Set([A, B]);
  const q = (s) => ix.parseQuery(new URLSearchParams(s), indexed);
  assert.deepEqual(q(''), { address: null, topic0: null, topic1: null, fromBlock: null });
  const full = q(`address=${A.toUpperCase().replace('0X', '0x')}&topic0=${T0},${T1}&topic1=${DID}&fromBlock=150`);
  assert.deepEqual([...full.address], [A]);
  assert.deepEqual([...full.topic0], [T0, T1]);
  assert.equal(full.topic1, DID);
  assert.equal(full.fromBlock, 150);
  for (const bad of [
    `address=${'0x' + 'cc'.repeat(20)}`, 'topic0=0x12', `topic0=${Array(21).fill(T0).join(',')}`,
    `topic1=${T0},${T1}`, 'fromBlock=-1', 'fromBlock=1e3', 'fromBlock=abc',
  ]) assert.ok(q(bad) instanceof Error, bad);
});

test('selectLogs and eventsBody: every filter applies, and the body says the blocks read', () => {
  const index = ix.createIndex({ chainId: 7, fromBlock: 100, addresses: [A, B] });
  const n = (b, over) => ix.normalizeLog(raw(b, 0, over), { ...ctx, to: 1000 });
  ix.appendLogs(index, [n(110), n(120, { address: B }), n(130, { topics: [T1, DID] }), n(140, { topics: [T0, '0x' + 'ee'.repeat(32)] })], 199, 1199);
  const pick = (s) => ix.selectLogs(index, ix.parseQuery(new URLSearchParams(s), new Set([A, B]))).map((l) => parseInt(l.blockNumber, 16));
  assert.deepEqual(pick(''), [110, 120, 130, 140]);
  assert.deepEqual(pick(`address=${B}`), [120]);
  assert.deepEqual(pick(`topic0=${T1}`), [130]);
  assert.deepEqual(pick(`topic1=${DID}`), [110, 120, 130]);
  assert.deepEqual(pick('fromBlock=125'), [130, 140]);
  const body = ix.eventsBody(index, ix.parseQuery(new URLSearchParams(`address=${A}`), new Set([A, B])));
  assert.equal(body.chainId, 7);
  assert.equal(body.fromBlock, 100);
  assert.equal(body.toBlock, 199);
  assert.equal(body.toBlockTime, 1199);
  assert.equal(body.logs.length, 3);
});

// --- redact -------------------------------------------------------------------------

test('redact: the RPC URL, its key and any other URL are cut out', () => {
  const url = 'https://arc-testnet.g.alchemy.com/v2/abcdefghijklmnopqrstu';
  const out = ix.redact(`fetch ${url} failed; key abcdefghijklmnopqrstu; see https://example.com/x`, [url, 'abcdefghijklmnopqrstu']);
  assert.equal(out.includes('abcdefghijklmnopqrstu'), false);
  assert.equal(out.includes('example.com'), false);
  assert.match(out, /<secret>/);
});
