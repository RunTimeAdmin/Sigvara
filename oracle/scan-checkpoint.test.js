'use strict';

// The payment scan's checkpoint, end to end. checkpointAfter is tested on its own in
// payment-scan.test.js; this is the call site, that index.js hands it the canary's verdict. A scan that
// finds nothing is only believed once its own query has found a settlement already held, and when that
// probe fails the range has to be scanned again at the next epoch. The log line says so ("unverified,
// not quiet") and so did the comment above runPaymentScan, but the checkpoint moved on regardless, and
// a payment in that range was never looked for again.

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { World, startOracle, wallet, ASSET } = require('./test-support/oracle-harness');
const { TRANSFER_TOPIC } = require('./payments');

const USDC = 1_000_000n;
const ADMIN = 'a'.repeat(64);
const HEAD = 1_000_000;
const CONFIRMATIONS = 6; // the floor
const ENV = {
  PAYMENT_VERIFICATION: 'required',
  PAYMENT_ASSET: ASSET,
  PAYMENT_MIN_AMOUNT: '10000',
  PAYMENT_SCAN_ENABLED: '1',
  PAYMENT_SCAN_FROM_BLOCK: String(HEAD - 1000),
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

const savedCheckpoint = () => JSON.parse(oracle.files()['state.json']).paymentScanState?.lastBlock;

/**
 * Start an oracle that has already scanned up to the head, then give it a payment it holds and move
 * the head on, so the next scan covers a new range and has a settlement for its canary to find.
 */
async function startWithAHeldPayment(world) {
  const agent = world.addRegisteredAgent();
  oracle = await startOracle({ world, env: ENV });
  await waitForEpochs(1); // nothing held yet, so the canary has nothing to point at and the scan advances
  assert.equal(savedCheckpoint(), HEAD - CONFIRMATIONS, 'the first scan checkpointed at the safe head');

  const tx = world.addTx([{ from: wallet(), to: agent.agentAddress, value: 5n * USDC }]);
  const r = await oracle.call('POST', '/attest', { didHash: agent.didHash, success: true, payment: { txHash: tx } });
  assert.equal(r.status, 200, r.text);

  world.set('head', HEAD + 100);
  return { agent, tx };
}

test('a failed canary leaves the checkpoint where it was, so the range is scanned again', async () => {
  const world = new World();
  await startWithAHeldPayment(world); // the world holds no logs: the scan's query finds nothing, canary included

  const r = await oracle.call('POST', '/epoch', undefined, ADMIN);
  assert.equal(r.status, 202, r.text); // accepted: it runs in the background
  await waitForEpochs(2);

  assert.match(oracle.logs(), /payment scan canary FAILED/, 'the failure is said out loud');
  assert.match(oracle.logs(), /canary failed/, 'and in the scan summary');
  assert.equal(savedCheckpoint(), HEAD - CONFIRMATIONS, 'held: the whole new range is retried next epoch');
});

test('a canary that passes lets the checkpoint advance', async () => {
  const world = new World();
  const { tx } = await startWithAHeldPayment(world);
  world.set('canaryLogs', [{ transactionHash: tx }]); // the probe finds the settlement it points at

  const r = await oracle.call('POST', '/epoch', undefined, ADMIN);
  assert.equal(r.status, 202, r.text); // accepted: it runs in the background
  await waitForEpochs(2);

  assert.match(oracle.logs(), /canary passed/);
  assert.equal(savedCheckpoint(), HEAD + 100 - CONFIRMATIONS, 'the empty range was proved empty and is done');
});

test('a payment made before the agent registered is skipped, and the scan goes on past it', async () => {
  const world = new World();
  const registeredBlock = HEAD - 500;
  const agent = world.addRegisteredAgent({ registeredBlock });
  const payer = wallet();
  const log = (block) => ({
    address: ASSET,
    topics: [TRANSFER_TOPIC, ethers.zeroPadValue(payer, 32), ethers.zeroPadValue(agent.agentAddress, 32)],
    data: ethers.toBeHex(5n * USDC, 32),
    blockNumber: block,
    transactionHash: ethers.id(`pay-${block}`),
    logIndex: 0,
    removed: false,
  });
  world.set('scanLogs', [log(registeredBlock - 1), log(registeredBlock), log(registeredBlock + 1)]);
  oracle = await startOracle({ world, env: ENV });
  await waitForEpochs(1);
  assert.match(oracle.logs(), /payment scan \d+-\d+: 2 credited, 1 skipped .*"before_registration":1/);
  assert.equal(savedCheckpoint(), HEAD - CONFIRMATIONS);
  const evidence = await oracle.call('GET', `/evidence/${agent.didHash}`);
  assert.deepEqual(
    evidence.body.evidence.map((e) => e.txHash).sort(),
    [ethers.id(`pay-${registeredBlock}`), ethers.id(`pay-${registeredBlock + 1}`)].sort(),
  );
});
