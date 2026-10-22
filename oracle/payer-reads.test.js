'use strict';

// What an epoch does when the node cannot answer for one of an agent's payers. A counterparty's standing
// feeds the per-payer cap and the propagation factor, so a payer read as "no standing" because the read
// was throttled lowers the score the primary proposes, and a checker whose own read succeeded then
// records a divergence against an honest primary. The agent is skipped for the epoch instead, and
// scored at the next one. That a throttled read is retried, and then rejects and is not read as zero, is
// tested in chain.test.js; this is the loop around it, which has to treat a rejection as one agent's
// failure and not the epoch's.

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { World, startOracle, wallet, ASSET } = require('./test-support/oracle-harness');

const USDC = 1_000_000n;
const ADMIN = 'a'.repeat(64);
const ENV = {
  PAYMENT_VERIFICATION: 'required',
  PAYMENT_ASSET: ASSET,
  PAYMENT_MIN_AMOUNT: '10000',
  ORACLE_ADMIN_TOKEN: ADMIN,
};

let oracle;
afterEach(async () => {
  if (oracle) await oracle.stop();
  oracle = null;
});

const count = (text, re) => (text.match(re) || []).length;
const proposals = () => oracle.calls().filter((c) => c.name === 'proposeScore').length;

async function waitForEpochs(n) {
  const deadline = Date.now() + 20_000;
  while (count(oracle.logs(), /\[oracle\] epoch done/g) < n) {
    if (Date.now() > deadline) throw new Error(`fewer than ${n} epochs finished:\n${oracle.logs()}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function runEpoch(n) {
  const r = await oracle.call('POST', '/epoch', undefined, ADMIN);
  assert.equal(r.status, 202, r.text);
  await waitForEpochs(n);
}

test('an agent whose payer the node could not read is skipped for the epoch, and scored at the next', async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  oracle = await startOracle({ world, env: ENV });
  await waitForEpochs(1);
  assert.equal(proposals(), 1, 'the first epoch proposed: no payments, so no payer to read');

  const payer = wallet();
  const tx = world.addTx([{ from: payer, to: agent.agentAddress, value: 5n * USDC }]);
  const r = await oracle.call('POST', '/attest', { didHash: agent.didHash, success: true, payment: { txHash: tx } });
  assert.equal(r.status, 200, r.text);

  world.set('standingFails', { [payer.toLowerCase()]: true });
  await runEpoch(2);
  assert.equal(proposals(), 1, 'nothing was proposed on a number built on a read that failed');
  assert.match(oracle.logs(), /429 too many requests/, 'and the failure is logged');

  world.set('standingFails', {});
  await runEpoch(3);
  assert.equal(proposals(), 2, 'the next epoch scored the agent');
});
