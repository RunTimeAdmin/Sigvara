'use strict';

// Outcomes a payer signs for a payment on a payment chain (ADR 0009, section 7): the lookup on its own,
// then the real oracle process, the stubbed scored chain, and a JSON-RPC endpoint standing in for Base
// Sepolia that real ethers objects talk to.

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { ethers } = require('ethers');
const paymentChains = require('./payment-chains');
const payerOutcome = require('./payer-outcome');
const { World, startOracle, ASSET } = require('./test-support/oracle-harness');
const { TRANSFER_TOPIC } = require('./payments');

const BASE = 84532;
const SCORED = 5042;
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const ADMIN = 'a'.repeat(64);
const FINALIZED = 5_000;
const AMOUNT = 3_000_000n;
// The harness's REPUTATION_ADDRESS.
const REPUTATION = `0x${'33'.repeat(20)}`;
const BASE_DOMAIN = payerOutcome.domain(BASE, REPUTATION);
const SCORED_DOMAIN = payerOutcome.domain(SCORED, REPUTATION);
const MAGIC = `0x1626ba7e${'0'.repeat(56)}`;
const hex = (n) => `0x${BigInt(n).toString(16)}`;

/** Base Sepolia as far as the oracle asks: blocks, transactions, USDC logs, account code and ERC-1271. */
async function startBase({ now }) {
  const calls = [];
  const txs = [];
  const stub = {
    calls,
    finalized: FINALIZED,
    // The finalized block a quarter of an hour ago, the first one half an hour ago whatever has happened
    // since, so a signature checked there holds, and the payments before and after it old enough to score.
    blockTime: (n) => (n === stub.finalized ? now - 900 : n === FINALIZED ? now - 1800 : now - 7200),
    code: new Map(),
    answers1271: () => MAGIC,
    failing: new Set(),
  };
  const logsOf = (tx) => tx.transfers.map((t, i) => ({
    address: USDC,
    topics: [TRANSFER_TOPIC, ethers.zeroPadValue(t.from, 32), ethers.zeroPadValue(t.to, 32)],
    data: ethers.toBeHex(t.amount, 32),
    blockNumber: hex(tx.block),
    blockHash: ethers.id(`base-${tx.block}`),
    transactionHash: tx.hash,
    transactionIndex: '0x0',
    logIndex: hex(i),
    removed: false,
  }));
  stub.addTx = (transfers, block = FINALIZED - 100, hash = ethers.id(`base-tx-${Math.random()}`)) => {
    txs.push({ hash: hash.toLowerCase(), block, transfers });
    return hash;
  };
  const block = (n) => ({
    number: hex(n), hash: ethers.id(`base-${n}`), parentHash: ethers.id(`base-${n - 1}`),
    timestamp: hex(stub.blockTime(n)), nonce: '0x0000000000000000', difficulty: '0x0',
    gasLimit: hex(30_000_000), gasUsed: '0x0', miner: ethers.ZeroAddress, extraData: '0x',
    baseFeePerGas: '0x1', transactions: [],
  });
  const answer = (method, params) => {
    calls.push({ method, params });
    if (stub.failing.has(method)) throw new Error(`${method} refused`);
    switch (method) {
      case 'eth_chainId': return hex(BASE);
      case 'eth_blockNumber': return hex(stub.finalized + 80);
      case 'eth_getBlockByNumber': return block(params[0] === 'finalized' ? stub.finalized : Number(params[0]));
      case 'eth_getCode': return stub.code.get(params[0].toLowerCase()) ?? '0x';
      case 'eth_call': {
        const said = stub.answers1271(params[0].to, params[0].data, params[1]);
        if (said === null) throw Object.assign(new Error('execution reverted'), { rpcCode: 3 });
        return said;
      }
      case 'eth_getLogs': {
        const f = params[0];
        const wanted = new Set((f.topics?.[2] || []).map((t) => t.toLowerCase()));
        return txs.flatMap(logsOf).filter((l) => Number(l.blockNumber) >= Number(f.fromBlock)
          && Number(l.blockNumber) <= Number(f.toBlock) && wanted.has(l.topics[2].toLowerCase()));
      }
      case 'eth_getTransactionReceipt': {
        const tx = txs.find((t) => t.hash === params[0].toLowerCase());
        if (!tx) return null;
        return {
          transactionHash: tx.hash, transactionIndex: '0x0', blockHash: ethers.id(`base-${tx.block}`),
          blockNumber: hex(tx.block), from: ethers.ZeroAddress, to: USDC, cumulativeGasUsed: '0x1', gasUsed: '0x1',
          effectiveGasPrice: '0x1', contractAddress: null, logs: logsOf(tx), logsBloom: `0x${'00'.repeat(256)}`,
          status: '0x1', type: '0x2',
        };
      }
      default: throw new Error(`base stub: ${method}`);
    }
  };
  const respond = (r) => {
    try { return { jsonrpc: '2.0', id: r.id, result: answer(r.method, r.params) }; }
    catch (err) { return { jsonrpc: '2.0', id: r.id, error: { code: err.rpcCode ?? -32601, message: err.message } }; }
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
  stub.url = `http://127.0.0.1:${server.address().port}/v2/SECRET-KEY`;
  stub.stop = () => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); };
  return stub;
}

const env = (url, over = {}) => ({
  EXPECTED_CHAIN_ID: String(SCORED),
  PAYMENT_VERIFICATION: 'required',
  PAYMENT_ASSET: ASSET,
  PAYMENT_MIN_AMOUNT: '10000',
  PAYMENT_SCAN_ENABLED: '1',
  PAYMENT_SCAN_FROM_BLOCK: String(1_000_000 - 100),
  PAYMENT_SCAN_PACE_MS: '0',
  ORACLE_ADMIN_TOKEN: ADMIN,
  PAYER_OUTCOMES: 'positive',
  PAYER_OUTCOMES_PUBLISH: 'on',
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

const nowSec = () => Math.floor(Date.now() / 1000);
// ethers answers the same read from its cache for 250 ms, so a change in the stub shows after that.
const ethersCacheExpires = () => new Promise((r) => setTimeout(r, 300));

async function signOutcome(didHash, txHash, payer, { dom = BASE_DOMAIN, signedAt = nowSec(), deadline = nowSec() + 3_600 } = {}) {
  const value = { payer: payer.address, outcome: 1, evidence: ethers.ZeroHash, signedAt, deadline };
  const signature = await payer.signTypedData(dom, payerOutcome.TYPES, payerOutcome.message(didHash, txHash, value));
  return { ...value, signature };
}

describe('lookUpPayment', () => {
  const agent = { agentAddress: ethers.Wallet.createRandom().address, blockNumber: 7 };
  const payer = ethers.Wallet.createRandom().address;
  const txHash = ethers.id('a payment');
  const chain = paymentChains.readConfig({
    PAYMENT_CHAIN_IDS: String(BASE),
    [`PAYMENT_CHAIN_${BASE}_RPC_URL`]: 'https://rpc.example/SECRET-KEY',
    [`PAYMENT_CHAIN_${BASE}_ASSET`]: USDC,
    [`PAYMENT_CHAIN_${BASE}_FROM_BLOCK`]: '100',
    [`PAYMENT_CHAIN_${BASE}_FEE_UNIT`]: '100000000',
    [`PAYMENT_CHAIN_${BASE}_MIN_AMOUNT`]: '10000',
    [`PAYMENT_CHAIN_${BASE}_MODE`]: 'on',
  }).chains[0];

  function providers({
    block = 500, finalized = 600, chainId = BASE, codeHere = '0x', codeScored = '0x', receiptFails = null,
  } = {}) {
    const asked = [];
    const provider = {
      send: async () => hex(chainId),
      getTransactionReceipt: async () => {
        if (receiptFails) throw new Error(receiptFails);
        return {
          status: 1,
          blockNumber: block,
          logs: [{
            address: USDC,
            topics: [TRANSFER_TOPIC, ethers.zeroPadValue(payer, 32), ethers.zeroPadValue(agent.agentAddress, 32)],
            data: ethers.toBeHex(AMOUNT, 32),
          }],
        };
      },
      getBlockNumber: async () => finalized + 80,
      getBlock: async (tag) => (tag === 'finalized' ? { number: finalized, timestamp: 2_000 } : { number: tag, timestamp: 1_000 }),
      getCode: async (address, tag) => { asked.push(['here', tag]); return codeHere; },
    };
    const scoredProvider = { getCode: async (address, tag) => { asked.push(['scored', tag]); return codeScored; } };
    return { provider, scoredProvider, asked };
  }

  const lookUp = (p, registeredAtMs = 500_000) =>
    paymentChains.lookUpPayment(chain, { ...p, agent, registeredAtMs }, txHash);
  const refused = (code) => (err) => {
    assert.equal(err.code, code, err.message);
    assert.ok(!err.message.includes('SECRET-KEY'), err.message);
    return true;
  };

  test('takes a finalized payment, and reads the recipient at its block and at its registration', async () => {
    const p = providers();
    const credited = await lookUp(p);
    assert.equal(credited.legs.length, 1);
    assert.equal(credited.legs[0].payer, payer);
    assert.equal(credited.legs[0].amount, AMOUNT);
    assert.equal(credited.settledAt, 1_000_000);
    assert.deepEqual(p.asked.sort(), [['here', 500], ['scored', 7]]);
  });

  test('says a payment past the finalized block is not yet, and one before FROM_BLOCK never', async () => {
    await assert.rejects(lookUp(providers({ block: 601 })), refused('unconfirmed'));
    await assert.rejects(lookUp(providers({ block: 99 })), refused('before_from_block'));
  });

  test('refuses a payment before the agent registered, by the block\'s time', async () => {
    await assert.rejects(lookUp(providers(), 1_000_001), refused('before_registration'));
  });

  test('refuses a recipient with code on either chain, but not an EIP-7702 delegation', async () => {
    await assert.rejects(lookUp(providers({ codeHere: '0x6080' })), refused('contract_recipient'));
    await assert.rejects(lookUp(providers({ codeScored: '0x6080' })), refused('contract_recipient'));
    const delegation = `0xef0100${'ab'.repeat(20)}`;
    assert.ok(await lookUp(providers({ codeHere: delegation, codeScored: delegation })));
  });

  test('will not read an endpoint serving another chain, and keeps the URL out of a failed read', async () => {
    await assert.rejects(lookUp(providers({ chainId: 8453 })), refused('rpc_error'));
    await assert.rejects(lookUp(providers({ receiptFails: `bad https://rpc.example/SECRET-KEY` })), refused('rpc_error'));
  });
});

describe('the chain a request or a peer names', () => {
  test('chainIdOf reads none as null and anything but a chain id as undefined', () => {
    assert.equal(payerOutcome.chainIdOf(undefined), null);
    assert.equal(payerOutcome.chainIdOf(null), null);
    assert.equal(payerOutcome.chainIdOf(BASE), BASE);
    for (const bad of [0, -1, 1.5, '84532', {}, 2 ** 53]) assert.equal(payerOutcome.chainIdOf(bad), undefined);
  });

  test('parseServed carries it, and refuses an item whose chain is not a chain id', async () => {
    const payer = ethers.Wallet.createRandom();
    const didHash = ethers.id('did');
    const txHash = ethers.id('tx');
    const item = { didHash, txHash, ...(await signOutcome(didHash, txHash, payer)), checkedAtBlock: 5, acceptedAt: 1 };
    assert.equal(payerOutcome.parseServed(item).value.chainId, null);
    assert.equal(payerOutcome.parseServed({ ...item, chainId: BASE }).value.chainId, BASE);
    assert.equal(payerOutcome.parseServed({ ...item, chainId: '84532' }).ok, false);
  });
});

describe('POST /attest for a payment on a payment chain', () => {
  let oracle;
  let others = [];
  let base;

  afterEach(async () => {
    for (const o of [oracle, ...others]) if (o) await o.stop();
    if (base) await base.stop();
    oracle = null;
    others = [];
    base = null;
  });

  const post = (o, didHash, txHash, signed, chainId = BASE) => o.call('POST', '/attest', {
    didHash, payment: { txHash, ...(chainId === null ? {} : { chainId }) }, payerOutcome: signed,
  });
  const evidence = async (o, didHash) => (await o.call('GET', `/evidence/${didHash}`)).body.evidence;

  async function waitFor(o, re, n = 1) {
    const deadline = Date.now() + 20_000;
    while ((o.logs().match(new RegExp(re.source, 'g')) || []).length < n) {
      if (Date.now() > deadline) throw new Error(`never logged ${re} ${n} times:\n${o.logs()}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** One more epoch, once the oracle will take one. */
  async function nextEpoch(o) {
    const before = (o.logs().match(/\[oracle\] epoch done/g) || []).length;
    for (;;) {
      const r = await o.call('POST', '/epoch', undefined, ADMIN);
      if (r.status === 202) break;
      assert.equal(r.status, 409, r.text);
      await new Promise((res) => setTimeout(res, 50));
    }
    await waitFor(o, /\[oracle\] epoch done/, before + 1);
  }

  /** The oracle up with one registered agent, its first epoch over. */
  async function up(over = {}) {
    const world = new World();
    const agent = world.addRegisteredAgent();
    base = await startBase({ now: world.data.nowSec });
    oracle = await startOracle({ world, env: env(base.url, over) });
    await waitFor(oracle, /\[oracle\] epoch done/);
    return { world, agent };
  }

  test('takes an outcome signed in the domain of Base, checks it there, and serves it with its chain', async () => {
    const { agent } = await up();
    const payer = ethers.Wallet.createRandom();
    const txHash = base.addTx([{ from: payer.address, to: agent.agentAddress, amount: AMOUNT }], FINALIZED - 10);
    const signed = await signOutcome(agent.didHash, txHash, payer);

    const r = await post(oracle, agent.didHash, txHash, signed);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.outcomeSource, 'payer_signed');
    assert.equal(r.body.payment.chainId, BASE);
    assert.equal(r.body.outcomeHash, payerOutcome.outcomeHash(BASE_DOMAIN, agent.didHash, txHash, signed));

    const [e] = await evidence(oracle, agent.didHash);
    assert.equal(e.chainId, BASE);
    assert.equal(e.success, true);
    assert.equal(e.amount, AMOUNT.toString());
    assert.equal(e.outcomeSource, 'payer_signed');
    assert.equal(e.payerOutcome.signer, 'eoa');
    assert.equal(e.payerOutcome.checkedAtBlock, FINALIZED, 'the finalized block of Base, which a peer can read');

    const { outcomes } = (await oracle.call('GET', '/outcomes?since=0')).body;
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0].chainId, BASE);
    assert.equal(outcomes[0].txHash, txHash.toLowerCase());

    // A second one for the same leg gets the answer a carrier compares, in the same domain.
    const again = await post(oracle, agent.didHash, txHash, signed);
    assert.equal(again.status, 409);
    assert.equal(again.body.sameOutcome, true);
    assert.equal(again.body.heldOutcomeHash, r.body.outcomeHash);
  });

  test('counts it in the score once the payment is past the delay', async () => {
    const { agent } = await up();
    const payer = ethers.Wallet.createRandom();
    const txHash = base.addTx([{ from: payer.address, to: agent.agentAddress, amount: AMOUNT }], FINALIZED - 10);
    assert.equal((await post(oracle, agent.didHash, txHash, await signOutcome(agent.didHash, txHash, payer))).status, 200);
    const score = await oracle.call('GET', `/score/${agent.didHash}`);
    assert.equal(score.status, 200, score.text);
    assert.ok(score.body.weighted.attestations.successful > 0, score.text);
    assert.equal(score.body.weighted.attestations.successful, score.body.weighted.attestations.total);
  });

  test('refuses a signature made for another chain, in either direction', async () => {
    const { world, agent } = await up();
    const payer = ethers.Wallet.createRandom();
    const onBase = base.addTx([{ from: payer.address, to: agent.agentAddress, amount: AMOUNT }], FINALIZED - 10);
    const wrong = await signOutcome(agent.didHash, onBase, payer, { dom: SCORED_DOMAIN });
    const r = await post(oracle, agent.didHash, onBase, wrong);
    assert.equal(r.status, 400, r.text);
    assert.equal(r.body.code, 'bad_signature');

    const onScored = world.addTx([{ from: payer.address, to: agent.agentAddress, value: 5_000_000n }]);
    const other = await post(oracle, agent.didHash, onScored, await signOutcome(agent.didHash, onScored, payer), null);
    assert.equal(other.status, 400, other.text);
    assert.equal(other.body.code, 'bad_signature');
  });

  test('keeps a hash on two chains apart, one outcome each', async () => {
    const { world, agent } = await up();
    const payer = ethers.Wallet.createRandom();
    const txHash = world.addTx([{ from: payer.address, to: agent.agentAddress, value: 5_000_000n }]);
    base.addTx([{ from: payer.address, to: agent.agentAddress, amount: AMOUNT }], FINALIZED - 10, txHash);

    const scored = await signOutcome(agent.didHash, txHash, payer, { dom: SCORED_DOMAIN });
    assert.equal((await post(oracle, agent.didHash, txHash, scored, SCORED)).status, 200, 'naming the scored chain is leaving it out');
    assert.equal((await post(oracle, agent.didHash, txHash, await signOutcome(agent.didHash, txHash, payer))).status, 200);

    const { outcomes } = (await oracle.call('GET', '/outcomes?since=0')).body;
    assert.deepEqual(outcomes.map((o) => o.chainId ?? null), [null, BASE]);
    assert.ok(outcomes.every((o) => o.txHash === txHash.toLowerCase()));
  });

  test('says "not yet" with a 503 until the payment is finalized, so a carrier sends it again', async () => {
    const { agent } = await up();
    const payer = ethers.Wallet.createRandom();
    const txHash = base.addTx([{ from: payer.address, to: agent.agentAddress, amount: AMOUNT }], FINALIZED + 10);
    const signed = await signOutcome(agent.didHash, txHash, payer);

    const early = await post(oracle, agent.didHash, txHash, signed);
    assert.equal(early.status, 503, early.text);
    assert.equal(early.body.code, 'unconfirmed');

    const unknown = await post(oracle, agent.didHash, ethers.id('not mined'), signed);
    assert.equal(unknown.status, 503, unknown.text);
    assert.equal(unknown.body.code, 'not_found');

    base.finalized = FINALIZED + 20;
    await ethersCacheExpires();
    assert.equal((await post(oracle, agent.didHash, txHash, signed)).status, 200);
  });

  test('says "not yet" for an agent the registry scan has not reached', async () => {
    const { world } = await up();
    const late = world.addAgent();
    const payer = ethers.Wallet.createRandom();
    const txHash = base.addTx([{ from: payer.address, to: late.agentAddress, amount: AMOUNT }], FINALIZED - 10);
    const r = await post(oracle, late.didHash, txHash, await signOutcome(late.didHash, txHash, payer));
    assert.equal(r.status, 503, r.text);
    assert.equal(r.body.code, 'agent_not_seen');
  });

  test('refuses what cannot count: a chain not on, a bad chain id, a chain id with no signed outcome', async () => {
    const { agent } = await up({ [`PAYMENT_CHAIN_${BASE}_MODE`]: 'shadow' });
    const payer = ethers.Wallet.createRandom();
    const txHash = base.addTx([{ from: payer.address, to: agent.agentAddress, amount: AMOUNT }], FINALIZED - 10);
    const signed = await signOutcome(agent.didHash, txHash, payer);

    const shadow = await post(oracle, agent.didHash, txHash, signed);
    assert.equal(shadow.status, 400, shadow.text);
    assert.equal(shadow.body.code, 'payment_chain_off');
    assert.equal((await post(oracle, agent.didHash, txHash, signed, 8453)).body.code, 'payment_chain_off');
    assert.equal((await post(oracle, agent.didHash, txHash, signed, '84532')).body.code, 'bad_chain_id');

    const noOutcome = await oracle.call('POST', '/attest', { didHash: agent.didHash, payment: { txHash, chainId: BASE } });
    assert.equal(noOutcome.status, 400, noOutcome.text);
    assert.equal(noOutcome.body.code, 'bad_chain_id');
  });

  test('refuses a payment to an agent registered at a contract, as the scan skips it', async () => {
    const { agent } = await up();
    const payer = ethers.Wallet.createRandom();
    base.code.set(agent.agentAddress.toLowerCase(), '0x6080');
    const txHash = base.addTx([{ from: payer.address, to: agent.agentAddress, amount: AMOUNT }], FINALIZED - 10);
    const r = await post(oracle, agent.didHash, txHash, await signOutcome(agent.didHash, txHash, payer));
    assert.equal(r.status, 402, r.text);
    assert.equal(r.body.code, 'contract_recipient');
    assert.equal((await evidence(oracle, agent.didHash)).length, 0);
  });

  test('asks a smart wallet on Base, at the finalized block, and takes its "no"', async () => {
    const { agent } = await up();
    const smartWallet = ethers.Wallet.createRandom().address;
    base.code.set(smartWallet.toLowerCase(), '0x6080');
    const asked = [];
    base.answers1271 = (to, data, tag) => { asked.push({ to: to.toLowerCase(), tag }); return MAGIC; };
    const txHash = base.addTx([{ from: smartWallet, to: agent.agentAddress, amount: AMOUNT }], FINALIZED - 10);
    const value = { payer: smartWallet, outcome: 1, evidence: ethers.ZeroHash, signedAt: nowSec(), deadline: nowSec() + 3_600 };

    const r = await post(oracle, agent.didHash, txHash, { ...value, signature: '0x1234' });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(asked, [{ to: smartWallet.toLowerCase(), tag: hex(FINALIZED) }]);
    assert.equal((await evidence(oracle, agent.didHash))[0].payerOutcome.signer, 'contract');

    const other = base.addTx([{ from: smartWallet, to: agent.agentAddress, amount: AMOUNT }], FINALIZED - 9);
    base.answers1271 = () => null;
    const no = await post(oracle, agent.didHash, other, { ...value, signature: '0x1234' });
    assert.equal(no.status, 400, no.text);
    assert.equal(no.body.code, 'bad_signature');
  });

  test('puts the outcome on the payment the scan credited, and the scan credits one posted first only once', async () => {
    const { agent } = await up();
    const payer = ethers.Wallet.createRandom();

    // Found by the scan, then signed for.
    const scanned = base.addTx([{ from: payer.address, to: agent.agentAddress, amount: AMOUNT }], FINALIZED + 5);
    base.finalized = FINALIZED + 10;
    await ethersCacheExpires();
    await nextEpoch(oracle);
    const [found] = await evidence(oracle, agent.didHash);
    assert.equal(found.success, null);
    assert.equal((await post(oracle, agent.didHash, scanned, await signOutcome(agent.didHash, scanned, payer))).status, 200);
    const list = await evidence(oracle, agent.didHash);
    assert.equal(list.length, 1);
    assert.equal(list[0].success, true);

    // Signed for, then reached by the scan.
    const other = ethers.Wallet.createRandom();
    const posted = base.addTx([{ from: other.address, to: agent.agentAddress, amount: AMOUNT }], FINALIZED + 15);
    base.finalized = FINALIZED + 20;
    await ethersCacheExpires();
    assert.equal((await post(oracle, agent.didHash, posted, await signOutcome(agent.didHash, posted, other))).status, 200);
    await nextEpoch(oracle);
    const after = await evidence(oracle, agent.didHash);
    assert.equal(after.length, 2);
    assert.ok(after.every((e) => e.success === true));
    assert.equal((await oracle.call('GET', '/health')).body.paymentChains[0].lastScan.reasons.already_credited, 1);
  });

  test('keeps the RPC URL out of every log and reply when Base cannot be read', async () => {
    const { agent } = await up();
    const payer = ethers.Wallet.createRandom();
    const txHash = base.addTx([{ from: payer.address, to: agent.agentAddress, amount: AMOUNT }], FINALIZED - 10);
    const signed = await signOutcome(agent.didHash, txHash, payer);

    for (const method of ['eth_getTransactionReceipt', 'eth_getCode', 'eth_getBlockByNumber']) {
      base.failing = new Set([method]);
      await ethersCacheExpires();
      const r = await post(oracle, agent.didHash, txHash, signed);
      assert.equal(r.status, 502, `${method}: ${r.text}`);
      assert.equal(r.body.code, 'rpc_error');
      assert.ok(!r.text.includes('SECRET-KEY'));
    }
    assert.ok(!oracle.logs().includes('SECRET-KEY'), oracle.logs());
    base.failing = new Set();
    await ethersCacheExpires();
    assert.equal((await post(oracle, agent.didHash, txHash, signed)).status, 200);
  });

  test('refuses to judge a deadline by a finalized block older than the chain\'s delay', async () => {
    const { world, agent } = await up();
    const payer = ethers.Wallet.createRandom();
    const txHash = base.addTx([{ from: payer.address, to: agent.agentAddress, amount: AMOUNT }], FINALIZED - 10);
    base.blockTime = () => world.data.nowSec - 7200;
    await ethersCacheExpires();
    const r = await post(oracle, agent.didHash, txHash, await signOutcome(agent.didHash, txHash, payer));
    assert.equal(r.status, 502, r.text);
    assert.equal(r.body.code, 'rpc_error');
  });

  test('an operator imports a Base outcome from its peer, at the block the peer recorded, and serves it on', async () => {
    const { world, agent } = await up();
    const peer = `http://127.0.0.1:${oracle.port}`;
    const b = await startOracle({ world, env: env(base.url, { PAYER_OUTCOMES_PEERS: peer }) });
    const shadowed = await startOracle({
      world,
      env: env(base.url, { PAYER_OUTCOMES_PEERS: peer, [`PAYMENT_CHAIN_${BASE}_MODE`]: 'shadow' }),
    });
    others = [b, shadowed];
    const files = [oracle, b, shadowed].map((o) => path.join(o.dir, 'world.json'));
    world.flush = function flush() {
      for (const f of files) fs.writeFileSync(f, JSON.stringify(this.data));
    };
    world.flush();
    await waitFor(b, /\[oracle\] epoch done/);
    await waitFor(shadowed, /\[oracle\] epoch done/);

    const payer = ethers.Wallet.createRandom();
    const txHash = base.addTx([{ from: payer.address, to: agent.agentAddress, amount: AMOUNT }], FINALIZED - 10);
    assert.equal((await post(oracle, agent.didHash, txHash, await signOutcome(agent.didHash, txHash, payer))).status, 200);
    const [taken] = await evidence(oracle, agent.didHash);

    // Finality moves on before the import, which must still read the block the peer recorded.
    base.finalized = FINALIZED + 50;
    await ethersCacheExpires();
    await nextEpoch(b);
    assert.match(b.logs(), new RegExp(`payer outcomes from ${peer}: 1 imported, 0 refused`));
    const [e] = await evidence(b, agent.didHash);
    assert.equal(e.chainId, BASE);
    assert.equal(e.success, true);
    assert.equal(e.leaf, taken.leaf, 'the same leaf on both operators');
    assert.equal(e.payerOutcome.checkedAtBlock, FINALIZED);
    assert.equal((await b.call('GET', '/outcomes?since=0')).body.outcomes[0].chainId, BASE);

    // An operator that has this chain in shadow counts nothing from it.
    await nextEpoch(shadowed);
    assert.match(shadowed.logs(), /payment_chain_off/);
    assert.equal((await evidence(shadowed, agent.didHash)).length, 0);
  });

  test('an import while this node cannot reach Base passes nothing over, and takes everything once it can', async () => {
    const { world, agent } = await up();
    const peer = `http://127.0.0.1:${oracle.port}`;
    const b = await startOracle({ world, env: env(base.url, { PAYER_OUTCOMES_PEERS: peer }) });
    others = [b];
    const files = [oracle, b].map((o) => path.join(o.dir, 'world.json'));
    world.flush = function flush() {
      for (const f of files) fs.writeFileSync(f, JSON.stringify(this.data));
    };
    world.flush();
    await waitFor(b, /\[oracle\] epoch done/);

    const payers = [ethers.Wallet.createRandom(), ethers.Wallet.createRandom()];
    for (const payer of payers) {
      const txHash = base.addTx([{ from: payer.address, to: agent.agentAddress, amount: AMOUNT }], FINALIZED - 10);
      assert.equal((await post(oracle, agent.didHash, txHash, await signOutcome(agent.didHash, txHash, payer))).status, 200);
    }
    const runs = /payer outcomes from http:\/\/127\.0\.0\.1:\d+:/;
    async function importRun() {
      const before = (b.logs().match(new RegExp(runs.source, 'g')) || []).length;
      for (;;) {
        const r = await b.call('POST', '/epoch', undefined, ADMIN);
        if (r.status === 202) break;
        assert.equal(r.status, 409, r.text);
        await new Promise((res) => setTimeout(res, 50));
      }
      await waitFor(b, runs, before + 1);
    }

    // Base answers nothing to this node for three runs, one more than an outcome may stall.
    for (const m of ['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getTransactionReceipt', 'eth_getCode', 'eth_call', 'eth_getLogs']) base.failing.add(m);
    await ethersCacheExpires();
    for (let i = 0; i < 3; i += 1) await importRun();
    assert.doesNotMatch(b.logs(), /passing over/);
    assert.match(b.logs(), /stopped early \(rpc_down\)/);

    base.failing.clear();
    await ethersCacheExpires();
    await importRun();
    const held = (await evidence(b, agent.didHash)).filter((e) => e.outcomeSource === 'payer_signed');
    assert.equal(held.length, 2, 'both outcomes taken once Base answers');
  });
});
