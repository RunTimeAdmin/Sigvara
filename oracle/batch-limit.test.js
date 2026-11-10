'use strict';

// A JSON-RPC batch stays within what a node accepts, however many reads are asked for at once. Real
// ethers and real chain.js, against a node that answers 20 calls in a batch and refuses the rest, as
// Arc's public RPC does. A refusal arrives as CALL_EXCEPTION, missing revert data, and gets retried, so
// nothing fails: the only sign of being over the limit is the wasted round trips counted here.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { ethers } = require('ethers');
const chain = require('./chain');
const external = require('./external');
const { MAX_BATCH_CALLS } = require('./read-retry');
const { READ_PACE_MS } = require('./epoch-policy');
const { World, startOracle } = require('./test-support/oracle-harness');

const IDENTITY = `0x${'11'.repeat(20)}`;
const REPUTATION = `0x${'22'.repeat(20)}`;
const ID_ABI = new ethers.Interface([
  'function getIdentity(bytes32 didHash) view returns (tuple(address operator, address agentAddress, bytes32 ed25519PubKey, uint8 status, uint256 registeredAt))',
]);
const identityAnswer = ID_ABI.encodeFunctionResult('getIdentity', [[`0x${'33'.repeat(20)}`, `0x${'44'.repeat(20)}`, ethers.ZeroHash, 0, 1000]]);

function fakeNode() {
  const batches = [];
  let refused = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const j = JSON.parse(body);
      const calls = Array.isArray(j) ? j : [j];
      batches.push(calls.length);
      const answers = calls.map((c, i) => {
        if (c.method === 'eth_chainId') return { jsonrpc: '2.0', id: c.id, result: '0x1' };
        if (i >= 20) {
          refused += 1;
          return { jsonrpc: '2.0', id: c.id, error: { code: -32005, message: 'rate limit exceeded' } };
        }
        return { jsonrpc: '2.0', id: c.id, result: identityAnswer };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(j) ? answers : answers[0]));
    });
  });
  return { server, batches, refused: () => refused };
}

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = (server) => `http://127.0.0.1:${server.address().port}`;

test('the limit and the pace are what was measured on Arc', () => {
  assert.equal(MAX_BATCH_CALLS, 20);
  assert.equal(READ_PACE_MS, 1_500);
});

test('chain.js: a hundred reads at once go out in batches a node accepts, with none refused', async (t) => {
  const node = fakeNode();
  await listen(node.server);
  t.after(() => { node.server.closeAllConnections(); node.server.close(); });
  chain.init({
    rpcUrl: url(node.server), privateKey: `0x${'11'.repeat(32)}`, identityAddress: IDENTITY, reputationAddress: REPUTATION, fromBlock: 1, logChunkSize: 2000,
  });
  const did = (i) => ethers.zeroPadValue(ethers.toBeHex(i + 1), 32);
  const infos = await Promise.all(Array.from({ length: 100 }, (_, i) => chain.getAgentInfo(did(i))));
  assert.equal(infos.length, 100);
  assert.ok(infos.every((x) => x.registeredAt === 1000));
  assert.ok(Math.max(...node.batches) <= MAX_BATCH_CALLS, `largest batch ${Math.max(...node.batches)}`);
  assert.equal(node.refused(), 0, 'and so nothing needed retrying');
});

test('external.js: its provider keeps to the same limit', async (t) => {
  const node = fakeNode();
  await listen(node.server);
  t.after(() => { node.server.closeAllConnections(); node.server.close(); external.init({}); });
  external.init({ externalRpc: url(node.server), externalIdentity: IDENTITY, externalReputation: REPUTATION });
  const owner = ethers.getAddress(`0x${'33'.repeat(20)}`);
  const ownerAnswer = ethers.AbiCoder.defaultAbiCoder().encode(['address'], [owner]);
  node.server.removeAllListeners('request');
  const batches = [];
  node.server.on('request', (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const j = JSON.parse(body);
      const calls = Array.isArray(j) ? j : [j];
      batches.push(calls.length);
      const answers = calls.map((c) => ({ jsonrpc: '2.0', id: c.id, result: c.method === 'eth_chainId' ? '0x1' : ownerAnswer }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(j) ? answers : answers[0]));
    });
  });
  const reads = await Promise.all(Array.from({ length: 60 }, (_, i) => external.verifyOwnership(String(i + 1), owner)));
  assert.ok(reads.every((owns) => owns === true));
  assert.ok(Math.max(...batches) <= MAX_BATCH_CALLS, `largest batch ${Math.max(...batches)}`);
});

// The real index.js with the chain stubbed: one burst of reads is one batch, so this is what a node sees.
test('an epoch reads in bursts a node accepts, with a wait between each', async (t) => {
  const world = new World();
  const registered = Array.from({ length: 12 }, () => world.addAgent().didHash);
  world.set('registered', registered);
  world.set('recordEpochReads', true);
  const oracle = await startOracle({ world, env: { ORACLE_ADMIN_TOKEN: 'a'.repeat(64) } });
  t.after(() => oracle.stop());

  const wanted = 12 * 5; // three reads each ahead of the writes, and two guards each
  const deadline = Date.now() + 30_000;
  const times = () => oracle.calls().filter((c) => c.name === 'epochRead').map((c) => c.args[0]);
  while (times().length < wanted) {
    assert.ok(Date.now() < deadline, `only ${times().length} of ${wanted} reads:\n${oracle.logs()}`);
    await new Promise((r) => setTimeout(r, 50));
  }

  const bursts = [];
  let last = -Infinity;
  for (const at of times().sort((a, b) => a - b)) {
    if (at - last > READ_PACE_MS / 2) bursts.push({ first: at, reads: 0 });
    bursts[bursts.length - 1].reads += 1;
    last = at;
  }
  // Six agents and six ahead of the writes, then ten and two at the guards.
  assert.deepEqual(bursts.map((b) => b.reads), [18, 18, 20, 4]);
  for (let i = 1; i < bursts.length; i += 1) {
    assert.ok(bursts[i].first - bursts[i - 1].first >= READ_PACE_MS - 50, `burst ${i} came too soon`);
  }
});
