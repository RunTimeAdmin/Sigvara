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

test('normalizeLog: a log without blockTimestamp, or with null, is kept for the indexer to time', () => {
  const r = raw(150);
  delete r.blockTimestamp;
  for (const x of [r, raw(150, 0, { blockTimestamp: null })]) {
    const l = ix.normalizeLog(x, ctx);
    assert.ok(!(l instanceof Error));
    assert.equal(l.blockTimestamp, undefined);
  }
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
  assert.deepEqual(q(''), { address: null, topic0: null, topic1: null, fromBlock: null, limit: ix.PAGE_ROWS, after: null });
  assert.equal(q('limit=1').limit, 1);
  assert.equal(q(`limit=${ix.PAGE_ROWS}`).limit, ix.PAGE_ROWS);
  assert.deepEqual(q('after=150-3').after, [150, 3]);
  const full = q(`address=${A.toUpperCase().replace('0X', '0x')}&topic0=${T0},${T1}&topic1=${DID}&fromBlock=150`);
  assert.deepEqual([...full.address], [A]);
  assert.deepEqual([...full.topic0], [T0, T1]);
  assert.equal(full.topic1, DID);
  assert.equal(full.fromBlock, 150);
  for (const bad of [
    `address=${'0x' + 'cc'.repeat(20)}`, 'topic0=0x12', `topic0=${Array(21).fill(T0).join(',')}`,
    `topic1=${T0},${T1}`, 'fromBlock=-1', 'fromBlock=1e3', 'fromBlock=abc',
    'limit=0', `limit=${ix.PAGE_ROWS + 1}`, 'limit=1.5', 'limit=-1', 'after=150', 'after=0x96-3', 'after=150-3-1', 'after=',
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
  assert.equal(body.next, null);
});

test('eventsBody: a long answer comes a page at a time, by rows or by bytes, and the pages join up', () => {
  const index = ix.createIndex({ chainId: 7, fromBlock: 100, addresses: [A, B] });
  const n = (b, i, over) => ix.normalizeLog(raw(b, i, over), { ...ctx, to: 1000 });
  // Two logs share block 120, so a cursor must tell them apart by log index.
  ix.appendLogs(index, [n(110, 0), n(120, 0), n(120, 1, { address: B }), n(130, 0), n(140, 2), n(150, 0, { address: B })], 199, 1199);
  const indexed = new Set([A, B]);
  const all = ix.eventsBody(index, ix.parseQuery(new URLSearchParams(''), indexed)).logs;
  assert.equal(all.length, 6);

  // Reads every page of `params`, each answer at most `maxBytes`, and returns the pages.
  const pages = (params, maxBytes) => {
    const out = [];
    for (let after = null; ;) {
      const p = new URLSearchParams(params);
      if (after) p.set('after', after);
      const body = ix.eventsBody(index, ix.parseQuery(p, indexed), maxBytes);
      out.push(body);
      if (body.next === null) return out;
      assert.ok(out.length < 10, 'the pages end');
      after = body.next;
    }
  };
  const byRows = pages('limit=2');
  assert.deepEqual(byRows.map((b) => b.logs.length), [2, 2, 2]);
  assert.deepEqual(byRows.map((b) => b.next), ['120-0', '130-0', null]);
  assert.deepEqual(byRows.flatMap((b) => b.logs), all);

  // A byte cap that fits two logs splits the same way; one smaller than a log still gives one.
  const size = JSON.stringify(all[0]).length + 1;
  assert.deepEqual(pages('', size * 2).flatMap((b) => b.logs), all);
  assert.deepEqual(pages('', size * 2).map((b) => b.logs.length), [2, 2, 2]);
  assert.deepEqual(pages('', 10).map((b) => b.logs.length), [1, 1, 1, 1, 1, 1]);

  // Filters hold across pages: B's logs, one at a time.
  const bOnly = pages(`address=${B}&limit=1`);
  assert.deepEqual(bOnly.flatMap((b) => b.logs).map((l) => [parseInt(l.blockNumber, 16), l.address]), [[120, B], [150, B]]);
  // A cursor past the end answers no logs and no next.
  assert.deepEqual(ix.eventsBody(index, ix.parseQuery(new URLSearchParams('after=150-0'), indexed)).logs, []);
  // The default answer holds the whole of a short history.
  assert.equal(ix.eventsBody(index, ix.parseQuery(new URLSearchParams(''), indexed)).next, null);
});

// --- redact -------------------------------------------------------------------------

test('redact: the RPC URL, its key and any other URL are cut out', () => {
  const url = 'https://arc-testnet.g.alchemy.com/v2/abcdefghijklmnopqrstu';
  const out = ix.redact(`fetch ${url} failed; key abcdefghijklmnopqrstu; see https://example.com/x`, [url, 'abcdefghijklmnopqrstu']);
  assert.equal(out, 'fetch <secret> failed; key <secret>; see <url>');
});
