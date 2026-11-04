'use strict';

// A payment chain end to end (ADR 0009): the real oracle process, the stubbed scored chain, and a
// JSON-RPC endpoint standing in for Base Sepolia that real ethers objects talk to. payment-chains.test.js
// tests the scan on its own; this is index.js handing it the chain, crediting what it finds, holding an
// epoch when the scan is behind, and serving the result.

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
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
async function startBase({ blockTime, logs = [], finalizedAt = () => FINALIZED, logsFail = null }) {
  const calls = [];
  let finalizedReads = 0;
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
      case 'eth_getBlockByNumber': return block(params[0] === 'finalized' ? finalizedAt(++finalizedReads) : Number(params[0]));
      case 'eth_getCode': return '0x';
      case 'eth_getLogs': {
        if (logsFail) throw new Error(logsFail(server));
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
  [`PAYMENT_CHAIN_${BASE}_MIN_AMOUNT`]: '10000',
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

test('a catch-up stops at its time budget and carries on next epoch, with what it has done saved', async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  const now = world.data.nowSec;
  // Reading when the agent registered, in the first step, is where this host's clock passes the ten minutes.
  world.data.hostClockSteps = { getAgentInfo: 11 * 60_000 };
  base = await startBase({
    blockTime: (n) => (n === FINALIZED ? now - 900 : now - 7200),
    logs: [transfer({ from: wallet(), to: agent.agentAddress, amount: 3_000_000n, block: FINALIZED - 250 })],
  });
  oracle = await startOracle({ world, env: env(base.url, { [`PAYMENT_CHAIN_${BASE}_MAX_BLOCKS`]: '100' }) });
  await waitFor(new RegExp(`payment chain ${BASE}: still catching up at block ${FINALIZED - 201}; continuing next epoch`));
  assert.doesNotMatch(oracle.logs(), new RegExp(`\\(on\\) ${FINALIZED - 200}-`));
  const health = await oracle.call('GET', '/health');
  assert.equal(health.body.paymentChains[0].lastBlock, FINALIZED - 201);
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
  assert.match(oracle.logs(), new RegExp(`payment chain ${BASE} \\(shadow\\) .*: 1 would credit`));
  const ev = await oracle.call('GET', `/evidence/${agent.didHash}`);
  assert.equal(ev.body.count, 0, 'nothing was credited');
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
  assert.match(oracle.logs(), /a transaction from this wallet has not been seen mined; proposing next epoch/);
});

// ---- the guards around a cut-off ------------------------------------------------------------------

const CHECKER = { ORACLE_MODE: 'checker', DIVERGENCE_TOLERANCE: '0' };
// The scored chain's scan stops this many blocks short of the head, so its reach is this block's time.
const scanEnd = (world) => world.data.head - 6;
const FEES = { feeGating: true, epochFee: '1000' };
const DEFERRED = /this operator's scans have not passed the pending proposal's time; checking it next epoch/;
// Far from anything an agent with no payments computes, so a checker that compares is bound to disagree.
const HIGH_SCORE = { feeScore: 40, successScore: 25, ageScore: 10, externalScore: 0, communityScore: 5, propagationScore: 5 };
const proposalAt = (proposedAt) => ({ exists: true, proposedAt, data: HIGH_SCORE, evidenceRoot: null });
const healthyBase = (now) => startBase({ blockTime: (n) => (n === FINALIZED ? now - 900 : now - 7200) });
const WRITES = new Set(['chargeEpoch', 'proposeScore', 'finalizeScore']);
const writes = () => oracle.calls().filter((c) => WRITES.has(c.name)).map((c) => c.name);

/** A USDC transfer on the scored chain, as the stub's provider hands it to the payment scan. */
function arcTransfer({ from, to, amount, block }) {
  return {
    address: ASSET, topics: [TRANSFER_TOPIC, ethers.zeroPadValue(from, 32), ethers.zeroPadValue(to, 32)],
    data: ethers.toBeHex(amount, 32), blockNumber: block, blockHash: ethers.id(`arc-${block}`),
    transactionHash: ethers.id(`arc-tx-${block}-${to}`), transactionIndex: 0, index: 0, logIndex: 0, removed: false,
  };
}

test("a checker puts off a proposal newer than its scan of the scored chain, and does not dispute it", async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  const now = world.data.nowSec;
  // The stub's blocks read a minute behind its clock, so the scan has reached now - 60.
  world.setFor('pending', agent.didHash, proposalAt(now - 10));
  base = await healthyBase(now);
  oracle = await startOracle({ world, env: env(base.url, CHECKER) });
  await waitFor(/\[oracle\] epoch done/);
  assert.match(oracle.logs(), DEFERRED);
  assert.doesNotMatch(oracle.logs(), /DIVERGENCE/);
  assert.deepEqual(writes(), []);
});

test('a checker puts off a proposal newer than what its scan of a payment chain can count', async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  const now = world.data.nowSec;
  // The scored chain's scan has passed the proposal. Base's finalized head and the hour's delay count up
  // to now - 50: enough for this epoch's cut-off, which is at most now - 60, and short of the proposal.
  world.data.blockTimes = { [scanEnd(world)]: now };
  world.setFor('pending', agent.didHash, proposalAt(now - 10));
  base = await startBase({ blockTime: () => now - 3650 });
  oracle = await startOracle({ world, env: env(base.url, CHECKER) });
  await waitFor(/\[oracle\] epoch done/);
  assert.match(oracle.logs(), DEFERRED);
  assert.doesNotMatch(oracle.logs(), /DIVERGENCE/);
  assert.deepEqual(writes(), []);
});

test("a proposal older than a checker's scans is checked, and disputed when it disagrees", async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  const now = world.data.nowSec;
  world.setFor('pending', agent.didHash, proposalAt(now - 300));
  base = await healthyBase(now);
  oracle = await startOracle({ world, env: env(base.url, CHECKER) });
  await waitFor(/\[oracle\] epoch done/);
  assert.doesNotMatch(oracle.logs(), DEFERRED);
  assert.match(oracle.logs(), /DIVERGENCE/);
});

test('a primary whose scored-chain scan is too far behind holds the epoch: nothing charged, finalized or proposed', async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  Object.assign(world.data, FEES);
  const now = world.data.nowSec;
  // With TX_WAIT_SECONDS at its default, a cut-off has 25 minutes of the checker's half hour to be used in.
  world.data.blockTimes = { [scanEnd(world)]: now - 1600 };
  world.setFor('pending', agent.didHash, proposalAt(now - 30_000));
  base = await healthyBase(now);
  oracle = await startOracle({ world, env: env(base.url) });
  await waitFor(/the scored chain's payment scan has reached .*; scoring nothing this epoch/);
  assert.deepEqual(writes(), []);
  const text = (await oracle.call('GET', '/metrics')).text;
  assert.match(text, /sigvara_oracle_epochs_held_by_payment_chain_total 1/);
  assert.match(text, /sigvara_oracle_epochs_total\{status="failed"\} 1/);
  assert.match(text, /sigvara_oracle_epochs_total\{status="succeeded"\} 0/);
  assert.deepEqual((await oracle.call('GET', '/health')).body.paymentChainHold.chains, [5042]);
});

test('a checker whose scored-chain scan is too far behind holds the epoch, and its silence reads as a failure', async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  const now = world.data.nowSec;
  world.data.blockTimes = { [scanEnd(world)]: now - 1600 };
  world.setFor('pending', agent.didHash, proposalAt(now - 2000));
  base = await healthyBase(now);
  oracle = await startOracle({ world, env: env(base.url, CHECKER) });
  await waitFor(/scoring nothing this epoch/);
  assert.doesNotMatch(oracle.logs(), /DIVERGENCE/);
  assert.match((await oracle.call('GET', '/metrics')).text, /sigvara_oracle_epochs_total\{status="failed"\} 1/);
});

test('an epoch held by a payment chain finalizes nothing, and /health names the chain', async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  const now = world.data.nowSec;
  world.setFor('pending', agent.didHash, proposalAt(now - 30_000));
  base = await startBase({ blockTime: () => now - 7200 });
  oracle = await startOracle({ world, env: env(base.url) });
  await waitFor(/scoring nothing this epoch/);
  assert.deepEqual(writes(), []);
  const health = await oracle.call('GET', '/health');
  assert.deepEqual(health.body.paymentChainHold.chains, [BASE]);
});

test('scans that fall too far behind during an epoch leave later agents unscored, neither finalized nor charged', async () => {
  const world = new World();
  const first = world.addRegisteredAgent();
  world.addRegisteredAgent();
  const third = world.addRegisteredAgent();
  Object.assign(world.data, FEES);
  const now = world.data.nowSec;
  world.setFor('pending', third.didHash, proposalAt(now - 30_000));
  // The first proposal takes most of half an hour, and the scored chain has made no block worth the name since.
  world.data.clockSteps = { proposeScore: 1600 };
  world.data.blockTimes = { [scanEnd(world) + 1600]: now - 60 };
  base = await healthyBase(now);
  oracle = await startOracle({ world, env: env(base.url) });
  await waitFor(/\[oracle\] epoch done/);
  assert.deepEqual(oracle.calls().filter((c) => WRITES.has(c.name)).map((c) => [c.name, c.args[0]]), [
    ['chargeEpoch', first.didHash], ['proposeScore', first.didHash],
  ]);
  assert.match(oracle.logs(), /2 agent\(s\) left unscored/);
  const text = (await oracle.call('GET', '/metrics')).text;
  assert.match(text, /sigvara_oracle_epochs_held_by_payment_chain_total 1/);
  assert.equal((await oracle.call('GET', '/health')).body.paymentChainHold.agents, 2);
});

test('a scan further behind, but not too far to land in time, still proposes at its cut-off', async () => {
  const world = new World();
  world.addRegisteredAgent();
  Object.assign(world.data, FEES);
  const now = world.data.nowSec;
  world.data.blockTimes = { [scanEnd(world)]: now - 1200 };
  base = await healthyBase(now);
  oracle = await startOracle({ world, env: env(base.url) });
  await waitFor(/\[oracle\] epoch done/);
  assert.doesNotMatch(oracle.logs(), /recent enough cut-off/);
  assert.deepEqual(writes(), ['chargeEpoch', 'proposeScore']);
});

test('evidence chosen too long before it could be sent is not charged for or proposed', async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  Object.assign(world.data, FEES);
  const now = world.data.nowSec;
  // Reading the payer's standing, between choosing the evidence and proposing, takes most of half an hour.
  world.data.clockSteps = { getAgentScore: 1600 };
  base = await startBase({
    blockTime: (n) => (n === FINALIZED ? now - 900 : now - 7200),
    logs: [transfer({ from: wallet(), to: agent.agentAddress, amount: 3_000_000n, block: FINALIZED - 100 })],
  });
  oracle = await startOracle({ world, env: env(base.url) });
  await waitFor(/\[oracle\] epoch done/);
  assert.match(oracle.logs(), /its evidence was chosen too long ago to propose; proposing next epoch/);
  assert.deepEqual(writes(), []);
});

test("a long epoch scans the scored chain again, so a later agent's proposal holds what settled meanwhile", async () => {
  const world = new World();
  const first = world.addRegisteredAgent();
  const second = world.addRegisteredAgent();
  const now = world.data.nowSec;
  const payer = wallet();
  // Each proposal takes ten minutes. This payment settles after the epoch's first scan, before the second agent.
  world.data.clockSteps = { proposeScore: 600 };
  const block = world.data.head + 300;
  world.data.blockTimes = { [block]: now + 100 };
  const log = arcTransfer({ from: payer, to: second.agentAddress, amount: 3_000_000n, block });
  world.data.scanLogs = [log];
  base = await healthyBase(now);
  oracle = await startOracle({ world, env: env(base.url) });
  await waitFor(/\[oracle\] epoch done/);
  const proposals = oracle.calls().filter((c) => c.name === 'proposeScore');
  assert.deepEqual(proposals.map((c) => c.args[0]), [first.didHash, second.didHash]);
  const expected = merkle.leafFor({ txHash: log.transactionHash, payer, amount: '3000000', ts: (now + 100) * 1000, success: null });
  assert.equal(proposals[1].args[2], expected, oracle.logs());
});

test("a long epoch scans a payment chain again, so a later agent's proposal holds what came to count meanwhile", async () => {
  const world = new World();
  const first = world.addRegisteredAgent();
  const second = world.addRegisteredAgent();
  const now = world.data.nowSec;
  const payer = wallet();
  // Each proposal takes twenty minutes. Base's finalized head at the epoch's start counts up to now + 600,
  // short of the second agent's cut-off, and by then it has moved past a payment that counts from now + 900.
  world.data.clockSteps = { proposeScore: 1200 };
  world.data.proposeDelayMs = 300;
  const paid = FINALIZED + 100;
  const later = FINALIZED + 200;
  const times = { [FINALIZED]: now - 3000, [paid]: now - 2700, [later]: now - 900 };
  base = await startBase({
    finalizedAt: (nthRead) => (nthRead === 1 ? FINALIZED : later),
    blockTime: (n) => times[n] ?? now - 7200,
    logs: [transfer({ from: payer, to: second.agentAddress, amount: 3_000_000n, block: paid })],
  });
  oracle = await startOracle({ world, env: env(base.url) });
  await waitFor(/\[oracle\] epoch done/);
  const proposals = oracle.calls().filter((c) => c.name === 'proposeScore');
  assert.deepEqual(proposals.map((c) => c.args[0]), [first.didHash, second.didHash]);
  const expected = merkle.leafFor({
    chainId: BASE, txHash: ethers.id(`tx-${paid}-${second.agentAddress}`), payer,
    amount: '3000000', ts: (now - 2700) * 1000, success: null,
  });
  assert.equal(proposals[1].args[2], expected, oracle.logs());
});

test('in a long epoch each score is measured at the clock its own evidence was cut at', async () => {
  const world = new World();
  const first = world.addRegisteredAgent();
  const second = world.addRegisteredAgent();
  const now = world.data.nowSec;
  const DAY = 86_400;
  // Enough to fade any score: the epoch's first proposal takes forty days, which the scans keep up with.
  const step = 40 * DAY;
  world.data.clockSteps = { proposeScore: step };
  world.data.proposeDelayMs = 300;
  const later = FINALIZED + 200;
  const times = { [FINALIZED]: now - 900, [later]: now + step - 900 };
  base = await startBase({ finalizedAt: (nthRead) => (nthRead === 1 ? FINALIZED : later), blockTime: (n) => times[n] ?? now - 7200 });
  // The same history for both, so the only difference between their scores is when they are measured.
  const history = (tag) => [200, 150, 100, 50, 10, 1].map((daysAgo, i) => ({
    txHash: ethers.id(`${tag}-${i}`), ts: (now - daysAgo * DAY) * 1000, amount: '5000000', payer: wallet(), success: true,
  }));
  oracle = await startOracle({
    world,
    env: env(base.url, { PAYMENT_SCAN_CHUNK: '10000000' }),
    files: { 'state.json': JSON.stringify({ schemaVersion: 1, paymentEvents: { [first.didHash]: history('first'), [second.didHash]: history('second') } }) },
  });
  await waitFor(/\[oracle\] epoch done/);
  const proposals = oracle.calls().filter((c) => c.name === 'proposeScore');
  assert.deepEqual(proposals.map((c) => c.args[0]), [first.didHash, second.didHash], oracle.logs());
  assert.ok(proposals[1].args[1].total < proposals[0].args[1].total, `${JSON.stringify(proposals.map((c) => c.args[1]))}\n${oracle.logs()}`);
});

// ---- the fourth review ----------------------------------------------------------------------------

const counted = (text, name) => Number(text.split('\n').find((l) => l.startsWith(`${name} `))?.split(' ').pop() ?? NaN);
const AGREED = 'sigvara_oracle_checker_comparisons_total{verdict="agreed"}';
const DIVERGED = 'sigvara_oracle_checker_comparisons_total{verdict="diverged"}';
const DAY = 86_400;
const history = (now, tag, daysAgo = [200, 150, 100, 50, 10, 1]) => daysAgo.map((d, i) => ({
  txHash: ethers.id(`${tag}-${i}`), ts: (now - d * DAY) * 1000, amount: '5000000', payer: wallet(), success: null,
}));
const scoresOf = ({ feeScore, successScore, ageScore, externalScore, communityScore, propagationScore }) => (
  { feeScore, successScore, ageScore, externalScore, communityScore, propagationScore }
);
const stateWith = (paymentEvents, rest = {}) => JSON.stringify({ schemaVersion: 1, paymentEvents, ...rest });

test('a scan run again during an epoch reads the registry again, so a payment to an agent registered since is kept', async () => {
  const world = new World();
  world.addRegisteredAgent();
  world.addRegisteredAgent();
  const later = world.addAgent();
  const now = world.data.nowSec;
  world.data.registeredLater = [later.didHash];
  world.data.clockSteps = { proposeScore: 600 };
  const block = world.data.head + 300;
  world.data.blockTimes = { [block]: now - 300 };
  world.data.scanLogs = [arcTransfer({ from: wallet(), to: later.agentAddress, amount: 3_000_000n, block })];
  base = await healthyBase(now);
  oracle = await startOracle({ world, env: env(base.url) });
  await waitFor(/\[oracle\] epoch done/);
  // The scan's cursor has passed this block for good, so this was its one chance to be credited.
  const ev = await oracle.call('GET', `/evidence/${later.didHash}`);
  assert.equal(ev.body.count, 1, oracle.logs());
});

test('a scan that cannot move is run again once per cut-off, not once per agent', async () => {
  const world = new World();
  const agents = [world.addRegisteredAgent(), world.addRegisteredAgent(), world.addRegisteredAgent()];
  const now = world.data.nowSec;
  // A payment the canary must find and cannot, so the scan never moves on from an old reach.
  const events = [{ ...history(now, 'known', [1])[0], blockNumber: scanEnd(world) - 500 }];
  base = await healthyBase(now);
  oracle = await startOracle({
    world,
    env: env(base.url),
    files: { 'state.json': stateWith({ [agents[0].didHash]: events }, {
      paymentScanState: { lastBlock: scanEnd(world) - 100, lastBlockTs: now - 600, at: (now - 600) * 1000 },
    }) },
  });
  await waitFor(/\[oracle\] epoch done/);
  const failures = counted((await oracle.call('GET', '/metrics')).text, 'sigvara_oracle_payment_scan_canary_failures_total');
  assert.equal(failures, 2, `the epoch's scan and one more:\n${oracle.logs()}`);
});

test('each payment chain is scanned before the scored chain, so a slow one does not widen the gap before scoring', async () => {
  const world = new World();
  world.addRegisteredAgent();
  const now = world.data.nowSec;
  base = await healthyBase(now);
  oracle = await startOracle({ world, env: env(base.url, { [`PAYMENT_CHAIN_${BASE}_MODE`]: 'shadow' }) });
  await waitFor(/\[oracle\] epoch done/);
  const logs = oracle.logs();
  assert.ok(logs.indexOf(`payment chain ${BASE} (shadow)`) < logs.indexOf('payment scan '), logs);
});

test('a checker agrees with a primary: it finds the cut-off, whatever order it credited the payments in', async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  const now = world.data.nowSec;
  const block = FINALIZED - 100;
  base = await startBase({
    blockTime: (n) => (n === FINALIZED ? now - 900 : n === block ? now - 7200 : now - 1800),
    logs: [transfer({ from: wallet(), to: agent.agentAddress, amount: 3_000_000n, block })],
  });
  const stored = history(now, 'both');
  oracle = await startOracle({ world, env: env(base.url), files: { 'state.json': stateWith({ [agent.didHash]: stored }) } });
  await waitFor(/\[oracle\] epoch done/);
  const proposal = oracle.calls().find((c) => c.name === 'proposeScore');
  assert.ok(proposal, oracle.logs());
  await oracle.stop();
  oracle = null;

  // The checker, five minutes on. It holds the same payments credited the other way round, and has since
  // found a large one that settled after the primary's cut-off and before its proposal landed.
  world.file = null;
  const paidAt = world.data.head + 100;
  world.data.nowSec = now + 300;
  world.data.head += 300;
  world.data.blockTimes = { [paidAt]: now + 10 };
  world.data.scanLogs = [arcTransfer({ from: wallet(), to: agent.agentAddress, amount: 90_000_000_000n, block: paidAt })];
  world.setFor('pending', agent.didHash, { exists: true, proposedAt: now + 30, data: scoresOf(proposal.args[1]), evidenceRoot: proposal.args[2] });
  oracle = await startOracle({ world, env: env(base.url, CHECKER), files: { 'state.json': stateWith({ [agent.didHash]: [...stored].reverse() }) } });
  await waitFor(/\[oracle\] epoch done/);
  assert.doesNotMatch(oracle.logs(), /DIVERGENCE/);
  const text = (await oracle.call('GET', '/metrics')).text;
  assert.equal(counted(text, AGREED), 1, oracle.logs());
  assert.equal(counted(text, DIVERGED), 0);
});

test('switching on, checker first: a proposal made before the switch is still agreed', async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  const now = world.data.nowSec;
  // FROM_BLOCK is recent, as the README asks, so this older payment counts for neither operator.
  base = await startBase({
    blockTime: (n) => (n === FINALIZED ? now - 900 : now - 7200),
    logs: [transfer({ from: wallet(), to: agent.agentAddress, amount: 3_000_000n, block: FINALIZED - 400 })],
  });
  const stored = history(now, 'switch');
  oracle = await startOracle({
    world,
    env: env(base.url, { [`PAYMENT_CHAIN_${BASE}_MODE`]: 'shadow' }),
    files: { 'state.json': stateWith({ [agent.didHash]: stored }) },
  });
  await waitFor(/\[oracle\] epoch done/);
  const proposal = oracle.calls().find((c) => c.name === 'proposeScore');
  await oracle.stop();
  oracle = null;

  world.file = null;
  world.data.nowSec = now + 300;
  world.data.head += 300;
  world.setFor('pending', agent.didHash, { exists: true, proposedAt: now + 30, data: scoresOf(proposal.args[1]), evidenceRoot: proposal.args[2] });
  oracle = await startOracle({ world, env: env(base.url, CHECKER), files: { 'state.json': stateWith({ [agent.didHash]: stored }) } });
  await waitFor(/\[oracle\] epoch done/);
  assert.equal(counted((await oracle.call('GET', '/metrics')).text, AGREED), 1, oracle.logs());
});

test('a transaction still pending from before this epoch stops its proposals: they would queue behind it', async () => {
  const world = new World();
  world.addRegisteredAgent();
  Object.assign(world.data, FEES);
  world.data.nonceGap = 1;
  base = await healthyBase(world.data.nowSec);
  oracle = await startOracle({ world, env: env(base.url) });
  await waitFor(/\[oracle\] epoch done/);
  assert.match(oracle.logs(), /a transaction from this wallet has not been seen mined; proposing next epoch/);
  assert.deepEqual(writes(), []);
});

test('a charge not seen mined stops the proposals after it', async () => {
  const world = new World();
  world.addRegisteredAgent();
  world.addRegisteredAgent();
  Object.assign(world.data, FEES);
  world.data.charge = 'unconfirmed';
  base = await healthyBase(world.data.nowSec);
  oracle = await startOracle({ world, env: env(base.url) });
  await waitFor(/\[oracle\] epoch done/);
  assert.deepEqual(writes(), ['chargeEpoch']);
  assert.match(oracle.logs(), /a transaction from this wallet has not been seen mined; proposing next epoch/);
});

test("a scored-chain cursor saved without its block's time gets one, and the epoch is not held", async () => {
  const world = new World();
  world.addRegisteredAgent();
  const now = world.data.nowSec;
  base = await healthyBase(now);
  oracle = await startOracle({
    world,
    env: env(base.url),
    files: { 'state.json': stateWith({}, { paymentScanState: { lastBlock: world.data.head, at: now * 1000 } }) },
  });
  await waitFor(/\[oracle\] epoch done/);
  assert.deepEqual(writes(), ['proposeScore']);
});

test("the scored chain's canary never looks for a payment that settled on a payment chain", async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  const now = world.data.nowSec;
  // Base's own canary finds it there, before FROM_BLOCK. The scored chain's would look for it in vain.
  const block = FINALIZED - 400;
  const payer = wallet();
  base = await startBase({
    blockTime: (n) => (n === FINALIZED ? now - 900 : now - 7200),
    logs: [transfer({ from: payer, to: agent.agentAddress, amount: 5_000_000n, block })],
  });
  const onBase = {
    ...history(now, 'base', [1])[0], chainId: BASE, blockNumber: block, payer, txHash: ethers.id(`tx-${block}-${agent.agentAddress}`),
  };
  oracle = await startOracle({
    world,
    env: env(base.url),
    files: { 'state.json': JSON.stringify({ schemaVersion: 2, paymentEvents: { [agent.didHash]: [onBase] } }) },
  });
  await waitFor(/\[oracle\] epoch done/);
  assert.doesNotMatch(oracle.logs(), /payment scan canary FAILED/);
  assert.match(oracle.logs(), /payment scan \d+-\d+: 0 credited, 0 skipped, canary unavailable/);
});

test('/evidence serves what counted by the cut-off, not all it holds', async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  const now = world.data.nowSec;
  base = await healthyBase(now);
  const [old] = history(now, 'old', [10]);
  const [justSettled] = history(now, 'fresh', [0]);
  const [youngOnBase] = history(now, 'young', [0.01]);
  oracle = await startOracle({
    world,
    env: env(base.url),
    files: { 'state.json': JSON.stringify({ schemaVersion: 2, paymentEvents: { [agent.didHash]: [old, justSettled, { ...youngOnBase, chainId: BASE }] } }) },
  });
  await waitFor(/\[oracle\] epoch done/);
  const ev = await oracle.call('GET', `/evidence/${agent.didHash}`);
  assert.deepEqual(ev.body.evidence.map((e) => e.txHash), [old.txHash]);
});

test("the external factor's reviewers are judged on the scored chain's payments only", async () => {
  const { snapshotOf } = require('./reviewers');
  const proposedExternal = async (chainId) => {
    const world = new World();
    const agent = world.addRegisteredAgent();
    const now = world.data.nowSec;
    const raters = Array.from({ length: 5 }, () => wallet().toLowerCase());
    const paidMs = snapshotOf(now) * 1000 - 3_600_000;
    const events = raters.map((payer, i) => ({
      payer, ts: paidMs - 2 * 3_600_000, amount: '1000000', txHash: ethers.id(`reviewer-${i}`), success: null,
      ...(chainId ? { chainId } : {}),
    }));
    world.set('externalOwns', true);
    world.set('externalFeedback', raters.map((client) => ({ client, value: 100, tag: 'quality' })));
    world.set('reviewers', Object.fromEntries(raters.map((r) => [r, {
      registered: true, operator: wallet(), status: 0, registeredAt: now - 365 * DAY, matured: 60, bonded: true,
    }])));
    world.set('funders', Object.fromEntries(raters.map((r) => [r, wallet().toLowerCase()])));
    base = await healthyBase(now);
    oracle = await startOracle({
      world,
      env: env(base.url),
      files: { 'state.json': JSON.stringify({ schemaVersion: 2, links: { [agent.didHash]: '7' }, paymentEvents: { [agent.didHash]: events } }) },
    });
    await waitFor(/\[oracle\] epoch done/);
    const proposal = oracle.calls().find((c) => c.name === 'proposeScore');
    assert.ok(proposal, oracle.logs());
    await oracle.stop();
    await base.stop();
    oracle = null;
    base = null;
    return proposal.args[1].externalScore;
  };
  assert.ok((await proposedExternal(null)) > 0, 'paid on the scored chain: they count');
  assert.equal(await proposedExternal(BASE), 0, 'paid on Base: they do not');
});

test("an RPC error that repeats the node's URL does not put its key in the log", async () => {
  const world = new World();
  world.addRegisteredAgent();
  base = await startBase({
    blockTime: () => world.data.nowSec - 900,
    logsFail: (server) => `upstream http://127.0.0.1:${server.address().port}/v2/SECRET-KEY refused the request`,
  });
  oracle = await startOracle({ world, env: env(base.url) });
  await waitFor(new RegExp(`payment chain ${BASE} scan failed`));
  assert.ok(!oracle.logs().includes('SECRET-KEY'), oracle.logs());
});
