'use strict';

// Who counts as an agent's own operator on a payment chain (ADR 0009, section 7). Its blocks are not the
// scored chain's, so a payment there is not judged by the operator of its block. An address named the agent's
// operator, at registration or by OperatorTransferred, is refused at the time of its payment and stops counting
// from when it was named, so two operators whose registry scans have read different amounts of the scored chain
// still hold the same evidence for any cut-off.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { ethers } = require('ethers');
const pc = require('./payment-chains');
const paymentScan = require('./payment-scan');
const merkle = require('./merkle');
const chain = require('./chain');
const payerOutcome = require('./payer-outcome');
const { evidenceAsOf } = require('./evidence-as-of');
const { TRANSFER_TOPIC } = require('./payments');
const { World, startOracle, ASSET } = require('./test-support/oracle-harness');

const BASE = 84532;
const ARC = 5042002;
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const HOUR = 3_600_000;
// Block n of the fake Base is at T0 + n seconds.
const T0 = 1_700_000_000;
const timeOf = (block) => (T0 + block) * 1000;

const cfg = pc.readConfig({
  PAYMENT_CHAIN_IDS: String(BASE),
  [`PAYMENT_CHAIN_${BASE}_RPC_URL`]: 'https://base-sepolia.example/v2/SECRET-KEY',
  [`PAYMENT_CHAIN_${BASE}_ASSET`]: USDC,
  [`PAYMENT_CHAIN_${BASE}_FROM_BLOCK`]: '1000',
  [`PAYMENT_CHAIN_${BASE}_FEE_UNIT`]: '100000000',
  [`PAYMENT_CHAIN_${BASE}_MIN_AMOUNT`]: '10000',
  [`PAYMENT_CHAIN_${BASE}_MODE`]: 'on',
}, { scoredChainId: ARC });

const pad = (a) => ethers.zeroPadValue(a, 32);
const transferLog = ({ from, to, amount = 1_000_000n, block }) => ({
  address: USDC, topics: [TRANSFER_TOPIC, pad(from), pad(to)], data: ethers.toBeHex(amount, 32),
  blockNumber: block, transactionHash: ethers.id(`tx-${block}-${from}`), logIndex: 0, removed: false,
});

function fakeBase(logs) {
  return {
    send: async (method) => { if (method === 'eth_chainId') return ethers.toQuantity(BASE); throw new Error(method); },
    getBlock: async (tag) => {
      const n = tag === 'finalized' ? 2000 : tag;
      return { number: n, timestamp: T0 + n };
    },
    getLogs: async (f) => {
      const wanted = new Set((f.topics[2] || []).map((t) => t.toLowerCase()));
      return logs.filter((l) => l.blockNumber >= f.fromBlock && l.blockNumber <= f.toBlock && wanted.has(l.topics[2].toLowerCase()));
    },
    getCode: async () => '0x',
  };
}

/** One operator's scan of Base, with the agent as its registry scan holds it, and what it credited as stored events. */
async function scanAs(agent, logs, reachMs) {
  const credited = [];
  const out = await pc.scanChain(cfg.chains[0], {
    provider: fakeBase(logs),
    scoredProvider: { getCode: async () => '0x' },
    agents: [agent],
    state: null,
    isCredited: () => false,
    credit: (c, ts) => { credited.push(Object.freeze({ chainId: BASE, txHash: c.txHash.toLowerCase(), payer: c.payer, amount: c.amount, ts, success: null })); return true; },
    registeredAtMs: async () => 0,
    knownOnChain: new Map(),
    read: (_label, fn) => fn(),
    sleep: async () => {},
    reachMs,
  });
  return { out, credited, payers: credited.map((e) => e.payer.toLowerCase()).sort() };
}

const wallets = () => {
  const [a, b, c] = [0, 1, 2].map(() => ethers.Wallet.createRandom().address);
  return { a, b, c, didHash: ethers.id(`agent-${a}`), agentAddress: ethers.Wallet.createRandom().address };
};
// The handover from A to B on the scored chain, by its block's time: well after every payment below is old enough
// to count, so a payment B made before it counts for a while.
const HANDOVER_MS = timeOf(1500) + 5 * HOUR;
/** The agent as a registry scan holds it before it has read the handover, and after. */
const before = (w) => ({ didHash: w.didHash, agentAddress: w.agentAddress, operator: w.a, blockNumber: 10 });
const after = (w) => ({
  ...before(w), operator: w.b,
  operators: [{ fromBlock: 10, operator: w.a }, { fromBlock: 900, operator: w.b, atMs: HANDOVER_MS }],
});

// ---- the attack: a former operator's payment, scanned after it handed the agent on ----------------------------

test("a former operator's payment to its agent, scanned after the handover, is refused as its own", async () => {
  const w = wallets();
  // A pays its own agent while it operates it, hands it to B, and the Base scan only reaches the payment after
  // the registry scan has read the handover. Judged by today's operator, A looked like a customer.
  const logs = [transferLog({ from: w.a, to: w.agentAddress, block: 1500 })];
  const { out, credited } = await scanAs(after(w), logs, HANDOVER_MS + HOUR);
  assert.deepEqual(credited, [], "a former operator's payment is not a customer's");
  assert.equal(out.reasons.self_payment, 1);
});

test('the new operator is refused for what it paid once named, and what it paid before stops counting then', async () => {
  const w = wallets();
  const logs = [
    transferLog({ from: w.b, to: w.agentAddress, block: 1500 }),
    // B's own payment after it was named: 1500 + 5 h + 2 min of fake Base blocks.
    transferLog({ from: w.b, to: w.agentAddress, block: 1500 + 5 * 3600 + 120 }),
  ];
  const fake = fakeBase(logs);
  const realGetBlock = fake.getBlock;
  fake.getBlock = async (tag) => (tag === 'finalized' ? { number: 30_000, timestamp: T0 + 30_000 } : realGetBlock(tag));
  const credited = [];
  const big = { ...cfg.chains[0], maxBlocks: 100_000 };
  const out = await pc.scanChain(big, {
    provider: fake, scoredProvider: { getCode: async () => '0x' }, agents: [after(w)], state: null,
    isCredited: () => false, credit: (c, ts) => { credited.push(Object.freeze({ chainId: BASE, txHash: c.txHash, payer: c.payer, amount: c.amount, ts, success: null })); return true; },
    registeredAtMs: async () => 0, knownOnChain: new Map(), read: (_l, fn) => fn(), sleep: async () => {},
  });
  assert.equal(out.reasons.self_payment, 1, 'B paying after it was named is refused');
  assert.deepEqual(credited.map((e) => e.ts), [timeOf(1500)], 'B paying before it was named is a payment');

  const named = paymentScan.operatorsNamedAt(after(w));
  const namedAt = (payer) => named.get(payer.toLowerCase());
  const events = Object.freeze(credited);
  assert.equal(pc.eventsAt(events, HANDOVER_MS - 60_000, cfg, namedAt).length, 1, 'it counts until B is named');
  assert.equal(pc.eventsAt(events, HANDOVER_MS, cfg, namedAt).length, 0, 'and not from then on');
  assert.equal(pc.eventsAt(events, HANDOVER_MS + HOUR, cfg, namedAt), pc.eventsAt(events, HANDOVER_MS + HOUR, cfg, namedAt),
    'the same answer is the same array, so the evidence and root caches still hit');
  assert.equal(pc.eventsAt(events, HANDOVER_MS - 60_000, cfg).length, 1, 'and an answer left out for its payer is not kept for one that is not');
});

test('an address that was never the operator still counts, before and after a handover', async () => {
  const w = wallets();
  const logs = [transferLog({ from: w.c, to: w.agentAddress, block: 1500 })];
  const { credited } = await scanAs(after(w), logs, HANDOVER_MS + HOUR);
  assert.equal(credited.length, 1);
  const named = paymentScan.operatorsNamedAt(after(w));
  const namedAt = (payer) => named.get(payer.toLowerCase());
  for (const cut of [HANDOVER_MS - 60_000, HANDOVER_MS, HANDOVER_MS + 24 * HOUR]) {
    assert.equal(pc.eventsAt(Object.freeze(credited), cut, cfg, namedAt).length, 1);
  }
});

// ---- two operators ---------------------------------------------------------------------------------------------

test('two operators, one scanning Base before it reads the handover and one after, commit to the same root', async () => {
  const w = wallets();
  const logs = [
    transferLog({ from: w.a, to: w.agentAddress, block: 1500 }),
    transferLog({ from: w.b, to: w.agentAddress, block: 1510 }),
    transferLog({ from: w.c, to: w.agentAddress, block: 1520 }),
  ];
  // The primary's registry scan had not reached the handover when its Base scan ran; the checker's had.
  const primary = await scanAs(before(w), logs, timeOf(1999));
  const checker = await scanAs(after(w), logs, HANDOVER_MS + HOUR);
  assert.deepEqual(primary.payers, checker.payers, 'both hold the same payments, whenever their registry scans read the handover');
  assert.deepEqual(primary.payers, [w.b, w.c].map((x) => x.toLowerCase()).sort());

  // By the time either scores, its registry scan has passed the cut-off (the scored chain's scan stops at its reach).
  const named = paymentScan.operatorsNamedAt(after(w));
  const namedAt = (payer) => named.get(payer.toLowerCase());
  for (const cut of [timeOf(1520) + 2 * HOUR, HANDOVER_MS - 60_000, HANDOVER_MS, HANDOVER_MS + 2 * HOUR]) {
    const p = pc.eventsAt(Object.freeze(primary.credited), cut, cfg, namedAt);
    const c = pc.eventsAt(Object.freeze(checker.credited), cut, cfg, namedAt);
    assert.equal(merkle.rootFor(p), merkle.rootFor(c), `the same root at ${cut}`);
    assert.equal(p.length, cut < HANDOVER_MS ? 2 : 1);
  }

  // A checker auditing a proposal whose cut-off came before the handover and whose transaction landed after it
  // finds the root the proposal committed to, and one cut after the handover too.
  const atProposalMs = HANDOVER_MS + 20 * 60_000;
  const options = {
    eligibleAt: (e) => pc.eligibleAtMs(e, cfg),
    endsAt: (e) => (e.chainId == null ? Infinity : namedAt(e.payer) ?? Infinity),
    cuts: pc.auditCuts(atProposalMs, cfg),
  };
  const held = pc.eventsAt(Object.freeze(checker.credited), atProposalMs, cfg);
  const early = merkle.rootFor(pc.eventsAt(Object.freeze(primary.credited), HANDOVER_MS - 5 * 60_000, cfg, namedAt));
  assert.equal(evidenceAsOf(held, atProposalMs, early, options).matchedRoot, true, 'a cut-off before the handover');
  const late = merkle.rootFor(pc.eventsAt(Object.freeze(primary.credited), HANDOVER_MS + 5 * 60_000, cfg, namedAt));
  const got = evidenceAsOf(held, atProposalMs, late, options);
  assert.equal(got.matchedRoot, true, 'a cut-off after it');
  assert.equal(got.events.length, 1);
});

test('the registry scan keeps the time of each operator change, and reads it for one kept without', async () => {
  chain.reset();
  const logs = [
    { args: { didHash: '0xdid1', agentAddress: '0xagent1', operator: '0xa' }, blockNumber: 110, eventName: 'AgentRegistered' },
    { args: { didHash: '0xdid1', from: '0xa', to: '0xc' }, blockNumber: 150, eventName: 'OperatorTransferred' },
  ];
  const identityContract = { filters: {}, queryFilter: async (_f, a, b) => logs.filter((l) => l.blockNumber >= a && l.blockNumber <= b) };
  const provider = { getBlockNumber: async () => 199, getBlock: async (n) => ({ number: n, timestamp: T0 + n }) };
  const start = () => chain.init(
    { rpcUrl: 'x', privateKey: '0x' + '1'.repeat(64), identityAddress: '0x' + '1'.repeat(40),
      reputationAddress: '0x' + '2'.repeat(40), fromBlock: 100, logChunkSize: 1000 },
    { provider, wallet: {}, identityContract, reputationContract: {} },
  );
  start();
  const [one] = await chain.getRegisteredAgents();
  assert.deepEqual(one.operators, [{ fromBlock: 110, operator: '0xa' }, { fromBlock: 150, operator: '0xc', atMs: timeOf(150) }]);

  // A state saved before the time was kept.
  chain.reset();
  chain.restoreScanState({ lastScannedBlock: 199, agents: [{ ...one, operators: [{ fromBlock: 110, operator: '0xa' }, { fromBlock: 150, operator: '0xc' }] }] });
  start();
  const [again] = await chain.getRegisteredAgents();
  assert.equal(again.operators[1].atMs, timeOf(150));
});

// ---- the real oracle -----------------------------------------------------------------------------------------

const FINALIZED = 5_000;
const hex = (n) => `0x${BigInt(n).toString(16)}`;

/** Base Sepolia as far as the oracle asks of it here. */
async function startBase(now, txs) {
  const logsOf = (tx) => [{
    address: USDC, topics: [TRANSFER_TOPIC, pad(tx.from), pad(tx.to)], data: ethers.toBeHex(3_000_000n, 32),
    blockNumber: hex(tx.block), blockHash: ethers.id(`base-${tx.block}`), transactionHash: tx.hash,
    transactionIndex: '0x0', logIndex: '0x0', removed: false,
  }];
  const block = (n) => ({
    number: hex(n), hash: ethers.id(`base-${n}`), parentHash: ethers.id(`base-${n - 1}`),
    timestamp: hex(n === FINALIZED ? now - 900 : now - 7200), nonce: '0x0000000000000000', difficulty: '0x0',
    gasLimit: hex(30_000_000), gasUsed: '0x0', miner: ethers.ZeroAddress, extraData: '0x', baseFeePerGas: '0x1', transactions: [],
  });
  const answer = (method, params) => {
    switch (method) {
      case 'eth_chainId': return hex(BASE);
      case 'eth_blockNumber': return hex(FINALIZED + 80);
      case 'eth_getBlockByNumber': return block(params[0] === 'finalized' ? FINALIZED : Number(params[0]));
      case 'eth_getCode': return '0x';
      case 'eth_getLogs': {
        const f = params[0];
        const wanted = new Set((f.topics?.[2] || []).map((t) => t.toLowerCase()));
        return txs.flatMap(logsOf).filter((l) => Number(l.blockNumber) >= Number(f.fromBlock)
          && Number(l.blockNumber) <= Number(f.toBlock) && wanted.has(l.topics[2].toLowerCase()));
      }
      case 'eth_getTransactionReceipt': {
        const tx = txs.find((t) => t.hash === params[0].toLowerCase());
        return tx && {
          transactionHash: tx.hash, transactionIndex: '0x0', blockHash: ethers.id(`base-${tx.block}`), blockNumber: hex(tx.block),
          from: ethers.ZeroAddress, to: USDC, cumulativeGasUsed: '0x1', gasUsed: '0x1', effectiveGasPrice: '0x1',
          contractAddress: null, logs: logsOf(tx), logsBloom: `0x${'00'.repeat(256)}`, status: '0x1', type: '0x2',
        };
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
    stop: () => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); },
  };
}

test("the oracle neither credits nor serves a former operator's Base payment, nor takes its outcome", async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  const now = world.data.nowSec;
  const former = ethers.Wallet.createRandom();
  const next = ethers.Wallet.createRandom().address;
  const customer = ethers.Wallet.createRandom().address;
  // Registered by the former operator, handed to the next an hour ago, after both payments.
  Object.assign(world.data.agents[agent.didHash], {
    operator: next,
    operators: [{ fromBlock: 1, operator: former.address }, { fromBlock: world.data.head - 100, operator: next, atMs: (now - 3600) * 1000 }],
  });
  world.flush();
  const txs = [
    { hash: ethers.id('from the former operator'), from: former.address, to: agent.agentAddress, block: FINALIZED - 100 },
    { hash: ethers.id('from a customer'), from: customer, to: agent.agentAddress, block: FINALIZED - 90 },
  ];
  const base = await startBase(now, txs);
  let oracle;
  try {
    oracle = await startOracle({
      world,
      env: {
        EXPECTED_CHAIN_ID: '5042', PAYMENT_VERIFICATION: 'required', PAYMENT_ASSET: ASSET, PAYMENT_MIN_AMOUNT: '10000',
        PAYMENT_SCAN_ENABLED: '1', PAYMENT_SCAN_FROM_BLOCK: String(1_000_000 - 100), PAYMENT_SCAN_PACE_MS: '0',
        PAYER_OUTCOMES: 'positive', PAYMENT_CHAIN_IDS: String(BASE),
        [`PAYMENT_CHAIN_${BASE}_RPC_URL`]: base.url, [`PAYMENT_CHAIN_${BASE}_ASSET`]: USDC,
        [`PAYMENT_CHAIN_${BASE}_FROM_BLOCK`]: String(FINALIZED - 300), [`PAYMENT_CHAIN_${BASE}_FEE_UNIT`]: '100000000',
        [`PAYMENT_CHAIN_${BASE}_MIN_AMOUNT`]: '10000', [`PAYMENT_CHAIN_${BASE}_PACE_MS`]: '0', [`PAYMENT_CHAIN_${BASE}_MODE`]: 'on',
      },
    });
    const deadline = Date.now() + 20_000;
    while (!/\[oracle\] epoch done/.test(oracle.logs())) {
      if (Date.now() > deadline) throw new Error(`no epoch:\n${oracle.logs()}`);
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.match(oracle.logs(), new RegExp(`payment chain ${BASE} \\(on\\) \\d+-\\d+: 1 credited, 1 skipped \\(\\{"self_payment":1\\}\\)`));
    const served = (await oracle.call('GET', `/evidence/${agent.didHash}`)).body.evidence;
    assert.deepEqual(served.map((e) => e.payer.toLowerCase()), [customer.toLowerCase()], "only the customer's payment is evidence");

    const value = { payer: former.address, outcome: 1, evidence: ethers.ZeroHash, signedAt: Math.floor(Date.now() / 1000), deadline: Math.floor(Date.now() / 1000) + 3600 };
    const signature = await former.signTypedData(payerOutcome.domain(BASE, `0x${'33'.repeat(20)}`), payerOutcome.TYPES,
      payerOutcome.message(agent.didHash, txs[0].hash, value));
    const r = await oracle.call('POST', '/attest', {
      didHash: agent.didHash, payment: { txHash: txs[0].hash, chainId: BASE }, payerOutcome: { ...value, signature },
    });
    assert.equal(r.status, 402, r.text);
    assert.equal(r.body.code, 'self_payment');
  } finally {
    if (oracle) await oracle.stop();
    await base.stop();
  }
});
