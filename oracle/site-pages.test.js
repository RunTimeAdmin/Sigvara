'use strict';

// Explorer pages and the demo: what they label an agent with, and what the demo numbers a block.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const explorer = require('../site/assets/explorer.js');
const demo = require('../site/assets/demo.js');
const did = require('../site/assets/did.js');
const lobby = require('../site/assets/lobby.js');

test('the demo does not number blocks from the start again after the log is cleared', () => {
  const sim = new demo.Simulator(null);
  sim.emit('A', {});
  sim.emit('B', {});
  sim.events = []; // what Clear log does (site/assets/demo-page.js)
  const e = sim.emit('C', {});
  assert.equal(e.block, 62607071);
});

test('a simulation list that fails to load for any reason but a 404 is reported as unknown', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({ status: 503, ok: false, headers: { get: () => null } }));
  await explorer.loadSimulation();
  assert.equal(explorer.simUnknown(), true);
  assert.equal(explorer.simAgent('0x00000000000000000000000000000000000000a1'), null);
});

test('a Suspended or PendingBond simulated agent with stake is not shown as Active', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'site', 'assets', 'simulation.js'), 'utf8');
  const ctx = vm.createContext({
    window: { SigvaraExplorer: { getJson: () => new Promise(() => {}) } },
    document: { getElementById: () => ({ querySelector: () => ({}), querySelectorAll: () => [], classList: { remove() {} } }) },
    // The page picks the batch it shows from its query string when it loads (#284), and a vm context
    // has neither a URLSearchParams nor a location of its own.
    URLSearchParams,
    location: { search: '' },
  });
  vm.runInContext(source, ctx);
  const agent = (status) => ({ registeredAt: 1, status, slash: 'none', stake: 10n ** 21n, day: 0 });
  assert.deepEqual([...ctx.statusOf(agent(1), 0)], ['warn', 'Suspended']);
  assert.deepEqual([...ctx.statusOf(agent(3), 0)], ['waiting', 'Not bonded yet']);
  assert.deepEqual([...ctx.statusOf(agent(0), 0)], ['live', 'Active']);
});

test('the agents page reads the chain only for the agents it shows, 50 rows at a time and 60 in the lobby', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'site', 'assets', 'agents.js'), 'utf8');
  const word = (n) => n.toString(16).padStart(64, '0');
  // 130 registrations, oldest first, as contractLogs gives them.
  const logs = Array.from({ length: 130 }, (_, i) => ({
    topics: [explorer.EVENTS[0].topic, '0x' + word(i + 1), '0x' + word(0xabc), '0x' + word(0x1000 + i)], time: 1_700_000_000 + i, tx: null,
  }));
  const asked = [];
  const X = {
    ...explorer,
    contractLogs: async () => ({ logs, truncated: false, tail: null }),
    loadSimulation: async () => {},
    // The didHash each read is for. Every answer is zero words: an active agent with nothing yet.
    ethCalls: async (calls) => { asked.push(...calls.map((c) => c.data.slice(-64))); return calls.map(() => '0x' + word(0).repeat(5)); },
  };
  let html = '', people = null, next = null;
  const card = { querySelector: () => ({ set innerHTML(v) { html = v; } }), classList: { remove() {} }, scrollIntoView() {} };
  const ctx = vm.createContext({
    window: { SigvaraExplorer: X, SigvaraDid: did, SigvaraLobby: { ...lobby, startLobby: (_host, list) => { people = list; } } },
    document: {
      getElementById: () => card,
      addEventListener() {},
      querySelectorAll: (sel) => (sel === '[data-page]' ? [{ getAttribute: () => '1', addEventListener: (_ev, fn) => { next = fn; } }] : []),
    },
  });
  vm.runInContext(source, ctx);
  for (let i = 0; i < 50 && !people; i++) await new Promise(setImmediate);

  const rows = () => (html.match(/data-check="/g) || []).length;
  assert.equal(people.length, 60, 'the lobby holds 60');
  assert.deepEqual([...new Set(asked)], Array.from({ length: 60 }, (_, i) => word(i + 1)), 'the first 60 agents, read once each');
  assert.equal(asked.length, 60 * 5);
  assert.equal(rows(), 50);
  assert.match(html, /Rows 1 to 50 of 130\./);

  await next();
  assert.equal(rows(), 50);
  assert.match(html, /Rows 51 to 100 of 130\./);
  assert.deepEqual([...new Set(asked.slice(300))], Array.from({ length: 40 }, (_, i) => word(i + 61)), 'only the rows not read before');
});

test('the testnet page reports a read the RPC never answers after 20 seconds, rather than waiting for good', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'site', 'assets', 'testnet.js'), 'utf8');
  const els = new Map();
  const $ = (id) => {
    if (!els.has(id)) els.set(id, { textContent: '', value: '', href: '', setAttribute() {}, addEventListener() {} });
    return els.get(id);
  };
  let ready = null;
  const waits = [];
  const ctx = vm.createContext({
    window: { SigvaraDid: did },
    document: { getElementById: $, querySelector: () => null, addEventListener: (type, fn) => { if (type === 'DOMContentLoaded') ready = fn; } },
    // An address in the query string starts a check when the page loads.
    URLSearchParams,
    location: { search: '?a=0x00000000000000000000000000000000000000a1' },
    AbortController,
    // A node that accepts the connection and never answers: the request ends only if the page aborts it.
    fetch: (_url, init) => new Promise((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('This operation was aborted', 'AbortError')));
    }),
    // The page's timer fires at once, and the test checks the delay it asked for.
    setTimeout: (fn, ms) => { waits.push(ms); return setImmediate(fn); },
    clearTimeout: clearImmediate,
  });
  vm.runInContext(source, ctx);
  ready();
  for (let i = 0; i < 20; i++) await new Promise(setImmediate);
  assert.equal($('cardDid').textContent, 'read failed: the RPC did not answer within 20 seconds');
  assert.deepEqual(waits, [20000]);
});
