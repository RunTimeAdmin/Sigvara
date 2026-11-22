'use strict';

// The explorer pages' shared reads (site/assets/explorer.js): a cached read that several callers ask
// for at once, a chain read whose page has moved on, and the two fallback caches kept in step.

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const X = require('../site/assets/explorer.js');

const realFetch = globalThis.fetch;
const reply = (status, body) => ({ ok: status === 200, status, json: async () => body, headers: { get: () => null } });
afterEach(() => {
  globalThis.fetch = realFetch;
  delete globalThis.sessionStorage;
});

test('callers that ask for one cached key at once share a single read', async () => {
  let reads = 0;
  const read = () => { reads++; return new Promise((r) => setTimeout(() => r('value'), 20)); };
  const answers = await Promise.all([X.cached('probe', read), X.cached('probe', read), X.cached('probe', read)]);
  assert.equal(reads, 1);
  assert.deepEqual(answers, ['value', 'value', 'value']);
});

test('a chain read for a lookup the page has moved on from stops before it asks the RPC', async () => {
  let asked = 0;
  globalThis.fetch = async () => { asked++; return reply(200, []); };
  await assert.rejects(X.chainLogs([X.IDENTITY], null, 0, 40_000, { times: false, isCurrent: () => false }), /superseded/);
  assert.equal(asked, 0);
});

test('an explorer answer cached well before the chain tail is read again, so no blocks fall between them', async () => {
  const LATEST = 72_800_000;
  const now = Date.now();
  const store = new Map();
  globalThis.sessionStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => { store.set(k, v); } };
  // Registrations as the explorer answered five minutes ago, when its index reached less far.
  const topic = X.EVENTS.find((e) => e.name === 'AgentRegistered').topic;
  store.set(`sigvara-explorer-logs:${X.IDENTITY.toLowerCase()}:${topic}`,
    JSON.stringify({ at: now - 5 * 60_000, value: { rows: [], more: false, readAt: now - 5 * 60_000 } }));
  let explorerReads = 0;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith(X.INDEX)) return reply(503, {}); // the event index is down
    if (u.includes('/api/v2/addresses/')) return reply(200, { items: [{ block_number: LATEST - 100, block_timestamp: '2026-11-22T18:00:00Z' }] });
    if (u.startsWith(`${X.EXPLORER}/api?`)) { explorerReads++; return reply(200, { status: '0', message: 'No logs found', result: [] }); }
    if (u === X.RPC) {
      const calls = JSON.parse(init.body);
      return reply(200, calls.map((c) => ({
        jsonrpc: '2.0', id: c.id,
        result: c.method === 'eth_blockNumber' ? `0x${LATEST.toString(16)}` : c.method === 'eth_getLogs' ? [] : { timestamp: '0x1' },
      })));
    }
    throw new Error(`no stub for ${u}`);
  };
  const got = await X.contractLogs(X.IDENTITY, ['AgentRegistered']);
  assert.equal(explorerReads, 1, 'the explorer was asked again');
  assert.equal(got.tail.indexError !== undefined, true, 'this was the fallback path');
});
