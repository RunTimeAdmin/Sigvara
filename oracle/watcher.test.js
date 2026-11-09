'use strict';

// watcher.js end to end: the real process and real ethers, against a fake checker, node and webhook.
// What reaches the webhook is somebody else's channel, and ethers quotes the whole RPC URL when a node
// answers 500, so the alert must say what happened without it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ethers } = require('ethers');

const KEY = 'k3yk3yk3yk3yk3yk3yk3yk3y';
const DID = `0x${'cd'.repeat(32)}`;
const REPUTATION = `0x${'aa'.repeat(20)}`;

const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => handler(req, res, body));
  }).listen(0, '127.0.0.1', () => resolve(server));
});
const base = (server) => `http://127.0.0.1:${server.address().port}`;
const json = (res, value, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(value));
};

async function until(check, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const healthy = (res) => json(res, { ok: true, timeSinceLastEpochMs: 1000 });

async function withWatcher({ divergence, refusal = null, rpc = null, health = healthy, webhookDelayMs = 0 }, run) {
  const alerts = [];
  const webhook = await listen((_req, res, body) => {
    alerts.push(body);
    setTimeout(() => { res.writeHead(204); res.end(); }, webhookDelayMs);
  });
  const checker = await listen((req, res) => {
    if (req.url === '/health') return health(res);
    return divergence(res);
  });
  // Answers who it is, and fails everything else, as a node having a bad day does.
  const node = await listen(rpc ?? ((_req, res, body) => {
    const j = JSON.parse(body);
    const reply = (c) => {
      if (c.method === 'eth_chainId') return { jsonrpc: '2.0', id: c.id, result: '0x1' };
      return refusal ? { jsonrpc: '2.0', id: c.id, error: refusal } : null;
    };
    const replies = (Array.isArray(j) ? j : [j]).map(reply);
    if (replies.includes(null)) { res.writeHead(500); return res.end('oops'); }
    return json(res, Array.isArray(j) ? replies : replies[0]);
  }));
  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'test-support', 'fast-interval.js'), path.join(__dirname, 'watcher.js')], {
    env: {
      ...process.env,
      CHECKER_URL: base(checker),
      RPC_URL: `${base(node)}/v2/${KEY}`,
      REPUTATION_ADDRESS: REPUTATION,
      WEBHOOK_URL: `${base(webhook)}/hook`,
      POLL_SECONDS: '30',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  try {
    await run({ alerts, output: () => output });
  } finally {
    child.kill();
    await exited;
    await Promise.all([webhook, checker, node].map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); })));
  }
}

const disputed = (res) => json(res, {
  mode: 'checker', seesProposals: true, divergences: [{ didHash: DID, oracleScore: 1, computedScore: 2, proposedAt: 1 }],
});

const REPUTATION_ABI = new ethers.Interface([
  'function challengeWindow() view returns (uint256)',
  'function getPendingScore(bytes32 didHash) view returns (tuple(tuple(uint8 feeScore, uint8 successScore, uint8 ageScore, uint8 externalScore, uint8 communityScore, uint8 propagationScore, uint256 lastUpdated) data, uint256 proposedAt, bool exists, bytes32 evidenceRoot, address proposer, uint256 finalizableAt))',
]);
const PROPOSED_AT = Math.floor(Date.now() / 1000);
const agents = (n) => Array.from({ length: n }, (_, i) => ethers.id(`agent ${i}`));
const allDisputed = (dids) => (res) => json(res, {
  mode: 'checker', seesProposals: true, divergences: dids.map((didHash) => ({ didHash, pendingTotal: 1, ownTotal: 2, proposedAt: PROPOSED_AT })),
});

// A node as dRPC answered on 6 November 2026: a whole batch over 10 calls gets a 400, and anything
// smaller is read. Every agent has an open proposal, except that one in `reverting` cannot be read.
// `deadline()` is when the open proposal becomes finalizable; moving it closer stands in for the hours passing.
const pickyNode = (reverting = new Set(), { deadline = () => PROPOSED_AT + 21600 } = {}) => (_req, res, body) => {
  const j = JSON.parse(body);
  if (Array.isArray(j) && j.length > 10) {
    return json(res, j.map((c) => ({ jsonrpc: '2.0', id: c.id, error: { code: 31, message: 'Batch of more than 10 requests are not allowed' } })), 400);
  }
  const reply = (c) => {
    if (c.method === 'eth_chainId') return { jsonrpc: '2.0', id: c.id, result: '0x1' };
    const call = REPUTATION_ABI.parseTransaction({ data: c.params[0].data });
    if (call.name === 'challengeWindow') {
      return { jsonrpc: '2.0', id: c.id, result: REPUTATION_ABI.encodeFunctionResult(call.name, [21600]) };
    }
    if (reverting.has(call.args[0])) {
      return { jsonrpc: '2.0', id: c.id, error: { code: 3, message: 'execution reverted', data: '0x08c379a0' } };
    }
    const pending = [[0, 0, 0, 0, 0, 0, 0], PROPOSED_AT, true, ethers.ZeroHash, ethers.ZeroAddress, deadline()];
    return { jsonrpc: '2.0', id: c.id, result: REPUTATION_ABI.encodeFunctionResult(call.name, [pending]) };
  };
  return json(res, Array.isArray(j) ? j.map(reply) : reply(j));
};

test('watcher: every disputed agent is read and alerted on a node that refuses a large batch', async () => {
  const dids = agents(12);
  await withWatcher({ divergence: allDisputed(dids), rpc: pickyNode() }, async ({ alerts }) => {
    await until(() => dids.every((did) => alerts.some((a) => a.includes(did))));
    assert.ok(alerts.every((a) => a.includes('checker disputes a score')));
  });
});

test('watcher: an agent it cannot read fails the poll, after alerting on the agents it can', async () => {
  const [readable, unreadable] = agents(2);
  const rpc = pickyNode(new Set([unreadable]));
  await withWatcher({ divergence: allDisputed([readable, unreadable]), rpc }, async ({ alerts }) => {
    const raised = () => alerts.find((a) => a.includes('the watcher cannot complete its checks'));
    await until(raised);
    assert.match(raised(), /last error: could not read 1 of 2 disputed agents/);
    assert.ok(alerts.some((a) => a.includes(readable)), 'the agent it could read still alerted');
    assert.equal(alerts.some((a) => a.includes(unreadable)), false);
  });
});

test('watcher: a node failing keeps the RPC URL and its key out of the alert and the log', async () => {
  await withWatcher({ divergence: disputed }, async ({ alerts, output }) => {
    await until(() => alerts.some((a) => a.includes('the watcher cannot complete its checks')));
    const alert = alerts.find((a) => a.includes('the watcher cannot complete its checks'));
    assert.match(alert, /last error: server response 500/, 'and still says what happened');
    for (const said of [alert, output()]) {
      assert.equal(said.includes(KEY), false, 'the key');
      assert.equal(said.includes('/v2/'), false, 'the path it sits in');
    }
  });
});

test('watcher: a node refusing a read is reported in its own words', async () => {
  await withWatcher({ divergence: disputed, refusal: { code: -32005, message: 'rate limit exceeded' } }, async ({ alerts }) => {
    const raised = () => alerts.find((a) => a.includes('the watcher cannot complete its checks'));
    await until(raised);
    assert.match(raised(), /last error: rate limit exceeded/);
    assert.equal(raised().includes('coalesce'), false);
  });
});

test('watcher: what the checker sent instead of JSON is not repeated in the alert', async () => {
  const divergence = (res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<html>planted words</html>');
  };
  await withWatcher({ divergence }, async ({ alerts, output }) => {
    await until(() => alerts.some((a) => a.includes('the checker is not checking')));
    const alert = alerts.find((a) => a.includes('the checker is not checking'));
    assert.match(alert, /\/divergence did not return JSON/);
    for (const said of [alert, output()]) {
      assert.equal(said.includes('planted'), false);
      assert.equal(said.includes('<html'), false);
    }
  });
});

// A checker whose last save failed, or whose scoring is stale, answers /health with 503 and a body saying so,
// and goes on auditing. Read as unreachable, it stopped every dispute reaching the committee exactly when the
// checker was degraded.
test('watcher: a checker answering /health with 503 still has its disputes relayed, and the reason is the true one', async () => {
  const [did] = agents(1);
  const health = (res) => json(res, { ok: false, statePersisted: false, timeSinceLastEpochMs: 1000 }, 503);
  await withWatcher({ health, divergence: allDisputed([did]), rpc: pickyNode() }, async ({ alerts }) => {
    await until(() => alerts.some((a) => a.includes('checker disputes a score') && a.includes(did)));
    const down = alerts.filter((a) => a.includes('the checker is not checking'));
    assert.equal(down.length, 1);
    assert.match(down[0], /checker reports not ok/);
  });
});

test('watcher: a new reason while the checker is not ok is a new alert, and the same reason is not', async () => {
  let polls = 0;
  // Not ok at first, then ok but refusing its divergence list: two causes, two pages.
  const health = (res) => {
    polls += 1;
    return polls <= 3 ? json(res, { ok: false, timeSinceLastEpochMs: 1000 }, 503) : healthy(res);
  };
  const divergence = (res) => (polls <= 3 ? disputed(res) : json(res, { error: 'Rate limited' }, 429));
  await withWatcher({ health, divergence, rpc: pickyNode() }, async ({ alerts }) => {
    await until(() => alerts.filter((a) => a.includes('the checker is not checking')).length >= 2 && polls > 6);
    const down = alerts.filter((a) => a.includes('the checker is not checking'));
    assert.equal(down.length, 2);
    assert.match(down[0], /checker reports not ok/);
    assert.match(down[1], /divergence list could not be read/);
  });
});

// ---- each dispute is paged once, and its last call goes out whatever the checker does --------------

const count = (alerts, words) => alerts.filter((a) => a.includes(words)).length;
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

test('watcher: LAST CALL goes out while the checker is unreachable', async () => {
  const [did] = agents(1);
  let refused = 0;
  let down = false;
  const health = (res) => {
    if (!down) return healthy(res);
    refused += 1;
    res.writeHead(500);
    return res.end();
  };
  // Inside the final hour once the checker has gone, as if the hours had passed while it was down.
  const deadline = () => (refused >= 2 ? Math.floor(Date.now() / 1000) + 1800 : PROPOSED_AT + 21600);
  await withWatcher({ health, divergence: allDisputed([did]), rpc: pickyNode(new Set(), { deadline }) }, async ({ alerts }) => {
    await until(() => count(alerts, 'checker disputes a score') === 1);
    down = true;
    await until(() => count(alerts, 'LAST CALL') === 1);
    assert.ok(alerts.find((a) => a.includes('LAST CALL')).includes(did));
    assert.match(alerts.find((a) => a.includes('the checker is not checking')), /checker unreachable/);
  });
});

test('watcher: a dispute first seen inside the final window is paged once', async () => {
  const [did] = agents(1);
  const deadline = () => Math.floor(Date.now() / 1000) + 1800;
  await withWatcher({ divergence: allDisputed([did]), rpc: pickyNode(new Set(), { deadline }) }, async ({ alerts }) => {
    await until(() => count(alerts, did) >= 1);
    await settle(1000);
    assert.equal(count(alerts, did), 1);
    assert.equal(count(alerts, 'LAST CALL'), 0, 'its one page already says how little time is left');
  });
});

// A poll can outlast the interval: a node backing off, or a webhook slow to answer. Two polls at once each
// took the dispute the other was about to page for unseen.
test('watcher: one poll at a time, so a slow webhook does not page a dispute twice', async () => {
  const dids = agents(2);
  await withWatcher({ divergence: allDisputed(dids), rpc: pickyNode(), webhookDelayMs: 300 }, async ({ alerts }) => {
    await until(() => dids.every((did) => count(alerts, did) >= 1));
    await settle(1000);
    for (const did of dids) assert.equal(count(alerts, did), 1, did);
  });
});

test('watcher: a divergence list cut short is paged once, with the number of records behind it', async () => {
  const divergence = (res) => json(res, { mode: 'checker', seesProposals: true, total: 250, truncated: true, divergences: [] });
  await withWatcher({ divergence }, async ({ alerts }) => {
    await until(() => count(alerts, 'more disputes than its list shows') === 1);
    await settle(500);
    assert.equal(count(alerts, 'more disputes than its list shows'), 1);
    assert.match(alerts.find((a) => a.includes('more disputes than its list shows')), /recorded 250/);
  });
});
