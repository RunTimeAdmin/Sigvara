'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { stateChunks } = require('./state-serialize');

const join = (state, options) => Array.from(stateChunks(state, options)).join('');

// What persist() assembles, in the same key order.
function sampleState(over = {}) {
  const events = Array.from({ length: 40 }, (_, i) => ({
    txHash: '0x' + String(i).padStart(2, '0').repeat(32), ts: 1_700_000_000_000 + i, amount: String(1000 + i),
    payer: '0x' + '11'.repeat(20), success: i % 3 === 0 ? null : i % 2 === 0,
  }));
  return {
    schemaVersion: 1,
    chainId: 5042,
    attestations: { '0xaa': { successful: 3, total: 4 }, '0xbb': { successful: 0, total: 0 } },
    flags: { '0xaa': [1700000000000, 1700000001000] },
    links: { '0xaa': 7 },
    attestCooldowns: { '0x11:0xaa': 1700000000000 },
    paymentEvents: { '0xaa': events, '0xbb': [] },
    usedPaymentTxs: Array.from({ length: 10_000 }, (_, i) => `0x${i.toString(16)}:0xaa:0x11`),
    divergences: {},
    scanState: { lastScannedBlock: 123, agents: [{ didHash: '0xaa' }] },
    paymentScanState: null,
    savedAt: '2026-10-22T00:00:00.000Z',
    ...over,
  };
}

test('stateChunks: the pieces are exactly what JSON.stringify gives', () => {
  const state = sampleState();
  assert.equal(join(state), JSON.stringify(state));
});

test('stateChunks: still exact when every piece is tiny, so a split can fall anywhere', () => {
  const state = sampleState();
  for (const pieceChars of [1, 7, 64, 1000, 100_000]) {
    assert.equal(join(state, { pieceChars }), JSON.stringify(state), `pieceChars ${pieceChars}`);
  }
});

test('stateChunks: no piece is much larger than asked, however large the state', () => {
  const state = sampleState({ usedPaymentTxs: Array.from({ length: 50_000 }, (_, i) => 'k'.repeat(60) + i) });
  const sizes = Array.from(stateChunks(state, { pieceChars: 100_000 })).map((p) => p.length);
  assert.ok(sizes.length > 10, 'it was split');
  // One slice of a list can overshoot, and so can one agent's events, but not by the whole file.
  assert.ok(Math.max(...sizes) < 600_000, `largest piece ${Math.max(...sizes)}`);
});

test('stateChunks: empty and missing sections come out as JSON.stringify writes them', () => {
  const cases = [
    {},
    { a: undefined, b: null },
    { attestations: {}, paymentEvents: {}, usedPaymentTxs: [] },
    { paymentScanState: undefined, scanState: null, savedAt: 'x' },
    { attestations: null, flags: [], links: 'text' },
    { usedPaymentTxs: Array.from({ length: 5000 }, (_, i) => i) },
    { usedPaymentTxs: [undefined, null, 1, 'a'] },
  ];
  for (const state of cases) assert.equal(join(state, { pieceChars: 5 }), JSON.stringify(state), JSON.stringify(state));
});

test('stateChunks: keys and values that need escaping, and keys a plain object reorders', () => {
  const state = {
    attestations: { '2': 1, '1': 2, 'b': 3, 'a"quote': 4, 'line\nbreak': 5, '\u2028': 6, 'caf\u00e9': 7, '\ud83d\ude00': 8 },
    flags: { '0x1': { note: 'tab\there "quoted" \\ slash' } },
  };
  assert.equal(join(state, { pieceChars: 3 }), JSON.stringify(state));
});

test('stateChunks: a value JSON.stringify refuses is refused here too', () => {
  assert.throws(() => join({ attestations: { a: 10n } }), TypeError);
  assert.throws(() => JSON.stringify({ attestations: { a: 10n } }), TypeError);
});

test('stateChunks: a property that holds a function is left out, as JSON.stringify leaves it', () => {
  const state = { a: 1, f() {}, b: 2, attestations: { x: () => 1, y: 2 } };
  assert.equal(join(state), JSON.stringify(state));
});

// ---- a real save and a real load -----------------------------------------------------------------
//
// Two separate processes, because the state path is read when the store module loads. Large enough that the list of
// used payment keys crosses the slice boundary, so the joins between slices are in the file that gets loaded.

const { execFileSync } = require('node:child_process');
const fsx = require('node:fs');
const os = require('node:os');
const pathx = require('node:path');

test('persist then load: what one process saves, the next restores exactly', () => {
  const dir = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'sigvara-roundtrip-'));
  const statePath = pathx.join(dir, 'oracle-state.json');
  const run = (script) => execFileSync(process.execPath, ['-e', script], {
    env: { ...process.env, ORACLE_STATE_PATH: statePath }, cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const did = '0x' + 'a1'.repeat(32);
  try {
    const saved = run(`
      const s = require('./store');
      for (let i = 0; i < 6000; i++) {
        s.creditPayment('${did}', '0x' + i.toString(16).padStart(64, '0'), '5', '0x' + '22'.repeat(20), i % 2 === 0, 1700000000000 + i);
      }
      s.attestations.set('${did}', { successful: 3, total: 6000 });
      s.persist();
      console.log(JSON.stringify(s.getLastPersist().ok));
    `);
    assert.equal(saved.trim().split('\n').pop(), 'true');
    const loaded = JSON.parse(run(`
      const s = require('./store');
      s.load();
      const list = s.getPaymentEvents('${did}');
      console.log(JSON.stringify({
        events: list.length, used: s.usedPaymentTxs.size, att: s.attestations.get('${did}'),
        first: list[0].txHash, last: list[5999].txHash, success: list[1].success,
      }));
    `).trim().split('\n').pop());
    assert.deepEqual(loaded, {
      events: 6000, used: 6000, att: { successful: 3, total: 6000 },
      first: '0x' + '0'.repeat(64), last: '0x' + (5999).toString(16).padStart(64, '0'), success: false,
    });
  } finally {
    fsx.rmSync(dir, { recursive: true, force: true });
  }
});
