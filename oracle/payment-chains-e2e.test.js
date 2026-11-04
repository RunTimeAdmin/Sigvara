'use strict';

// A payment chain end to end (ADR 0009): the real oracle process, the stubbed scored chain, and a
// JSON-RPC endpoint standing in for Base Sepolia that real ethers objects talk to. payment-chains.test.js
// tests the scan on its own; this is index.js handing it the chain, crediting what it finds, holding an
// epoch when the scan is behind, and serving the result.

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const { ethers } = require('ethers');
const { World, startOracle, wallet, ASSET } = require('./test-support/oracle-harness');
const { TRANSFER_TOPIC } = require('./payments');
const merkle = require('./merkle');

const BASE = 84532;
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const ADMIN = 'a'.repeat(64);
const FINALIZED = 5_000;
const hex = (n) => `0x${BigInt(n).toString(16)}`;

/** Base Sepolia as far as the scan asks: its chain id, blocks, USDC logs and account code. */
async function startBase({ blockTime, logs = [] }) {
  const calls = [];
  const block = (n) => ({
    number: hex(n), hash: ethers.id(`base-${n}`), parentHash: ethers.id(`base-${n - 1}`),
    timestamp: hex(blockTime(n)), nonce: '0x0000000000000000', difficulty: '0x0',
    gasLimit: hex(30_000_000), gasUsed: '0x0', miner: ethers.ZeroAddress, extraData: '0x',
    baseFeePerGas: '0x1', transactions: [],
  });
  const answer = (method, params) => {
    calls.push(method);
    switch (method) {
      case 'eth_chainId': return hex(BASE);
      case 'eth_getBlockByNumber': return block(params[0] === 'finalized' ? FINALIZED : Number(params[0]));
      case 'eth_getCode': return '0x';
      case 'eth_getLogs': {
        const f = params[0];
        const from = Number(f.fromBlock);
        const to = Number(f.toBlock);
        const wanted = new Set((f.topics?.[2] || []).map((t) => t.toLowerCase()));
        return logs.filter((l) => l.address.toLowerCase() === String(f.address).toLowerCase()
          && Number(l.blockNumber) >= from && Number(l.blockNumber) <= to && wanted.has(l.topics[2].toLowerCase()));
      }
      default: throw new Error(`base stub: ${method}`);
    }
  };
  const respond = (r) => {
    try { return { jsonrpc: '2.0', id: r.id, result: answer(r.method, r.params) }; }
    catch (err) { return { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: err.message } }; }
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(respond) : respond(parsed)));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/v2/SECRET-KEY`,
    calls,
    stop: () => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); },
  };
}

function transfer({ from, to, amount, block }) {
  return {
    address: USDC, topics: [TRANSFER_TOPIC, ethers.zeroPadValue(from, 32), ethers.zeroPadValue(to, 32)],
    data: ethers.toBeHex(amount, 32), blockNumber: hex(block), blockHash: ethers.id(`base-${block}`),
    transactionHash: ethers.id(`tx-${block}-${to}`), transactionIndex: '0x0', logIndex: '0x0', removed: false,
  };
}

const env = (url, over = {}) => ({
  EXPECTED_CHAIN_ID: '5042',
  PAYMENT_VERIFICATION: 'required',
  PAYMENT_ASSET: ASSET,
  PAYMENT_MIN_AMOUNT: '10000',
  // The scored chain's own scan, which payment chains require.
  PAYMENT_SCAN_ENABLED: '1',
  PAYMENT_SCAN_FROM_BLOCK: String(1_000_000 - 100),
  PAYMENT_SCAN_PACE_MS: '0',
  ORACLE_ADMIN_TOKEN: ADMIN,
  PAYMENT_CHAIN_IDS: String(BASE),
  [`PAYMENT_CHAIN_${BASE}_RPC_URL`]: url,
  [`PAYMENT_CHAIN_${BASE}_ASSET`]: USDC,
  [`PAYMENT_CHAIN_${BASE}_FROM_BLOCK`]: String(FINALIZED - 300),
  [`PAYMENT_CHAIN_${BASE}_FEE_UNIT`]: '100000000',
  [`PAYMENT_CHAIN_${BASE}_PACE_MS`]: '0',
  [`PAYMENT_CHAIN_${BASE}_MODE`]: 'on',
  ...over,
});

let oracle;
let base;
afterEach(async () => {
  if (oracle) await oracle.stop();
  if (base) await base.stop();
  oracle = null;
  base = null;
});

async function waitFor(re) {
  const deadline = Date.now() + 20_000;
  while (!re.test(oracle.logs())) {
    if (Date.now() > deadline) throw new Error(`never logged ${re}:\n${oracle.logs()}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('a payment on Base Sepolia is credited, scored once old enough, and served with its chain', async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  const now = world.data.nowSec;
  // Finalized a quarter of an hour ago; the payment two hours ago, so past the hour's delay.
  base = await startBase({
    blockTime: (n) => (n === FINALIZED ? now - 900 : n === FINALIZED - 100 ? now - 7200 : now - 1800),
    logs: [transfer({ from: wallet(), to: agent.agentAddress, amount: 3_000_000n, block: FINALIZED - 100 })],
  });
  oracle = await startOracle({ world, env: env(base.url) });
  await waitFor(/\[oracle\] epoch done/);

  assert.match(oracle.logs(), new RegExp(`payment chain ${BASE} \\(on\\) ${FINALIZED - 300}-${FINALIZED}: 1 credited`));
  assert.ok(!oracle.logs().includes('SECRET-KEY'), 'the RPC URL is never logged');
  assert.ok(base.calls.includes('eth_getCode'), "the recipient's code was asked on Base");

  const health = await oracle.call('GET', '/health');
  assert.equal(health.status, 200);
  const [view] = health.body.paymentChains;
  assert.equal(view.chainId, BASE);
  assert.equal(view.lastBlock, FINALIZED);
  assert.equal(view.lastScan.credited, 1);
  assert.ok(!health.text.includes('SECRET-KEY'));

  const ev = await oracle.call('GET', `/evidence/${agent.didHash}`);
  assert.equal(ev.status, 200, ev.text);
  assert.deepEqual(ev.body.paymentChains, [{ chainId: BASE, delaySeconds: 3600 }]);
  const [served] = ev.body.evidence;
  assert.equal(served.chainId, BASE);
  assert.equal(served.amount, '3000000');
});

test('a scan behind by more than one step catches up within the epoch, a step at a time', async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  const now = world.data.nowSec;
  base = await startBase({
    blockTime: (n) => (n === FINALIZED ? now - 900 : now - 7200),
    logs: [transfer({ from: wallet(), to: agent.agentAddress, amount: 3_000_000n, block: FINALIZED - 50 })],
  });
  oracle = await startOracle({ world, env: env(base.url, { [`PAYMENT_CHAIN_${BASE}_MAX_BLOCKS`]: '100' }) });
  await waitFor(/\[oracle\] epoch done/);
  for (const range of [`${FINALIZED - 300}-${FINALIZED - 201}`, `${FINALIZED - 200}-${FINALIZED - 101}`, `${FINALIZED - 100}-${FINALIZED - 1}`, `${FINALIZED}-${FINALIZED}`]) {
    assert.match(oracle.logs(), new RegExp(`payment chain ${BASE} \\(on\\) ${range}:`), range);
  }
  const health = await oracle.call('GET', '/health');
  assert.equal(health.body.paymentChains[0].lastBlock, FINALIZED);
  const ev = await oracle.call('GET', `/evidence/${agent.didHash}`);
  assert.equal(ev.body.evidence.length, 1);
});

test('an epoch whose Base scan has not reached now less the delay scores nothing, and says why', async () => {
  const world = new World();
  world.addRegisteredAgent();
  const now = world.data.nowSec;
  // The finalized head is two hours old: the scan cannot have seen the last hour.
  base = await startBase({ blockTime: () => now - 7200 });
  oracle = await startOracle({ world, env: env(base.url) });
  await waitFor(/scoring nothing this epoch/);
  assert.match(oracle.logs(), new RegExp(`payment chain ${BASE}: the scan has reached`));
  assert.doesNotMatch(oracle.logs(), /\[oracle\] epoch done/);
  const metricsText = (await oracle.call('GET', '/metrics')).text;
  assert.match(metricsText, /sigvara_oracle_epochs_held_by_payment_chain_total 1/);
});

test('in shadow mode the scan reports what it would credit, and the epoch is not held', async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  const now = world.data.nowSec;
  base = await startBase({
    blockTime: () => now - 7200,
    logs: [transfer({ from: wallet(), to: agent.agentAddress, amount: 3_000_000n, block: FINALIZED - 100 })],
  });
  oracle = await startOracle({ world, env: env(base.url, { [`PAYMENT_CHAIN_${BASE}_MODE`]: 'shadow' }) });
  await waitFor(/\[oracle\] epoch done/);
  await waitFor(new RegExp(`payment chain ${BASE} \\(shadow\\) .*: 1 would credit`));
  const ev = await oracle.call('GET', `/evidence/${agent.didHash}`);
  assert.equal(ev.body.count, 0, 'nothing was credited');
});

test('a chain in shadow runs beside the epoch, so a hung endpoint cannot hold up a score', async () => {
  const world = new World();
  world.addRegisteredAgent();
  // Takes the connection and never answers. Scanned inside the epoch, this would hold it for two minutes.
  const sockets = [];
  const hung = net.createServer((s) => { s.on('error', () => {}); sockets.push(s); });
  await new Promise((resolve) => hung.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${hung.address().port}/v2/SECRET-KEY`;
    oracle = await startOracle({ world, env: env(url, { [`PAYMENT_CHAIN_${BASE}_MODE`]: 'shadow' }) });
    await waitFor(/\[oracle\] epoch done/);
    assert.ok(sockets.length > 0, 'the scan had started');
    assert.doesNotMatch(oracle.logs(), /SECRET-KEY/);
  } finally {
    if (oracle) await oracle.stop();
    oracle = null;
    sockets.forEach((s) => s.destroy());
    hung.close();
  }
});

test('a payment chain that is the scored chain, or set up without EXPECTED_CHAIN_ID, stops the process', async () => {
  const world = new World();
  await assert.rejects(
    startOracle({ world, env: env('http://127.0.0.1:1', { PAYMENT_CHAIN_IDS: '5042', PAYMENT_CHAIN_5042_RPC_URL: 'http://x', PAYMENT_CHAIN_5042_ASSET: USDC, PAYMENT_CHAIN_5042_FROM_BLOCK: '1', PAYMENT_CHAIN_5042_FEE_UNIT: '1' }) }),
    /scored chain/,
  );
  await assert.rejects(startOracle({ world, env: env('http://127.0.0.1:1', { EXPECTED_CHAIN_ID: '' }) }), /needs EXPECTED_CHAIN_ID/);
  await assert.rejects(startOracle({ world, env: env('http://127.0.0.1:1', { PAYMENT_SCAN_ENABLED: '0' }) }), /needs PAYMENT_SCAN_ENABLED=1/);
  await assert.rejects(startOracle({ world, env: env('http://127.0.0.1:1', { TX_WAIT_SECONDS: '600' }) }), /TX_WAIT_SECONDS=600 is too long/);
});

test('the proposal commits to what counted by its cut-off, Base payment included', async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  const now = world.data.nowSec;
  const payer = wallet();
  const block = FINALIZED - 100;
  base = await startBase({
    blockTime: (n) => (n === FINALIZED ? now - 900 : n === block ? now - 7200 : now - 1800),
    logs: [transfer({ from: payer, to: agent.agentAddress, amount: 3_000_000n, block })],
  });
  oracle = await startOracle({ world, env: env(base.url) });
  await waitFor(/\[oracle\] epoch done/);
  const proposal = oracle.calls().find((c) => c.name === 'proposeScore');
  assert.ok(proposal, `no proposal:\n${oracle.logs()}`);
  const expected = merkle.leafFor({
    chainId: BASE, txHash: ethers.id(`tx-${block}-${agent.agentAddress}`), payer,
    amount: '3000000', ts: (now - 7200) * 1000, success: null,
  });
  // One payment, so the root is its leaf.
  assert.equal(proposal.args[2], expected);
});

test('after a transaction is not seen mined, the epoch proposes nothing more', async () => {
  const world = new World();
  world.addRegisteredAgent();
  world.addRegisteredAgent();
  world.data.propose = 'unconfirmed';
  const now = world.data.nowSec;
  base = await startBase({ blockTime: (n) => (n === FINALIZED ? now - 900 : now - 7200) });
  oracle = await startOracle({ world, env: env(base.url) });
  await waitFor(/\[oracle\] epoch done/);
  assert.equal(oracle.calls().filter((c) => c.name === 'proposeScore').length, 1);
  assert.match(oracle.logs(), /a transaction this epoch was not seen mined; proposing next epoch/);
});
