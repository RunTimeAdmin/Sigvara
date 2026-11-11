'use strict';

/**
 * Event index.
 *
 * Reads every log the Sigvara contracts emit, from the block they were deployed in, and serves
 * them over HTTP so a page can have a contract's whole history, in pages, without the RPC.
 * docs/event-index.md says why it exists and how it is run.
 *
 * It holds no key that can sign and writes nothing to the chain. Its one secret is the RPC URL,
 * which for a provider such as Alchemy carries an API key; that is read from a file when
 * RPC_URL_FILE is set and is never logged or served. A request to it never reaches the RPC: it
 * answers from memory, so a busy page cannot spend the provider's credits.
 *
 * It reads only blocks the RPC calls finalized, less a margin, in order, and moves forward only
 * when a whole batch has been read and the node that answered it has the batch's last block, so
 * the index never has a hole. Arc finalizes each block as it is made.
 *
 *   RPC_URL_FILE=/run/secrets/rpc_url EXPECTED_CHAIN_ID=5042002 \
 *   INDEX_ADDRESSES=0x...,0x... INDEX_FROM_BLOCK=62662196 node indexer.js
 */

const fs = require('fs');
const http = require('http');
const zlib = require('zlib');
const ix = require('./event-index');
const { runningCommit, clientKey, parseTrustedProxies, rateLimited } = require('./http-helpers');
const { spanTooBig, readAnswer, readSplitting } = require('./log-spans');

const fail = (message) => { console.error(`[indexer] ${message}`); process.exit(1); };
const intSetting = (name, fallback, min, max = Number.MAX_SAFE_INTEGER) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    if (fallback === undefined) fail(`need ${name}`);
    return fallback;
  }
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) fail(`${name} is ${raw}; must be a whole number from ${min} to ${max}`);
  return n;
};

// The RPC URL, from the file RPC_URL_FILE names or from RPC_URL. Never echoed: for Alchemy the
// key is part of it. Plain http is allowed only to this machine, for tests and a local node.
function readRpcUrl(env = process.env) {
  if (env.RPC_URL_FILE && env.RPC_URL) fail('set RPC_URL_FILE or RPC_URL, not both');
  let raw = env.RPC_URL || '';
  if (env.RPC_URL_FILE) {
    try { raw = fs.readFileSync(env.RPC_URL_FILE, 'utf8'); } catch (e) { fail(`cannot read RPC_URL_FILE ${env.RPC_URL_FILE} (${e.code || 'error'})`); }
  }
  const url = raw.trim();
  if (!url) fail('need RPC_URL_FILE or RPC_URL');
  let parsed;
  try { parsed = new URL(url); } catch { fail('the RPC URL is not a URL (the value is not shown)'); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) fail('the RPC URL must be https (the value is not shown)');
  return url;
}

const rpcUrl = readRpcUrl();
// The URL, and its last path segment when that looks like a key, are cut out of every message.
const lastSegment = new URL(rpcUrl).pathname.split('/').filter(Boolean).pop() || '';
const secrets = [rpcUrl, lastSegment.length >= 16 ? lastSegment : ''];
const redact = (m) => ix.redact(m, secrets);

const addressList = (process.env.INDEX_ADDRESSES || '').split(',').map((a) => a.trim().toLowerCase()).filter(Boolean);
if (!addressList.length || addressList.length > 10 || addressList.some((a) => !/^0x[0-9a-f]{40}$/.test(a))) {
  fail('INDEX_ADDRESSES must be one to ten contract addresses, comma separated');
}

const cfg = {
  chainId: intSetting('EXPECTED_CHAIN_ID', undefined, 1),
  fromBlock: intSetting('INDEX_FROM_BLOCK', undefined, 0),
  addresses: new Set(addressList),
  port: intSetting('PORT', 3040, 1, 65535),
  host: process.env.INDEX_HOST || '127.0.0.1',
  pollSeconds: intSetting('POLL_SECONDS', 30, 1),
  // Spans per JSON-RPC batch. Alchemy takes 25 at once; Arc's public RPC refuses four, so a
  // deployment on it sets 1.
  batch: intSetting('INDEX_BATCH', 10, 1),
  stateFile: process.env.STATE_FILE || '',
  // The logs it will hold. Past this it stops reading on and keeps answering with what it has, and
  // /health fails. Set with the container's memory: docs/event-index.md says how they go together.
  maxLogs: intSetting('INDEX_MAX_LOGS', 100_000, 1),
};
let isTrustedProxy;
try { isTrustedProxy = parseTrustedProxies(process.env.TRUSTED_PROXIES); } catch { fail('TRUSTED_PROXIES must be comma-separated addresses or CIDR ranges (the value is not shown)'); }
// One poll reads at most this many spans (a million blocks) before it saves and starts the next,
// so a first run's backfill is saved as it goes.
const SPANS_PER_POLL = 100;
// /health fails once the index is this far behind the chain: about half an hour of Arc blocks.
const MAX_BEHIND = 3600;
// How far behind the finalized head the index stays: about ten seconds of Arc blocks. A provider
// spreads requests over several nodes, and a node that is a block behind the one that named the
// head can answer a log read for the newest blocks with what it has. The pages read the blocks
// after the index from the chain, so the margin costs them one small read.
const HEAD_MARGIN = 20;
// An answer past this is refused the way a node refuses a span for its size, so the read is asked
// for in smaller pieces (log-spans.js). A node's own limit can be 20,000 logs a span and a batch is
// ten spans, which is more than the process can hold. A single block holds far less than this.
const MAX_ANSWER_BYTES = 8 * 1024 * 1024;

// ---- state ----
function load() {
  const fresh = ix.createIndex(cfg);
  if (!cfg.stateFile || !fs.existsSync(cfg.stateFile)) return fresh;
  try {
    const saved = JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8'));
    if (ix.resumable(saved, cfg)) {
      console.log(`[indexer] resuming at block ${saved.toBlock} with ${saved.logs.length} logs`);
      return saved;
    }
    console.log('[indexer] the saved index is for another chain, start block or contract set; starting over');
  } catch (e) {
    console.log(`[indexer] the saved index cannot be read (${e.message}); starting over`);
  }
  return fresh;
}

// Temp file, fsync, rename: a crash leaves the old index or the new one, never half of one.
function save() {
  if (!cfg.stateFile) return;
  const tmp = `${cfg.stateFile}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    for (const chunk of ix.savedChunks(index)) fs.writeFileSync(fd, chunk);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, cfg.stateFile);
  savedThrough = index.toBlock;
}

let index = load();
let savedThrough = index.toBlock;
const status = { head: null, lastPollAt: null, lastOkAt: null, lastError: null, full: false };
let caughtUp = false;

// ---- the RPC ----
// Between the smaller reads of a refused span, so a run of them keeps under a public RPC's rate limit.
const SPLIT_PACE_MS = 400;

async function rpc(body) {
  // redirect: 'error'. A provider that redirects is not answering the request that was made.
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`the RPC answered HTTP ${res.status}`);
  return JSON.parse((await readAnswer(res.body, MAX_ANSWER_BYTES)).toString('utf8'));
}

async function call(method, params) {
  const j = await rpc({ jsonrpc: '2.0', id: 1, method, params });
  if (j && j.error) throw new Error(`${method}: ${j.error.message}`);
  if (!j || j.result === undefined || j.result === null) throw new Error(`${method}: no result`);
  return j.result;
}

// Every log of the indexed contracts in `spans`, in one batch, and the time of the batch's last
// block. The batch asks for that block too: a node that does not have it yet may still answer the
// log reads, with what it has, and the missing block is how that shows. Any refused, malformed or
// missing answer fails the whole batch, so nothing from it is kept.
async function readSpans(spans) {
  const hex = (n) => '0x' + n.toString(16);
  const last = spans[spans.length - 1][1];
  const answer = await rpc([
    ...spans.map(([a, b], id) => ({
      jsonrpc: '2.0', id, method: 'eth_getLogs', params: [{ address: [...cfg.addresses], fromBlock: hex(a), toBlock: hex(b) }],
    })),
    { jsonrpc: '2.0', id: spans.length, method: 'eth_getBlockByNumber', params: [hex(last), false] },
  ]);
  if (!Array.isArray(answer)) throw new Error(`eth_getLogs: ${answer && answer.error ? answer.error.message : 'not a batch answer'}`);
  const byId = new Map(answer.map((r) => [r && r.id, r]));
  const end = byId.get(spans.length);
  const block = end && !end.error ? end.result : null;
  if (!block || parseInt(block.number, 16) !== last) throw new Error(`the RPC does not have block ${last} yet`);
  const time = parseInt(block.timestamp, 16);
  const logs = [];
  spans.forEach(([a, b], id) => {
    const r = byId.get(id);
    if (!r || r.error || !Array.isArray(r.result)) throw new Error(`eth_getLogs ${a} to ${b}: ${r && r.error ? r.error.message : 'no result'}`);
    for (const raw of r.result) {
      const l = ix.normalizeLog(raw, { addresses: cfg.addresses, from: a, to: b });
      if (l instanceof Error) throw new Error(`eth_getLogs ${a} to ${b}: ${l.message}`);
      logs.push(l);
    }
  });
  return { logs, time: Number.isSafeInteger(time) && time > 0 ? time : null };
}

// An RPC that leaves blockTimestamp out of its logs gets each block's time asked for.
async function addTimes(logs) {
  const blocks = [...new Set(logs.filter((l) => !l.blockTimestamp).map((l) => l.blockNumber))];
  for (let i = 0; i < blocks.length; i += 10) {
    const part = blocks.slice(i, i + 10);
    const answer = await rpc(part.map((b, id) => ({ jsonrpc: '2.0', id, method: 'eth_getBlockByNumber', params: [b, false] })));
    const at = new Map((Array.isArray(answer) ? answer : []).map((r) => [part[r.id], r.result && r.result.timestamp]));
    for (const l of logs) {
      if (l.blockTimestamp) continue;
      const t = at.get(l.blockNumber);
      if (typeof t !== 'string' || !/^0x[0-9a-f]{1,16}$/i.test(t)) throw new Error(`no time for block ${parseInt(l.blockNumber, 16)}`);
      l.blockTimestamp = '0x' + parseInt(t, 16).toString(16);
    }
  }
}

// What a read brought, added to the index, unless the index has no room for all of it. Then nothing
// from it is added, so the index stays whole up to the block it holds.
async function take({ logs, time }, through) {
  if (index.logs.length + logs.length > cfg.maxLogs) {
    status.full = true;
    throw Object.assign(
      new Error(`the index is full: it holds ${index.logs.length} logs, the next read has ${logs.length}, and INDEX_MAX_LOGS is ${cfg.maxLogs}`),
      { indexFull: true },
    );
  }
  await addTimes(logs);
  ix.appendLogs(index, logs, through, time);
  status.full = false;
}

// readSpans, added to the index, with what is refused for its size asked for in smaller pieces: a
// batch a span at a time, and a span in halves (log-spans.js). Anyone can fill a span, by logging
// from an indexed contract in a loop, so each piece is added as it comes rather than all of them
// being held until the last. A single block still refused fails the batch, as anything else does.
async function readBatch(spans) {
  let whole;
  try {
    whole = await readSpans(spans);
  } catch (err) {
    if (!spanTooBig(err)) throw err;
    const pause = () => new Promise((r) => setTimeout(r, SPLIT_PACE_MS));
    const tooBig = (e) => !e.indexFull && spanTooBig(e);
    for (const [from, to] of spans) {
      await pause();
      await readSplitting(async (x, y) => take(await readSpans([[x, y]]), y), from, to, { tooBig, pause, join: () => undefined });
    }
    return;
  }
  await take(whole, spans[spans.length - 1][1]);
}

let timer = null;
async function poll() {
  timer = null;
  let more = false;
  try {
    const fin = await call('eth_getBlockByNumber', ['finalized', false]);
    const head = parseInt(fin.number, 16);
    if (!Number.isSafeInteger(head)) throw new Error('the finalized block has no number');
    status.head = head;
    const target = head - HEAD_MARGIN;
    const end = Math.min(target, index.toBlock + SPANS_PER_POLL * ix.LOG_SPAN);
    more = end < target;
    const work = ix.planSpans(index.toBlock + 1, end);
    try {
      for (let i = 0; i < work.length; i += cfg.batch) await readBatch(work.slice(i, i + cfg.batch));
    } finally {
      // What was read before a failure stays, since it has no hole. A full index would not move
      // again, so this is its one chance to save it.
      if (index.toBlock !== savedThrough) save();
    }
    if (!more && !caughtUp) {
      caughtUp = true;
      console.log(`[indexer] caught up: ${index.logs.length} logs through block ${index.toBlock}`);
    }
    status.lastOkAt = Date.now();
    status.lastError = null;
  } catch (e) {
    status.lastError = redact(e && e.message ? e.message : e);
    console.error(`[indexer] poll failed at block ${index.toBlock}: ${status.lastError}`);
  } finally {
    status.lastPollAt = Date.now();
    // While behind, the next million blocks follow at once; after that, one poll a period.
    timer = setTimeout(poll, more && !status.lastError ? 1000 : cfg.pollSeconds * 1000);
  }
}

// ---- http ----
const iso = (ms) => (ms ? new Date(ms).toISOString() : null);
function health() {
  const behind = status.head === null ? null : Math.max(0, status.head - index.toBlock);
  const fresh = status.lastOkAt !== null && Date.now() - status.lastOkAt < cfg.pollSeconds * 5000 + 60_000;
  return {
    ok: fresh && behind !== null && behind <= MAX_BEHIND && !status.full,
    chainId: index.chainId,
    fromBlock: index.fromBlock,
    toBlock: index.toBlock,
    toBlockTime: index.toBlockTime,
    head: status.head,
    behind,
    logs: index.logs.length,
    maxLogs: cfg.maxLogs,
    full: status.full,
    lastPollAt: iso(status.lastPollAt),
    lastOkAt: iso(status.lastOkAt),
    lastError: status.lastError,
    commit: runningCommit(),
  };
}

// Public chain data, so any origin may read it: a reader checking this index against another
// one is the point.
const COMMON = {
  'Access-Control-Allow-Origin': '*',
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'cross-origin',
};

// A body as sent: the JSON, and its gzip when it is worth compressing.
function encode(body) {
  const json = Buffer.from(JSON.stringify(body));
  return { json, gzip: json.length > 1024 ? zlib.gzipSync(json) : null };
}

// Each recent /events answer, kept until the index moves, so a burst of requests costs one
// encoding per query rather than one per request, and slow readers share one buffer. At most
// ANSWERS answers and ANSWERS_BYTES of them, encoded, are kept: the oldest goes first.
const ANSWERS = 64;
const ANSWERS_BYTES = 32 * 1024 * 1024;
// Answers one client may have built in a minute. Only these cost much, in encoding on the event
// loop: a question an earlier one already asked comes from the cache, and is not counted. Behind a
// proxy the client is the address it names, so with TRUSTED_PROXIES unset all share this.
const BUILDS_PER_MINUTE = 120;
const answers = new Map();
let answersBytes = 0;
let answersAt = null;
const sizeOf = (a) => a.json.length + (a.gzip ? a.gzip.length : 0);
// The answer to `q`, or null when `client` has had its share of new ones.
function eventsAnswer(q, client) {
  if (answersAt !== index.toBlock) { answers.clear(); answersBytes = 0; answersAt = index.toBlock; }
  const key = JSON.stringify([q.address && [...q.address].sort(), q.topic0 && [...q.topic0].sort(), q.topic1, q.fromBlock, q.limit, q.after]);
  let a = answers.get(key);
  if (!a) {
    if (rateLimited(`events:${client}`, Date.now(), BUILDS_PER_MINUTE, 60_000)) return null;
    a = encode(ix.eventsBody(index, q));
    answers.set(key, a);
    answersBytes += sizeOf(a);
    while (answers.size > ANSWERS || (answers.size > 1 && answersBytes > ANSWERS_BYTES)) {
      const [oldest, held] = answers.entries().next().value;
      answers.delete(oldest);
      answersBytes -= sizeOf(held);
    }
  }
  return a;
}

function send(req, res, status, encoded, { cache = 'no-store', headers = {} } = {}) {
  const gzip = encoded.gzip !== null && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const out = gzip ? encoded.gzip : encoded.json;
  res.writeHead(status, {
    ...COMMON,
    ...headers,
    'Content-Type': 'application/json',
    'Cache-Control': cache,
    Vary: 'Accept-Encoding',
    ...(gzip ? { 'Content-Encoding': 'gzip' } : {}),
    'Content-Length': out.length,
  });
  res.end(req.method === 'HEAD' ? undefined : out);
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...COMMON, 'Access-Control-Allow-Methods': 'GET, HEAD', 'Access-Control-Max-Age': '86400' });
    return res.end();
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, encode({ error: 'GET only' }));
  let url;
  try { url = new URL(req.url, 'http://index.invalid'); } catch { return send(req, res, 400, encode({ error: 'bad request' })); }
  if (url.pathname === '/health') {
    const h = health();
    return send(req, res, h.ok ? 200 : 503, encode(h));
  }
  if (url.pathname === '/events') {
    const q = ix.parseQuery(url.searchParams, cfg.addresses);
    if (q instanceof Error) return send(req, res, 400, encode({ error: q.message }));
    if (index.toBlock < index.fromBlock) return send(req, res, 503, encode({ error: 'nothing indexed yet' }));
    const answer = eventsAnswer(q, clientKey(req, isTrustedProxy));
    if (!answer) return send(req, res, 429, encode({ error: 'too many new questions; try again in a minute' }), { headers: { 'Retry-After': '60' } });
    return send(req, res, 200, answer, { cache: 'public, max-age=10' });
  }
  return send(req, res, 404, encode({ error: 'not found' }));
});

async function start() {
  let chainId;
  try {
    chainId = parseInt(await call('eth_chainId', []), 16);
  } catch (e) {
    fail(`cannot reach the RPC: ${redact(e && e.message ? e.message : e)}`);
  }
  if (chainId !== cfg.chainId) fail(`the RPC serves chain ${chainId}, not EXPECTED_CHAIN_ID ${cfg.chainId}`);
  server.listen(cfg.port, cfg.host, () => {
    console.log(`[indexer] chain ${chainId}, ${cfg.addresses.size} contracts from block ${cfg.fromBlock}, serving on ${cfg.host}:${cfg.port}${runningCommit() ? `, running ${runningCommit()}` : ''}`);
  });
  poll();
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    if (timer) clearTimeout(timer);
    server.close();
    try { save(); } catch (e) { console.error(`[indexer] could not save on exit: ${e.message}`); }
    process.exit(0);
  });
}

start();
