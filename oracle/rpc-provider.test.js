'use strict';

// How the oracle reaches a node (rpc-provider.js), against a local JSON-RPC endpoint that counts what it is asked.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { ethers } = require('ethers');
const { rpcProvider } = require('./rpc-provider');
const chain = require('./chain');

const CHAIN_ID = 5042002;
const asked = [];
let mode = 'answer';
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const calls = [].concat(JSON.parse(body));
    for (const c of calls) asked.push(c.method);
    if (mode === 'silent') return; // never answers
    if (mode === 'throttle') { res.writeHead(429); return res.end('{}'); }
    const answer = (c) => ({
      jsonrpc: '2.0',
      id: c.id,
      result: c.method === 'eth_chainId' ? ethers.toQuantity(CHAIN_ID) : c.method === 'eth_getBalance' ? '0x1' : '0x10',
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(Array.isArray(JSON.parse(body)) ? calls.map(answer) : answer(calls[0])));
  });
});
const url = new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
after(() => { server.closeAllConnections(); server.close(); });

const count = (method) => asked.filter((m) => m === method).length;
const someone = (n) => `0x${String(n).padStart(40, '0')}`;

// ethers asked eth_chainId before every wave of reads: 21 to 29% of what the SDK sent (performance review, 15 November).
test('the oracle\'s provider asks no eth_chainId with its reads', async () => {
  chain.init({
    rpcUrl: await url,
    expectedChainId: CHAIN_ID,
    privateKey: ethers.Wallet.createRandom().privateKey,
    identityAddress: someone(1),
    reputationAddress: someone(2),
  });
  const p = chain.getProvider();
  asked.length = 0;
  for (let i = 0; i < 3; i += 1) await p.getBalance(someone(10 + i));
  assert.equal(count('eth_getBalance'), 3);
  assert.equal(count('eth_chainId'), 0);
  // What checks the chain asks the node itself.
  assert.equal(await chain.getChainId(), CHAIN_ID);
  assert.equal(count('eth_chainId'), 1);
});

test('without a chain id, the node is asked once, not once a wave', async () => {
  const p = rpcProvider(await url);
  asked.length = 0;
  for (let i = 0; i < 3; i += 1) await p.getBalance(someone(20 + i));
  assert.equal(count('eth_getBalance'), 3);
  assert.equal(count('eth_chainId'), 1);
});

// ethers tried an HTTP 429 up to 12 times inside each of readWithBackoff's attempts.
test('a throttled request is not tried again by the provider', async () => {
  const p = rpcProvider(await url, CHAIN_ID);
  asked.length = 0;
  mode = 'throttle';
  try {
    await assert.rejects(p.send('eth_blockNumber', []), (err) => err.code === 'SERVER_ERROR' && /429/.test(err.message));
  } finally {
    mode = 'answer';
  }
  assert.equal(count('eth_blockNumber'), 1);
});

test('a request with no answer gives up at its deadline', async () => {
  const p = rpcProvider(await url, CHAIN_ID, { timeoutMs: 300 });
  mode = 'silent';
  const started = Date.now();
  try {
    await assert.rejects(p.send('eth_blockNumber', []), (err) => err.code === 'TIMEOUT');
  } finally {
    mode = 'answer';
  }
  assert.ok(Date.now() - started < 5_000);
});

// A real HTTP 429 through the provider. ethers, allowed one try, reports it as "exceeded maximum retry limit", and the
// 429 is left only in the status of the response it escalated, so a check of the short message alone missed it and the
// checker's node, which answers a burst with a 429, got four quick tries instead of the rate limit's schedule.
test('a read refused with HTTP 429 is tried on the rate limit\'s schedule', async () => {
  const { readWithBackoff, isRateLimited, RATE_LIMIT_ATTEMPTS } = require('./read-retry');
  const p = rpcProvider(await url, CHAIN_ID);
  asked.length = 0;
  mode = 'throttle';
  let seen;
  try {
    await assert.rejects(readWithBackoff('x', () => p.send('eth_blockNumber', []), 4, undefined, { pause: async () => {} }), (err) => {
      seen = err;
      return true;
    });
  } finally {
    mode = 'answer';
  }
  assert.equal(isRateLimited(seen), true, `${seen.shortMessage}: read as a rate limit`);
  assert.equal(count('eth_blockNumber'), RATE_LIMIT_ATTEMPTS, 'tried as often as the rate limit allows');
});
