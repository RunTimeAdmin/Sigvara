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
//     blockTimes: { "<block number>": seconds } a block's time, where it is not nowSec - 60
//     receipts:  { "<txhash>": { status, blockNumber, logs: [{ address, topics, data }] } }
//     agents:    { "<didhash>": { operator, agentAddress, registeredAt, status } }
//     standing:  { "<address>": hard score of a counterparty }
//     standingFails: { "<address>": true } counterparties the node cannot answer for: the read is throttled
//     explodeHealth: when true, the /health route throws
//     externalOwns: when set, the ERC-8004 registry reads as configured and /link finds the agent owned by
//                its Sigvara operator (true) or not (false); left out, the registry is not configured
//     chainId:   the chain id the fake node reports (default 5042)
//     nonceGap:  how many of the wallet's transactions the node holds pending (default 0)
//     operatorStanding: { enforced, allowed, operatorBond } what the boot check finds (default not enforced)
//     jobs:      { head, logs } what the ERC-8183 job registry's node answers, when the oracle
//                is given JOBS_REGISTRY_ADDRESS (head defaults to `head`, logs to none)
//     scanLogs, canaryLogs: what the payment scan's getLogs finds. A range is the scan, a single
//                block is its canary (the block a known settlement sits in); each defaults to none
//   }
//
// Keys are lowercase. Unless the world lists agents to score, epochs are switched off: the
// fake registry read throws, which the oracle logs and survives, so only the request
// handlers run. An epoch is switched on by naming the agents it should see:
//
//   {
//     registered:      [ "<didhash>" ]  agents the registry returns (each also needs an `agents` entry)
//     challengeWindow: seconds (default 21600)
//     feeGating:       true to configure the epoch fee; epochFee: its size, as a decimal string
//     pending:         { "<didhash>": { exists, proposedAt, finalizableAt, data, evidenceRoot, proposerDead } }  (default none)
//                      finalizableAt: the deadline the contract fixed when the proposal was made; leave it out (or 0)
//                      for a proposal judged against the live challengeWindow
//                      proposerDead: the proposer has lost its authority, so finalize reverts with
//                      ProposerNotAuthorized and a compare-and-swap proposal may replace it
//     bonded, covered: { "<didhash>": bool }  (default true)
//     canPropose:      { "<didhash>": { ok: false, reason } | "throw" }  (default ok, except that
//                      the compare-and-swap entry point refuses a slot held by a live proposer)
//     charge:          "ok" | "fail" | "already_charged" | "unconfirmed"
//     propose:         "ok" | "revert" | "fee_cap" | "unconfirmed"
//   }
//
// Every write the oracle attempts is appended to the file named by STUB_CALLS, one JSON line
// each, so a test can say what was asked of the chain and in what order.

const fs = require('fs');
const Module = require('module');
const path = require('path');
const { ethers } = require('ethers');

const oracleDir = path.resolve(__dirname, '..');
// The error classes and their predicates are the real ones, so a test sees the message an
// operator would. chain.js needs only ethers and epoch-policy to load.
const real = require(path.join(oracleDir, 'chain.js'));

const world = () => JSON.parse(fs.readFileSync(process.env.STUB_WORLD, 'utf8'));
const ZERO = '0x0000000000000000000000000000000000000000';

const record = (name, ...args) => {
  if (!process.env.STUB_CALLS) return;
  fs.appendFileSync(
    process.env.STUB_CALLS,
    `${JSON.stringify({ name, args }, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}\n`,
  );
};
const fakeHash = (tag) => `0x${tag.repeat(32)}`;

const provider = {
  getTransactionReceipt: async (hash) => world().receipts[String(hash).toLowerCase()] ?? null,
  getBlockNumber: async () => world().head,
  getBlock: async (n) => ({ number: n, timestamp: world().blockTimes?.[n] ?? world().nowSec - 60 }),
  getLogs: async (filter) => (filter.fromBlock === filter.toBlock ? world().canaryLogs : world().scanLogs) ?? [],
  // Smart accounts for payer-signed outcomes: world().accounts maps an address to the key that
  // may sign for it, by block ({ owners: [{ fromBlock, owner }] }). An address listed there has
  // code; any other has none.
  getCode: async (address, blockTag) => {
    record('getCode', String(address).toLowerCase(), blockTag);
    return world().accounts?.[String(address).toLowerCase()] ? '0x6080' : '0x';
  },
  call: async ({ to, data, blockTag }) => {
    record('call', String(to).toLowerCase(), blockTag);
    const account = world().accounts?.[String(to).toLowerCase()];
    if (!account) return '0x';
    const iface = new ethers.Interface(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)']);
    const [hash, signature] = iface.decodeFunctionData('isValidSignature', data);
    const owner = [...account.owners].reverse().find((o) => o.fromBlock <= blockTag)?.owner;
    let signer = null;
    try { signer = ethers.recoverAddress(hash, signature); } catch { signer = null; }
    const yes = owner && signer && signer.toLowerCase() === owner.toLowerCase();
    return yes ? `0x1626ba7e${'0'.repeat(56)}` : `0xffffffff${'0'.repeat(56)}`;
  },
};

const chain = {
  // What index.js hands the chain module, so a test can see its settings arrive.
  init(cfg) {
    record('init', {
      txWaitMs: cfg.txWaitMs, maxFeeGwei: cfg.maxFeeGwei, maxTxCost: cfg.maxTxCost, expectedChainId: cfg.expectedChainId,
    });
  },
  STATUS_SLASHED: 2,
  getProvider: () => provider,
  getAgentInfo: async (didHash) => world().agents[String(didHash).toLowerCase()]
    ?? { operator: ZERO, agentAddress: ZERO, registeredAt: 0, status: 0 },
  getRegisteredAgents: async () => {
    const w = world();
    if (!w.registered) throw new Error('stub: epochs are off in end-to-end tests');
    return w.registered.map((didHash) => ({
      didHash, agentAddress: w.agents[didHash]?.agentAddress ?? null, blockNumber: 1,
    }));
  },
  getScanState: () => null,
  restoreScanState: () => false,
  verifyDidHashDerivation: async () => false,
  operatorStanding: async () => world().operatorStanding ?? ({ enforced: false }),
  getLatestBlockTimestamp: async () => world().nowSec,
  getAgentScore: async (address) => {
    const key = String(address).toLowerCase();
    if (world().standingFails?.[key]) {
      throw Object.assign(new Error('429 too many requests'), { code: 'SERVER_ERROR' });
    }
    return world().standing[key] ?? 0;
  },
  readWithBackoff: (_label, fn) => fn(),

  // The chain check runs at boot and before every epoch.
  ChainMismatchError: real.ChainMismatchError,
  isTxUnconfirmed: real.isTxUnconfirmed,
  isFeeCap: real.isFeeCap,
  isProposerNotAuthorized: real.isProposerNotAuthorized,
  isAlreadyCharged: real.isAlreadyCharged,
  isTransientReadError: real.isTransientReadError,
  getChainId: async () => world().chainId ?? 5042,
  assertChainId: async (expected = null) => {
    const actual = world().chainId ?? 5042;
    if (expected != null && actual !== Number(expected)) throw new real.ChainMismatchError(Number(expected), actual);
    return actual;
  },
  getNonceGap: async () => world().nonceGap ?? 0,

  // What an epoch reads and writes.
  getChallengeWindow: async () => world().challengeWindow ?? 21600,
  feeGatingConfigured: () => !!world().feeGating,
  getEpochFee: async () => BigInt(world().epochFee ?? 0),
  getPendingScore: async (didHash) => world().pending?.[didHash] ?? { exists: false },
  isCovered: async (didHash) => world().covered?.[didHash] ?? true,
  isBonded: async (didHash) => world().bonded?.[didHash] ?? true,
  pruneAgent() {},
  isSlotTaken: () => false,
  isRateLimited: () => false,
  // The contract refuses to finalize a proposal whose proposer has lost its authority, which
  // the world says with `proposerDead` on the pending entry.
  finalizeScore: async (didHash) => {
    record('finalizeScore', didHash);
    if (world().pending?.[didHash]?.proposerDead) {
      throw new Error('stub: execution reverted: ProposerNotAuthorized');
    }
    return fakeHash('f1');
  },
  canPropose: async (didHash, scores, evidenceRoot, ifEmpty) => {
    record('canPropose', didHash, scores, evidenceRoot ?? null, ifEmpty);
    const w = world();
    const rule = w.canPropose?.[didHash];
    if (rule === 'throw') throw new Error('stub: the simulation could not be run');
    if (rule) return rule;
    // The compare-and-swap entry point refuses an occupied slot, unless the proposer that
    // holds it is dead. The replacing entry point overwrites whatever is there.
    const held = w.pending?.[didHash];
    if (ifEmpty && held?.exists && !held.proposerDead) return { ok: false, reason: 'ScoreAlreadyPending' };
    return { ok: true };
  },
  chargeEpoch: async (didHash) => {
    record('chargeEpoch', didHash);
    const mode = world().charge ?? 'ok';
    if (mode === 'fail') throw new Error('stub: execution reverted: the operator cannot pay');
    if (mode === 'already_charged') throw new Error('stub: execution reverted: AlreadyCharged');
    if (mode === 'unconfirmed') throw new real.TxUnconfirmedError(fakeHash('c1'), 60_000);
    return fakeHash('c0');
  },
  proposeScore: async (didHash, scores, evidenceRoot, ifEmpty) => {
    record('proposeScore', didHash, scores, evidenceRoot ?? null, ifEmpty);
    const mode = world().propose ?? 'ok';
    if (mode === 'revert') throw new Error('stub: execution reverted: the proposal was refused');
    if (mode === 'fee_cap') throw new real.FeeCapError('stub: the fee is above the cap');
    if (mode === 'unconfirmed') throw new real.TxUnconfirmedError(fakeHash('d1'), 60_000, fakeHash('d2'));
    return fakeHash('d0');
  },
};

const external = {
  init() {},
  refreshChainId: async () => null,
  configured: () => world().externalOwns !== undefined,
  // world.explodeHealth makes the /health route throw, which is how a test proves that a
  // handler error costs one request and not the process.
  chainState: () => {
    if (world().explodeHealth) throw new Error('stub: the health route was told to fail');
    return { status: 'disabled', chainId: null };
  },
  externalScoreFor: async () => 0,
  verifyOwnership: async () => world().externalOwns === true,
};

for (const [file, fake] of [['chain.js', chain], ['external.js', external]]) {
  const filename = require.resolve(path.join(oracleDir, file));
  const stub = new Module(filename);
  stub.filename = filename;
  stub.loaded = true;
  stub.exports = fake;
  require.cache[filename] = stub;
}

// The job registry's node. Only the provider is replaced, so the real jobs.js scans,
// decodes and turns logs into evidence for GET /jobs/:address.
const jobs = require(path.join(oracleDir, 'jobs.js'));
jobs.makeProvider = (cfg) => (jobs.enabled(cfg) ? {
  getNetwork: async () => ({ chainId: BigInt(world().chainId ?? 5042) }),
  getBlockNumber: async () => world().jobs?.head ?? world().head,
  getLogs: async () => world().jobs?.logs ?? [],
  getBlock: async (n) => ({ number: n, timestamp: world().nowSec }),
} : null);
