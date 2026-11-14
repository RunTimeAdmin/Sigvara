'use strict';

// Explorer pages and the demo: what they label an agent with, and what the demo numbers a block.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const explorer = require('../site/assets/explorer.js');
const demo = require('../site/assets/demo.js');

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
