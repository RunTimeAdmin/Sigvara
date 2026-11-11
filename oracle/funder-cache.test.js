'use strict';

// How much of reviewer funding the reader keeps (funder-scan.js): a bound on the wallets read, which
// ones go when it is reached, and the state file it is saved in (state-serialize.js).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFunderReader, UNREAD } = require('./funder-scan');
const { stateChunks } = require('./state-serialize');

const FLOOR = 10n ** 18n;
const DAY_MS = 86_400_000;
const addr = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const FUNDER = addr(0xf00d);

test('at 50,000 wallets read the cache stays at its bound: the least recently asked go, one still asked about stays, and one gone is read again', async () => {
  let clock = Date.UTC(2026, 10, 1);
  const reads = [];
  const r = createFunderReader({
    floor: FLOOR,
    now: () => clock,
    // Every wallet was funded by FUNDER at block 5.
    readIn: async (a, from, to) => {
      reads.push(a);
      return from <= 5 && to >= 5 ? [{ from: FUNDER, value: FLOOR, blockNumber: 5, logIndex: 0 }] : [];
    },
  });
  const WALLETS = 50_000;
  for (let i = 1; i <= WALLETS; i++) await r.funderOf(addr(i), 100);
  assert.deepEqual(await r.readWanted(), { reads: WALLETS, left: 0, error: null });
  assert.equal(Object.keys(r.getState().wallets).length, WALLETS, 'all asked about this week, so all in use and kept');

  // A week and a day on, three of them are asked about again: the ones that would go first by address.
  clock += 8 * DAY_MS;
  for (const i of [1, 2, 3]) assert.deepEqual(await r.funderOf(addr(i), 100), { funder: FUNDER, block: 5 });
  await r.readWanted();
  const kept = r.getState().wallets;
  assert.equal(Object.keys(kept).length, 10_000, 'the cache is at its bound');
  for (const i of [1, 2, 3]) assert.ok(kept[addr(i)], `wallet ${i}, asked about this week, is kept`);
  assert.equal(kept[addr(4)], undefined, 'the idle wallets go lowest address first');
  assert.ok(kept[addr(WALLETS)], 'and the bound is filled from the rest');

  // One that went answers UNREAD, so its agent waits, and asking reads it again.
  assert.equal(await r.funderOf(addr(4), 100), UNREAD);
  const before = reads.length;
  assert.deepEqual(await r.readWanted(), { reads: 1, left: 0, error: null });
  assert.deepEqual(reads.slice(before), [addr(4)]);
  assert.deepEqual(await r.funderOf(addr(4), 100), { funder: FUNDER, block: 5 });
  assert.equal(Object.keys(r.getState().wallets).length, 10_000, 'still at its bound');
  for (const i of [1, 2, 3, 4]) assert.ok(r.getState().wallets[addr(i)], `wallet ${i} is still kept`);
});

/** `n` wallets read, each funded by addr(7), as the reader keeps them. Also run as source in a child process. */
function makeWallets(n) {
  const wallets = {};
  for (let i = 1; i <= n; i++) {
    wallets['0x' + i.toString(16).padStart(40, '0')] = { through: 30000000, funder: '0x' + '7'.padStart(40, '0'), block: 5 + i, asked: 1700000000000 };
  }
  return wallets;
}

test('a large cache is written to the state file in pieces, and loads back', () => {
  const WALLETS = 50_000;
  const wallets = makeWallets(WALLETS);
  const state = { schemaVersion: 1, funderScanState: { wallets }, savedAt: 'x' };
  const pieces = Array.from(stateChunks(state, { pieceChars: 100_000 }));
  assert.equal(pieces.join(''), JSON.stringify(state));
  const largest = Math.max(...pieces.map((p) => p.length));
  assert.ok(largest < 200_000, `the largest piece is ${largest} characters, of ${JSON.stringify(state).length}`);

  // A real save and a real load, in two processes because the state path is read when the store loads.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigvara-funders-'));
  const statePath = path.join(dir, 'oracle-state.json');
  const run = (script) => execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, ORACLE_STATE_PATH: statePath }, cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim().split('\n').pop();
  try {
    assert.equal(run(`
      const s = require('./store');
      ${makeWallets}
      s.setFunderScanState({ wallets: makeWallets(${WALLETS}) });
      console.log(JSON.stringify(s.persist()));
    `), 'true');
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).schemaVersion, 1, 'a file the build before this one reads');
    const loaded = JSON.parse(run(`
      const s = require('./store');
      const { createFunderReader } = require('./funder-scan');
      s.load();
      const r = createFunderReader({ floor: 1n, readIn: async () => [] });
      r.restore(s.getFunderScanState());
      r.funderOf('0x' + (${WALLETS}).toString(16).padStart(40, '0'), 10 ** 9).then((last) => {
        console.log(JSON.stringify({ kept: Object.keys(r.getState().wallets).length, last }));
      });
    `));
    assert.deepEqual(loaded, { kept: WALLETS, last: { funder: addr(7), block: 5 + WALLETS } });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
