'use strict';

// How much a payment chain's endpoint can make the oracle read. Its answer is read only up to 8 MiB, and a
// log read is taken only up to 10,000 logs, before anything in it is used. Past either, a log read is asked
// for in halves, as a span the endpoint refused is, and any other read fails with that error. A block that
// stays too big fails the scan, so its cursor never moves past blocks it has not read.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const { ethers } = require('ethers');
const pc = require('./payment-chains');
const { readWithBackoff } = require('./read-retry');
const { TRANSFER_TOPIC } = require('./payments');

const BASE_SEPOLIA = 84532;
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const PAYER = '0x00000000000000000000000000000000000000aa';
const MIB = 1024 * 1024;
const hex = (n) => ethers.toQuantity(n);
const pad = (a) => ethers.zeroPadValue(a, 32);
const blockHash = (n) => ethers.toBeHex(n + 1, 32);

function block(n) {
  return {
    hash: blockHash(n), parentHash: blockHash(n - 1), number: hex(n), timestamp: hex(1_700_000_000 + n),
    nonce: '0x0000000000000000', difficulty: '0x0', gasLimit: '0x1c9c380', gasUsed: '0x0',
    miner: ethers.ZeroAddress, extraData: '0x', baseFeePerGas: '0x1', transactions: [],
  };
}

function transferLog(to, amount, n, i = 0) {
  return {
    address: USDC, topics: [TRANSFER_TOPIC, pad(PAYER), pad(to)], data: ethers.toBeHex(amount, 32),
    blockNumber: hex(n), blockHash: blockHash(n), transactionHash: ethers.id(`${n}/${i}`),
    transactionIndex: '0x0', logIndex: hex(i), removed: false,
  };
}

/**
 * Base Sepolia at 127.0.0.1. `logsAnswer(from, to)` is the JSON a getLogs answers with, and `answer[method]`
 * the headers and raw body for anything else it should answer oddly. `asked` holds every span asked for, and
 * `head.finalized` can be moved on.
 */
async function endpoint({ logsAnswer = () => '[]', answer = {} } = {}) {
  const asked = [];
  const head = { finalized: 1199 };
  const reply = (r, result) => `{"jsonrpc":"2.0","id":${JSON.stringify(r.id)},"result":${result}}`;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const r = JSON.parse(body);
      if (answer[r.method]) {
        const [headers, out] = answer[r.method](r);
        res.writeHead(200, { 'Content-Type': 'application/json', ...headers });
        res.end(out);
        return;
      }
      let result = 'null';
      if (r.method === 'eth_chainId') result = JSON.stringify(hex(BASE_SEPOLIA));
      if (r.method === 'eth_getBlockByNumber') result = JSON.stringify(block(r.params[0] === 'finalized' ? head.finalized : Number(r.params[0])));
      if (r.method === 'eth_getCode') result = '"0x"';
      if (r.method === 'eth_getLogs') {
        const [from, to] = [Number(r.params[0].fromBlock), Number(r.params[0].toBlock)];
        asked.push([from, to]);
        result = logsAnswer(from, to);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(reply(r, result));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const chain = pc.readConfig({
    PAYMENT_CHAIN_IDS: String(BASE_SEPOLIA),
    [`PAYMENT_CHAIN_${BASE_SEPOLIA}_RPC_URL`]: `http://127.0.0.1:${server.address().port}/v2/SECRET-KEY`,
    [`PAYMENT_CHAIN_${BASE_SEPOLIA}_ASSET`]: USDC,
    [`PAYMENT_CHAIN_${BASE_SEPOLIA}_FROM_BLOCK`]: '1000',
    [`PAYMENT_CHAIN_${BASE_SEPOLIA}_FEE_UNIT`]: '100000000',
    [`PAYMENT_CHAIN_${BASE_SEPOLIA}_MIN_AMOUNT`]: '10000',
    [`PAYMENT_CHAIN_${BASE_SEPOLIA}_MODE`]: 'on',
  }, { scoredChainId: 5042002 }).chains[0];
  const provider = pc.providerFor(chain);
  const close = () => { provider.destroy(); server.closeAllConnections(); server.close(); };
  return { asked, head, chain, provider, close };
}

const agent = () => ({
  didHash: ethers.hexlify(ethers.randomBytes(32)), agentAddress: ethers.Wallet.createRandom().address,
  operator: ethers.Wallet.createRandom().address, blockNumber: 1,
});

/** One scan, with the reads index.js gives it: backoff, the deadline, and errors without the URL. */
function scan({ chain, provider }, a, state, credited) {
  return pc.scanChain(chain, {
    provider,
    scoredProvider: { getCode: async () => '0x' },
    agents: [a],
    state,
    isCredited: () => false,
    creditAll: (list) => list.map(({ credit: c, ts }) => { credited.push({ ...c, ts }); return true; }),
    registeredAtMs: async () => 0,
    knownOnChain: new Map(),
    read: (label, fn) => readWithBackoff(label, () => pc.withDeadline(fn)).catch((err) => { throw pc.rpcError(err, chain.rpcUrl); }),
    sleep: async () => {},
  });
}

test('a getLogs answer past 8 MiB is asked for in halves, and a block that stays past it fails the scan where it is', async () => {
  const a = agent();
  const FLOOD = 1250;
  const held = [transferLog(a.agentAddress, 1_000_000n, 1150), transferLog(a.agentAddress, 2_000_000n, 1300)];
  // Every span wider than 50 blocks, and any span holding FLOOD, answers with its logs and 9 MiB after them.
  const e = await endpoint({
    logsAnswer: (from, to) => {
      const logs = JSON.stringify(held.filter((l) => Number(l.blockNumber) >= from && Number(l.blockNumber) <= to));
      return to - from + 1 > 50 || (from <= FLOOD && FLOOD <= to) ? logs + ' '.repeat(9 * MIB) : logs;
    },
  });
  try {
    const credited = [];
    const out = await scan(e, a, null, credited);
    assert.deepEqual(e.asked, [[1000, 1199], [1000, 1099], [1000, 1049], [1050, 1099], [1100, 1199], [1100, 1149], [1150, 1199]]);
    assert.equal(out.credited, 1);
    assert.equal(credited[0].blockNumber, 1150);
    assert.equal(out.state.lastBlock, 1199, 'every block up to the cursor was read');

    // The next scan reaches FLOOD, which is too big even alone. It fails, so the cursor stays at 1199 and the
    // payment after FLOOD waits for a later scan instead of being passed over.
    e.head.finalized = 1399;
    await assert.rejects(scan(e, a, out.state, credited), (err) => {
      assert.match(err.message, /an answer past 8388608 bytes/);
      assert.ok(!err.message.includes('SECRET-KEY'));
      return true;
    });
    assert.deepEqual(e.asked.at(-1), [FLOOD, FLOOD], 'asked for FLOOD alone before giving up');
    assert.equal(credited.length, 1, 'nothing past FLOOD was credited');
  } finally {
    e.close();
  }
});

test('a getLogs answer holding more than 10,000 logs is asked for in halves, with nothing lost', async () => {
  const a = agent();
  // 10,001 transfers of one unit over blocks 1000 to 1099, then one real payment.
  const dust = Array.from({ length: 10_001 }, (_, i) => transferLog(a.agentAddress, 1n, 1000 + (i % 100), Math.floor(i / 100)));
  const held = [...dust, transferLog(a.agentAddress, 1_000_000n, 1150)];
  const e = await endpoint({
    logsAnswer: (from, to) => JSON.stringify(held.filter((l) => Number(l.blockNumber) >= from && Number(l.blockNumber) <= to)),
  });
  try {
    const credited = [];
    const out = await scan(e, a, null, credited);
    assert.deepEqual(e.asked, [[1000, 1199], [1000, 1099], [1000, 1049], [1050, 1099], [1100, 1199]]);
    assert.equal(out.credited, 1);
    assert.equal(out.reasons.below_minimum, 10_001, 'every log of the halves was read');
    assert.equal(out.state.lastBlock, 1199);
  } finally {
    e.close();
  }
});

test('any other read past 8 MiB fails with that error, counted after unzipping, and none of it is parsed', async () => {
  const padded = (r) => [{}, `{"jsonrpc":"2.0","id":${JSON.stringify(r.id)},"result":${JSON.stringify(block(5))}${' '.repeat(9 * MIB)}}`];
  // About 9 KB on the wire.
  const zipped = (r) => [{ 'Content-Encoding': 'gzip' }, zlib.gzipSync(`{"jsonrpc":"2.0","id":${JSON.stringify(r.id)},"result":null${' '.repeat(9 * MIB)}}`)];
  const e = await endpoint({ answer: { eth_getBlockByNumber: padded, eth_getTransactionReceipt: zipped } });
  try {
    const bounded = pc.boundedProvider(e.provider);
    for (const read of [() => e.provider.getBlock(5), () => bounded.getTransactionReceipt(ethers.id('payment'))]) {
      await assert.rejects(read(), (err) => {
        assert.match(err.message, /an answer past 8388608 bytes/);
        assert.equal(pc.rpcError(err, e.chain.rpcUrl).message, 'an answer past 8388608 bytes');
        return true;
      });
    }
  } finally {
    e.close();
  }
});
