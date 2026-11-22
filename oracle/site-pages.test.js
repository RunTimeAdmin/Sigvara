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

// The agents page in a vm, with a card for each element id and the explorer stubbed by `X`.
function agentsPage(X) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'site', 'assets', 'agents.js'), 'utf8');
  const cards = new Map();
  const card = (id) => {
    if (!cards.has(id)) {
      const c = { html: '', classList: { remove() {}, add() {} }, scrollIntoView() {} };
      c.querySelector = () => ({ set innerHTML(v) { c.html = v; } });
      cards.set(id, c);
    }
    return cards.get(id);
  };
  const buttons = {};
  const ctx = vm.createContext({
    window: { SigvaraExplorer: X, SigvaraDid: did, SigvaraLobby: { ...lobby, startLobby: () => {} } },
    document: {
      getElementById: card,
      addEventListener() {},
      querySelectorAll: (sel) => (sel === '[data-page]' ? [{ getAttribute: () => '1', addEventListener: (_ev, fn) => { buttons.next = fn; } }] : []),
    },
  });
  vm.runInContext(source, ctx);
  return { ctx, html: (id) => card(id).html, el: card, buttons };
}
const settle = async (n = 60) => { for (let i = 0; i < n; i++) await new Promise(setImmediate); };

test('Check evidence checks against the root the contract holds now, not the one read with the row', async () => {
  const word = (n) => BigInt(n).toString(16).padStart(64, '0');
  const DID = `0x${'d1'.repeat(32)}`;
  const AGENT = `0x${'00'.repeat(19)}a1`;
  const pay = (i, t) => ({ txHash: `0x${word(0xbeef00 + i)}`, payer: `0x${'00'.repeat(19)}b${i}`, amount: String(10n ** 6n), settledAt: t, success: true });
  const list = [pay(1, 1_700_000_000), pay(2, 1_700_100_000)];
  const leaves = list.map((e) => explorer.leafOf(e));
  const oldRoot = explorer.rootOf(leaves.slice(0, 1)); // finalized when only the first payment counted
  const newRoot = explorer.rootOf(leaves); // finalized after the row was read
  let rootNow = oldRoot;
  const answer = ({ data }) => {
    const sel = data.slice(0, 10);
    if (sel === explorer.SEL.evidenceRoots) return rootNow;
    if (sel === explorer.SEL.verifyEvidence) {
      // As the contract does: true only for a proof that leads to the root it holds now.
      const words = data.slice(10).match(/.{64}/g);
      const proof = words.slice(4, 4 + Number(BigInt(`0x${words[3]}`))).map((x) => `0x${x}`);
      const root = proof.reduce((h, p) => explorer.hashPair(h, p), `0x${words[1]}`);
      return `0x${word(explorer.same(root, rootNow) ? 1 : 0)}`;
    }
    return `0x${word(0).repeat(12)}`;
  };
  const X = {
    ...explorer,
    contractLogs: async () => ({ logs: [{ topics: [explorer.EVENTS[0].topic, DID, `0x${word(0xabc)}`, `0x${AGENT.slice(2).padStart(64, '0')}`], time: 1_700_000_000, tx: null }], truncated: false, tail: null }),
    loadSimulation: async () => {},
    ethCalls: async (calls) => calls.map(answer),
    getJson: async () => ({ evidence: list, evidenceRoot: newRoot }),
  };
  const page = agentsPage(X);
  await settle();
  assert.match(page.html('agentsCard'), new RegExp(oldRoot.slice(2, 8)), 'the row shows the root read with it');
  rootNow = newRoot; // the agent's next proposal is finalized while the page is open
  await page.ctx.checkEvidence(DID);
  await settle();
  assert.match(page.html('checkCard'), /reproduced<\/span> from all 2 payments listed/);
  assert.match(page.el('contractCheck').innerHTML, /pill-ok">confirmed<\/span> <code>verifyEvidence<\/code> returns true for all 2 payments/);
  assert.doesNotMatch(page.el('contractCheck').innerHTML, /of 2 confirmed/);
  assert.match(page.html('agentsCard'), new RegExp(newRoot.slice(2, 8)), 'the row now shows the root that was checked');
});

test('a failed read on the next page of agents keeps the table, with the error above it', async () => {
  const word = (n) => n.toString(16).padStart(64, '0');
  const logs = Array.from({ length: 130 }, (_, i) => ({
    topics: [explorer.EVENTS[0].topic, '0x' + word(i + 1), '0x' + word(0xabc), '0x' + word(0x1000 + i)], time: 1_700_000_000 + i, tx: null,
  }));
  let fail = false;
  const X = {
    ...explorer,
    contractLogs: async () => ({ logs, truncated: false, tail: null }),
    loadSimulation: async () => {},
    ethCalls: async (calls) => { if (fail) throw new Error('rate limit exceeded'); return calls.map(() => '0x' + word(0).repeat(5)); },
  };
  const page = agentsPage(X);
  await settle();
  assert.match(page.html('agentsCard'), /Rows 1 to 50 of 130\./);
  fail = true;
  await page.buttons.next();
  assert.match(page.html('agentsCard'), /Rows 1 to 50 of 130\./, 'the page the visitor had is still there');
  assert.match(page.html('agentsCard'), /Could not read the agents.{0,6}scores from the chain/);
  fail = false;
  await page.buttons.next();
  assert.match(page.html('agentsCard'), /Rows 51 to 100 of 130\./);
  assert.doesNotMatch(page.html('agentsCard'), /Could not read/);
});

test('the simulation tiles do not count an agent whose evidence could not be read as zero payments', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'site', 'assets', 'simulation.js'), 'utf8');
  let hero = '';
  const el = { querySelector: () => ({ set innerHTML(v) { hero = v; } }), querySelectorAll: () => [], classList: { remove() {} } };
  const ctx = vm.createContext({
    window: { SigvaraExplorer: { ...explorer, getJson: () => new Promise(() => {}) } },
    document: { getElementById: () => el, addEventListener() {}, dispatchEvent() {} },
    URLSearchParams,
    location: { search: '' },
    Event: class { constructor(type) { this.type = type; } },
  });
  vm.runInContext(source, ctx);
  const agent = (payments) => ({ registeredAt: 1, stake: 10n ** 21n, payments, paid: 0n, signed: 0, negatives: 0, onBase: 0 });
  const start = Math.floor(Date.now() / 1000) - 86400;

  const none = [agent(null), agent(null)];
  ctx.renderHero(none, start, none);
  assert.doesNotMatch(hero, /sim-tile-value">0</, 'no tile reads 0 when nothing was read');
  assert.match(hero, /sim-tile-value">\?</);
  assert.match(hero, /could not be read for any agent/);

  const some = [agent(4), agent(null)];
  ctx.renderHero(some, start, some);
  assert.match(hero, /sim-tile-value">4</);
  assert.match(hero, /could not be read for 1 of 2 agents/);
});

test('the operators page reads /health again once a run is due, so an operator that ran is not drawn as overdue', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'site', 'assets', 'operators.js'), 'utf8');
  const HOUR = 3600 * 1000;
  const now = Date.now();
  let fresh = null;
  const timers = [];
  const card = { querySelector: () => ({}), classList: { remove() {} } };
  const ctx = vm.createContext({
    window: {
      SigvaraExplorer: {
        ...explorer,
        contractLogs: () => new Promise(() => {}), // the page's own load waits for good
        getJson: async (url) => (url.endsWith('/health') ? fresh : new Promise(() => {})),
      },
    },
    document: { getElementById: () => card, hidden: false, addEventListener() {}, dispatchEvent() {} },
    Event: class { constructor(type) { this.type = type; } },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout() {},
  });
  vm.runInContext(source, ctx);
  // As read at load: each operator finished an epoch 55 minutes ago, one an hour.
  const read = (ago) => ({ epochMs: HOUR, last: now - ago, commit: 'a'.repeat(40) });
  const health = { primary: read(55 * 60 * 1000), checker: read(55 * 60 * 1000) };
  ctx.keepHealthFresh(health);
  assert.equal(timers.length, 1);
  assert.ok(timers[0].ms > 5 * 60 * 1000 && timers[0].ms <= 6 * 60 * 1000 + 1000, `the read again is due about a minute after the next run (${timers[0].ms} ms)`);
  // The run happened: /health now says the last epoch finished two minutes ago.
  fresh = { epochMs: HOUR, lastSuccessfulEpochMs: now - 2 * 60 * 1000, commit: 'b'.repeat(40) };
  await timers[0].fn();
  assert.equal(health.primary.last, now - 2 * 60 * 1000, 'the object the room draws from is updated in place');
  assert.equal(health.checker.commit, 'b'.repeat(40));
  assert.equal(timers.length, 2, 'and the next read is scheduled');
});

test('the demo starts from what it holds after a reload, not from form state the browser restored', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'site', 'assets', 'demo-page.js'), 'utf8');
  const els = new Map();
  const element = () => ({
    value: '', textContent: '', innerHTML: '', disabled: false, dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, querySelectorAll: () => [], querySelector: () => element(), setAttribute() {}, scrollIntoView() {},
  });
  const $ = (id) => { if (!els.has(id)) els.set(id, element()); return els.get(id); };
  // What Firefox restores on a reload after step 01 and one slider move.
  $('btnRegister').disabled = true;
  $('inFees').value = '3000';
  $('vFees').textContent = '1200';
  const ctx = vm.createContext({
    window: { SigvaraDemo: demo, nacl: undefined },
    document: { getElementById: $, querySelector: () => element(), querySelectorAll: () => [] },
    crypto: globalThis.crypto,
  });
  vm.runInContext(source, ctx);
  assert.equal($('btnRegister').disabled, false, 'step 01 can be run: the simulator has no agent yet');
  assert.equal($('vFees').textContent, '3000', 'the label says what the slider holds');
});

test('the epochs page does not read a failed chain read as nothing pending', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'site', 'assets', 'epochs.js'), 'utf8');
  const cards = new Map();
  const card = (id) => {
    if (!cards.has(id)) {
      const c = { html: '', value: '', textContent: '', classList: { add() {}, remove() {} }, addEventListener() {} };
      c.querySelector = () => ({ set innerHTML(v) { c.html = v; } });
      cards.set(id, c);
    }
    return cards.get(id);
  };
  const idle = () => new Promise(() => {});
  const ctx = vm.createContext({
    window: { SigvaraExplorer: { ...explorer, indexLogs: idle, getJson: idle, contractLogs: idle }, SigvaraDid: did, location: { search: '' } },
    document: { getElementById: card, addEventListener() {}, dispatchEvent() {}, querySelector: () => null },
    Event: class { constructor(type) { this.type = type; } },
    URLSearchParams, URL, AbortController, setTimeout, clearTimeout,
    fetch: idle,
  });
  vm.runInContext(source, ctx);
  const unread = { status: 'rejected', reason: new Error('rate limit exceeded') };
  const health = { status: 'fulfilled', value: { ok: true, lastSuccessfulEpochMs: Date.now() - 60000, epochMs: 3600000 } };
  const divergence = { status: 'fulfilled', value: { tolerance: 5, divergences: [{ at: Date.now() - 120000, proposedAt: 1_700_000_000, pendingTotal: 50, ownTotal: 40 }] } };
  ctx.renderOperators(`0x${'d1'.repeat(32)}`, health, health, divergence, unread);
  const said = card('operatorsCard').html;
  assert.doesNotMatch(said, /Nothing is pending/);
  assert.match(said, /chain could not be read just now/);
  assert.match(said, /1 disagreement for this agent/, 'not filed as earlier when the pending proposal is unknown');

  const item = ctx.epochItem({ proposedAt: 1_700_000_000, fate: null, root: `0x${'ab'.repeat(32)}`, tx: null }, undefined, unread);
  assert.match(item, /Pending or ended: the chain could not be read just now/);
  assert.doesNotMatch(item, /No longer pending on chain/);
  assert.equal(ctx.epochBar({ proposedAt: 1_700_000_000, fate: null }, unread).kind, 'unknown');
});

test('the check page says what the badge says, and links the agent\'s own evidence', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'site', 'assets', 'check.js'), 'utf8');
  const els = new Map();
  const element = () => ({
    value: '', textContent: '', href: '', src: '', alt: '', hidden: false, className: '',
    style: { setProperty() {} }, classList: { add() {}, remove() {} },
    addEventListener() {}, appendChild() {}, focus() {},
  });
  const $ = (id) => { if (!els.has(id)) els.set(id, element()); return els.get(id); };
  const AGENT = '0x00000000000000000000000000000000000000a1';
  const badge = require('./badge.js');
  let state = { kind: 'unavailable' };
  const ctx = vm.createContext({
    window: { SigvaraDid: did, location: { search: `?a=${AGENT}`, href: `https://sigvara.xyz/check?a=${AGENT}` }, history: { replaceState() {} } },
    document: { getElementById: $, addEventListener() {}, createElement: () => element() },
    fetch: async () => ({ ok: true, text: async () => badge.renderBadge(state) }),
    URL, URLSearchParams, encodeURIComponent,
  });
  vm.runInContext(source, ctx);
  await settle(10);
  assert.equal($('resultState').textContent, 'Unavailable', 'a badge that says unavailable is not called live');
  assert.equal($('evidenceLink').href, `https://oracle.sigvara.xyz/evidence/${did.computeDidHash(AGENT, 5042002).toLowerCase()}`);
  assert.match($('badgeImg').src, /^data:image\/svg\+xml/, 'the badge shown is the one that was read');
});
