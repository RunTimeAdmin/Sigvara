'use strict';

/**
 * The event index's pure parts: which block spans to read, which logs to accept, and what to
 * answer. indexer.js does the reading and the serving; everything here is testable without a
 * chain or a socket.
 *
 * The index holds every log the Sigvara contracts have emitted, from the block they were
 * deployed in, as eth_getLogs returned it. It is a cache of public chain data, not a source of
 * truth: each log carries its transaction hash, and a reader can check any of them against the
 * chain. It exists because the Arc explorer's log index stopped on 2 November 2026 and allows
 * ten requests an hour, and the public RPC answers 10,000 blocks a call.
 */

// The most blocks one eth_getLogs may span, inclusive, on Arc's public RPC and on Alchemy's.
const LOG_SPAN = 10000;

// One /events answer holds at most PAGE_ROWS logs and PAGE_BYTES of them as JSON. A longer one
// ends with `next`, the cursor to ask for the rest with (`after`). The whole testnet history is a
// few hundred kilobytes, so today it comes in one answer; the caps keep a long history from
// becoming one unbounded answer, and the indexer from holding many of them.
const PAGE_ROWS = 5000;
const PAGE_BYTES = 4 * 1024 * 1024;
// A cursor names the last log an answer held: its block and log index, in decimal.
const CURSOR = /^(\d{1,12})-(\d{1,9})$/;

const HEX = /^0x[0-9a-fA-F]*$/;
const QUANTITY = /^0x[0-9a-fA-F]{1,16}$/;
const WORD = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

// The spans that cover blocks [from, to], oldest first, each at most `span` blocks.
function planSpans(from, to, span = LOG_SPAN) {
  const out = [];
  for (let a = from; a <= to; a += span) out.push([a, Math.min(to, a + span - 1)]);
  return out;
}

/**
 * One log as eth_getLogs returned it, checked and normalised (hex lowercased), or an Error.
 * A log outside the span asked for, from a contract not asked for, or with a field the RPC
 * could not have meant, means the answer is not what was asked, so the whole read is refused
 * rather than storing a part of it.
 */
function normalizeLog(raw, { addresses, from, to }) {
  if (!raw || typeof raw !== 'object') return new Error('a log that is not an object');
  if (raw.removed === true) return new Error('a removed log');
  const address = String(raw.address || '').toLowerCase();
  if (!ADDRESS.test(address) || !addresses.has(address)) return new Error(`a log from ${address || 'no address'}, which was not asked for`);
  if (!QUANTITY.test(raw.blockNumber || '') || !QUANTITY.test(raw.logIndex || '')) return new Error('a log without a block number or index');
  const block = parseInt(raw.blockNumber, 16);
  if (block < from || block > to) return new Error(`a log from block ${block}, outside ${from} to ${to}`);
  if (!Array.isArray(raw.topics) || raw.topics.length > 4 || !raw.topics.every((t) => WORD.test(t))) return new Error('a log with malformed topics');
  if (typeof raw.data !== 'string' || !HEX.test(raw.data) || raw.data.length % 2) return new Error('a log with malformed data');
  if (!WORD.test(raw.transactionHash || '')) return new Error('a log without a transaction hash');
  // null is read as absent: the indexer then asks for the block's time.
  const ts = raw.blockTimestamp ?? undefined;
  if (ts !== undefined && !QUANTITY.test(ts)) return new Error('a log with a malformed block time');
  return {
    address,
    topics: raw.topics.map((t) => t.toLowerCase()),
    data: raw.data.toLowerCase(),
    blockNumber: '0x' + block.toString(16),
    logIndex: '0x' + parseInt(raw.logIndex, 16).toString(16),
    transactionHash: raw.transactionHash.toLowerCase(),
    ...(ts !== undefined ? { blockTimestamp: '0x' + parseInt(ts, 16).toString(16) } : {}),
  };
}

const orderOf = (l) => [parseInt(l.blockNumber, 16), parseInt(l.logIndex, 16)];
const byChainOrder = (a, b) => {
  const [ab, ai] = orderOf(a), [bb, bi] = orderOf(b);
  return ab - bb || ai - bi;
};

// A fresh index: nothing read yet, so it holds every block before `fromBlock` and none after.
function createIndex({ chainId, fromBlock, addresses }) {
  return {
    chainId,
    fromBlock,
    addresses: [...addresses].map((a) => a.toLowerCase()).sort(),
    toBlock: fromBlock - 1,
    toBlockTime: null,
    logs: [],
  };
}

/**
 * Adds the logs of blocks (index.toBlock, through], which must follow on from what the index
 * holds, so it never has a hole. Logs already held are kept once. `throughTime` is the time of
 * block `through`, or null when it is not known yet. Returns the index.
 */
function appendLogs(index, logs, through, throughTime = null) {
  if (!Number.isSafeInteger(through) || through < index.toBlock) throw new Error(`cannot move the index back from ${index.toBlock} to ${through}`);
  const seen = new Set(index.logs.map((l) => `${l.transactionHash}:${l.logIndex}`));
  for (const l of logs) {
    const block = parseInt(l.blockNumber, 16);
    if (block <= index.toBlock || block > through) throw new Error(`a log from block ${block}, outside ${index.toBlock + 1} to ${through}`);
    const key = `${l.transactionHash}:${l.logIndex}`;
    if (!seen.has(key)) { seen.add(key); index.logs.push(l); }
  }
  index.logs.sort(byChainOrder);
  index.toBlock = through;
  index.toBlockTime = throughTime;
  return index;
}

// Whether a saved index can be carried on from, given the index this run is configured for.
function resumable(saved, { chainId, fromBlock, addresses }) {
  if (!saved || typeof saved !== 'object' || !Array.isArray(saved.logs) || !Number.isSafeInteger(saved.toBlock)) return false;
  const want = [...addresses].map((a) => a.toLowerCase()).sort();
  return saved.chainId === chainId && saved.fromBlock === fromBlock
    && Array.isArray(saved.addresses) && saved.addresses.join(',') === want.join(',');
}

/**
 * The filter a /events request asks for, or an Error to answer 400 with. Every parameter is
 * optional: `address` (one or more of the indexed contracts), `topic0` (up to 20 event
 * topics), `topic1` (one 32-byte value), `fromBlock` (a block number), `limit` (at most this
 * many logs, up to PAGE_ROWS) and `after` (the `next` cursor of an earlier answer).
 */
function parseQuery(params, indexed) {
  const list = (name) => (params.get(name) || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const address = list('address');
  if (address.some((a) => !indexed.has(a))) return new Error('address must be one of the indexed contracts');
  const topic0 = list('topic0');
  if (topic0.length > 20 || topic0.some((t) => !WORD.test(t))) return new Error('topic0 must be up to 20 32-byte hex values');
  const topic1 = list('topic1');
  if (topic1.length > 1 || topic1.some((t) => !WORD.test(t))) return new Error('topic1 must be one 32-byte hex value');
  const fromRaw = params.get('fromBlock');
  const fromBlock = fromRaw === null ? null : Number(fromRaw);
  if (fromRaw !== null && (!/^\d{1,12}$/.test(fromRaw) || !Number.isSafeInteger(fromBlock))) return new Error('fromBlock must be a block number');
  const limitRaw = params.get('limit');
  const limit = limitRaw === null ? PAGE_ROWS : Number(limitRaw);
  if (limitRaw !== null && (!/^\d{1,5}$/.test(limitRaw) || limit < 1 || limit > PAGE_ROWS)) return new Error(`limit must be from 1 to ${PAGE_ROWS}`);
  const afterRaw = params.get('after');
  const cursor = afterRaw === null ? null : CURSOR.exec(afterRaw);
  if (afterRaw !== null && !cursor) return new Error('after must be the next cursor of an earlier answer');
  return {
    address: address.length ? new Set(address) : null,
    topic0: topic0.length ? new Set(topic0) : null,
    topic1: topic1[0] || null,
    fromBlock,
    limit,
    after: cursor ? [Number(cursor[1]), Number(cursor[2])] : null,
  };
}

// Where a log sits in the chain, as a cursor.
const cursorOf = (l) => orderOf(l).join('-');

function selectLogs(index, q) {
  const after = q.after ?? null;
  return index.logs.filter((l) => (!q.address || q.address.has(l.address))
    && (!q.topic0 || q.topic0.has(l.topics[0]))
    && (!q.topic1 || l.topics[1] === q.topic1)
    && (q.fromBlock === null || q.fromBlock === undefined || parseInt(l.blockNumber, 16) >= q.fromBlock)
    && (!after || (([b, i]) => b > after[0] || (b === after[0] && i > after[1]))(orderOf(l))));
}

/**
 * The /events answer: the logs that match, from `after` on, and the blocks they were read over.
 * It holds at most `q.limit` logs and `maxBytes` of them as JSON, though always one when one
 * matches, and `next` is the cursor of its last log when more match, or null. A reader asks again
 * with `after` set to `next` until it is null, then takes the blocks after the last answer's
 * toBlock from the chain itself.
 */
function eventsBody(index, q, maxBytes = PAGE_BYTES) {
  const limit = q.limit ?? PAGE_ROWS;
  const logs = [];
  let bytes = 0;
  let next = null;
  for (const l of selectLogs(index, q)) {
    const size = JSON.stringify(l).length + 1;
    if (logs.length === limit || (logs.length > 0 && bytes + size > maxBytes)) {
      next = cursorOf(logs[logs.length - 1]);
      break;
    }
    logs.push(l);
    bytes += size;
  }
  return {
    chainId: index.chainId,
    fromBlock: index.fromBlock,
    toBlock: index.toBlock,
    toBlockTime: index.toBlockTime,
    logs,
    next,
  };
}

// An error message with the RPC URL and its key taken out: an Alchemy URL carries its key in
// the path. Any other URL goes too, since a message that quotes one may quote it whole.
function redact(message, secrets = []) {
  let out = String(message);
  for (const s of secrets) if (s) out = out.split(s).join('<secret>');
  return out.replace(/https?:\/\/\S+/g, '<url>');
}

module.exports = {
  LOG_SPAN, PAGE_ROWS, PAGE_BYTES, planSpans, normalizeLog, createIndex, appendLogs, resumable, parseQuery, selectLogs, eventsBody, redact,
};
