'use strict';

// scripts/fat-path.mjs against a fake chain: a run that stops part way still leaves a record of what it paid.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { ethers } = require('ethers');
const { startFakeRpc } = require('./test-support/fake-rpc');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'fat-path.mjs');
const AGENT = '0x00000000000000000000000000000000000000a1';

const ids = new ethers.Interface([
  'function computeDidHash(address) view returns (bytes32)',
  'function identities(bytes32) view returns (address, address, bytes32, uint8, uint256)',
  'function balanceOf(address) view returns (uint256)',
]);

/** The fake RPC, with the reads this script makes answered: an Active agent, and a funder who holds plenty. */
async function chain(t) {
  const rpc = await startFakeRpc();
  const reads = (req) => {
    if (req.method === 'eth_getBalance') return ethers.toBeHex(10n ** 24n);
    if (req.method !== 'eth_call') return undefined;
    const call = ids.parseTransaction({ data: req.params[0].data });
    if (call.name === 'computeDidHash') return ids.encodeFunctionResult(call.name, [ethers.id('agent')]);
    if (call.name === 'identities') return ids.encodeFunctionResult(call.name, [AGENT, AGENT, ethers.ZeroHash, 0, 1]);
    return ids.encodeFunctionResult(call.name, [10n ** 24n]);
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
      const parsed = JSON.parse(body);
      const one = async (r) => {
        const local = reads(r);
        if (local !== undefined) return { jsonrpc: '2.0', id: r.id, result: local };
        const fwd = await fetch(rpc.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(r) });
        return fwd.json();
      };
      const out = Array.isArray(parsed) ? await Promise.all(parsed.map(one)) : await one(parsed);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); server.close(); await rpc.stop(); });
  return { url: `http://127.0.0.1:${server.address().port}`, rpc };
}

test('a run that fails at the first attestation leaves a record of the payment it made', async (t) => {
  const { url, rpc } = await chain(t);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fat-path-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const child = spawn(process.execPath, [SCRIPT, '--agent', AGENT, '--payers', '2', '--amount', '1'], {
    cwd: dir,
    env: {
      ...process.env,
      RPC_URL: url,
      ORACLE_URL: 'http://127.0.0.1:9', // nothing listens: the attestation fails after the payment is sent
      DEPLOYER_PRIVATE_KEY: ethers.id('a throwaway test key'),
    },
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const code = await new Promise((resolve) => child.on('close', resolve));

  assert.notEqual(code, 0, out);
  const paid = rpc.sent.filter((s) => s.tx.data.startsWith(ethers.id('transfer(address,uint256)').slice(0, 10))
    && s.tx.data.includes(AGENT.slice(2)));
  assert.equal(paid.length, 1, out);
  const records = fs.readdirSync(dir).filter((f) => /^fat-path-\d+\.json$/.test(f));
  assert.equal(records.length, 1, `no run record after a failed run:\n${out}`);
  const record = JSON.parse(fs.readFileSync(path.join(dir, records[0]), 'utf8'));
  assert.deepEqual(record.payments.map((p) => p.txHash), [paid[0].hash]);
});
