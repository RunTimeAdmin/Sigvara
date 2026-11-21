'use strict';

// The link scanner (link-scan.js) against stub chain and registry reads. The scan's end-to-end
// runs through the oracle are in links-on-chain.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLinkScanner } = require('./link-scan');
const refusals = require('./test-support/refusals');

const did = (n) => `0x${n.toString(16).padStart(64, '0')}`;
const OPERATOR = '0x00000000000000000000000000000000000000a0';
const SOMEONE = '0x00000000000000000000000000000000000000b0';

test('scan hands each claim it keeps to onClaim, and none it drops', async () => {
  // 8004 agent 7 is the operator's and names did(1); 8004 agent 8 names did(2) but is someone else's.
  const owners = { 7: OPERATOR, 8: SOMEONE };
  const logs = [
    { agentId: 7n, value: did(1), blockNumber: 100, logIndex: 0 },
    { agentId: 8n, value: did(2), blockNumber: 101, logIndex: 0 },
  ];
  let state = null;
  const scanner = createLinkScanner({
    chain: {
      readWithBackoff: (_label, fn) => fn(),
      isTransientReadError: () => false,
      getAgentInfo: async () => ({ operator: OPERATOR }),
    },
    external: {
      latestBlock: async () => 120,
      readLinkLogs: async () => logs,
      ownerAt: async (agentId) => owners[agentId],
      claimHolds: async (agentId, _key, _didHash, operator) => owners[agentId] === operator,
    },
    fromBlock: 90, chunkSize: 1000,
    getState: () => state, setState: (s) => { state = s; }, persist: () => {},
  });
  const seen = [];
  assert.equal(await scanner.scan({ onClaim: (claim) => seen.push(claim) }), 1);
  assert.deepEqual(seen, [{ didHash: did(1), agentId: '7', block: 100, logIndex: 0 }]);
  assert.equal(await scanner.scan(), 0, 'and still works without one');
});

test('a span refused in each node\'s own words is halved, on the scan and on what the epoch falls back on', async () => {
  for (const refuse of [refusals.arcTooMany, refusals.arcTooWide, refusals.elysium]) {
    const answered = [];
    let state = null;
    const scanner = createLinkScanner({
      chain: {
        readWithBackoff: (_label, fn) => fn(),
        isTransientReadError: () => false,
        getAgentInfo: async () => ({ operator: OPERATOR }),
      },
      external: {
        latestBlock: async () => 1500,
        readLinkLogs: async (_key, from, to) => {
          if (to - from + 1 > 100) throw refuse();
          answered.push([from, to]);
          return [];
        },
      },
      fromBlock: 1000, chunkSize: 400,
      getState: () => state, setState: (s) => { state = s; }, persist: () => {},
    });
    await scanner.uncheckedAgents(1200);
    assert.ok(answered.length > 1);
    answered.length = 0;
    assert.equal(await scanner.scan(), 0);
    assert.ok(answered.every(([from, to]) => to - from + 1 <= 100));
    answered.forEach(([from], i) => { if (i > 0) assert.equal(from, answered[i - 1][1] + 1, 'with no block left out'); });
  }
});

test('of the logs one 8004 agent emits in one block only the last is checked, so a burst costs one read', async () => {
  // Block 100: fifty claims on 8004 agent 7 naming other agents, then the operator's for did(1), which is what
  // agent 7 names at the block's end. Block 101: a claim, then a log that clears the key, so nothing from it holds.
  const logs = [];
  for (let i = 0; i < 50; i++) logs.push({ agentId: 7n, value: did(1000 + i), blockNumber: 100, logIndex: i });
  logs.push({ agentId: 7n, value: did(1), blockNumber: 100, logIndex: 50 });
  logs.push({ agentId: 7n, value: did(2), blockNumber: 101, logIndex: 0 });
  logs.push({ agentId: 7n, value: '0x', blockNumber: 101, logIndex: 1 });
  let infoReads = 0;
  let state = null;
  const scanner = createLinkScanner({
    chain: {
      readWithBackoff: (_label, fn) => fn(),
      isTransientReadError: () => false,
      getAgentInfo: async () => { infoReads += 1; return { operator: OPERATOR }; },
    },
    external: {
      latestBlock: async () => 120,
      readLinkLogs: async () => logs,
      ownerAt: async () => OPERATOR,
      // What agent 7 names as of each block's end: did(1) after block 100, nothing after block 101.
      claimHolds: async (_agentId, _key, didHash, _operator, block) => block === 100 && didHash === did(1),
    },
    fromBlock: 90, chunkSize: 1000,
    getState: () => state, setState: (s) => { state = s; }, persist: () => {},
  });
  assert.equal(await scanner.scan(), 1);
  assert.equal(infoReads, 1, 'one read for the burst, and none for a block whose last log claims nothing');
  assert.deepEqual(state.claims, { [did(1)]: [{ agentId: '7', block: 100, logIndex: 50 }] });
  assert.deepEqual(state.cursor, { block: 121, logIndex: 0 });
});
