'use strict';

// watcher.js end to end: the real process and real ethers, against a fake checker, node and webhook.
// What reaches the webhook is somebody else's channel, and ethers quotes the whole RPC URL when a node
// answers 500, so the alert must say what happened without it.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

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

async function withWatcher({ divergence, refusal = null }, run) {
  const alerts = [];
  const webhook = await listen((_req, res, body) => { alerts.push(body); res.writeHead(204); res.end(); });
  const checker = await listen((req, res) => {
    if (req.url === '/health') return json(res, { ok: true, timeSinceLastEpochMs: 1000 });
    return divergence(res);
  });
  // Answers who it is, and fails everything else, as a node having a bad day does.
  const node = await listen((_req, res, body) => {
    const j = JSON.parse(body);
    const reply = (c) => {
      if (c.method === 'eth_chainId') return { jsonrpc: '2.0', id: c.id, result: '0x1' };
      return refusal ? { jsonrpc: '2.0', id: c.id, error: refusal } : null;
    };
    const replies = (Array.isArray(j) ? j : [j]).map(reply);
    if (replies.includes(null)) { res.writeHead(500); return res.end('oops'); }
    return json(res, Array.isArray(j) ? replies : replies[0]);
  });
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
