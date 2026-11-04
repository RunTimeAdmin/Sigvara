'use strict';

// The explorer pages read the chain through Multicall3 (ethCalls in site/assets/explorer.js), with
// the encoding written by hand because the site has no ABI library. These tests hold that encoding
// to ethers' answers, and hold ethCalls to what its callers got before it: answers in the order
// asked, and the RPC's own error when a read reverts.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const explorer = require('../site/assets/explorer.js');

const { MULTICALL3, aggregate3Call, aggregate3Answers, ethCalls } = explorer;
const iface = new ethers.Interface([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[] returnData)',
]);
const HASH = `0x${'ab'.repeat(32)}`;
const read = (i) => ({ to: explorer.REPUTATION, data: explorer.SEL.getTotalScore + explorer.pad32(i.toString(16)) });
// What the stub chain answers a read with: its data, read back as a number and doubled.
const answerTo = (data) => ethers.toBeHex(BigInt(`0x${data.slice(10)}`) * 2n, 32);

// Answers the JSON-RPC requests ethCalls sends, and records each request's batch. `multicall` says
// how to answer a call to Multicall3, and `direct` how to answer any other call.
function stubRpc(t, { multicall, direct = (req) => ({ result: answerTo(req.params[0].data) }) }) {
  const sent = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const batch = JSON.parse(init.body);
    sent.push(batch);
    const reply = batch.map((req) => ({
      jsonrpc: '2.0',
      id: req.id,
      ...(req.params[0].to === MULTICALL3 ? multicall(req) : direct(req)),
    }));
    return { status: 200, ok: true, json: async () => reply };
  });
  return sent;
}
const subCalls = (req) => iface.decodeFunctionData('aggregate3', req.params[0].data)[0];
// A Multicall3 that makes each read, as the chain would.
const working = (req) => ({
  result: iface.encodeFunctionResult('aggregate3', [subCalls(req).map((c) => [true, answerTo(c.callData)])]),
});

test('aggregate3Call matches what an ABI library encodes', () => {
  const sets = [
    [{ to: explorer.ORACLE_BOND, data: explorer.SEL.bondAmount }],
    [read(1), read(2), read(3)],
    // A selector alone, a selector and a word, and a call with a dynamic proof, so every length of
    // padding and every offset is different.
    [
      { to: explorer.ORACLE_BOND, data: explorer.SEL.slashBeneficiary },
      read(7),
      { to: explorer.REPUTATION, data: explorer.verifyEvidenceCall(HASH, HASH, [HASH, HASH, HASH]) },
      { to: explorer.REPUTATION, data: explorer.verifyEvidenceCall(HASH, HASH, []) },
    ],
  ];
  for (const set of sets) {
    assert.equal(
      aggregate3Call(set),
      iface.encodeFunctionData('aggregate3', [set.map((c) => [c.to, true, c.data])]),
    );
  }
});

test('aggregate3Answers reads what an ABI library encodes, and a revert as null', () => {
  const results = [
    [true, HASH],
    [false, '0x'],
    [true, '0x'],
    [true, `0x${'cd'.repeat(32 * 11)}`],
    [true, '0x12'],
    [false, '0x08c379a0'],
  ];
  assert.deepEqual(
    aggregate3Answers(iface.encodeFunctionResult('aggregate3', [results]), results.length),
    [HASH, null, '0x', `0x${'cd'.repeat(32 * 11)}`, '0x12', null],
  );
});

test('aggregate3Answers refuses what does not parse', () => {
  const good = iface.encodeFunctionResult('aggregate3', [[[true, HASH], [true, HASH]]]);
  const word = (n) => n.toString(16).padStart(64, '0');
  for (const [name, answer, count] of [
    ['no code at the address', '0x', 2],
    ['fewer results than reads', good, 3],
    ['more results than reads', good, 1],
    ['cut short', good.slice(0, good.length - 64), 2],
    ['not hex', `${good.slice(0, 66)}zz${good.slice(68)}`, 2],
    ['an offset past the end', `0x${word(0x20)}${word(1)}${word(0xffff)}`, 1],
    ['an offset too large to hold', `0x${'ff'.repeat(32)}`, 1],
    ['a length past the end', `0x${word(0x20)}${word(1)}${word(0x20)}${word(1)}${word(0x40)}${word(0xffff)}`, 1],
  ]) {
    assert.throws(() => aggregate3Answers(answer, count), /multicall answer/, name);
  }
});

test('two or more reads are one request, answered in the order asked', async (t) => {
  const sent = stubRpc(t, { multicall: working });
  const calls = [1, 2, 3, 4, 5].map(read);
  assert.deepEqual(await ethCalls(calls), calls.map((c) => answerTo(c.data)));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].length, 1);
  assert.equal(sent[0][0].params[0].to, MULTICALL3);
  assert.equal(sent[0][0].params[1], 'latest');
});

test('one read goes to its contract directly', async (t) => {
  const sent = stubRpc(t, { multicall: () => assert.fail('nothing to bundle') });
  assert.deepEqual(await ethCalls([read(9)]), [answerTo(read(9).data)]);
  assert.equal(sent[0][0].params[0].to, explorer.REPUTATION);
});

test('no reads ask for nothing', async (t) => {
  const sent = stubRpc(t, { multicall: () => assert.fail('nothing to bundle') });
  assert.deepEqual(await ethCalls([]), []);
  assert.equal(sent.length, 0);
});

test('a set too large for one call is split, and stays in order', async (t) => {
  const sent = stubRpc(t, { multicall: working, direct: () => assert.fail('no read should go directly') });
  const calls = Array.from({ length: 1201 }, (_, i) => read(i + 1));
  assert.deepEqual(await ethCalls(calls), calls.map((c) => answerTo(c.data)));
  assert.deepEqual(sent.map((batch) => batch.map((req) => subCalls(req).length)), [[500], [500], [201]]);
});

for (const [name, multicall] of [
  ['refused', () => ({ error: { code: 3, message: 'out of gas: gas required exceeds: 30000000' } })],
  ['answered with something that does not parse', () => ({ result: '0x' })],
]) {
  test(`a Multicall3 read that is ${name} goes directly`, async (t) => {
    const sent = stubRpc(t, { multicall });
    const calls = [1, 2, 3].map(read);
    assert.deepEqual(await ethCalls(calls), calls.map((c) => answerTo(c.data)));
    assert.deepEqual(sent[1].map((req) => req.params[0].to), calls.map(() => explorer.REPUTATION));
  });
}

test('a read that reverts brings the RPC its own error, as it did before', async (t) => {
  const calls = [1, 2, 3].map(read);
  stubRpc(t, {
    multicall: (req) => ({
      result: iface.encodeFunctionResult('aggregate3', [subCalls(req).map((c, i) => [i !== 1, i === 1 ? '0x' : answerTo(c.callData)])]),
    }),
    direct: (req) => (req.params[0].data === calls[1].data
      ? { error: { code: 3, message: 'execution reverted' } }
      : { result: answerTo(req.params[0].data) }),
  });
  await assert.rejects(ethCalls(calls), /execution reverted/);
});

test('a read of an address with no code answers 0x, as it did before', async (t) => {
  stubRpc(t, {
    multicall: (req) => ({ result: iface.encodeFunctionResult('aggregate3', [subCalls(req).map(() => [true, '0x'])]) }),
    direct: () => assert.fail('no read should go directly'),
  });
  assert.deepEqual(await ethCalls([read(1), read(2)]), ['0x', '0x']);
});

test('a Multicall3 read the RPC limits is asked again, not sent directly', async (t) => {
  let asked = 0;
  stubRpc(t, {
    multicall: (req) => (++asked === 1 ? { error: { code: -32005, message: 'rate limit exceeded' } } : working(req)),
    direct: () => assert.fail('no read should go directly'),
  });
  const calls = [read(1), read(2)];
  assert.deepEqual(await ethCalls(calls), calls.map((c) => answerTo(c.data)));
  assert.equal(asked, 2);
});
