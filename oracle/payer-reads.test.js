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

// ---- how fast the standing of many payers is asked for ------------------------------------

/** An agent paid by `n` different wallets in one transaction, each leg a payment, on a running oracle. */
async function paidByMany(n) {
  const world = new World();
  const agent = world.addAgent();
  const payers = Array.from({ length: n }, () => wallet());
  const tx = world.addTx(payers.map((from) => ({ from, to: agent.agentAddress, value: 5n * USDC })));
  world.set('standingReadMs', 20);
  oracle = await startOracle({ world, env: ENV });
  const r = await oracle.call('POST', '/attest', { didHash: agent.didHash, success: true, payment: { txHash: tx } }, ADMIN);
  assert.equal(r.status, 200, r.text);
  return { world, agent, payers };
}
const standingReads = () => oracle.calls().filter((c) => c.name === 'standingRead').map((c) => c.args[0]);

test('payers are asked about a few at a time: a node takes only so many reads in one batch', async () => {
  // All at once, a same-tick burst of more than about 80 went past what the backoff could catch up with
  // on Arc's public RPC, and the agent went unscored for having customers.
  const { agent } = await paidByMany(25);
  const started = Date.now();
  const r = await oracle.call('GET', `/score/${agent.didHash}`);
  assert.equal(r.status, 200, r.text);
  const reads = standingReads();
  assert.equal(reads.length, 25, 'each of them, once');
  assert.ok(Math.max(...reads) <= 10, `at most ten at once, not ${Math.max(...reads)}`);
  assert.ok(Math.max(...reads) > 1, 'and still together, since one at a time costs a round trip each');
  // A floor, which a busy machine can only make longer: three chunks, two waits between them.
  assert.ok(Date.now() - started >= 3_000, 'with a wait between chunks, since the node also has a budget');
});

test('a node that cannot answer is not asked for the rest, and what it did answer is kept', async () => {
  const { world, agent, payers } = await paidByMany(25);
  const failing = (list) => Object.fromEntries(list.map((p) => [p.toLowerCase(), true]));

  // None of them can be read: it stops after the first chunk.
  world.set('standingFails', failing(payers));
  const none = await oracle.call('GET', `/score/${agent.didHash}`);
  assert.equal(none.status, 502, none.text);
  assert.equal(none.body.code, 'rpc_error');
  assert.equal(standingReads().length, 10);

  // One of them cannot: evidence is not held in the order paid, so which chunk it falls in varies.
  world.set('standingFails', failing([payers[0]]));
  assert.equal((await oracle.call('GET', `/score/${agent.didHash}`)).status, 502);
  const before = standingReads().length - 10;
  assert.ok(before % 10 === 0 || before === 25, `stopped at the end of a chunk, after ${before}`);

  // Now it can: everything read so far is kept, so only that one and those not reached are asked for.
  world.set('standingFails', {});
  const ok = await oracle.call('GET', `/score/${agent.didHash}`);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(standingReads().length - 10 - before, 25 - (before - 1));
});
