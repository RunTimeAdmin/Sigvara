'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spanRefused, spanTooBig, readSplitting } = require('./log-spans');
const refusals = require('./test-support/refusals');

// ---- what counts as refused for its size ---------------------------------------------------

test('spanRefused: each node\'s own refusal counts', () => {
  for (const name of ['arcTooMany', 'arcTooWide', 'elysium', 'baseSepolia']) {
    assert.equal(spanRefused(refusals[name]()), true, name);
  }
  // As the indexer and the link scan's stub see them, with no ethers around the words.
  for (const words of [
    'eth_getLogs 1000 to 10999: Log response size exceeded. You can make eth_getLogs requests with up to a 2K block range',
    'query returned more than 10000 results',
    'exceed maximum block range: 2000',
    'too many logs',
  ]) {
    assert.equal(spanRefused(new Error(words)), true, words);
  }
});

test('spanRefused: a rate limit is not one, in any of the ways nodes say it', () => {
  // Arc's rate limit and Elysium's log limit share -32005, so the code alone cannot tell them apart.
  assert.equal(refusals.rateLimited().error.code, refusals.elysium().error.code);
  for (const err of [
    refusals.rateLimited(),
    refusals.http429(),
    new Error('429 too many requests'),
    new Error('your rate limit was exceeded for block range queries'),
    new Error('rate limit exceeded, retried until timeout'),
  ]) {
    assert.equal(spanRefused(err), false, err.message);
    assert.equal(spanTooBig(err), false, err.message);
  }
});

test('spanRefused: the request inside an ethers message cannot decide it', () => {
  // This request's id is 429, which would read as a throttle and stop the halving, once in each process.
  const err = refusals.arcTooWide();
  assert.match(err.message, /"id": 429\b/);
  assert.equal(spanRefused(err), true);
  // And the words of a request are not the node's: this one was throttled, whatever it asked for.
  const throttled = refusals.fromEthers(-32005, 'rate limit exceeded');
  throttled.message += ' block range too large';
  assert.equal(spanRefused(throttled), false);
});

test('spanRefused: a refusal naming a block with 429 in it is still a refusal', () => {
  assert.equal(spanRefused(refusals.fromEthers(-32012, 'query exceeds max results 20000, retry with the range 70742912-70750000')), true);
});

test('spanRefused: anything else is not one', () => {
  for (const err of [
    new Error('execution reverted'),
    new Error('connect ECONNREFUSED'),
    new Error('request timeout'),
    new Error('the RPC does not have block 12 yet'),
    undefined,
    null,
  ]) {
    assert.equal(spanRefused(err), false, String(err));
  }
});

test('spanRefused: rpcError\'s answer stands in for words it has dropped', () => {
  assert.equal(spanRefused(Object.assign(new Error('could not coalesce error (rpc -32005)'), { spanRefused: true })), true);
  assert.equal(spanRefused(new Error('could not coalesce error (rpc -32005)')), false);
});

test('spanTooBig: a timeout counts too, and only there', () => {
  const timeout = Object.assign(new Error('request timeout'), { code: 'TIMEOUT' });
  assert.equal(spanRefused(timeout), false);
  assert.equal(spanTooBig(timeout), true);
  assert.equal(spanTooBig(new Error('The operation was aborted due to timeout')), true);
  assert.equal(spanTooBig(refusals.elysium()), true);
  assert.equal(spanTooBig(new Error('connect ECONNREFUSED')), false);
});

// ---- reading around a refusal ---------------------------------------------------------------

/** A node with `perBlock[n]` logs in block n (1 otherwise), which refuses a read of more than `cap`. */
function node(perBlock, cap, refusal = refusals.arcTooMany) {
  const asked = [];
  const read = async (a, b) => {
    asked.push([a, b]);
    const logs = [];
    for (let n = a; n <= b; n += 1) {
      for (let i = 0; i < (perBlock[n] ?? 1); i += 1) logs.push(`${n}.${i}`);
    }
    if (logs.length > cap) throw refusal();
    return logs;
  };
  return { asked, read };
}

test('readSplitting: what is not refused is one read', async () => {
  const { asked, read } = node({}, 100);
  let pauses = 0;
  const logs = await readSplitting(read, 1, 10, { pause: async () => { pauses += 1; } });
  assert.equal(logs.length, 10);
  assert.deepEqual(asked, [[1, 10]]);
  assert.equal(pauses, 0);
});

test('readSplitting: a dense span comes back whole, in block order, with nothing twice', async () => {
  const { asked, read } = node({ 17: 15 }, 20);
  const logs = await readSplitting(read, 1, 64);
  const want = [];
  for (let n = 1; n <= 64; n += 1) {
    for (let i = 0; i < (n === 17 ? 15 : 1); i += 1) want.push(`${n}.${i}`);
  }
  assert.deepEqual(logs, want);
  assert.ok(asked.length > 1);
});

test('readSplitting: halves exactly, with no block left out or read by both sides', async () => {
  const { asked, read } = node({}, 1);
  const logs = await readSplitting(read, 10, 13);
  assert.deepEqual(logs, ['10.0', '11.0', '12.0', '13.0']);
  assert.deepEqual(asked, [[10, 13], [10, 11], [10, 10], [11, 11], [12, 13], [12, 12], [13, 13]]);
});

test('readSplitting: a single block still refused is thrown, as the node said it', async () => {
  const refusal = refusals.elysium();
  const { asked, read } = node({ 3: 30 }, 20, () => refusal);
  await assert.rejects(readSplitting(read, 1, 8), (err) => err === refusal);
  assert.ok(asked.some(([a, b]) => a === 3 && b === 3), 'it got that far');
});

test('readSplitting: any other failure is thrown at once, with no smaller read', async () => {
  for (const refuse of [refusals.rateLimited, refusals.http429, () => new Error('connect ECONNREFUSED')]) {
    const { asked, read } = node({}, 0, refuse);
    await assert.rejects(readSplitting(read, 1, 8));
    assert.deepEqual(asked, [[1, 8]]);
  }
});

test('readSplitting: a timeout is thrown unless the caller says a smaller span may cure it', async () => {
  const timeout = () => Object.assign(new Error('request timeout'), { code: 'TIMEOUT' });
  const once = node({}, 0, timeout);
  await assert.rejects(readSplitting(once.read, 1, 4));
  assert.deepEqual(once.asked, [[1, 4]]);

  const slow = node({}, 1, timeout);
  assert.equal((await readSplitting(slow.read, 1, 4, { tooBig: spanTooBig })).length, 4);
});

test('readSplitting: pauses before each smaller read, at every level', async () => {
  const { read } = node({}, 1);
  let pauses = 0;
  await readSplitting(read, 1, 4, { pause: async () => { pauses += 1; } });
  assert.equal(pauses, 6, 'three reads were refused, each followed by two smaller ones');
});

test('readSplitting: a caller whose reads are not arrays says how to join them', async () => {
  const read = async (a, b) => {
    if (b > a) throw refusals.arcTooWide();
    return { logs: [a], time: a * 10 };
  };
  const join = (l, r) => ({ logs: l.logs.concat(r.logs), time: r.time });
  assert.deepEqual(await readSplitting(read, 1, 3, { join }), { logs: [1, 2, 3], time: 30 });
});
