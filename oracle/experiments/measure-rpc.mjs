/**
 * What an RPC endpoint can actually do for the oracle, measured, not assumed.
 *
 * The oracle depends on four things an endpoint can quietly get wrong, and an `eth_call`
 * at head (which every endpoint passes) tests none of them:
 *
 *   - eth_getLogs span: the largest toBlock - fromBlock it will answer (a span of N covers N+1 blocks). The payment scan and the
 *     role and registration scans ask for LOG_CHUNK_SIZE blocks at a time.
 *   - receipt horizon: how far back eth_getTransactionReceipt still resolves. Payment
 *     verification fetches the settlement transaction's receipt, so a settlement older
 *     than the horizon is refused even though the money moved. Providers prune the
 *     transaction index at very different depths while blocks and logs keep resolving.
 *   - throttling: whether a sustained run of log scans is refused, at what pace.
 *   - latency and block time.
 *
 * Read-only. It sends only eth_chainId, eth_blockNumber, eth_getBlockByNumber,
 * eth_getTransactionReceipt and eth_getLogs. A key in the URL is never printed.
 *
 *   node oracle/experiments/measure-rpc.mjs primary=https://rpc.mainnet.arc.io
 *   node oracle/experiments/measure-rpc.mjs --no-burst own=$OWN_NODE_URL    # a production node
 *
 * Options: --no-burst skips the throttle test, which is the only part that sends many
 * requests; PACE_MS (default 500) sets the burst pace; BURST (default 60) its length.
 * Arguments are name=url. ARC_USDC_LOGS_TOPIC style knobs are not needed: the log probe
 * asks for the ERC-20 Transfer topic on Arc's USDC token, which is busy on mainnet.
 */

const USDC = '0x3600000000000000000000000000000000000000';
// An address with no logs: a log query against it can fail only on the span, never on the result count.
const QUIET = '0x000000000000000000000000000000000000dEaD';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const noBurst = process.argv.includes('--no-burst');
const PACE_MS = Number(process.env.PACE_MS || 500);
const BURST = Number(process.env.BURST || 60);
const sleep = ms => new Promise(r => setTimeout(r, ms));

const targets = process.argv.slice(2).filter(a => !a.startsWith('--')).map(a => {
  const i = a.indexOf('=');
  return i < 0 ? { name: a, url: a } : { name: a.slice(0, i), url: a.slice(i + 1) };
});
if (!targets.length) {
  console.error('usage: node oracle/experiments/measure-rpc.mjs [--no-burst] name=url [name=url ...]');
  process.exit(1);
}

let id = 0;
let retries = 0;
const isThrottle = e => e && (e.code === 429 || /rate limit|too many requests|429/i.test(e.message || ''));
/** One JSON-RPC call. A throttled call is retried with backoff and counted, never mistaken for a limit. */
async function rpc(url, method, params = []) {
  let r;
  for (let attempt = 0; attempt < 7; attempt++) {
    r = await rpcOnce(url, method, params);
    if (!isThrottle(r.error)) return r;
    retries++;
    await sleep(2000 * 2 ** Math.min(attempt, 3));
  }
  return r;
}
async function rpcOnce(url, method, params = []) {
  const t0 = performance.now();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    return { error: { code: 'network', message: String(e.cause?.code || e.message) }, ms: performance.now() - t0 };
  }
  const ms = performance.now() - t0;
  if (!res.ok) return { error: { code: res.status, message: `HTTP ${res.status}` }, ms };
  let j;
  try { j = await res.json(); } catch { return { error: { code: 'parse', message: 'not JSON' }, ms }; }
  return j.error ? { error: j.error, ms } : { result: j.result, ms };
}

const hex = n => '0x' + n.toString(16);
const unhex = h => Number(BigInt(h));
const median = a => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

/**
 * Largest span (in blocks) eth_getLogs answers, by doubling and then bisecting. Run twice:
 * on an address with no logs, which isolates the span limit, and on a busy token, which
 * shows the result-count cap that a span limit can hide behind.
 */
async function logSpan(url, head, filter) {
  const ok = async span => {
    const from = head - span - 10; // stay clear of the tip
    const r = await rpc(url, 'eth_getLogs', [{ fromBlock: hex(from), toBlock: hex(from + span), ...filter }]);
    await sleep(300);
    if (isThrottle(r.error)) throw new Error('still throttled after retries; rerun later');
    return !r.error;
  };
  if (!(await ok(10))) return { max: 0, note: 'refused even 10 blocks' };
  let lo = 10, hi = 20;
  while (hi <= 200000 && (await ok(hi))) { lo = hi; hi *= 2; }
  if (hi > 200000) return { max: lo, note: 'no limit found up to 200,000' };
  while (hi - lo > Math.max(1, Math.floor(lo * 0.01))) {
    const mid = Math.floor((lo + hi) / 2);
    if (await ok(mid)) lo = mid; else hi = mid;
  }
  return { max: lo, note: '' };
}

/** A block at or after `height` that has a transaction, and one of its hashes. */
async function txNear(url, height, head) {
  for (let h = height; h < Math.min(height + 400, head); h++) {
    const b = await rpc(url, 'eth_getBlockByNumber', [hex(h), false]);
    if (b.error || !b.result) return null;
    if (b.result.transactions?.length) return { height: h, hash: b.result.transactions[0] };
  }
  return null;
}

/** How many blocks back eth_getTransactionReceipt still resolves, by doubling and bisecting. */
async function receiptHorizon(url, head) {
  const resolves = async depth => {
    const t = await txNear(url, head - depth, head);
    if (!t) return null; // block itself is gone or empty
    const r = await rpc(url, 'eth_getTransactionReceipt', [t.hash]);
    await sleep(200);
    return !r.error && r.result !== null;
  };
  let lo = 1000, hi = 2000, last;
  if ((await resolves(lo)) !== true) return { depth: 0, note: 'not even 1,000 blocks back' };
  while (hi < head) {
    last = await resolves(hi);
    if (last !== true) break;
    lo = hi; hi *= 2;
  }
  if (hi >= head && last === true) return { depth: lo, note: 'resolves back to genesis range tested' };
  while (hi - lo > Math.max(500, Math.floor(lo * 0.01))) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await resolves(mid)) === true) lo = mid; else hi = mid;
  }
  return { depth: lo, note: last === null ? 'blocks themselves stop resolving here' : 'blocks resolve further back' };
}

async function burst(url, head) {
  let refused = 0, firstRefusal = null;
  const codes = new Set();
  for (let i = 0; i < BURST; i++) {
    const from = head - 2000 - i;
    // rpcOnce, not rpc: a refusal here is the measurement, so it must not be retried away.
    const r = await rpcOnce(url, 'eth_getLogs', [{ fromBlock: hex(from), toBlock: hex(from + 1000), address: QUIET }]);
    if (r.error) { refused++; codes.add(r.error.code); firstRefusal ??= i + 1; }
    await sleep(PACE_MS);
  }
  return { refused, of: BURST, firstRefusal, codes: [...codes].join(',') };
}

const rows = [];
for (const t of targets) {
  const row = { name: t.name };
  retries = 0;
  const cid = await rpc(t.url, 'eth_chainId');
  if (cid.error) { row.error = `${cid.error.code} ${cid.error.message}`; rows.push(row); console.error(`${t.name}: ${row.error}`); continue; }
  row.chain = unhex(cid.result);
  const hd = await rpc(t.url, 'eth_blockNumber');
  const head = unhex(hd.result);
  row.head = head;
  const lat = [];
  for (let i = 0; i < 9; i++) { const r = await rpc(t.url, 'eth_blockNumber'); if (!r.error) lat.push(r.ms); await sleep(150); }
  row.latencyMs = lat.length ? Math.round(median(lat)) : null;

  const b1 = await rpc(t.url, 'eth_getBlockByNumber', [hex(head), false]);
  const b0 = await rpc(t.url, 'eth_getBlockByNumber', [hex(head - 1000), false]);
  if (b1.result && b0.result) row.blockTimeS = +((unhex(b1.result.timestamp) - unhex(b0.result.timestamp)) / 1000).toFixed(3);

  row.logSpanQuiet = (await logSpan(t.url, head, { address: QUIET })).max;
  row.logSpanBusyUsdc = (await logSpan(t.url, head, { address: USDC, topics: [TRANSFER] })).max;
  const rh = await receiptHorizon(t.url, head);
  row.receiptHorizon = rh.depth;
  row.receiptNote = rh.note;
  if (row.blockTimeS) row.receiptHorizonDays = +((rh.depth * row.blockTimeS) / 86400).toFixed(1);
  row.throttledAndRetried = retries;
  if (!noBurst) row.burst = await burst(t.url, head);
  rows.push(row);
  console.error(`${t.name}: done`);
}

console.log(JSON.stringify(rows, null, 2));
