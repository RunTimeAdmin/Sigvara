'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const chain = require('./chain');

const CFG = {
  rpcUrl: 'http://fake',
  privateKey: '0x' + '1'.repeat(64),
  identityAddress: '0xIdentity',
  reputationAddress: '0xReputation',
  fromBlock: 100,
  logChunkSize: 2000, // large enough that all test fixtures fit in one chunk
};

// Minimal fakes covering only the ethers.Contract/Provider surface chain.js
// actually calls — no real network, no real ethers objects.
function makeFakeProvider(latestBlock, timestamp = 1_700_000_000) {
  return {
    getBlockNumber: async () => latestBlock,
    getBlock: async () => ({ timestamp: BigInt(timestamp) }),
  };
}

function makeFakeIdentityContract({ events = [], identities = {} } = {}) {
  return {
    filters: { AgentRegistered: () => 'AgentRegistered-filter' },
    queryFilter: async (_filter, start, end) =>
      events.filter(e => e.blockNumber >= start && e.blockNumber <= end),
    getIdentity: async didHash => {
      const id = identities[didHash];
      if (!id) throw new Error(`no fake identity configured for ${didHash}`);
      return id;
    },
  };
}

function makeFakeReputationContract({ pending = {}, challengeWindow = 3600 } = {}) {
  const calls = { proposeReputation: [], finalizeReputation: [] };
  const fakeTx = hash => ({ hash, wait: async () => ({}) });
  return {
    calls,
    proposeReputation: async (didHash, data) => {
      calls.proposeReputation.push({ didHash, data });
      return fakeTx('0xproposeTxHash');
    },
    finalizeReputation: async didHash => {
      calls.finalizeReputation.push({ didHash });
      return fakeTx('0xfinalizeTxHash');
    },
    getPendingScore: async didHash =>
      pending[didHash] ?? { exists: false, proposedAt: 0n, data: {} },
    challengeWindow: async () => BigInt(challengeWindow),
  };
}

beforeEach(() => {
  chain.reset();
});

// -------------------------------------------------------------------------
// getRegisteredAgents / pruneAgent
// -------------------------------------------------------------------------

test('getRegisteredAgents: returns agents registered since fromBlock', async () => {
  const events = [
    { blockNumber: 105, args: { didHash: '0xaaa', agentAddress: '0xAgentA' } },
    { blockNumber: 110, args: { didHash: '0xbbb', agentAddress: '0xAgentB' } },
  ];
  chain.init(CFG, {
    provider: makeFakeProvider(120),
    identityContract: makeFakeIdentityContract({ events }),
    reputationContract: makeFakeReputationContract(),
  });

  const agents = await chain.getRegisteredAgents();

  assert.equal(agents.length, 2);
  assert.deepEqual(agents.map(a => a.didHash).sort(), ['0xaaa', '0xbbb']);
});

test('getRegisteredAgents: second call only scans new blocks but keeps prior agents', async () => {
  const firstBatch = [{ blockNumber: 105, args: { didHash: '0xaaa', agentAddress: '0xAgentA' } }];
  chain.init(CFG, {
    provider: makeFakeProvider(120),
    identityContract: makeFakeIdentityContract({ events: firstBatch }),
    reputationContract: makeFakeReputationContract(),
  });
  const firstAgents = await chain.getRegisteredAgents();
  assert.equal(firstAgents.length, 1);

  // Simulate a new agent registered in a later block, and the chain having advanced.
  const secondBatchContract = makeFakeIdentityContract({
    events: [{ blockNumber: 150, args: { didHash: '0xbbb', agentAddress: '0xAgentB' } }],
  });
  chain.init(CFG, {
    provider: makeFakeProvider(160),
    identityContract: secondBatchContract,
    reputationContract: makeFakeReputationContract(),
  });

  const secondAgents = await chain.getRegisteredAgents();
  assert.equal(secondAgents.length, 2, 'previously known agent should still be present');
  assert.deepEqual(secondAgents.map(a => a.didHash).sort(), ['0xaaa', '0xbbb']);
});

test('getRegisteredAgents: returns empty array when no agents registered', async () => {
  chain.init(CFG, {
    provider: makeFakeProvider(120),
    identityContract: makeFakeIdentityContract({ events: [] }),
    reputationContract: makeFakeReputationContract(),
  });

  const agents = await chain.getRegisteredAgents();
  assert.deepEqual(agents, []);
});

test('pruneAgent: removes an agent from the known set', async () => {
  const events = [
    { blockNumber: 105, args: { didHash: '0xaaa', agentAddress: '0xAgentA' } },
    { blockNumber: 110, args: { didHash: '0xbbb', agentAddress: '0xAgentB' } },
  ];
  chain.init(CFG, {
    provider: makeFakeProvider(120),
    identityContract: makeFakeIdentityContract({ events }),
    reputationContract: makeFakeReputationContract(),
  });
  await chain.getRegisteredAgents();

  chain.pruneAgent('0xaaa');

  const agents = await chain.getRegisteredAgents();
  assert.deepEqual(agents.map(a => a.didHash), ['0xbbb']);
});

// -------------------------------------------------------------------------
// getAgentInfo
// -------------------------------------------------------------------------

test('getAgentInfo: converts on-chain fields to numbers', async () => {
  chain.init(CFG, {
    provider: makeFakeProvider(120),
    identityContract: makeFakeIdentityContract({
      identities: { '0xaaa': { registeredAt: 1_700_000_000n, status: 0n } },
    }),
    reputationContract: makeFakeReputationContract(),
  });

  const info = await chain.getAgentInfo('0xaaa');
  assert.equal(info.registeredAt, 1_700_000_000);
  assert.equal(info.status, 0);
  assert.equal(typeof info.registeredAt, 'number');
});

// -------------------------------------------------------------------------
// proposeScore / finalizeScore
// -------------------------------------------------------------------------

test('proposeScore: forwards score fields and returns tx hash', async () => {
  const repContract = makeFakeReputationContract();
  chain.init(CFG, {
    provider: makeFakeProvider(120),
    identityContract: makeFakeIdentityContract(),
    reputationContract: repContract,
  });

  const scores = { feeScore: 10, successScore: 20, ageScore: 5, externalScore: 0, communityScore: 5, propagationScore: 0, total: 40 };
  const txHash = await chain.proposeScore('0xaaa', scores);

  assert.equal(txHash, '0xproposeTxHash');
  assert.equal(repContract.calls.proposeReputation.length, 1);
  const call = repContract.calls.proposeReputation[0];
  assert.equal(call.didHash, '0xaaa');
  assert.equal(call.data.feeScore, 10);
  assert.equal(call.data.successScore, 20);
});

test('finalizeScore: calls finalizeReputation and returns tx hash', async () => {
  const repContract = makeFakeReputationContract();
  chain.init(CFG, {
    provider: makeFakeProvider(120),
    identityContract: makeFakeIdentityContract(),
    reputationContract: repContract,
  });

  const txHash = await chain.finalizeScore('0xaaa');

  assert.equal(txHash, '0xfinalizeTxHash');
  assert.deepEqual(repContract.calls.finalizeReputation, [{ didHash: '0xaaa' }]);
});

// -------------------------------------------------------------------------
// getPendingScore / getChallengeWindow
// -------------------------------------------------------------------------

test('getPendingScore: converts proposedAt to a number and preserves exists', async () => {
  chain.init(CFG, {
    provider: makeFakeProvider(120),
    identityContract: makeFakeIdentityContract(),
    reputationContract: makeFakeReputationContract({
      // Shaped like the contract's ReputationData, not an empty object: checker mode
      // compares these, and a fake that omits them would test a shape that cannot occur.
      pending: { '0xaaa': { exists: true, proposedAt: 1_700_000_000n, data: {
        feeScore: 0n, successScore: 7n, ageScore: 0n,
        externalScore: 0n, communityScore: 5n, propagationScore: 0n,
      } } },
    }),
  });

  const pending = await chain.getPendingScore('0xaaa');
  assert.equal(pending.exists, true);
  assert.equal(pending.proposedAt, 1_700_000_000);
  assert.equal(typeof pending.proposedAt, 'number');
});

test('getPendingScore: no pending proposal reports exists=false', async () => {
  chain.init(CFG, {
    provider: makeFakeProvider(120),
    identityContract: makeFakeIdentityContract(),
    reputationContract: makeFakeReputationContract(),
  });

  const pending = await chain.getPendingScore('0xnotset');
  assert.equal(pending.exists, false);
});

test('getChallengeWindow: converts to a number', async () => {
  chain.init(CFG, {
    provider: makeFakeProvider(120),
    identityContract: makeFakeIdentityContract(),
    reputationContract: makeFakeReputationContract({ challengeWindow: 21600 }),
  });

  const window = await chain.getChallengeWindow();
  assert.equal(window, 21600);
  assert.equal(typeof window, 'number');
});

test('getLatestBlockTimestamp: converts block timestamp to a number', async () => {
  chain.init(CFG, {
    provider: makeFakeProvider(120, 1_700_000_123),
    identityContract: makeFakeIdentityContract(),
    reputationContract: makeFakeReputationContract(),
  });

  const ts = await chain.getLatestBlockTimestamp();
  assert.equal(ts, 1_700_000_123);
  assert.equal(typeof ts, 'number');
});

// ---- Epoch-fee gating -------------------------------------------------------

function makeFakeFeeContract({ epochFee = 0n, covered = {} } = {}) {
  const calls = { chargeEpoch: [] };
  return {
    calls,
    epochFee: async () => epochFee,
    isCovered: async didHash => covered[didHash] ?? false,
    chargeEpoch: async didHash => {
      calls.chargeEpoch.push(didHash);
      return { hash: '0xchargeTxHash', wait: async () => ({}) };
    },
  };
}

test('fee gating: not configured and helpers are no-ops without a registry', async () => {
  chain.init(CFG, {
    provider: makeFakeProvider(1),
    identityContract: makeFakeIdentityContract(),
    reputationContract: makeFakeReputationContract(),
  });
  assert.equal(chain.feeGatingConfigured(), false);
  assert.equal(await chain.getEpochFee(), 0n);
  assert.equal(await chain.isCovered('0xaaa'), true);   // everyone covered when off
  assert.equal(await chain.chargeEpoch('0xaaa'), undefined); // no-op
});

test('fee gating: helpers delegate to the registry when configured', async () => {
  const fee = makeFakeFeeContract({ epochFee: 10n, covered: { '0xaaa': true, '0xbbb': false } });
  chain.init(CFG, {
    provider: makeFakeProvider(1),
    identityContract: makeFakeIdentityContract(),
    reputationContract: makeFakeReputationContract(),
    feeContract: fee,
  });
  assert.equal(chain.feeGatingConfigured(), true);
  assert.equal(await chain.getEpochFee(), 10n);
  assert.equal(await chain.isCovered('0xaaa'), true);
  assert.equal(await chain.isCovered('0xbbb'), false);
  await chain.chargeEpoch('0xaaa');
  assert.deepEqual(fee.calls.chargeEpoch, ['0xaaa']);
});

// ---- scan cursor -----------------------------------------------------------

test('restoreScanState: resumes from a saved cursor', () => {
  chain.reset();
  const ok = chain.restoreScanState({
    lastScannedBlock: 62700000,
    agents: [{ didHash: '0xaa', agentAddress: '0xbb', blockNumber: 1 }],
  });
  assert.equal(ok, true);
  const out = chain.getScanState();
  assert.equal(out.lastScannedBlock, 62700000);
  assert.equal(out.agents.length, 1);
  assert.equal(out.agents[0].didHash, '0xaa');
});

test('restoreScanState: ignores missing or malformed state rather than throwing', () => {
  chain.reset();
  assert.equal(chain.restoreScanState(null), false);
  assert.equal(chain.restoreScanState({}), false);
  assert.equal(chain.restoreScanState({ lastScannedBlock: 'soon' }), false);
  assert.equal(chain.getScanState().lastScannedBlock, null, 'left at a full rescan');
});

test('restoreScanState: a cursor with no agents is still a valid resume point', () => {
  // A chain where nothing has registered yet must not be replayed every restart.
  chain.reset();
  assert.equal(chain.restoreScanState({ lastScannedBlock: 500 }), true);
  assert.equal(chain.getScanState().lastScannedBlock, 500);
  assert.equal(chain.getScanState().agents.length, 0);
});

test('reset: clears the cursor so a fresh scan starts from FROM_BLOCK', () => {
  chain.restoreScanState({ lastScannedBlock: 999, agents: [] });
  chain.reset();
  assert.equal(chain.getScanState().lastScannedBlock, null);
});

test('getRegisteredAgents: keeps progress when a chunk fails part way through', async () => {
  chain.reset();
  // Fails for one block range every time it is asked, so the backoff exhausts
  // rather than slipping past a call counter on retry.
  const fakeIdentity = {
    filters: { AgentRegistered: () => ({}) },
    queryFilter: async (_f, start) => {
      if (start === 1200) throw new Error('rate limit exceeded');
      return [{
        args: { didHash: '0xdid' + start, agentAddress: '0xagent' },
        blockNumber: start,
      }];
    },
  };
  chain.init(
    { rpcUrl: 'x', privateKey: '0x' + '1'.repeat(64), identityAddress: '0x' + '1'.repeat(40),
      reputationAddress: '0x' + '2'.repeat(40), fromBlock: 1000, logChunkSize: 100 },
    { provider: { getBlockNumber: async () => 1999 }, wallet: {}, identityContract: fakeIdentity,
      reputationContract: {} }
  );

  await assert.rejects(() => chain.getRegisteredAgents(), /rate limit/);

  const state = chain.getScanState();
  assert.equal(state.lastScannedBlock, 1199, 'kept the two chunks that succeeded');
  assert.equal(state.agents.length, 2, 'kept the agents those chunks found');
});

// ---------------------------------------------------------------- didHash derivation --

const { ethers } = require('ethers');

// Verified against the deployed registry on Arc testnet: computeDidHash for this agent
// address returns exactly this hash. Pinned so a change to the derivation, the packing
// or the chain id fails here rather than silently scoring every counterparty as unknown.
const REAL_AGENT = '0xCc52Cd92963f8A86d04dB29a4810d1e01D193910';
const REAL_DID   = '0x8414ce0bf4f1e1695193623e0a656a9439e356f8bed0b8bf249b179fe77c7e19';

test('didHashOf reproduces what the deployed registry computes', () => {
  assert.equal(chain.didHashOf(REAL_AGENT, 5042002), REAL_DID);
  // Checksummed or not, the address packs the same.
  assert.equal(chain.didHashOf(REAL_AGENT.toLowerCase(), 5042002), REAL_DID);
  // The chain id is part of the identity: the same key elsewhere is a different DID.
  assert.notEqual(chain.didHashOf(REAL_AGENT, 1), REAL_DID);
});

test('verifyDidHashDerivation enables local derivation only when the registry agrees', async () => {
  chain.reset();
  chain.init(CFG, {
    provider: { ...makeFakeProvider(1), getNetwork: async () => ({ chainId: 5042002n }) },
    wallet: {},
    identityContract: {
      ...makeFakeIdentityContract(),
      computeDidHash: async addr => chain.didHashOf(addr, 5042002),
    },
    reputationContract: makeFakeReputationContract(),
  });
  assert.equal(await chain.verifyDidHashDerivation(), true);
});

test('a registry that disagrees leaves the oracle reading the chain', async () => {
  chain.reset();
  chain.init(CFG, {
    provider: { ...makeFakeProvider(1), getNetwork: async () => ({ chainId: 5042002n }) },
    wallet: {},
    identityContract: {
      ...makeFakeIdentityContract(),
      // A registry using some other scheme. Deriving locally here would resolve every
      // counterparty to an unregistered DID and quietly flatten the web of trust, so the
      // check has to fail closed rather than assume.
      computeDidHash: async () => ethers.ZeroHash,
    },
    reputationContract: makeFakeReputationContract(),
  });
  assert.equal(await chain.verifyDidHashDerivation(), false);
});

test('an unreachable registry also leaves it reading the chain', async () => {
  chain.reset();
  chain.init(CFG, {
    provider: { ...makeFakeProvider(1), getNetwork: async () => { throw new Error('rpc down'); } },
    wallet: {},
    identityContract: makeFakeIdentityContract(),
    reputationContract: makeFakeReputationContract(),
  });
  assert.equal(await chain.verifyDidHashDerivation(), false);
});

test('getPendingScore: returns the factors for checker mode to compare', async () => {
  chain.init(CFG, {
    provider: makeFakeProvider(120),
    identityContract: makeFakeIdentityContract(),
    reputationContract: makeFakeReputationContract({
      pending: { '0xaaa': { exists: true, proposedAt: 1_700_000_000n, data: {
        feeScore: 3n, successScore: 7n, ageScore: 2n,
        externalScore: 1n, communityScore: 5n, propagationScore: 4n,
      } } },
    }),
  });
  const pending = await chain.getPendingScore('0xaaa');
  assert.deepEqual(pending.data, {
    feeScore: 3, successScore: 7, ageScore: 2,
    externalScore: 1, communityScore: 5, propagationScore: 4,
  });
});

test('getPendingScore: a factor that does not decode throws instead of reading as zero', async () => {
  // SigvaraReputation is upgradeable; inserting a field into ReputationData would shift
  // everything after it. A checker that treated an undecodable factor as 0 would quietly
  // start agreeing with scores it can no longer read, which is the worst failure it has.
  chain.init(CFG, {
    provider: makeFakeProvider(120),
    identityContract: makeFakeIdentityContract(),
    reputationContract: makeFakeReputationContract({
      pending: { '0xaaa': { exists: true, proposedAt: 1_700_000_000n, data: {
        feeScore: 3n, successScore: 7n, ageScore: 2n, externalScore: 1n, communityScore: 5n,
      } } },
    }),
  });
  await assert.rejects(
    () => chain.getPendingScore('0xaaa'),
    /propagationScore did not decode to a number/,
  );
});
