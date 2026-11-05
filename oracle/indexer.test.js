'use strict';

// indexer.js end to end: the real process against a fake RPC. Backfill in batches, a refused span
// that must not leave a hole, new blocks after it, a node behind the head that answers log reads
// with what it has, filters and gzip on /events, a restart that resumes from the saved index, and
// an RPC key that never reaches a log line or an answer.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');
const os = require('os');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn } = require('child_process');

const KEY = 'k3yk3yk3yk3yk3yk3yk3yk3y';
const A = '0x' + 'aa'.repeat(20);
const B = '0x' + 'bb'.repeat(20);
const T0 = '0x' + '01'.repeat(32);
const DID = '0x' + 'cd'.repeat(32);
const FROM = 1000;
const MARGIN = 20; // HEAD_MARGIN in indexer.js
const hex = (n) => '0x' + n.toString(16);

function fakeRpc() {
  const chain = {
    head: FROM + 34_999, // four spans
    logs: [],
    refuseOnce: new Set(), // fromBlock values whose first eth_getLogs is refused
    getLogsFrom: [],       // every fromBlock asked for, in order
    noTimestamp: true,     // leave blockTimestamp off the first log, for the indexer to ask
    lagTo: null,           // a node that has blocks only up to here, though it names a later head
  };
  const add = (block, address = A, topics = [T0, DID]) => chain.logs.push({
    address, topics, data: '0x', blockNumber: hex(block), logIndex: '0x0',
    transactionHash: '0x' + block.toString(16).padStart(64, '0'), blockTimestamp: hex(5000 + block), removed: false,
  });
  const answer = (r) => {
    const ok = (result) => ({ jsonrpc: '2.0', id: r.id, result });
    if (r.method === 'eth_chainId') return ok('0x4cef52');
    if (r.method === 'eth_getBlockByNumber') {
      const n = r.params[0] === 'finalized' ? chain.head : parseInt(r.params[0], 16);
      // The head is named by a node that has it; the lagging one answers the block reads.
      if (chain.lagTo !== null && r.params[0] !== 'finalized' && n > chain.lagTo) return ok(null);
      return ok({ number: hex(n), timestamp: hex(5000 + n) });
    }
    if (r.method === 'eth_getLogs') {
      const f = r.params[0], from = parseInt(f.fromBlock, 16);
      // As a node behind the head does: it answers for the blocks it has, and says nothing.
      const to = chain.lagTo === null ? parseInt(f.toBlock, 16) : Math.min(parseInt(f.toBlock, 16), chain.lagTo);
      chain.getLogsFrom.push(from);
      if (parseInt(f.toBlock, 16) - from + 1 > 10000) return { jsonrpc: '2.0', id: r.id, error: { code: -32600, message: 'range too large' } };
      if (chain.refuseOnce.delete(from)) return { jsonrpc: '2.0', id: r.id, error: { code: 429, message: `rate limited at https://rpc.invalid/v2/${KEY}` } };
      const want = new Set(f.address.map((a) => a.toLowerCase()));
      return ok(chain.logs.filter((l) => {
        const b = parseInt(l.blockNumber, 16);
        return b >= from && b <= to && want.has(l.address);
      }).map((l, i) => {
        if (chain.noTimestamp && i === 0) { chain.noTimestamp = false; const { blockTimestamp, ...rest } = l; return rest; }
        return l;
      }));
    }
    return { jsonrpc: '2.0', id: r.id, error: { code: -32601, message: 'no such method' } };
  };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (!req.url.endsWith(`/v2/${KEY}`)) { res.writeHead(401); return res.end(); }
      const j = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(j) ? j.map(answer) : answer(j)));
    });
  });
  return { chain, add, server };
}

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// Its own word that it is serving. Until it has bound the port, the port may be another test
// file's server, and a request sent there fails whichever test that file is running.
const serving = (child) => until(() => /serving on /.test(child.output));

function startIndexer(env) {
  const child = spawn(process.execPath, [path.join(__dirname, 'indexer.js')], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.output = '';
  child.stdout.on('data', (d) => { child.output += d; });
  child.stderr.on('data', (d) => { child.output += d; });
  child.exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  return child;
}

function get(port, p, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        if (res.headers['content-encoding'] === 'gzip') buf = zlib.gunzipSync(buf);
        resolve({ status: res.statusCode, headers: res.headers, body: buf.length ? JSON.parse(buf) : null });
      });
    }).on('error', reject);
  });
}

async function until(check, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    try { const v = await check(); if (v) return v; } catch { /* not up yet */ }
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('indexer: backfills without holes, follows new blocks, filters, resumes, and keeps its key out', async () => {
  const rpc = fakeRpc();
  rpc.add(FROM);                                   // first block of the index
  rpc.add(FROM + 9_999, B);                        // last block of the first span
  rpc.add(FROM + 10_000);                          // first block of the second span, which is refused once
  rpc.add(FROM + 25_000, A, [T0, '0x' + 'ee'.repeat(32)]);
  rpc.add(FROM - 1);                               // before the index starts: never read
  rpc.chain.refuseOnce.add(FROM + 10_000);
  await new Promise((r) => rpc.server.listen(0, '127.0.0.1', r));
  const rpcPort = rpc.server.address().port;
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigvara-index-'));
  const env = {
    RPC_URL: `http://127.0.0.1:${rpcPort}/v2/${KEY}`,
    EXPECTED_CHAIN_ID: '5042002',
    INDEX_ADDRESSES: `${A},${B}`,
    INDEX_FROM_BLOCK: String(FROM),
    PORT: String(port),
    POLL_SECONDS: '1',
    INDEX_BATCH: '3',
    STATE_FILE: path.join(dir, 'index.json'),
  };
  let child = startIndexer(env);
  try {
    await serving(child);
    // Caught up to the margin behind the head, through the refused span.
    const h = await until(async () => { const r = await get(port, '/health'); return r.body.toBlock === rpc.chain.head - MARGIN && r; });
    assert.equal(h.status, 200);
    assert.equal(h.body.ok, true);
    assert.equal(h.body.fromBlock, FROM);
    assert.equal(h.body.behind, MARGIN);
    assert.equal(h.body.toBlockTime, 5000 + rpc.chain.head - MARGIN);

    const all = await get(port, '/events');
    assert.equal(all.status, 200);
    assert.equal(all.headers['access-control-allow-origin'], '*');
    assert.deepEqual(all.body.logs.map((l) => parseInt(l.blockNumber, 16)), [FROM, FROM + 9_999, FROM + 10_000, FROM + 25_000]);
    assert.ok(all.body.logs.every((l) => /^0x[0-9a-f]+$/.test(l.blockTimestamp)), 'every log has its block time, asked for where the RPC left it out');
    // The refused span was read again, and nothing was read before the index starts.
    assert.equal(rpc.chain.getLogsFrom.filter((f) => f === FROM + 10_000).length, 2);
    assert.ok(rpc.chain.getLogsFrom.every((f) => f >= FROM));

    // Filters, and gzip for a client that asks.
    const filtered = await get(port, `/events?address=${B}`, { 'Accept-Encoding': 'gzip' });
    assert.deepEqual(filtered.body.logs.map((l) => l.address), [B]);
    assert.equal((await get(port, `/events?topic1=${DID}&fromBlock=${FROM + 1}`)).body.logs.length, 2);
    assert.equal((await get(port, '/events?topic0=0x12')).status, 400);
    assert.equal((await get(port, '/nothing')).status, 404);

    // A page at a time: `next` asks for the rest, and the pages join up to the whole answer.
    const paged = [];
    for (let after = null, page = 0; page < 10; page++) {
      const body = (await get(port, `/events?limit=1${after ? `&after=${after}` : ''}`)).body;
      paged.push(...body.logs);
      if (body.next === null) break;
      after = body.next;
    }
    assert.deepEqual(paged, all.body.logs);
    assert.equal(all.body.next, null);
    assert.equal((await get(port, '/events?limit=0')).status, 400);
    assert.equal((await get(port, '/events?after=nonsense')).status, 400);

    // New blocks after the head are picked up on the next poll.
    rpc.add(rpc.chain.head + 500);
    rpc.chain.head += 1000;
    await until(async () => (await get(port, '/events')).body.toBlock === rpc.chain.head - MARGIN);
    assert.equal((await get(port, '/events')).body.logs.length, 5);

    // A node that names a head it does not have answers the log reads with what it has. The index
    // must not take that as the whole span: it waits, then reads the span again.
    const stuckAt = rpc.chain.head - MARGIN;
    rpc.chain.lagTo = rpc.chain.head;
    rpc.add(rpc.chain.head + 300);
    rpc.chain.head += 1000;
    const refused = await until(async () => { const r = (await get(port, '/health')).body; return /does not have block/.test(r.lastError || '') && r; });
    assert.equal(refused.toBlock, stuckAt, 'nothing past what the lagging node has is marked as read');
    rpc.chain.lagTo = null;
    await until(async () => (await get(port, '/events')).body.toBlock === rpc.chain.head - MARGIN);
    assert.equal((await get(port, '/events')).body.logs.length, 6, 'the log the lagging node left out is in the index');

    // The key reached neither the log nor any answer, although an RPC error quoted it.
    assert.match(child.output, /poll failed/);
    assert.equal(child.output.includes(KEY), false, child.output);
    assert.equal(JSON.stringify((await get(port, '/health')).body).includes(KEY), false);

    // A restart resumes from the saved index instead of reading from the start again.
    child.kill();
    await child.exited;
    const asked = rpc.chain.getLogsFrom.length;
    child = startIndexer(env);
    await serving(child);
    await until(async () => (await get(port, '/health')).body.ok);
    assert.match(child.output, /resuming at block/);
    assert.ok(rpc.chain.getLogsFrom.slice(asked).every((f) => f > rpc.chain.head - MARGIN - 1000), 'nothing already indexed is read again');
    assert.equal((await get(port, '/events')).body.logs.length, 6);
  } finally {
    child.kill();
    await child.exited;
    rpc.server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('indexer: refuses an RPC on another chain, and a bad URL without printing it', async () => {
  const rpc = fakeRpc();
  await new Promise((r) => rpc.server.listen(0, '127.0.0.1', r));
  const base = {
    EXPECTED_CHAIN_ID: '1', INDEX_ADDRESSES: A, INDEX_FROM_BLOCK: '0', PORT: String(await freePort()),
  };
  const wrongChain = startIndexer({ ...base, RPC_URL: `http://127.0.0.1:${rpc.server.address().port}/v2/${KEY}` });
  assert.equal(await wrongChain.exited, 1);
  assert.match(wrongChain.output, /serves chain 5042002, not EXPECTED_CHAIN_ID 1/);

  const plainHttp = startIndexer({ ...base, RPC_URL: `http://rpc.example/v2/${KEY}` });
  assert.equal(await plainHttp.exited, 1);
  assert.match(plainHttp.output, /must be https/);
  assert.equal(plainHttp.output.includes(KEY), false);
  rpc.server.close();
});

// The VPS compose file copies the indexer out of a checkout and starts it. It started node in the
// checkout's directory, where the copied files are not, and the container restarted in a loop on
// MODULE_NOT_FOUND: the tests above run indexer.js directly and never saw it.
test('docker-compose.indexer.vps.yml copies every file the indexer loads, and starts it where they are', () => {
  const yml = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.indexer.vps.yml'), 'utf8');
  const cp = yml.match(/cp ((?:\/src\/oracle\/[\w.-]+\.js )+)\/app\//);
  assert.ok(cp, 'the compose file copies the indexer into /app');
  const copied = new Set(cp[1].trim().split(/\s+/).map((p) => path.basename(p)));
  const loads = new Set(), queue = ['indexer.js'];
  while (queue.length) {
    const f = queue.pop();
    if (loads.has(f)) continue;
    loads.add(f);
    for (const m of fs.readFileSync(path.join(__dirname, f), 'utf8').matchAll(/require\('\.\/([\w.-]+)'\)/g)) {
      queue.push(m[1].endsWith('.js') ? m[1] : `${m[1]}.js`);
    }
  }
  for (const f of loads) assert.ok(copied.has(f), `indexer.js loads ${f}, which the compose file does not copy`);
  const after = yml.slice(yml.indexOf(cp[0]) + cp[0].length);
  assert.match(after, /^\s*cd \/app\n[\s\S]*?exec node indexer\.js/, 'node starts in /app, where the files were copied');
});
