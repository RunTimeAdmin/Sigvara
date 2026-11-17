'use strict';

// Where the explorer pages read the chain themselves when Sigvara's event index does not answer (site/assets/explorer.js,
// tailRange and the note under a history). The Arc explorer's index stopped at block 70337205 on 2 November 2026 and
// was not relied on past it; by 17 November it held every log after it, so it is relied on up to its newest indexed
// log again. These run against a stubbed explorer and RPC.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const X = require('../site/assets/explorer.js');

const LATEST = 72_800_000;
// The block of the explorer's newest reputation log, or null for an explorer that does not answer.
let explorerHead;
const realFetch = globalThis.fetch;
const reply = (status, body) => ({ ok: status === 200, status, json: async () => body, headers: { get: () => null } });

beforeEach(() => {
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('/api/v2/addresses/')) {
      return explorerHead === null ? reply(503, {})
        : reply(200, { items: [{ block_number: explorerHead, block_timestamp: '2026-11-17T19:00:00Z' }] });
    }
    if (String(url) === X.RPC) {
      const calls = JSON.parse(init.body);
      return reply(200, calls.map((c) => ({ jsonrpc: '2.0', id: c.id, result: `0x${LATEST.toString(16)}` })));
    }
    throw new Error(`no stub for ${url}`);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

test('the explorer is relied on up to its newest indexed log, past the block it stopped at on 2 November', async () => {
  explorerHead = LATEST - 1000;
  const t = await X.tailRange();
  assert.equal(t.from, LATEST - 999);
  assert.equal(t.to, LATEST);
  assert.equal(t.missed, null);
  assert.equal(X.historyNote({ tail: t }), '', 'a tail this short needs no note');
});

test('an explorer further behind than the tail leaves a gap, and the page names it', async () => {
  explorerHead = LATEST - X.TAIL_BLOCKS - 5000;
  const t = await X.tailRange();
  assert.equal(t.from, LATEST - X.TAIL_BLOCKS + 1);
  assert.deepEqual(t.missed, [explorerHead + 1, LATEST - X.TAIL_BLOCKS]);
  assert.match(X.historyNote({ tail: t }), /past the Arc explorer's newest indexed log/);
});

test('an explorer that does not say how far it has indexed gets the newest blocks from the chain, and a warning', async () => {
  explorerHead = null;
  const t = await X.tailRange();
  assert.equal(t.from, LATEST - X.TAIL_BLOCKS + 1);
  assert.equal(t.reachUnknown, true);
  assert.equal(t.missed, null);
  assert.match(X.historyNote({ tail: t }), /did not say how far its index reaches/);
});
