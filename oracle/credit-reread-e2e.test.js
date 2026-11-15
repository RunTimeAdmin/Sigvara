'use strict';

// A credit read again once its block is final, end to end (docs/adr/0012-a-credit-a-reorganization-removed.md). The
// pieces are tested on their own in credit-reread.test.js; this is the epoch, the state file, /evidence, /health and
// /attest, against a stub chain that replaces a block after the oracle credited a payment in it.

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { World, startOracle, wallet, ASSET } = require('./test-support/oracle-harness');

const USDC = 1_000_000n;
const ADMIN = 'a'.repeat(64);
const HEAD = 1_000_000;
const ENV = {
  PAYMENT_VERIFICATION: 'required',
  PAYMENT_ASSET: ASSET,
  PAYMENT_MIN_AMOUNT: '10000',
  PAYMENT_SCAN_PACE_MS: '0',
  ORACLE_ADMIN_TOKEN: ADMIN,
};

let oracle;
afterEach(async () => {
  if (oracle) await oracle.stop();
  oracle = null;
});

const count = (text, re) => (text.match(re) || []).length;

async function waitForEpochs(n) {
  const deadline = Date.now() + 20_000;
  while (count(oracle.logs(), /\[oracle\] epoch done/g) < n) {
    if (Date.now() > deadline) throw new Error(`fewer than ${n} epochs finished:\n${oracle.logs()}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function nextEpoch(n) {
  const r = await oracle.call('POST', '/epoch', undefined, ADMIN);
  assert.equal(r.status, 202, r.text);
  await waitForEpochs(n);
}

const saved = () => JSON.parse(oracle.files()['state.json']);

test('a credit whose transaction is gone once final is removed: left out, listed, counted, and never credited again', async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  oracle = await startOracle({ world, env: ENV });
  await waitForEpochs(1);

  const stays = world.addTx([{ from: wallet(), to: agent.agentAddress, value: 5n * USDC }], { blockNumber: HEAD - 10 });
  const goes = world.addTx([{ from: wallet(), to: agent.agentAddress, value: 7n * USDC }], { blockNumber: HEAD - 9 });
  for (const tx of [stays, goes]) {
    const r = await oracle.call('POST', '/attest', { didHash: agent.didHash, success: true, payment: { txHash: tx } });
    assert.equal(r.status, 200, r.text);
  }

  // The chain replaces the second payment's block: no receipt for it, and the block no longer lists it.
  const receipt = world.data.receipts[goes];
  delete world.data.receipts[goes];
  world.set('blockTxs', { [HEAD - 9]: [] });
  await nextEpoch(2);

  assert.match(oracle.logs(), new RegExp(`REMOVED credit ${goes} .*: not_in_block`));
  const events = saved().paymentEvents[agent.didHash.toLowerCase()];
  const byTx = Object.fromEntries(events.map((e) => [e.txHash, e]));
  assert.equal(byTx[stays].rereadBlock, HEAD, 'the one that stays is marked read, so it is not read again');
  assert.equal(byTx[stays].removedAt, undefined);
  assert.ok(Number.isSafeInteger(byTx[goes].removedAt), 'the one that went is dated by the finalized block it was read against');
  assert.equal(byTx[goes].removedWhy, 'not_in_block');
  assert.equal(saved().schemaVersion, 6, 'a build from before this would count it, so it must refuse the file');

  const evidence = JSON.parse((await oracle.call('GET', `/evidence/${agent.didHash}`)).text);
  assert.deepEqual(evidence.evidence.map((e) => e.txHash), [stays], 'out of the evidence');
  assert.deepEqual(evidence.removed.map((e) => [e.txHash, e.reason, e.blockNumber]), [[goes, 'not_in_block', HEAD - 9]]);
  assert.equal(JSON.parse((await oracle.call('GET', '/health')).text).creditsRemoved, 1);
  assert.match((await oracle.call('GET', '/metrics')).text, /sigvara_oracle_credits_removed_total 1/);

  // Put back in a later block, it is still the same transaction, and its hash stays used.
  world.data.receipts[goes] = { ...receipt, blockNumber: HEAD - 2 };
  world.flush();
  const again = await oracle.call('POST', '/attest', { didHash: agent.didHash, success: true, payment: { txHash: goes } });
  assert.notEqual(again.status, 200, again.text);
  assert.equal(saved().paymentEvents[agent.didHash.toLowerCase()].length, 2, 'not credited a second time');

  // Nothing is read twice: the next epoch has no credit left to read.
  await nextEpoch(3);
  assert.equal(count(oracle.logs(), /REMOVED credit/g), 1);
});

test('a payment whose block is not final yet is not credited, and the carrier is told to send it again', async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  world.set('finalized', HEAD - 20);
  oracle = await startOracle({ world, env: ENV });
  const tx = world.addTx([{ from: wallet(), to: agent.agentAddress, value: 5n * USDC }], { blockNumber: HEAD - 10 });

  const early = await oracle.call('POST', '/attest', { didHash: agent.didHash, success: true, payment: { txHash: tx } });
  assert.equal(early.status, 503, early.text);
  assert.equal(JSON.parse(early.text).code, 'unconfirmed');

  world.set('finalized', HEAD - 10);
  const final = await oracle.call('POST', '/attest', { didHash: agent.didHash, success: true, payment: { txHash: tx } });
  assert.equal(final.status, 200, final.text);
});
