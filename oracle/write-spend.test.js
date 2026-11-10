'use strict';

// What an epoch writes, and what it reads. An unchanged score is not proposed again until its last write is
// SCORE_REFRESH_HOURS old, and a checker does not take a slot left empty for that reason for a primary that is late.
// MAX_WRITES_PER_EPOCH caps the proposals one epoch sends, spent on the oldest scores first. An agent with no bond is
// read once and then left out of the epoch's reads until a log says its bond may have changed. The real index.js runs
// as a child process with the chain stubbed (test-support/), as in robustness.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { ethers } = require('ethers');
const { World, startOracle, ASSET } = require('./test-support/oracle-harness');

const ADMIN = 'a'.repeat(64);
const BASE_ENV = { ORACLE_ADMIN_TOKEN: ADMIN };
const HOUR = 3600;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const names = (calls) => calls.map((c) => c.name);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const counter = (text, name) => {
  const m = text.match(new RegExp(`^${escapeRe(name)} (\\d+)`, 'm'));
  return m ? Number(m[1]) : NaN;
};
const EPOCHS_OK = 'sigvara_oracle_epochs_total{status="succeeded"}';
const EPOCHS_FAILED = 'sigvara_oracle_epochs_total{status="failed"}';
const UNCHANGED = 'sigvara_oracle_unchanged_not_proposed_total';
const HELD_BY_BUDGET = 'sigvara_oracle_agents_held_by_write_budget_total';
const DEFERRED_PROPOSE = 'sigvara_oracle_checker_deferred_total{action="propose"}';

async function withOracle(opts, fn) {
  const oracle = await startOracle(opts);
  try {
    return await fn(oracle);
  } finally {
    await oracle.stop();
  }
}

/** The /metrics text once `count` epochs have finished, however they ended. */
async function epochsFinished(oracle, count = 1) {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const text = (await oracle.call('GET', '/metrics')).text;
    if ((counter(text, EPOCHS_OK) || 0) + (counter(text, EPOCHS_FAILED) || 0) >= count) return text;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} epoch(s):\n${oracle.logs()}`);
    await sleep(50);
  }
}

/** Run one more epoch and wait for it. */
async function nextEpoch(oracle, count) {
  assert.equal((await oracle.call('POST', '/epoch', {}, ADMIN)).status, 202);
  return epochsFinished(oracle, count);
}

/** What this oracle computes for an agent with no payments: the score already on chain, in the tests below. */
function computedScores() {
  const world = new World();
  world.addRegisteredAgent();
  return withOracle({ world, env: BASE_ENV }, async (oracle) => {
    await epochsFinished(oracle);
    const { feeScore, successScore, ageScore, externalScore, communityScore, propagationScore } = oracle.calls()[0].args[1];
    return { feeScore, successScore, ageScore, externalScore, communityScore, propagationScore };
  });
}

// ---- an unchanged score --------------------------------------------------------------------------------------

test('an unchanged score is not proposed again until its last write is SCORE_REFRESH_HOURS old', async () => {
  const same = await computedScores();
  const world = new World();
  const now = world.data.nowSec;
  const recent = world.addRegisteredAgent();
  const due = world.addRegisteredAgent();
  const finalized = world.addRegisteredAgent();
  // Written an hour ago, and twelve hours and a minute ago, with the score this oracle computes now.
  world.setFor('reputation', recent.didHash, { ...same, lastUpdated: now - HOUR });
  world.setFor('reputation', due.didHash, { ...same, lastUpdated: now - 12 * HOUR - 60 });
  // Proposed seven hours ago with the same score, so finalizing it dates the score on chain then.
  world.setFor('pending', finalized.didHash, { exists: true, proposedAt: now - 7 * HOUR, data: same, evidenceRoot: null });

  await withOracle({ world, env: BASE_ENV }, async (oracle) => {
    const text = await epochsFinished(oracle);
    assert.deepEqual(oracle.calls().map((c) => [c.name, c.args[0]]), [
      ['proposeScore', due.didHash],
      ['finalizeScore', finalized.didHash],
    ], 'the score twelve hours old is written again; the others are not, though one is finalized');
    assert.equal(counter(text, UNCHANGED), 2);
    assert.match(oracle.logs(), /2 agent\(s\) unchanged since their last write, less than SCORE_REFRESH_HOURS ago: not proposed/);
    assert.deepEqual((await oracle.call('GET', '/health')).body.writePolicy, { scoreRefreshHours: 12, maxWritesPerEpoch: 1000 });
  });
});

// ---- a checker and a skipped write ----------------------------------------------------------------------------

test('a checker does not cover for a slot left empty because the score had not changed, until the refresh is a grace late', async () => {
  const same = await computedScores();
  const world = new World();
  const agent = world.addRegisteredAgent();
  const written = world.data.nowSec - 3 * HOUR;
  world.setFor('reputation', agent.didHash, { ...same, lastUpdated: written });
  const env = {
    ...BASE_ENV, ORACLE_MODE: 'checker', DIVERGENCE_TOLERANCE: '3',
    EPOCH_HOURS: '1', CHECKER_GRACE_MINUTES: '120', MAX_CLOCK_SKEW_SECONDS: String(2 * 86_400),
  };

  await withOracle({ world, env }, async (oracle) => {
    let text = await epochsFinished(oracle, 1);
    assert.equal(counter(text, DEFERRED_PROPOSE), 0, 'nothing is due, so nothing is left to the primary');
    // Past the grace, and still short of twelve hours since the last write.
    world.set('nowSec', world.data.nowSec + 2 * HOUR + 60);
    text = await nextEpoch(oracle, 2);
    assert.deepEqual(names(oracle.calls()), [], 'a primary that skipped an unchanged score is not late');
    assert.equal(counter(text, UNCHANGED), 2);

    // Twelve hours since the last write: due now, so the grace starts.
    world.set('nowSec', written + 12 * HOUR + 60);
    text = await nextEpoch(oracle, 3);
    assert.deepEqual(names(oracle.calls()), []);
    assert.equal(counter(text, DEFERRED_PROPOSE), 1);
    // A grace later the primary is late, and the checker covers.
    world.set('nowSec', world.data.nowSec + 2 * HOUR + 60);
    await nextEpoch(oracle, 4);
    assert.deepEqual(oracle.calls().map((c) => [c.name, c.args[3]]), [['proposeScore', true]]);
  });
});

// ---- the write budget ----------------------------------------------------------------------------------------

const BASE = 84532;
const FINALIZED = 5_000;
const hex = (n) => `0x${BigInt(n).toString(16)}`;

/** Base Sepolia with no payments on it, finalized a quarter of an hour ago: a payment chain that holds nothing up. */
async function startBase(nowSec) {
  const block = (n) => ({
    number: hex(n), hash: ethers.id(`base-${n}`), parentHash: ethers.id(`base-${n - 1}`),
    timestamp: hex(n === FINALIZED ? nowSec - 900 : nowSec - 7200), nonce: '0x0000000000000000', difficulty: '0x0',
    gasLimit: hex(30_000_000), gasUsed: '0x0', miner: ethers.ZeroAddress, extraData: '0x',
    baseFeePerGas: '0x1', transactions: [],
  });
  const answer = ({ method, params }) => {
    if (method === 'eth_chainId') return hex(BASE);
    if (method === 'eth_getBlockByNumber') return block(params[0] === 'finalized' ? FINALIZED : Number(params[0]));
    if (method === 'eth_getLogs') return [];
    if (method === 'eth_getCode') return '0x';
    throw new Error(`base stub: ${method}`);
  };
  const respond = (r) => {
    try { return { jsonrpc: '2.0', id: r.id, result: answer(r) }; }
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
    url: `http://127.0.0.1:${server.address().port}/`,
    stop: () => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); },
  };
}

// Far from what an agent with no payments computes, so the agent holding it has a changed score to write.
const HIGH_SCORE = { feeScore: 20, successScore: 15, ageScore: 10, externalScore: 0, communityScore: 5, propagationScore: 5 };

test('the write budget holds the proposals past it, says why, and spends itself on the oldest score first', async () => {
  const world = new World();
  const now = world.data.nowSec;
  world.addRegisteredAgent();
  const old = world.addRegisteredAgent();
  // Registered after the other, and its score, written ten days ago, has changed since.
  world.setFor('reputation', old.didHash, { ...HIGH_SCORE, lastUpdated: now - 10 * 86_400 });
  const base = await startBase(now);
  const env = {
    ORACLE_ADMIN_TOKEN: ADMIN,
    EXPECTED_CHAIN_ID: '5042',
    PAYMENT_VERIFICATION: 'required',
    PAYMENT_ASSET: ASSET,
    PAYMENT_MIN_AMOUNT: '10000',
    PAYMENT_SCAN_ENABLED: '1',
    PAYMENT_SCAN_FROM_BLOCK: String(1_000_000 - 100),
    PAYMENT_SCAN_PACE_MS: '0',
    PAYMENT_CHAIN_IDS: String(BASE),
    [`PAYMENT_CHAIN_${BASE}_RPC_URL`]: base.url,
    [`PAYMENT_CHAIN_${BASE}_ASSET`]: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    [`PAYMENT_CHAIN_${BASE}_FROM_BLOCK`]: String(FINALIZED - 300),
    [`PAYMENT_CHAIN_${BASE}_FEE_UNIT`]: '100000000',
    [`PAYMENT_CHAIN_${BASE}_MIN_AMOUNT`]: '10000',
    [`PAYMENT_CHAIN_${BASE}_PACE_MS`]: '0',
    [`PAYMENT_CHAIN_${BASE}_MODE`]: 'on',
    MAX_WRITES_PER_EPOCH: '1',
  };
  try {
    await withOracle({ world, env }, async (oracle) => {
      const text = await epochsFinished(oracle);
      assert.deepEqual(oracle.calls().map((c) => [c.name, c.args[0]]), [['proposeScore', old.didHash]],
        'one proposal, for the score that is oldest');
      assert.match(oracle.logs(), /1 agent\(s\) left unscored: this epoch's 1 proposal\(s\) \(MAX_WRITES_PER_EPOCH\) were spent/);
      assert.equal(counter(text, HELD_BY_BUDGET), 1);
      assert.equal(counter(text, EPOCHS_OK), 1, 'a budget spent is not a failed epoch');
      const health = (await oracle.call('GET', '/health')).body;
      assert.deepEqual(health.paymentChainHold.reasons, ['write_budget']);
      assert.equal(health.paymentChainHold.agents, 1);
      assert.equal(health.writePolicy.maxWritesPerEpoch, 1);
    });
  } finally {
    await base.stop();
  }
});

test('thousands of free registrations and a flood of fresh work cannot keep an old score out of the budget', () => {
  const { writeOrder } = require('./epoch-policy');
  const now = 1_800_000_000;
  const PENDING_BOND = 3;
  const infos = [];
  // Registrations with no bond, before and after the agent that matters: they cost their registrant nothing.
  for (let i = 0; i < 3000; i += 1) infos.push({ didHash: `spam-a${i}`, status: PENDING_BOND, reputation: { lastUpdated: 0 } });
  // Bonded agents written in the last hour whose scores moved, so each wants a proposal.
  for (let i = 0; i < 2000; i += 1) infos.push({ didHash: `busy-${i}`, status: 0, reputation: { lastUpdated: now - 600 - i } });
  // Bonded registrations never scored.
  for (let i = 0; i < 1000; i += 1) infos.push({ didHash: `new-${i}`, status: 0, reputation: { lastUpdated: 0 } });
  infos.push({ didHash: 'old', status: 0, reputation: { lastUpdated: now - 11 * HOUR } });
  for (let i = 0; i < 3000; i += 1) infos.push({ didHash: `spam-b${i}`, status: PENDING_BOND, reputation: { lastUpdated: 0 } });

  const order = writeOrder(infos);
  assert.equal(order.length, infos.length);
  // The epoch spends its budget in this order: an agent with no bond is skipped at its guard read and costs no
  // write, every other one here costs a proposal.
  const budget = 50;
  const written = [];
  for (const a of order) {
    if (a.status === PENDING_BOND) continue;
    if (written.length === budget) break;
    written.push(a.didHash);
  }
  assert.equal(written[0], 'old', 'the oldest score is written first');
  assert.ok(written.slice(1).every((d) => d.startsWith('busy-')), 'then the scores already on chain, oldest first');
  assert.equal(order.findIndex((a) => a.status === PENDING_BOND), infos.length - 6000, 'registrations with no bond come last');
  assert.ok(order.indexOf(infos.find((a) => a.didHash === 'new-0')) > order.indexOf(infos.find((a) => a.didHash === 'busy-0')));
});

// ---- agents with no bond -------------------------------------------------------------------------------------

test('an agent with no bond is read once, and then only after a stake log or a new minimum stake names it', async () => {
  const world = new World();
  const bonded = world.addRegisteredAgent();
  const staker = world.addRegisteredAgent();
  const waiter = world.addRegisteredAgent();
  world.setFor('bonded', staker.didHash, false);
  world.setFor('bonded', waiter.didHash, false);
  world.set('recordEpochReads', true);

  await withOracle({ world, env: BASE_ENV }, async (oracle) => {
    let seen = 0;
    // The agents this epoch read, and what it wrote, since the last call.
    const epoch = () => {
      const calls = oracle.calls().slice(seen);
      seen += calls.length;
      return {
        read: new Set(calls.filter((c) => c.name === 'epochRead').map((c) => c.args[1])),
        proposed: calls.filter((c) => c.name === 'proposeScore').map((c) => c.args[0]),
      };
    };
    let text = await epochsFinished(oracle, 1);
    let e = epoch();
    assert.deepEqual([...e.read].sort(), [bonded.didHash, staker.didHash, waiter.didHash].sort(), 'the first epoch reads every agent');
    assert.deepEqual(e.proposed, [bonded.didHash]);
    assert.equal(counter(text, 'sigvara_oracle_skipped_unbonded_total'), 2);

    text = await nextEpoch(oracle, 2);
    e = epoch();
    assert.deepEqual([...e.read], [bonded.didHash], 'the two with no bond are not read again');
    assert.match(oracle.logs(), /2 agent\(s\) with no bond not read this epoch/);

    // The staker deposits: a log names it, and it is read and scored at the next epoch.
    world.set('head', world.data.head + 1);
    world.set('bondLogs', [{ blockNumber: world.data.head, didHash: staker.didHash }]);
    world.setFor('bonded', staker.didHash, true);
    await nextEpoch(oracle, 3);
    e = epoch();
    assert.ok(e.read.has(staker.didHash), 'read after its stake log');
    assert.ok(!e.read.has(waiter.didHash));
    assert.deepEqual(e.proposed.sort(), [bonded.didHash, staker.didHash].sort());

    // The minimum stake is lowered, which no log about the waiter says, and the waiter now holds enough.
    world.set('head', world.data.head + 1);
    world.set('bondLogs', [...world.data.bondLogs, { blockNumber: world.data.head, minimumStake: true }]);
    world.setFor('bonded', waiter.didHash, true);
    await nextEpoch(oracle, 4);
    e = epoch();
    assert.ok(e.read.has(waiter.didHash), 'read after the minimum changed');
    assert.ok(e.proposed.includes(waiter.didHash));
  });
});

// ---- the pieces on their own ---------------------------------------------------------------------------------

test('bond watch: lets an agent back for a log naming it, everyone for a new minimum, a failed read or a day', async () => {
  const { createBondWatch } = require('./bond-watch');
  const watch = createBondWatch();
  let head = 1_000;
  let changes = { agents: new Set(), minimumChanged: false };
  const asked = [];
  const refresh = (nowMs) => watch.refresh({
    readHead: async () => head,
    readChanges: async (from, to) => { asked.push([from, to]); if (changes === 'fail') throw new Error('429'); return changes; },
    nowMs,
  });

  assert.equal((await refresh(0)).full, true, 'the first epoch reads everyone');
  assert.deepEqual(asked, [], 'and needs no logs to do it');
  watch.add('0xAA');
  watch.add('0xbb');
  head = 1_500;
  await refresh(60_000);
  assert.deepEqual(asked, [[901, 1_500]], 'from a little before where the last read stopped');
  assert.equal(watch.excluded('0xaa'), true);
  assert.equal(watch.excluded('0xBB'), true);

  changes = { agents: new Set(['0xaa']), minimumChanged: false };
  await refresh(120_000);
  assert.equal(watch.excluded('0xaa'), false, 'a log named it');
  assert.equal(watch.excluded('0xbb'), true);

  watch.add('0xaa');
  changes = { agents: new Set(), minimumChanged: true };
  await refresh(180_000);
  assert.equal(watch.size(), 0, 'a new minimum lets everyone back');

  watch.add('0xaa');
  changes = 'fail';
  assert.ok((await refresh(240_000)).error, 'a read that fails is said');
  assert.equal(watch.size(), 0, 'and lets everyone back');

  watch.add('0xaa');
  changes = { agents: new Set(), minimumChanged: false };
  await refresh(300_000);
  assert.equal(watch.excluded('0xaa'), true);
  await refresh(24 * HOUR * 1000);
  assert.equal(watch.size(), 0, 'once a day everyone is read again');
});

test('writeDueAt: due at once unless the score on chain is the same one, and then once its last write is the refresh old', () => {
  const { writeDueAt } = require('./epoch-policy');
  const same = { feeScore: 1, successScore: 2, ageScore: 3, externalScore: 0, communityScore: 5, propagationScore: 0 };
  assert.equal(writeDueAt({ ...same, lastUpdated: 1_000 }, same, 600), 1_600);
  assert.equal(writeDueAt({ ...same, lastUpdated: 1_000 }, { ...same, ageScore: 4 }, 600), 0, 'a changed factor');
  assert.equal(writeDueAt({ ...same, lastUpdated: 0 }, same, 600), 0, 'never scored');
  assert.equal(writeDueAt(null, same, 600), 0, 'not read');
  assert.equal(writeDueAt({ lastUpdated: 1_000 }, same, 600), 0, 'factors that did not decode');
  assert.equal(writeDueAt({ ...same, lastUpdated: 1_000 }, same, 0), 1_000, 'a refresh of 0 writes every epoch');
});

test('scoreRefreshSeconds: 12 hours unset, and refused where a stable score could pass a day before its next write lands', () => {
  const { scoreRefreshSeconds } = require('./epoch-policy');
  assert.deepEqual(scoreRefreshSeconds(undefined, HOUR * 1000), { seconds: 12 * HOUR });
  assert.deepEqual(scoreRefreshSeconds('', 24 * HOUR * 1000), { seconds: 12 * HOUR });
  assert.deepEqual(scoreRefreshSeconds('0', HOUR * 1000), { seconds: 0 });
  assert.match(scoreRefreshSeconds('13', HOUR * 1000).error, /SCORE_REFRESH_HOURS is 13/);
  assert.match(scoreRefreshSeconds('-1', HOUR * 1000).error, /SCORE_REFRESH_HOURS is -1/);
  assert.match(scoreRefreshSeconds('12', 4 * HOUR * 1000).error, /EPOCH_HOURS of 4/);
  assert.deepEqual(scoreRefreshSeconds('10', 4 * HOUR * 1000), { seconds: 10 * HOUR });
});
