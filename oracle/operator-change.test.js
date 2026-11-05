'use strict';

// A payment is judged against the operator of its own block, on every path into the evidence. The scan
// used the operator an agent registered with and /attest the one it has today, so after a handover
// the same payment counted by one door and was refused by the other.
//
//   A runs the agent until block T, then B does.
//     A paying before T   its own agent, so refused
//     A paying after T    a former operator, now a customer like anyone
//     B paying before T   a customer then, whatever it became
//     B paying after T    its own agent, so refused

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const payerOutcome = require('./payer-outcome');
const { World, startOracle, ASSET } = require('./test-support/oracle-harness');
const { TRANSFER_TOPIC } = require('./payments');

const USDC = 1_000_000n;
const ADMIN = 'a'.repeat(64);
const CHAIN_ID = 5042;
const REPUTATION = `0x${'33'.repeat(20)}`;
const ENV = {
  PAYMENT_VERIFICATION: 'required',
  PAYMENT_ASSET: ASSET,
  PAYMENT_MIN_AMOUNT: '10000',
  ORACLE_ADMIN_TOKEN: ADMIN,
};
const SCAN_ENV = { ...ENV, PAYMENT_SCAN_ENABLED: '1', PAYMENT_SCAN_PACE_MS: '0' };

let oracle;
afterEach(async () => {
  if (oracle) await oracle.stop();
  oracle = null;
});

function handedOver(world, addAgent) {
  const a = ethers.Wallet.createRandom();
  const b = ethers.Wallet.createRandom();
  const agent = addAgent();
  const t = world.data.head - 100;
  const registered = agent.registeredBlock ?? 1;
  Object.assign(world.data.agents[agent.didHash], {
    operator: b.address,
    operators: [{ fromBlock: registered, operator: a.address }, { fromBlock: t, operator: b.address }],
  });
  world.flush();
  return { a, b, agent, t };
}

const payments = ({ a, b, t }) => [
  { name: 'A before', from: a, block: t - 10, counts: false },
  { name: 'A after', from: a, block: t + 10, counts: true },
  { name: 'B before', from: b, block: t - 10, counts: true },
  { name: 'B after', from: b, block: t + 10, counts: false },
];

test('POST /attest judges a payment by the operator at its block', async () => {
  const world = new World();
  const h = handedOver(world, () => world.addAgent());
  oracle = await startOracle({ world, env: ENV });
  for (const p of payments(h)) {
    const txHash = world.addTx([{ from: p.from.address, to: h.agent.agentAddress, value: 5n * USDC }], { blockNumber: p.block });
    const r = await oracle.call('POST', '/attest', { didHash: h.agent.didHash, success: true, payment: { txHash } }, ADMIN);
    assert.equal(r.status, p.counts ? 200 : 402, `${p.name}: ${r.text}`);
    if (!p.counts) assert.equal(r.body.code, 'self_payment', p.name);
  }
});

test('POST /attest judges each leg of a transaction by the operator at its block', async () => {
  const world = new World();
  const h = handedOver(world, () => world.addAgent());
  oracle = await startOracle({ world, env: ENV });
  const customer = ethers.Wallet.createRandom().address;
  const txHash = world.addTx([
    { from: customer, to: h.agent.agentAddress, value: 9n * USDC },
    { from: h.a.address, to: h.agent.agentAddress, value: 5n * USDC }, // A's own, before the handover
  ], { blockNumber: h.t - 10 });
  const r = await oracle.call('POST', '/attest', { didHash: h.agent.didHash, success: true, payment: { txHash } }, ADMIN);
  assert.equal(r.status, 200, r.text);
  const payers = (await oracle.call('GET', `/evidence/${h.agent.didHash}`)).body.evidence.map((e) => e.payer.toLowerCase());
  assert.deepEqual(payers, [customer.toLowerCase()]);
});

test('a payer-signed outcome is judged by the operator at the payment\'s block too', async () => {
  const world = new World();
  const h = handedOver(world, () => world.addAgent());
  oracle = await startOracle({ world, env: { ...ENV, PAYER_OUTCOMES: 'both', EXPECTED_CHAIN_ID: String(CHAIN_ID), REPUTATION_ADDRESS: REPUTATION } });
  const dom = payerOutcome.domain(CHAIN_ID, REPUTATION);
  const now = Math.floor(Date.now() / 1000);
  for (const p of payments(h)) {
    const txHash = world.addTx([{ from: p.from.address, to: h.agent.agentAddress, value: 5n * USDC }], { blockNumber: p.block });
    const value = { payer: p.from.address, outcome: payerOutcome.DELIVERED, evidence: ethers.ZeroHash, signedAt: now, deadline: now + 3600 };
    const signature = await p.from.signTypedData(dom, payerOutcome.TYPES, payerOutcome.message(h.agent.didHash, txHash, value));
    const r = await oracle.call('POST', '/attest', { didHash: h.agent.didHash, payment: { txHash }, payerOutcome: { ...value, signature } });
    if (p.counts) assert.equal(r.status, 200, `${p.name}: ${r.text}`);
    else assert.equal(r.body.code, 'self_payment', `${p.name}: ${r.text}`);
  }
});

test('the payment scan reaches the same answers as /attest', async () => {
  const world = new World();
  const h = handedOver(world, () => world.addRegisteredAgent());
  const all = payments(h);
  world.set('scanLogs', all.map((p, i) => ({
    address: ASSET,
    topics: [TRANSFER_TOPIC, ethers.zeroPadValue(p.from.address, 32), ethers.zeroPadValue(h.agent.agentAddress, 32)],
    data: ethers.toBeHex(5n * USDC, 32),
    blockNumber: p.block,
    transactionHash: ethers.id(`pay-${i}`),
    logIndex: 0,
    removed: false,
  })));
  oracle = await startOracle({ world, env: { ...SCAN_ENV, PAYMENT_SCAN_FROM_BLOCK: String(h.t - 50) } });
  await oracle.waitForLog(/\[oracle\] epoch done/);
  assert.match(oracle.logs(), /payment scan \d+-\d+: 2 credited, 2 skipped .*"self_payment":2/);
  const credited = (await oracle.call('GET', `/evidence/${h.agent.didHash}`)).body.evidence.map((e) => e.txHash).sort();
  assert.deepEqual(credited, [ethers.id('pay-1'), ethers.id('pay-2')].sort());
});
