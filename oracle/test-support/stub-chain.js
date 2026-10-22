'use strict';

// Preload for end-to-end tests:  node --require test-support/stub-chain.js index.js
//
// Replaces chain.js and external.js with fakes, so the real HTTP handlers, store, payments,
// scoring and merkle code run against a world the test describes and nothing touches a
// network. The world is a JSON file named by STUB_WORLD, read again on every call, so a test
// can add a receipt or an agent while the oracle is running.
//
//   {
//     nowSec:    the chain clock, in seconds
//     head:      the block number
//     receipts:  { "<txhash>": { status, blockNumber, logs: [{ address, topics, data }] } }
//     agents:    { "<didhash>": { operator, agentAddress, registeredAt, status } }
//     standing:  { "<address>": hard score of a counterparty }
//     explodeHealth: when true, the /health route throws
//   }
//
// Keys are lowercase. Epochs are switched off: the fake registry read throws, which the
// oracle logs and survives, so only the request handlers run.

const fs = require('fs');
const Module = require('module');
const path = require('path');

const world = () => JSON.parse(fs.readFileSync(process.env.STUB_WORLD, 'utf8'));
const ZERO = '0x0000000000000000000000000000000000000000';

const provider = {
  getTransactionReceipt: async (hash) => world().receipts[String(hash).toLowerCase()] ?? null,
  getBlockNumber: async () => world().head,
  getBlock: async () => ({ timestamp: world().nowSec - 60 }),
};

const chain = {
  init() {},
  STATUS_SLASHED: 2,
  getProvider: () => provider,
  getAgentInfo: async (didHash) => world().agents[String(didHash).toLowerCase()]
    ?? { operator: ZERO, agentAddress: ZERO, registeredAt: 0, status: 0 },
  getRegisteredAgents: async () => { throw new Error('stub: epochs are off in end-to-end tests'); },
  getScanState: () => null,
  restoreScanState: () => false,
  verifyDidHashDerivation: async () => false,
  operatorStanding: async () => ({ enforced: false }),
  getLatestBlockTimestamp: async () => world().nowSec,
  getAgentScore: async (address) => world().standing[String(address).toLowerCase()] ?? 0,
  readWithBackoff: (_label, fn) => fn(),
};

const external = {
  init() {},
  refreshChainId: async () => null,
  configured: () => false,
  // world.explodeHealth makes the /health route throw, which is how a test proves that a
  // handler error costs one request and not the process.
  chainState: () => {
    if (world().explodeHealth) throw new Error('stub: the health route was told to fail');
    return { status: 'disabled', chainId: null };
  },
  externalScoreFor: async () => 0,
  verifyOwnership: async () => false,
};

const oracleDir = path.resolve(__dirname, '..');
for (const [file, fake] of [['chain.js', chain], ['external.js', external]]) {
  const filename = require.resolve(path.join(oracleDir, file));
  const stub = new Module(filename);
  stub.filename = filename;
  stub.loaded = true;
  stub.exports = fake;
  require.cache[filename] = stub;
}
