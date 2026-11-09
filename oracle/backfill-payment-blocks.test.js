'use strict';

// scripts/backfill-payment-blocks.mjs against a stub RPC: what it writes to the state file, and that it does not
// overwrite a state file the oracle wrote while it ran.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'backfill-payment-blocks.mjs');
const TX = `0x${'ab'.repeat(32)}`;
const T0 = 1_700_000_000;
const HEAD = 100;
const SETTLED = 50;

/** Blocks 1..HEAD, block n at T0 + n, with the payment's Transfer in block SETTLED. onLogs runs as the logs are read. */
function stubRpc(onLogs) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const { method, params } = JSON.parse(raw);
      let result = null;
      if (method === 'eth_blockNumber') result = `0x${HEAD.toString(16)}`;
      else if (method === 'eth_getBlockByNumber') {
        const n = Number(BigInt(params[0]));
        result = n >= 1 && n <= HEAD ? { timestamp: `0x${(T0 + n).toString(16)}` } : null;
      } else if (method === 'eth_getLogs') {
        onLogs();
        result = [{ transactionHash: TX, blockNumber: `0x${SETTLED.toString(16)}` }];
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function stateFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backfill-'));
  const file = path.join(dir, 'state.json');
  const event = { txHash: TX, ts: (T0 + SETTLED) * 1000, amount: '1000' };
  fs.writeFileSync(file, JSON.stringify({ paymentEvents: { '0xagent': [event] } }));
  return { dir, file };
}

function run(server, file) {
  const url = `http://127.0.0.1:${server.address().port}`;
  const child = spawn(process.execPath, [SCRIPT, '--state', file, '--rpc', url, '--asset', `0x${'cc'.repeat(20)}`, '--pace', '0', '--write']);
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, out })));
}

test('fills in the block of a payment that has none', async (t) => {
  const { dir, file } = stateFile();
  const server = await stubRpc(() => {});
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const { code, out } = await run(server, file);
  assert.equal(code, 0, out);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).paymentEvents['0xagent'][0].blockNumber, SETTLED);
});

test('refuses to replace a state file that changed while it ran, and says to stop the oracle', async (t) => {
  const { dir, file } = stateFile();
  // What the oracle persists in the meantime: a credit the backfill never read.
  const written = JSON.stringify({ paymentEvents: { '0xagent': [], '0xother': [{ txHash: TX, ts: 1, amount: '7' }] } });
  const server = await stubRpc(() => fs.writeFileSync(file, written));
  t.after(() => { server.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  const { code, out } = await run(server, file);
  assert.equal(fs.readFileSync(file, 'utf8'), written, 'the oracle\'s write was replaced');
  assert.notEqual(code, 0);
  assert.match(out, /stop the oracle/i);
});
