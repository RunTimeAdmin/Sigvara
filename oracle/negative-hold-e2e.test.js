'use strict';
// A payer's held "not delivered" (ADR 0011) end to end: the real oracle process against the stubbed chain, with
// negatives seeded in its state file or posted to it. negative-hold.test.js tests the module on its own.
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const payerOutcome = require('./payer-outcome');
const { World, startOracle, wallet, ASSET } = require('./test-support/oracle-harness');

const DAY = 86_400_000;
const HOLD = 7 * DAY;
const MARGIN = 3_600_000;
const USDC = 1_000_000n;
const ADMIN = 'a'.repeat(64);
const CHAIN_ID = 5042;
// The harness's REPUTATION_ADDRESS.
const REPUTATION = `0x${'33'.repeat(20)}`;
const ENV = {
  PAYMENT_VERIFICATION: 'required',
  PAYMENT_ASSET: ASSET,
  PAYMENT_MIN_AMOUNT: '10000',
  ORACLE_ADMIN_TOKEN: ADMIN,
  EXPECTED_CHAIN_ID: String(CHAIN_ID),
  PAYER_OUTCOMES: 'both',
  PAYER_OUTCOMES_PUBLISH: 'on',
};

let oracles = [];
afterEach(async () => {
  for (const o of oracles) await o.stop();
  oracles = [];
});

async function start(world, { env = {}, events } = {}) {
  const files = events ? { 'state.json': JSON.stringify({ schemaVersion: 2, paymentEvents: events }) } : undefined;
  const o = await startOracle({ world, env: { ...ENV, ...env }, files });
  oracles.push(o);
  return o;
}

const count = (text, re) => (text.match(new RegExp(re.source, 'g')) || []).length;
async function waitFor(o, re, n = 1) {
  const deadline = Date.now() + 20_000;
  while (count(o.logs(), re) < n) {
    if (Date.now() > deadline) throw new Error(`never logged ${re} ${n} times:\n${o.logs()}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}
const evidence = async (o, didHash) => (await o.call('GET', `/evidence/${didHash}`)).body.evidence;
const metric = async (o, name) => Number(((await o.call('GET', '/metrics')).text.match(new RegExp(`^${name} (\\d+)$`, 'm')) || [])[1]);
const proposedFor = (o, didHash) => o.calls().filter((c) => c.name === 'proposeScore' && c.args[0] === didHash).length;
const settledNotRefunded = (readThroughBlock) => ({ final: true, refunded: false, readThroughBlock });

/**
 * A payment whose payer signed "not delivered", as the store holds it. Its hold starts at `checkedAtMs`, and
 * `refundCheck` says how far its refunds have been read. The signature is never checked once stored.
 */
function negative(world, { checkedAtMs, signedAt, checkedAtBlock = world.data.head - 100, refundCheck, chainId, blockNumber = world.data.head - 200 } = {}) {
  const signed = signedAt ?? Math.floor(checkedAtMs / 1000) - 60;
  return {
    txHash: ethers.id(`negative-${Math.random()}`),
    payer: wallet(),
    amount: String(5n * USDC),
    ts: (signed - 60) * 1000,
    blockNumber,
    success: false,
    ...(chainId ? { chainId } : {}),
    payerOutcome: {
      outcome: payerOutcome.NOT_DELIVERED,
      evidence: ethers.ZeroHash,
      signedAt: signed,
      deadline: signed + 86_400,
      signature: `0x${'11'.repeat(65)}`,
      signer: 'eoa',
      checkedAtBlock,
      ...(checkedAtMs === undefined ? {} : { checkedAtMs }),
      acceptedAt: Date.now() - 1000,
    },
    ...(refundCheck ? { refundCheck } : {}),
  };
}

test('a negative on a payment chain this operator no longer reads does not hold its agent', async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  // Due a day ago, on Base, which this operator no longer reads, so its refunds are never read.
  const onBase = negative(world, { checkedAtMs: world.data.nowSec * 1000 - HOLD - MARGIN - DAY, chainId: 84532 });
  const o = await start(world, { events: { [agent.didHash]: [onBase] } });
  await waitFor(o, /\[oracle\] epoch done/);
  assert.doesNotMatch(o.logs(), /a payer negative is due/);
  assert.equal(proposedFor(o, agent.didHash), 1, 'scored, on the evidence it has');
});

test("a negative recorded without its block's time is dated from that block, as an importing operator dates it", async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  const checkedAtBlock = world.data.head - 100;
  const checkedSec = world.data.nowSec - 10 * 86_400;
  world.set('blockTimes', { [checkedAtBlock]: checkedSec });
  const undated = negative(world, { checkedAtBlock, signedAt: checkedSec - 60, blockNumber: checkedAtBlock - 50 });
  // The refund read finds the payment itself, so its empty reads are believed.
  world.set('canaryLogs', [{ transactionHash: undated.txHash }]);
  const o = await start(world, { events: { [agent.didHash]: [undated] } });
  await waitFor(o, /\[oracle\] epoch done/);
  const [e] = await evidence(o, agent.didHash);
  assert.equal(e.payerNegative.countsFrom, new Date(checkedSec * 1000 + HOLD + MARGIN).toISOString(), 'held from that block');
  assert.equal(e.payerNegative.settled, true);
  assert.equal(e.success, false, 'read, not refunded, and past its hold, so it counts');
  const saved = JSON.parse(o.files()['state.json']).paymentEvents[agent.didHash][0];
  assert.equal(saved.payerOutcome.checkedAtMs, checkedSec * 1000, 'kept, so it is dated once');
});

test('a primary does not propose while a negative starts to count before its proposal could land', async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  // Read and not refunded, and counting two minutes after this epoch's evidence time: the checker reads the evidence
  // at the proposal's own time, a little later, and would count it.
  const countsFrom = world.data.nowSec * 1000 + 120_000;
  const soon = negative(world, { checkedAtMs: countsFrom - MARGIN - HOLD, refundCheck: settledNotRefunded(world.data.head - 6) });
  const o = await start(world, { events: { [agent.didHash]: [soon] } });
  await waitFor(o, /\[oracle\] epoch done/);
  assert.match(o.logs(), /a payer negative starts to count before a proposal could land, skipping/);
  assert.equal(proposedFor(o, agent.didHash), 0);
});

/** An agent whose negative is due, and whose refunds this node cannot read past the hold: its newest blocks are too old. */
function dueAndUnread(world) {
  const agent = world.addRegisteredAgent();
  const checkedAtMs = world.data.nowSec * 1000 - HOLD - MARGIN - DAY;
  const stale = Math.floor(checkedAtMs / 1000) + 86_400;
  world.set('blockTimes', Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((k) => [world.data.head - k, stale])));
  return { agent, events: { [agent.didHash]: [negative(world, { checkedAtMs })] } };
}

test('an agent held for a negative whose refunds are not read is not counted as a scan that fell behind', async () => {
  const world = new World();
  world.addRegisteredAgent();
  const { agent, events } = dueAndUnread(world);
  const o = await start(world, { events });
  await waitFor(o, /\[oracle\] epoch done/);
  assert.match(o.logs(), /a payer negative is due and its refunds are not read yet, skipping/);
  assert.doesNotMatch(o.logs(), /scans fell behind/);
  assert.equal(await metric(o, 'sigvara_oracle_epochs_held_by_payment_chain_total'), 0, 'not a scan that fell behind');
  assert.equal(await metric(o, 'sigvara_oracle_agents_held_by_payer_negative_total'), 1);
  assert.equal(proposedFor(o, agent.didHash), 0);
});

test('an epoch that holds every agent it would have scored counts as failed', async () => {
  const world = new World();
  const { events } = dueAndUnread(world);
  const o = await start(world, { events });
  await waitFor(o, /\[oracle\] epoch done/);
  const text = (await o.call('GET', '/metrics')).text;
  assert.match(text, /sigvara_oracle_epochs_total\{status="succeeded"\} 0/);
  assert.match(text, /sigvara_oracle_epochs_total\{status="failed"\} 1/);
});

test("/evidence presents a negative at the chain's clock, as the score does", async () => {
  const world = new World();
  const agent = world.addAgent();
  // The chain's clock five minutes ahead of this host's, and the negative counting from between the two.
  world.set('nowSec', Math.floor(Date.now() / 1000) + 300);
  const countsFrom = Date.now() + 120_000;
  const e = negative(world, { checkedAtMs: countsFrom - MARGIN - HOLD, refundCheck: settledNotRefunded(world.data.head - 6) });
  const o = await start(world, { events: { [agent.didHash]: [e] } });
  const [served] = await evidence(o, agent.didHash);
  assert.equal(served.success, false, "it counts by the chain's clock");
});

// ---- one negative posted to two operators ------------------------------------------------------------------

const DOMAIN = payerOutcome.domain(CHAIN_ID, REPUTATION);
async function signNegative(didHash, txHash, payer, signedAt) {
  const value = { payer: payer.address, outcome: payerOutcome.NOT_DELIVERED, evidence: ethers.ZeroHash, signedAt, deadline: signedAt + 86_400 };
  const signature = await payer.signTypedData(DOMAIN, payerOutcome.TYPES, payerOutcome.message(didHash, txHash, value));
  return { ...value, signature };
}

/** Points one world at several running oracles, so they read the same chain. */
function shareWorld(world, ...os) {
  const files = os.map((o) => path.join(o.dir, 'world.json'));
  world.flush = function flush() {
    for (const f of files) fs.writeFileSync(f, JSON.stringify(this.data));
  };
  world.flush();
}

test('the same negative posted to two operators 10 s apart is held from the first acceptance on both, once imported', async () => {
  const world = new World();
  const a = await start(world);
  const b = await start(world, { env: { PAYER_OUTCOMES_PEERS: `http://127.0.0.1:${a.port}`, MAX_CLOCK_SKEW_SECONDS: '864000' } });
  shareWorld(world, a, b);
  const imports = /payer outcomes from http:\/\/127\.0\.0\.1:\d+:/;
  await waitFor(b, imports);

  const now = world.data.nowSec;
  const agent = world.addAgent();
  const payer = ethers.Wallet.createRandom();
  const head = world.data.head;
  const txHash = world.addTx([{ from: payer.address, to: agent.agentAddress, value: 5n * USDC }], { blockNumber: head - 10 });
  world.set('blockTimes', { [head - 10]: now - 200, [head]: now - 50, [head + 20]: now - 40 });
  const signed = await signNegative(agent.didHash, txHash, payer, now - 100);
  const post = (o) => o.call('POST', '/attest', { didHash: agent.didHash, payment: { txHash }, payerOutcome: signed });
  assert.equal((await post(a)).status, 200);
  world.set('head', head + 20);
  assert.equal((await post(b)).status, 200);

  const [onA] = await evidence(a, agent.didHash);
  assert.notEqual((await evidence(b, agent.didHash))[0].payerNegative.countsFrom, onA.payerNegative.countsFrom, 'two holds before the import');
  for (;;) {
    const r = await b.call('POST', '/epoch', undefined, ADMIN);
    if (r.status === 202) break;
    await new Promise((res) => setTimeout(res, 50));
  }
  await waitFor(b, imports, 2);
  const [onB] = await evidence(b, agent.didHash);
  assert.equal(onB.payerNegative.countsFrom, onA.payerNegative.countsFrom, 'one hold, from the first acceptance');
  assert.equal(onB.payerOutcome.checkedAtBlock, head);
  assert.equal(onB.leaf, onA.leaf);
});
