'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ethers } = require('ethers');
const jobs = require('./jobs');

const addr = (n) => ethers.getAddress('0x' + String(n).repeat(40).slice(0, 40));
const CLIENT = addr('1');
const PROVIDER = addr('2');
const EVALUATOR = addr('3');

const w = (v) => ethers.zeroPadValue(ethers.toBeHex(v), 32);
const wAddr = (a) => ethers.zeroPadValue(a, 32);

/** A log in the shape ethers hands back from getLogs. */
const log = (name, topics, data = '0x', block = 100, tx = '0x' + 'ab'.repeat(32)) => ({
  topics: [jobs.TOPICS[name], ...topics],
  data,
  blockNumber: block,
  transactionHash: tx,
});

const created = (id, client = CLIENT, provider = PROVIDER, evaluator = EVALUATOR) =>
  log('JobCreated', [w(id), wAddr(client), wAddr(provider)],
    ethers.AbiCoder.defaultAbiCoder().encode(['address', 'uint256', 'address'], [evaluator, 0, ethers.ZeroAddress]));

const funded = (id, amount, client = CLIENT) => log('JobFunded', [w(id), wAddr(client)], w(amount));
const released = (id, amount, provider = PROVIDER) => log('PaymentReleased', [w(id), wAddr(provider)], w(amount));
const completed = (id, by = EVALUATOR, block = 100, tx = '0x' + 'cc'.repeat(32)) =>
  log('JobCompleted', [w(id), wAddr(by)], w(0), block, tx);
const rejected = (id, by = EVALUATOR, block = 100) => log('JobRejected', [w(id), wAddr(by)], w(0), block);
const expired = (id, block = 100) => log('JobExpired', [w(id)], '0x', block);

const assemble = (logs, times = new Map([[100, 1_700_000_000]])) =>
  jobs.assembleJobs(logs.map(jobs.decodeLog).filter(Boolean), times);

// ---------------------------------------------------------------------------
// Signature pinning
// ---------------------------------------------------------------------------

test('topics are derived from the signatures, and those match the published EIP', () => {
  // ERC-8183 is a Draft. If the spec changes a signature, this is where it should be
  // noticed, because the alternative is an indexer that quietly matches nothing and
  // reports every agent as having done no work.
  assert.strictEqual(jobs.EVENT_SIGNATURES.JobCompleted, 'JobCompleted(uint256,address,bytes32)');
  assert.strictEqual(jobs.EVENT_SIGNATURES.PaymentReleased, 'PaymentReleased(uint256,address,uint256)');
  for (const [name, sig] of Object.entries(jobs.EVENT_SIGNATURES)) {
    assert.strictEqual(jobs.TOPICS[name], ethers.id(sig), `${name} topic must come from its signature`);
  }
});

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

test('decodeLog reads a JobCompleted', () => {
  const d = jobs.decodeLog(completed(7));
  assert.strictEqual(d.name, 'JobCompleted');
  assert.strictEqual(d.jobId, '7');
  assert.strictEqual(d.args.evaluator, EVALUATOR);
});

test('decodeLog ignores a topic it does not know rather than throwing', () => {
  // A registry may emit events this module has never heard of, and a draft may add
  // some. Skipping is correct; refusing the whole scan is not.
  assert.strictEqual(jobs.decodeLog({ topics: [ethers.id('SomethingElse(uint256)')], data: '0x' }), null);
  assert.strictEqual(jobs.decodeLog({ topics: [] }), null);
  assert.strictEqual(jobs.decodeLog(null), null);
});

// ---------------------------------------------------------------------------
// Lifecycle assembly
// ---------------------------------------------------------------------------

test('assembleJobs folds a full lifecycle into one record', () => {
  const [j] = assemble([created(1), funded(1, 500n), released(1, 450n), completed(1)]);

  assert.strictEqual(j.jobId, '1');
  assert.strictEqual(j.client, CLIENT);
  assert.strictEqual(j.provider, PROVIDER);
  assert.strictEqual(j.evaluator, EVALUATOR);
  assert.strictEqual(j.funded, '500');
  assert.strictEqual(j.released, '450');
  assert.strictEqual(j.state, 'completed');
  assert.strictEqual(j.verdictBy, EVALUATOR);
  assert.strictEqual(j.settledAt, 1_700_000_000_000);
});

test('assembleJobs keeps jobs separate', () => {
  const all = assemble([created(1), completed(1), created(2), rejected(2)]);
  assert.strictEqual(all.length, 2);
  assert.deepStrictEqual(all.map((j) => j.state).sort(), ['completed', 'rejected']);
});

test('an expiry log after a verdict does not overturn it', () => {
  // Bookkeeping arriving late must not reverse a decision that was already made.
  const [j] = assemble([created(1), completed(1), expired(1)]);
  assert.strictEqual(j.state, 'completed');
});

test('settledAt is null when the verdict block has no known timestamp', () => {
  const [j] = assemble([created(1), completed(1)], new Map());
  assert.strictEqual(j.settledAt, null);
});

// ---------------------------------------------------------------------------
// What is refused. This is the point of the module.
// ---------------------------------------------------------------------------

test('an agent that graded its own work is refused', () => {
  // The verdict is the entire value of this source. One signed by the provider supplies
  // nothing the old attestation path did not already supply on trust.
  const [j] = assemble([created(1), funded(1, 100n), released(1, 100n), completed(1, PROVIDER)]);
  assert.strictEqual(jobs.rejectionReason(j), 'self_evaluated');

  const { evidence, dropped } = jobs.toEvidence([j], PROVIDER);
  assert.deepStrictEqual(evidence, []);
  assert.deepStrictEqual(dropped, [{ jobId: '1', reason: 'self_evaluated' }]);
});

test('an agent that paid itself is refused', () => {
  const [j] = assemble([created(1, PROVIDER, PROVIDER), funded(1, 100n, PROVIDER), released(1, 100n), completed(1)]);
  assert.strictEqual(jobs.rejectionReason(j), 'self_paid');
});

test('an expired job is not held against the provider', () => {
  // Expiry means nobody evaluated in time, which can as easily be the client failing to
  // act as the provider failing to deliver. Counting it would let any client damage an
  // agent by doing nothing.
  const [j] = assemble([created(1), funded(1, 100n), expired(1)]);
  assert.strictEqual(jobs.rejectionReason(j), 'not_terminal:expired');
  assert.deepStrictEqual(jobs.toEvidence([j], PROVIDER).evidence, []);
});

test('an unfinished job is not evidence either way', () => {
  const [j] = assemble([created(1), funded(1, 100n)]);
  assert.strictEqual(jobs.rejectionReason(j), 'not_terminal:open');
});

test('refusals are reported, not silently filtered', () => {
  // A quiet filter is indistinguishable from an agent that simply had no jobs.
  const js = assemble([
    created(1), funded(1, 10n), released(1, 10n), completed(1, PROVIDER), // self evaluated
    created(2), funded(2, 10n), expired(2),                                // expired
  ]);
  const { evidence, dropped } = jobs.toEvidence(js, PROVIDER);
  assert.strictEqual(evidence.length, 0);
  assert.strictEqual(dropped.length, 2);
  assert.deepStrictEqual(dropped.map((d) => d.reason).sort(), ['not_terminal:expired', 'self_evaluated']);
});

// ---------------------------------------------------------------------------
// Evidence shape
// ---------------------------------------------------------------------------

test('evidence carries exactly the fields the merkle leaf commits to', () => {
  // txHash, payer, amount, settledAt, success. Matching the existing shape is what lets
  // a job be scored without a new leaf format or a new evidence version.
  const [j] = assemble([created(1), funded(1, 500n), released(1, 450n), completed(1)]);
  const [e] = jobs.toEvidence([j], PROVIDER).evidence;

  for (const f of ['txHash', 'payer', 'amount', 'settledAt', 'success']) {
    assert.ok(f in e, `evidence must carry ${f}`);
  }
  assert.strictEqual(e.payer, CLIENT, 'the payer is the client, read from the log');
  assert.strictEqual(e.amount, '450', 'the amount actually released, not the budget');
  assert.strictEqual(e.success, true);
  assert.strictEqual(e.settledAt, 1_700_000_000_000);
});

test('a rejected job counts against success and pays nothing', () => {
  // The provider was not paid, so it must not earn fee volume; it still happened, so it
  // must count against the success rate. Recording the escrowed figure would pay an
  // agent, in score, for work that was refused.
  const [j] = assemble([created(1), funded(1, 500n), rejected(1)]);
  const [e] = jobs.toEvidence([j], PROVIDER).evidence;

  assert.strictEqual(e.success, false);
  assert.strictEqual(e.amount, '0');
});

test('a verdict from the paying client is kept but marked as not independent', () => {
  // A buyer accepting their own delivery is ordinary commerce and weaker evidence than
  // a third party. Keeping them but refusing to call them equal is the honest handling.
  const [indep] = assemble([created(1), funded(1, 10n), released(1, 10n), completed(1, EVALUATOR)]);
  const [byClient] = assemble([created(2), funded(2, 10n), released(2, 10n), completed(2, CLIENT)]);

  assert.strictEqual(jobs.toEvidence([indep], PROVIDER).evidence[0].independentEvaluator, true);
  assert.strictEqual(jobs.toEvidence([byClient], PROVIDER).evidence[0].independentEvaluator, false);
});

test('evidence is scoped to the provider asked about', () => {
  const other = addr('9');
  const js = assemble([
    created(1, CLIENT, PROVIDER), funded(1, 10n), released(1, 10n, PROVIDER), completed(1),
    created(2, CLIENT, other), funded(2, 99n), released(2, 99n, other), completed(2),
  ]);
  const { evidence } = jobs.toEvidence(js, PROVIDER);
  assert.strictEqual(evidence.length, 1);
  assert.strictEqual(evidence[0].jobId, '1');
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

test('the reader is off until a registry address is given', () => {
  assert.strictEqual(jobs.enabled(jobs.readConfig({})), false);
  assert.strictEqual(jobs.enabled(jobs.readConfig({ RPC_URL: 'https://x' })), false,
    'an RPC alone must not enable it: there is no canonical registry to assume');

  const cfg = jobs.readConfig({ JOBS_REGISTRY_ADDRESS: PROVIDER, RPC_URL: 'https://x' });
  assert.strictEqual(jobs.enabled(cfg), true);
  assert.strictEqual(cfg.registry, PROVIDER);
});

test('a malformed registry address fails at startup, not at the first scan', () => {
  assert.throws(() => jobs.readConfig({ JOBS_REGISTRY_ADDRESS: 'not-an-address' }), /must be an address/);
});

test('JOBS_RPC overrides the oracle RPC, so the registry may live on another chain', () => {
  const cfg = jobs.readConfig({
    JOBS_REGISTRY_ADDRESS: PROVIDER, RPC_URL: 'https://oracle', JOBS_RPC: 'https://elsewhere',
  });
  assert.strictEqual(cfg.rpcUrl, 'https://elsewhere');
});

test('scanLogs refuses when the reader is disabled rather than scanning nothing', async () => {
  await assert.rejects(
    () => jobs.scanLogs({ provider: {}, cfg: jobs.readConfig({}) }, 0, 10),
    /not configured/,
  );
});

test('scanLogs chunks the range', async () => {
  const calls = [];
  const provider = { getLogs: async (f) => { calls.push([f.fromBlock, f.toBlock]); return []; } };
  const cfg = { registry: PROVIDER, rpcUrl: 'https://x', chunkSize: 10 };

  await jobs.scanLogs({ provider, cfg }, 0, 25);
  assert.deepStrictEqual(calls, [[0, 9], [10, 19], [20, 25]]);
});
