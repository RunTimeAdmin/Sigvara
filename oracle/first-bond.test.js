'use strict';

// An agent's evidence starts at its first bond, end to end (docs/adr/0013-evidence-starts-at-the-first-bond.md). The
// registry scan's part is tested in chain.test.js and the scans' rules in payment-scan.test.js and
// payment-chains.test.js; this is the epoch, /attest and /health, against a stub chain that says which agents bonded.

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const { World, startOracle, wallet, ASSET } = require('./test-support/oracle-harness');
const { TRANSFER_TOPIC } = require('./payments');

const USDC = 1_000_000n;
const ADMIN = 'a'.repeat(64);
const HEAD = 1_000_000;
const ENV = {
  PAYMENT_VERIFICATION: 'required',
  PAYMENT_ASSET: ASSET,
  PAYMENT_MIN_AMOUNT: '10000',
  PAYMENT_SCAN_ENABLED: '1',
  PAYMENT_SCAN_FROM_BLOCK: String(HEAD - 1000),
  PAYMENT_SCAN_PACE_MS: '0',
  ORACLE_ADMIN_TOKEN: ADMIN,
};
const SUSPENDED = 1;
const PENDING_BOND = 3;

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

/** Set fields the stub reads on one agent. */
function setAgent(world, didHash, fields) {
  Object.assign(world.data.agents[didHash], fields);
  world.flush();
}

const transferLog = (to, block, tag) => ({
  address: ASSET,
  topics: [TRANSFER_TOPIC, ethers.zeroPadValue(wallet(), 32), ethers.zeroPadValue(to, 32)],
  data: ethers.toBeHex(5n * USDC, 32),
  blockNumber: block,
  transactionHash: ethers.id(tag),
  logIndex: 0,
  removed: false,
});

const evidenceCount = async (didHash) => (await oracle.call('GET', `/evidence/${didHash}`)).body.count;

test('an agent that never bonded is neither read nor scanned for, and a credit it already held stays', async () => {
  const world = new World();
  const bonded = world.addRegisteredAgent();
  const never = world.addRegisteredAgent();
  oracle = await startOracle({ world, env: ENV });
  await waitForEpochs(1);

  // Credited while it still read as bonded, as a build before the rule would have.
  const held = world.addTx([{ from: wallet(), to: never.agentAddress, value: 5n * USDC }], { blockNumber: HEAD - 20 });
  const r = await oracle.call('POST', '/attest', { didHash: never.didHash, success: true, payment: { txHash: held } });
  assert.equal(r.status, 200, r.text);

  // The registry scan finds it never bonded. A payment to each agent in the next scan's range.
  setAgent(world, never.didHash, { status: PENDING_BOND, bondedBlock: null });
  world.set('recordEpochReads', true);
  world.set('recordScanRecipients', true);
  world.set('scanLogs', [transferLog(bonded.agentAddress, HEAD + 10, 'to-bonded'), transferLog(never.agentAddress, HEAD + 10, 'to-never')]);
  world.set('head', HEAD + 100);
  await nextEpoch(2);

  const calls = oracle.calls();
  const read = calls.filter((c) => c.name === 'epochRead').map((c) => String(c.args[1]).toLowerCase());
  assert.ok(read.includes(bonded.didHash.toLowerCase()), 'the bonded agent is read');
  assert.ok(!read.includes(never.didHash.toLowerCase()), 'the one that never bonded is not');
  const asked = calls.filter((c) => c.name === 'scanRecipients').flatMap((c) => c.args[0].map((t) => t.toLowerCase()));
  assert.ok(asked.includes(ethers.zeroPadValue(bonded.agentAddress, 32).toLowerCase()), 'the scan asks for the bonded agent');
  assert.ok(!asked.includes(ethers.zeroPadValue(never.agentAddress, 32).toLowerCase()), 'and not for the other');

  assert.equal(await evidenceCount(bonded.didHash), 1, 'the bonded agent is credited from the scan');
  assert.equal(await evidenceCount(never.didHash), 1, 'the other keeps the credit it held, and gains none');
  assert.deepEqual((await oracle.call('GET', '/health')).body.agents, { registered: 2, bonded: 1 });
  assert.match(oracle.logs(), /2 agent\(s\) found, 1 bonded/);
});

test('POST /attest refuses a payment from before the first bond, and waits while the bond is unread', async () => {
  const world = new World();
  const pending = world.addRegisteredAgent();
  const suspended = world.addRegisteredAgent();
  const unread = world.addRegisteredAgent();
  const bondedBlock = HEAD - 100;
  setAgent(world, pending.didHash, { status: PENDING_BOND, bondedBlock: null });
  // Suspended at the payment, so the bond the registry scan recorded decides, not the status there.
  setAgent(world, suspended.didHash, { status: SUSPENDED, bondedBlock });
  // Suspended by its operator without a bond.
  setAgent(world, unread.didHash, { status: SUSPENDED, bondedBlock: null });
  oracle = await startOracle({ world, env: ENV });
  await waitForEpochs(1);
  const attest = (agent, blockNumber) => oracle.call('POST', '/attest', {
    didHash: agent.didHash,
    success: true,
    payment: { txHash: world.addTx([{ from: wallet(), to: agent.agentAddress, value: 5n * USDC }], { blockNumber }) },
  });

  const fromPending = await attest(pending, HEAD - 10);
  assert.equal(fromPending.status, 402, fromPending.text);
  assert.equal(fromPending.body.code, 'before_bond');

  const early = await attest(suspended, bondedBlock - 1);
  assert.equal(early.status, 402, early.text);
  assert.equal(early.body.code, 'before_bond');
  assert.equal(await evidenceCount(suspended.didHash), 0);
  const sameBlock = await attest(suspended, bondedBlock);
  assert.equal(sameBlock.status, 200, sameBlock.text);
  assert.equal(await evidenceCount(suspended.didHash), 1, 'the bond\'s own block counts');

  world.set('bondsReadTo', HEAD - 11);
  const waiting = await attest(unread, HEAD - 10);
  assert.equal(waiting.status, 503, waiting.text);
  assert.equal(waiting.body.code, 'bond_not_seen');
  world.set('bondsReadTo', HEAD - 10);
  const refused = await attest(unread, HEAD - 10);
  assert.equal(refused.status, 402, refused.text);
  assert.equal(refused.body.code, 'before_bond');
  assert.equal(await evidenceCount(unread.didHash), 0);
});
