// Fill in `blockNumber` on payment events that predate the field.
//
// The scan canary locates a known settlement and re-issues the scan's own filter against
// it, to tell "nobody was paid" apart from "the query is broken". It needs the settlement's
// block. Events credited before 3 Oct 2026 do not carry one, and the fallback,
// eth_getTransactionReceipt, cannot supply it: every Arc endpoint prunes that index, at
// roughly 6 days on Circle's and 13 on QuickNode's. So the canary reports `unavailable`
// forever on historical evidence, and no empty scan can be believed.
//
// Logs retain where receipts do not, and a block's timestamp is exactly what the event's
// `ts` was derived from, so the block is recoverable: bisect block timestamps to find the
// settlement's block, then confirm it by matching the transaction hash in that block's
// Transfer logs. Confirmation matters because several blocks can share a timestamp.
//
// Run with the oracle STOPPED. It holds state in memory and rewrites the file on every
// persist(), so an edit made while it runs is overwritten at the next epoch.
//
// Dry run unless --write is passed. Writes via temp file and rename, the same way the
// oracle does, and refuses to touch an event whose shape the oracle would reject on load.

import { readFileSync, writeFileSync, renameSync, copyFileSync, existsSync } from 'node:fs';

const arg = (name, dflt = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? dflt : process.argv[i + 1];
};
const STATE = arg('state');
const RPC = arg('rpc');
const ASSET = arg('asset');
const WRITE = process.argv.includes('--write');
const PACE_MS = Number(arg('pace', '120'));

if (!STATE || !RPC || !ASSET) {
  console.error('usage: --state <path> --rpc <url> --asset <0x..> [--write] [--pace ms]');
  process.exit(2);
}

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let calls = 0;

async function rpc(method, params) {
  // Paced deliberately. Both providers refuse sustained bursts: thirty back-to-back
  // getLogs were rejected about two thirds of the time on each.
  await sleep(PACE_MS);
  calls += 1;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const body = await res.json();
    if (!body.error) return body.result;
    const retryable = body.error.code === -32005 || /rate limit|too many/i.test(String(body.error.message));
    if (!retryable || attempt >= 4) throw new Error(`${method}: ${body.error.message}`);
    await sleep(500 * 2 ** attempt);
  }
}

const blockTs = async (n) => {
  const b = await rpc('eth_getBlockByNumber', [`0x${n.toString(16)}`, false]);
  return b ? Number(BigInt(b.timestamp)) : null;
};

/** Lowest block whose timestamp is >= target. */
async function bisectByTimestamp(target, lo, hi) {
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const ts = await blockTs(mid);
    if (ts === null) { lo = mid + 1; continue; }
    if (ts < target) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** The block carrying `txHash`, confirmed from the asset's Transfer logs near `near`. */
async function confirmBlock(txHash, near, span = 25) {
  const from = Math.max(0, near - span);
  const logs = await rpc('eth_getLogs', [{
    fromBlock: `0x${from.toString(16)}`,
    toBlock: `0x${(near + span).toString(16)}`,
    address: ASSET,
    topics: [TRANSFER],
  }]);
  const hit = (logs || []).find((l) => String(l.transactionHash).toLowerCase() === txHash.toLowerCase());
  return hit ? Number(BigInt(hit.blockNumber)) : null;
}

// Same rules the oracle applies on load. An event it would drop is not one to annotate.
const unusable = (e) => {
  if (!e || typeof e !== 'object') return 'not an object';
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(e.txHash || ''))) return 'bad txHash';
  if (!Number.isFinite(Number(e.ts))) return 'bad ts';
  if (!/^\d+$/.test(String(e.amount))) return 'bad amount';
  return null;
};

const state = JSON.parse(readFileSync(STATE, 'utf8'));
const head = Number(BigInt(await rpc('eth_blockNumber', [])));
console.log(`state: ${STATE}`);
console.log(`head : ${head}`);
console.log(`mode : ${WRITE ? 'WRITE' : 'dry run'}\n`);

let filled = 0, already = 0, failed = 0, skipped = 0;
for (const [did, events] of Object.entries(state.paymentEvents || {})) {
  for (const e of events) {
    const why = unusable(e);
    if (why) { console.log(`  ${did.slice(0, 10)}… ${String(e?.txHash).slice(0, 12)}… SKIP (${why})`); skipped++; continue; }
    if (Number.isInteger(e.blockNumber)) { already++; continue; }
    const targetSec = Math.floor(Number(e.ts) / 1000);
    try {
      const guess = await bisectByTimestamp(targetSec, 1, head);
      const block = await confirmBlock(e.txHash, guess);
      if (block === null) {
        console.log(`  ${did.slice(0, 10)}… ${e.txHash.slice(0, 12)}… NOT FOUND near ${guess}`);
        failed++;
        continue;
      }
      const ts = await blockTs(block);
      if (ts !== targetSec) {
        // The block must be the one the stored settlement time came from, or the leaf's
        // settledAt and this block would describe different moments.
        console.log(`  ${did.slice(0, 10)}… ${e.txHash.slice(0, 12)}… MISMATCH block ${block} ts ${ts} != ${targetSec}`);
        failed++;
        continue;
      }
      e.blockNumber = block;
      filled++;
      console.log(`  ${did.slice(0, 10)}… ${e.txHash.slice(0, 12)}… -> block ${block}`);
    } catch (err) {
      console.log(`  ${did.slice(0, 10)}… ${e.txHash.slice(0, 12)}… ERROR ${err.message}`);
      failed++;
    }
  }
}

console.log(`\nfilled ${filled}, already had one ${already}, failed ${failed}, skipped ${skipped}, rpc calls ${calls}`);

if (!WRITE) { console.log('\ndry run: nothing written. Re-run with --write.'); process.exit(failed ? 1 : 0); }
if (!filled) { console.log('\nnothing to write.'); process.exit(failed ? 1 : 0); }

const backup = `${STATE}.bak-backfill-${new Date().toISOString().slice(0, 10)}`;
if (!existsSync(backup)) copyFileSync(STATE, backup);
const tmp = `${STATE}.tmp-backfill`;
writeFileSync(tmp, JSON.stringify(state));
renameSync(tmp, STATE);
console.log(`\nwrote ${filled} block number(s). Backup at ${backup}.`);
process.exit(failed ? 1 : 0);
