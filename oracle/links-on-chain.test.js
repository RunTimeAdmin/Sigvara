'use strict';

// End to end: an agent linked to its ERC-8004 identity on chain, by setting the `sigvara` metadata
// key, with no POST /link and no credential (link-claims.js). The pure parts are tested in
// link-claims.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { snapshotOf } = require('./reviewers');
const { MAX_EXTERNAL_SCORE } = require('./external');
const { World, startOracle, wallet } = require('./test-support/oracle-harness');

const ADMIN = 'a'.repeat(64);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const counter = (text, name) => Number((text.match(new RegExp(`^${escapeRe(name)} (\\d+)`, 'm')) || [])[1]);

/**
 * An agent with five reviewers who each paid it before today's snapshot, and an ERC-8004 agent 7
 * that its operator has owned since block head - 60 and that names it from block head - 50. The
 * registry is on this chain. Nothing is linked with POST /link.
 */
function claimedWorld() {
  const w = new World();
  const agent = w.addRegisteredAgent();
  const head = w.data.head;
  const reviewers = Array.from({ length: 5 }, () => wallet().toLowerCase());
  const paidMs = snapshotOf(w.data.nowSec) * 1000 - 3_600_000;
  const events = reviewers.map((payer, i) => ({
    payer, ts: paidMs, amount: '1000000', txHash: `0x${(i + 1).toString(16).padStart(64, '0')}`,
  }));
  w.set('externalOwns', true);
  w.set('externalChainId', 5042);
  w.set('externalFeedback', reviewers.map((client) => ({ client, value: 100, tag: 'quality' })));
  w.set('reviewers', Object.fromEntries(reviewers.map((r) => [r, {
    registered: true, operator: wallet(), status: 0, registeredAt: w.data.nowSec - 365 * 86_400, matured: 60, bonded: true,
  }])));
  w.set('funders', Object.fromEntries(reviewers.map((r) => [r, wallet().toLowerCase()])));
  w.set('linkLogs', [{ agentId: '7', value: agent.didHash, blockNumber: head - 50, logIndex: 0 }]);
  w.set('linkHistory', {
    7: [
      { fromBlock: head - 60, owner: agent.operator, value: '0x' },
      { fromBlock: head - 50, owner: agent.operator, value: agent.didHash },
    ],
  });
  const state = JSON.stringify({ schemaVersion: 1, paymentEvents: { [agent.didHash]: events } });
  return { w, agent, head, files: { 'state.json': state } };
}

const linkEnv = (w) => ({ ORACLE_ADMIN_TOKEN: ADMIN, EXTERNAL_LINK_FROM_BLOCK: String(w.data.head - 100) });

async function untilEpoch(oracle) {
  for (let i = 0; i < 400; i++) {
    const text = (await oracle.call('GET', '/metrics')).text;
    if ((counter(text, 'sigvara_oracle_epochs_total{status="succeeded"}') || 0) >= 1) return text;
    if ((counter(text, 'sigvara_oracle_epochs_total{status="failed"}') || 0) >= 1) return text;
    await sleep(50);
  }
  throw new Error(`no epoch finished:\n${oracle.logs()}`);
}

/** Runs one epoch and returns what was proposed, the saved state, the logs and the calls made. */
async function epoch(w, files, env) {
  const oracle = await startOracle({ world: w, env, files });
  try {
    await untilEpoch(oracle);
    const call = oracle.calls().find((c) => c.name === 'proposeScore');
    return {
      scores: call?.args[1] ?? null,
      state: JSON.parse(oracle.files()['state.json']),
      logs: oracle.logs(),
      calls: oracle.calls(),
    };
  } finally {
    await oracle.stop();
  }
}

test('end to end: an agent linked on chain is scored from its ERC-8004 feedback, with no POST /link', async () => {
  const { w, agent, head, files } = claimedWorld();
  const { scores, state, logs } = await epoch(w, files, linkEnv(w));
  assert.equal(scores?.externalScore, MAX_EXTERNAL_SCORE, logs);
  assert.deepEqual(state.linkScanState.claims[agent.didHash], [{ agentId: '7', block: head - 50, logIndex: 0 }]);
  assert.deepEqual(state.linkScanState.cursor, { block: head + 1, logIndex: 0 });
  assert.deepEqual(state.links, {}, 'nothing was linked off chain');
  assert.match(logs, /ERC-8004 link scan: 1 link\(s\) made on chain/);
});

test('end to end: GET /score names the ERC-8004 agent a link made on chain points at', async () => {
  const { w, agent, files } = claimedWorld();
  const oracle = await startOracle({ world: w, env: linkEnv(w), files });
  try {
    await untilEpoch(oracle);
    const res = await oracle.call('GET', `/score/${agent.didHash}`);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.erc8004AgentId, '7');
    assert.equal(res.body.scores.externalScore, MAX_EXTERNAL_SCORE);
  } finally {
    await oracle.stop();
  }
});

test('end to end: a claim made from a wallet that is not the operator\'s is not kept', async () => {
  const { w, agent, head, files } = claimedWorld();
  const stranger = wallet();
  w.set('linkHistory', { 7: [{ fromBlock: head - 60, owner: stranger, value: agent.didHash }] });
  const { scores, state } = await epoch(w, files, linkEnv(w));
  assert.equal(scores?.externalScore, 0);
  assert.equal(state.linkScanState.claims[agent.didHash], undefined);
});

test('end to end: an 8004 agent handed to the operator in the block it was claimed in is not the operator\'s claim', async () => {
  // 7: a contract owned it, set the key to this agent's didHash and gave it to the operator, all in
  // one block. 8: minted to the operator with the key set in the same block, which looks the same.
  const { w, agent, head, files } = claimedWorld();
  const attacker = wallet();
  w.set('linkLogs', [
    { agentId: '7', value: agent.didHash, blockNumber: head - 50, logIndex: 0 },
    { agentId: '8', value: agent.didHash, blockNumber: head - 40, logIndex: 0 },
  ]);
  w.set('linkHistory', {
    7: [
      { fromBlock: head - 60, owner: attacker, value: '0x' },
      { fromBlock: head - 50, owner: agent.operator, value: agent.didHash },
    ],
    8: [{ fromBlock: head - 40, owner: agent.operator, value: agent.didHash }],
  });
  const { scores, state } = await epoch(w, files, linkEnv(w));
  assert.equal(scores?.externalScore, 0);
  assert.equal(state.linkScanState.claims[agent.didHash], undefined);
});

test('end to end: clearing the key before the snapshot undoes the link', async () => {
  const { w, agent, head, files } = claimedWorld();
  w.set('linkHistory', {
    7: [...w.data.linkHistory[7], { fromBlock: head - 20, owner: agent.operator, value: '0x' }],
  });
  const { scores, state } = await epoch(w, files, linkEnv(w));
  assert.equal(scores?.externalScore, 0);
  assert.equal(state.linkScanState.claims[agent.didHash].length, 1, 'the claim is kept; it no longer holds');
});

test('end to end: the 8004 agent\'s owner is tested against the operator at the snapshot, not the latest one', async () => {
  // The agent changes operator after the snapshot. A checker auditing after the change must still
  // test the 8004 agent's owner against the operator the primary saw.
  const { w, agent, head, files } = claimedWorld();
  w.set('snapshotBlock', head - 10);
  w.setFor('agents', agent.didHash, {
    ...w.data.agents[agent.didHash],
    operators: [{ fromBlock: 0, operator: agent.operator }, { fromBlock: head - 5, operator: wallet() }],
  });
  const { scores, logs } = await epoch(w, files, linkEnv(w));
  assert.equal(scores?.externalScore, MAX_EXTERNAL_SCORE, logs);
});

test('end to end: without EXTERNAL_LINK_FROM_BLOCK, links made on chain are not read', async () => {
  const { w, files } = claimedWorld();
  const { scores, state } = await epoch(w, files, { ORACLE_ADMIN_TOKEN: ADMIN });
  assert.equal(scores?.externalScore, 0);
  assert.equal(state.linkScanState ?? null, null);
});

test('end to end: a checker finds the same link on its own and agrees with the proposal exactly', async () => {
  const { w, agent, files } = claimedWorld();
  const { scores } = await epoch(w, files, linkEnv(w));
  assert.equal(scores?.externalScore, MAX_EXTERNAL_SCORE);

  // The checker starts from the same state the primary started from: no link of any kind.
  w.file = null;
  w.setFor('pending', agent.didHash, { exists: true, proposedAt: w.data.nowSec - 100, data: scores, evidenceRoot: null });
  const oracle = await startOracle({
    world: w, env: { ...linkEnv(w), ORACLE_MODE: 'checker', DIVERGENCE_TOLERANCE: '0' }, files,
  });
  try {
    const text = await untilEpoch(oracle);
    assert.equal(counter(text, 'sigvara_oracle_checker_comparisons_total{verdict="agreed"}'), 1, oracle.logs());
    assert.equal(counter(text, 'sigvara_oracle_checker_comparisons_total{verdict="diverged"}'), 0);
  } finally {
    await oracle.stop();
  }
});

test('end to end: a scan stopped short of the snapshot skips the agents its unchecked logs name, and scores the rest', async () => {
  // Two logs in one block name the agent. The first is checked; the node cannot answer for the
  // second, so the scan stops between them. The agent could hold a link the other operator has
  // found, so it is not scored on a guess. An agent no unchecked log names is scored as usual.
  const { w, agent, head, files } = claimedWorld();
  const other = w.addRegisteredAgent();
  w.set('linkLogs', [
    { agentId: '7', value: agent.didHash, blockNumber: head - 50, logIndex: 0 },
    { agentId: '9', value: agent.didHash, blockNumber: head - 50, logIndex: 1 },
  ]);
  w.set('linkHistory', { ...w.data.linkHistory, 9: 'throw' });
  const { state, logs, calls } = await epoch(w, files, linkEnv(w));
  const proposedFor = calls.filter((c) => c.name === 'proposeScore').map((c) => c.args[0]);
  assert.deepEqual(proposedFor, [other.didHash], logs);
  assert.deepEqual(state.linkScanState.cursor, { block: head - 50, logIndex: 1 }, 'it resumes at the second log');
  assert.deepEqual(state.linkScanState.claims[agent.didHash], [{ agentId: '7', block: head - 50, logIndex: 0 }]);
  assert.match(logs, /ERC-8004 link scan failed: 429/);
  assert.match(logs, new RegExp(`link scan has not reached block ${head}, today's snapshot; skipping the 1 agent`));
});

test('end to end: when the logs cannot be listed at all, the epoch scores nothing, and a rate limit is not halved', async () => {
  const { w, files } = claimedWorld();
  w.addRegisteredAgent();
  w.set('linkLogsFail', '429 too many requests');
  const { scores, logs, calls } = await epoch(w, files, linkEnv(w));
  assert.equal(scores, null, 'nothing proposed');
  assert.match(logs, /its logs could not be listed/);
  const widths = calls.filter((c) => c.name === 'readLinkLogsRefused').map((c) => c.args[1] - c.args[0] + 1);
  assert.ok(widths.length >= 1 && widths.every((n) => n === widths[0]), `no span was halved: ${JSON.stringify(widths)}`);
});

test('end to end: a span that times out is halved like one that returns too much', async () => {
  const { w, files } = claimedWorld();
  w.set('linkSpanLimit', 40);
  w.set('linkSpanError', 'external read timeout');
  const { scores, calls, logs } = await epoch(w, files, linkEnv(w));
  assert.equal(scores?.externalScore, MAX_EXTERNAL_SCORE, logs);
  assert.ok(calls.filter((c) => c.name === 'readLinkLogs').every((c) => c.args[1] - c.args[0] + 1 <= 40));
});

test('end to end: the scan reads no further than the registry scan, and an agent past it waits', async () => {
  const { w, head, files } = claimedWorld();
  w.set('registryScannedTo', head - 60);
  const { scores, state, logs } = await epoch(w, files, linkEnv(w));
  assert.deepEqual(state.linkScanState.cursor, { block: head - 59, logIndex: 0 });
  assert.equal(scores, null, 'the agent its unread claim names is skipped');
  assert.match(logs, /skipping the 1 agent\(s\) its unchecked logs name/);
});

test('end to end: a log naming a didHash that is not a registered agent costs no read', async () => {
  const { w, head, files } = claimedWorld();
  const stranger = `0x${'5a'.repeat(32)}`;
  w.set('linkLogs', [{ agentId: '11', value: stranger, blockNumber: head - 30, logIndex: 0 }]);
  w.set('linkHistory', { 11: [{ fromBlock: 0, owner: wallet(), value: stranger }] });
  const { state, calls } = await epoch(w, files, linkEnv(w));
  assert.deepEqual(calls.filter((c) => c.name === 'claimHolds' || c.name === 'ownerAt'), []);
  assert.deepEqual(state.linkScanState.claims, {});
});

test('end to end: a span the node refuses for its size is halved until it answers', async () => {
  const { w, files } = claimedWorld();
  w.set('linkSpanLimit', 40);
  const { scores, calls, logs } = await epoch(w, files, linkEnv(w));
  assert.equal(scores?.externalScore, MAX_EXTERNAL_SCORE, logs);
  const reads = calls.filter((c) => c.name === 'readLinkLogs').map((c) => c.args);
  assert.ok(reads.length > 1, JSON.stringify(reads));
  assert.ok(reads.every(([from, to]) => to - from + 1 <= 40), JSON.stringify(reads));
});

test('end to end: with the registry on another chain, links made on chain are not read', async () => {
  const { w, files } = claimedWorld();
  w.set('externalChainId', 1);
  const { scores, state, logs } = await epoch(w, files, linkEnv(w));
  assert.equal(scores?.externalScore, 0);
  assert.equal(state.linkScanState ?? null, null);
  assert.match(logs, /the ERC-8004 registry is on another chain/);
});

test('end to end: when the registry\'s chain cannot be read, the epoch scores nothing', async () => {
  const { w, files } = claimedWorld();
  delete w.data.externalChainId;
  w.flush();
  const { scores, logs } = await epoch(w, files, linkEnv(w));
  assert.equal(scores, null, 'nothing proposed');
  assert.match(logs, /registry's chain could not be read/);
});
