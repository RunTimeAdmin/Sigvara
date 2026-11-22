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
function agentsPage(X, win = {}, controls = []) {
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
    window: { SigvaraExplorer: X, SigvaraDid: did, SigvaraLobby: { ...lobby, startLobby: () => {} }, ...win },
    document: {
      getElementById: card,
      addEventListener() {},
      querySelectorAll: (sel) => (sel === '[data-page]' ? [{ getAttribute: () => '1', addEventListener: (_ev, fn) => { buttons.next = fn; } }]
        : sel === '[data-page], [data-filter]' ? controls : []),
    },
    URLSearchParams, URL,
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

// The epochs page in a vm: a card for each element id, `X` over the explorer, and a network that never answers.
function epochsPage(X = {}, extra = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'site', 'assets', 'epochs.js'), 'utf8');
  const cards = new Map();
  const card = (id) => {
    if (!cards.has(id)) {
      const c = { html: '', value: '', textContent: '', innerHTML: '', classList: { add() {}, remove() {} }, addEventListener() {} };
      c.querySelector = () => ({ set innerHTML(v) { c.html = v; } });
      cards.set(id, c);
    }
    return cards.get(id);
  };
  const idle = () => new Promise(() => {});
  const ctx = vm.createContext({
    window: { SigvaraExplorer: { ...explorer, indexLogs: idle, getJson: idle, contractLogs: idle, ...X }, SigvaraDid: did, location: { search: '', href: 'https://sigvara.xyz/epochs' }, history: { replaceState() {} } },
    document: { getElementById: card, addEventListener() {}, dispatchEvent() {}, querySelector: () => null, querySelectorAll: () => [], ...extra.document },
    Event: class { constructor(type) { this.type = type; } },
    URLSearchParams, URL, AbortController, setTimeout, clearTimeout, setInterval: extra.setInterval ?? (() => 0), clearInterval() {},
    fetch: idle,
    SigvaraDid: did,
  });
  vm.runInContext(source, ctx);
  return { ctx, card };
}

test('the epochs page names the agent being looked up at once, not the previous one', () => {
  const { ctx, card } = epochsPage();
  const B = '0x00000000000000000000000000000000000000b2';
  card('status').innerHTML = 'Active';
  ctx.lookup(B); // the reads never answer
  assert.match(card('didStr').textContent, new RegExp(B));
  assert.equal(card('status').textContent, 'Reading…');
  assert.equal(card('score').textContent, 'Reading…');
});

test('a lookup submitted again while it runs is not started twice, and a replaced one can stop its reads', () => {
  const asked = [];
  const { ctx } = epochsPage({ indexLogs: (_a, opts) => { asked.push(opts); return new Promise(() => {}); } });
  const A = '0x00000000000000000000000000000000000000a1';
  const B = '0x00000000000000000000000000000000000000b2';
  ctx.lookup(A);
  ctx.lookup(A);
  assert.equal(asked.length, 1, 'the same address twice is one lookup');
  assert.equal(asked[0].isCurrent(), true);
  ctx.lookup(B);
  assert.equal(asked.length, 2);
  assert.equal(asked[0].isCurrent(), false, "A's reads learn that B replaced it");
});

test('"no proposal yet" keeps the note on blocks the chain could not fill in', () => {
  const { ctx, card } = epochsPage();
  const tail = { source: 'index', indexHead: { block: 100, time: null }, from: 101, to: 100, missed: null, error: 'rate limit exceeded' };
  ctx.renderTimeline({ status: 'fulfilled', value: { logs: [], truncated: false, tail } }, { status: 'fulfilled', value: { pending: null } }, false);
  assert.match(card('timelineCard').html, /No proposal has been made/);
  assert.match(card('timelineCard').html, /could not be read from the chain/);
});

test('the time left in an open challenge window keeps counting while the page is open', () => {
  let tick = null;
  const shown = { dataset: {}, textContent: '' };
  const { ctx, card } = epochsPage({}, { setInterval: (fn) => { tick = fn; return 1; }, document: { querySelectorAll: () => [shown] } });
  const now = Math.floor(Date.now() / 1000);
  const pending = { total: 40, factors: [], proposer: '0x0000000000000000000000000000000000000001', proposedAt: now - 100, root: `0x${'ab'.repeat(32)}`, finalizableAt: now + 3600 };
  ctx.renderPending({ status: 'fulfilled', value: { pending } });
  assert.match(card('pendingCard').html, new RegExp(`data-until="${pending.finalizableAt}"`));
  assert.equal(typeof tick, 'function', 'a ticker runs while the window is open');
  shown.dataset.until = String(now - 1); // the window has closed since
  tick();
  assert.equal(shown.textContent, 'now closed');
});

test('the agents table takes its filter and page from the address, and keeps the address in step', async () => {
  const word = (n) => n.toString(16).padStart(64, '0');
  const logs = Array.from({ length: 130 }, (_, i) => ({ topics: [explorer.EVENTS[0].topic, '0x' + word(i + 1), '0x' + word(0xabc), '0x' + word(0x1000 + i)], time: 1_700_000_000 + i, tx: null }));
  const X = { ...explorer, contractLogs: async () => ({ logs, truncated: false, tail: null }), loadSimulation: async () => {}, ethCalls: async (calls) => calls.map(() => '0x' + word(0).repeat(5)) };
  const urls = [];
  const location = { search: '?page=2', href: 'https://sigvara.xyz/agents?page=2' };
  const page = agentsPage(X, { location, history: { replaceState: (_s, _t, u) => { urls.push(u); location.href = u; } } });
  await settle();
  assert.match(page.html('agentsCard'), /Rows 51 to 100 of 130\./, 'a shared link to page 2 opens on page 2');
  await page.buttons.next();
  assert.equal(urls.at(-1), 'https://sigvara.xyz/agents?page=3');
});

test('the agents page turns every paging and filter control off while the rows it asked for load', async () => {
  const word = (n) => n.toString(16).padStart(64, '0');
  const logs = Array.from({ length: 130 }, (_, i) => ({ topics: [explorer.EVENTS[0].topic, '0x' + word(i + 1), '0x' + word(0xabc), '0x' + word(0x1000 + i)], time: 1_700_000_000 + i, tx: null }));
  let hold = null;
  const X = { ...explorer, contractLogs: async () => ({ logs, truncated: false, tail: null }), loadSimulation: async () => {},
    ethCalls: async (calls) => { if (hold) await hold; return calls.map(() => '0x' + word(0).repeat(5)); } };
  const controls = [{ disabled: false }, { disabled: false }, { disabled: false }];
  const page = agentsPage(X, {}, controls);
  await settle();
  hold = new Promise(() => {}); // page 2's rows never arrive
  page.buttons.next();
  assert.ok(controls.every((c) => c.disabled), 'Previous, Next and the filters are off');
});

test('"no agent has registered" keeps the note on blocks the chain could not fill in', async () => {
  const tail = { source: 'index', indexHead: { block: 100, time: null }, from: 101, to: 100, missed: null, error: 'rate limit exceeded' };
  const X = { ...explorer, contractLogs: async () => ({ logs: [], truncated: false, tail }), loadSimulation: async () => {}, ethCalls: async () => [] };
  const page = agentsPage(X);
  await settle();
  assert.match(page.html('agentsCard'), /No agent has registered/);
  assert.match(page.html('agentsCard'), /could not be read from the chain/);
});

test('a second click on "Check the payments against the chain" while it runs starts nothing', async () => {
  const word = (n) => BigInt(n).toString(16).padStart(64, '0');
  const DID = `0x${'d1'.repeat(32)}`;
  const list = [{ txHash: `0x${word(0xbeef01)}`, payer: `0x${'00'.repeat(19)}b1`, amount: String(10n ** 6n), settledAt: 1_700_000_000, success: true }];
  const root = explorer.rootOf(list.map((e) => explorer.leafOf(e)));
  let receiptReads = 0;
  const X = {
    ...explorer,
    contractLogs: async () => ({ logs: [{ topics: [explorer.EVENTS[0].topic, DID, `0x${word(0xabc)}`, `0x${word(0xa1)}`], time: 1, tx: null }], truncated: false, tail: null }),
    loadSimulation: async () => {},
    ethCalls: async (calls) => calls.map(({ data }) => (data.startsWith(explorer.SEL.evidenceRoots) ? root : `0x${word(1)}${word(0).repeat(11)}`)),
    getJson: async () => ({ evidence: list, evidenceRoot: root }),
    rpcMany: async () => { receiptReads++; return new Promise(() => {}); }, // the receipts never arrive
  };
  const page = agentsPage(X);
  await settle();
  await page.ctx.checkEvidence(DID);
  await settle();
  const btn = page.el('chainCheckBtn');
  btn.onclick();
  btn.onclick();
  await settle(5);
  assert.equal(receiptReads, 1);
  assert.equal(btn.disabled, true);
});

// A page script in a vm, with a card for each element id and the explorer stubbed by `X`.
function pageIn(file, X = {}) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'site', 'assets', file), 'utf8');
  const cards = new Map();
  const card = (id) => {
    if (!cards.has(id)) {
      const c = { html: '', textContent: '', classList: { add() {}, remove() {} }, addEventListener() {} };
      c.querySelector = () => ({ set innerHTML(v) { c.html = v; } });
      cards.set(id, c);
    }
    return cards.get(id);
  };
  const idle = () => new Promise(() => {});
  const win = { SigvaraExplorer: { ...explorer, contractLogs: idle, getJson: idle, loadSimulation: async () => {}, ...X }, SigvaraDid: did };
  const ctx = vm.createContext({
    window: win,
    document: { getElementById: card, addEventListener() {}, dispatchEvent() {}, querySelector: () => null, querySelectorAll: () => [] },
    Event: class { constructor(type) { this.type = type; } },
    setTimeout, clearTimeout,
  });
  vm.runInContext(source, ctx);
  return { ctx, card, win };
}
const unreadTail = { source: 'index', indexHead: { block: 100, time: null }, from: 101, to: 100, missed: null, error: 'rate limit exceeded' };

test('the operators page lists the disagreements even when their agents\' addresses cannot be read', async () => {
  const D = `0x${'d1'.repeat(32)}`;
  const { ctx, card } = pageIn('operators.js', { ethCalls: async () => { throw new Error('rate limit exceeded'); } });
  const got = await ctx.renderDivergence({ status: 'fulfilled', value: { total: 1, tolerance: 5, divergences: [{ didHash: D, at: Date.now(), pendingTotal: 50, ownTotal: 40, proposedAt: 1_700_000_000 }] } });
  assert.match(card('divergenceCard').html, /proposed 50, checker got 40/);
  assert.ok(card('divergenceCard').html.includes(explorer.short(D)), 'named by its didHash');
  assert.equal(got.total, 1);
  const none = await ctx.renderDivergence({ status: 'fulfilled', value: { total: 0, divergences: [] } });
  assert.deepEqual({ ...none, shown: [...none.shown] }, { total: 0, shown: [] }, 'an empty list is a count of none');
});

test('the operators room is told when the disagreements were not read, rather than that there were none', () => {
  const { ctx, win } = pageIn('operators.js');
  ctx.publish({ ops: [], bondAmount: 0n }, [], { primary: { status: 'rejected' }, checker: { status: 'rejected' } }, undefined);
  assert.equal(win.SigvaraOperatorsData.divergenceTotal, null);
  assert.equal(win.SigvaraOperatorsData.divergences, null);
});

test('"no operator has bonded yet" keeps the note on blocks the chain could not fill in', async () => {
  const { ctx, card } = pageIn('operators.js');
  const down = { status: 'rejected', reason: new Error('offline') };
  await ctx.renderOperators({ status: 'fulfilled', value: { logs: [], truncated: false, tail: unreadTail } }, { primary: down, checker: down });
  assert.match(card('operatorsCard').html, /No operator has bonded yet/);
  assert.match(card('operatorsCard').html, /could not be read from the chain/);
});

test('the slashes page says a failed read of the filing transactions failed, not that the evidence is unreadable', async () => {
  const word = (n) => BigInt(n).toString(16).padStart(64, '0');
  const filed = { name: 'SlashInitiated', topics: [`0x${'5'.repeat(64)}`, `0x${'d1'.repeat(32)}`, `0x${word(0xa1)}`, `0x${word(0xb2)}`], data: `0x${word(1_700_000_000)}`, time: 1_700_000_000, tx: `0x${'ab'.repeat(32)}`, legacy: false };
  const history = { status: 'fulfilled', value: { logs: [filed], truncated: false, tail: null } };
  const failed = pageIn('slashes.js', { ethCalls: async (calls) => calls.map(() => `0x${word(0).repeat(5)}`), rpcMany: async () => { throw new Error('rate limit exceeded'); } });
  await failed.ctx.renderSlashes(history);
  assert.match(failed.card('slashCard').html, /could not be read just now \(rate limit exceeded\)/);
  const missing = pageIn('slashes.js', { ethCalls: async (calls) => calls.map(() => `0x${word(0).repeat(5)}`), rpcMany: async () => [null] });
  await missing.ctx.renderSlashes(history);
  assert.match(missing.card('slashCard').html, /the RPC did not return the transaction that filed it/);
});

test('"no operator bond has been slashed" keeps the note on blocks the chain could not fill in', () => {
  const { ctx, card } = pageIn('slashes.js');
  ctx.renderBondSlashes({ status: 'fulfilled', value: { logs: [], truncated: false, tail: unreadTail } });
  assert.match(card('bondSlashCard').html, /No operator bond has been slashed/);
  assert.match(card('bondSlashCard').html, /could not be read from the chain/);
});

test('a copy button clicked twice comes back to its own label', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'site', 'assets', 'check.js'), 'utf8');
  const els = new Map();
  const element = () => ({ value: '', textContent: '', href: '', src: '', hidden: false, style: { setProperty() {} }, classList: { add() {}, remove() {} }, addEventListener() {}, appendChild() {}, focus() {} });
  const $ = (id) => { if (!els.has(id)) els.set(id, element()); return els.get(id); };
  let onClick = null;
  const timers = [];
  const attrs = {};
  const btn = { textContent: 'Copy', getAttribute: (k) => (k === 'data-copy' ? 'snipMd' : attrs[k] ?? null), setAttribute: (k, v) => { attrs[k] = v; } };
  const ctx = vm.createContext({
    window: { SigvaraDid: did, location: { search: '', href: 'https://sigvara.xyz/check' }, history: { replaceState() {} } },
    document: { getElementById: $, addEventListener: (type, fn) => { if (type === 'click') onClick = fn; }, createElement: () => element() },
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {},
    URL, URLSearchParams,
  });
  vm.runInContext(source, ctx);
  const click = () => onClick({ target: { closest: () => btn } });
  click();
  await settle(3);
  click(); // while "Copied" shows
  await settle(3);
  assert.equal(btn.textContent, 'Copied');
  for (const t of timers) t.fn(); // both resets fire, in order
  assert.equal(btn.textContent, 'Copy');
});

test('the testnet check clears the previous address\'s card at once and puts the address in the link', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'site', 'assets', 'testnet.js'), 'utf8');
  const els = new Map();
  const handlers = {};
  const $ = (id) => {
    if (!els.has(id)) els.set(id, { id, textContent: '', value: '', href: '', setAttribute() {}, addEventListener: (type, fn) => { handlers[`${id}:${type}`] = fn; } });
    return els.get(id);
  };
  let ready = null;
  const urls = [];
  const ctx = vm.createContext({
    window: { SigvaraDid: did, location: { href: 'https://sigvara.xyz/testnet' }, history: { replaceState: (_s, _t, u) => urls.push(u) } },
    document: { getElementById: $, querySelector: () => null, addEventListener: (type, fn) => { if (type === 'DOMContentLoaded') ready = fn; } },
    URLSearchParams, URL, location: { search: '' }, AbortController,
    fetch: () => new Promise(() => {}), setTimeout: () => 0, clearTimeout() {},
  });
  vm.runInContext(source, ctx);
  ready();
  $('cardScore').textContent = '61'; // the previous address's score
  $('addr').value = '0x00000000000000000000000000000000000000b2';
  handlers['checkBtn:click']();
  assert.equal($('cardScore').textContent, '—', 'the previous score is gone while this one is read');
  assert.equal($('cardDid').textContent, 'reading chain…');
  assert.equal(urls.at(-1), 'https://sigvara.xyz/testnet?a=0x00000000000000000000000000000000000000b2');
});

test('the demo says what is missing when Verify is pressed before anything was signed', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'site', 'assets', 'demo-page.js'), 'utf8');
  const els = new Map();
  const element = () => ({
    value: '', textContent: '', innerHTML: '', disabled: false, dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; }, querySelectorAll: () => [], querySelector: () => null, setAttribute() {}, scrollIntoView() {}, prepend() {}, remove() {},
  });
  const $ = (id) => { if (!els.has(id)) els.set(id, element()); return els.get(id); };
  const ctx = vm.createContext({
    window: { SigvaraDemo: demo, nacl: undefined },
    document: { getElementById: $, querySelector: () => element(), querySelectorAll: () => [], createElement: () => element() },
    crypto: globalThis.crypto,
  });
  vm.runInContext(source, ctx);
  $('btnVerify').listeners.click();
  assert.match($('outVerify').innerHTML, /issue and sign a challenge first/);
  assert.doesNotMatch($('outVerify').innerHTML, /Cannot read properties/);
});

const SITE = path.join(__dirname, '..', 'site');

// Every file under site/ with the given extension, as [path relative to site/ with forward slashes, text].
function siteFiles(ext) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(ext)) out.push([path.relative(SITE, full).split(path.sep).join('/'), fs.readFileSync(full, 'utf8')]);
    }
  };
  walk(SITE);
  return out;
}

test('no heading is drawn in gradient text or tracked tighter than -0.01em, and no stylesheet asks for Inter', () => {
  const sheets = siteFiles('.css');
  const pages = siteFiles('.html');
  assert.ok(sheets.length > 0 && pages.length > 0);

  // Each rule as [file, selector, body]; a rule inside @media is matched on its own.
  const rules = sheets.flatMap(([name, css]) =>
    [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [name, m[1].trim(), m[2]]));
  const isHeading = (selector) => selector.split(',').some((s) => /^h[1-3](?![\w-])/.test(s.trim().split(/[\s>+~]+/).pop()));

  const clipped = new Set();
  for (const [name, selector, body] of rules) {
    if (/background-clip:\s*text/.test(body)) {
      assert.doesNotMatch(selector, /\bh[1-3]\b/, `${name}: ${selector} clips a gradient to heading text`);
      for (const [, cls] of selector.matchAll(/\.([\w-]+)/g)) clipped.add(cls);
    }
    for (const [decl] of body.matchAll(/(?:font|font-family|--[\w-]*font[\w-]*)\s*:[^;]*/g)) {
      assert.doesNotMatch(decl, /\bInter\b/, `${name}: ${selector}`);
    }
    if (isHeading(selector)) {
      const tracking = body.match(/letter-spacing:\s*(-?[\d.]+)em/);
      if (tracking) assert.ok(Number(tracking[1]) >= -0.01, `${name}: ${selector} is tracked at ${tracking[1]}em`);
    }
  }
  for (const [name, html] of pages) {
    for (const [heading] of html.matchAll(/<(h[1-3])\b[^>]*>[\s\S]*?<\/\1>/g)) {
      for (const [, list] of heading.matchAll(/class="([^"]*)"/g)) {
        for (const cls of list.split(/\s+/)) assert.ok(!clipped.has(cls), `${name}: ${heading}`);
      }
    }
  }
});

test('every font a stylesheet names is a file in site/, and pages preload only those fonts, in a way the stylesheet can reuse', () => {
  const faces = new Set();
  for (const [name, css] of siteFiles('.css')) {
    for (const [face] of css.matchAll(/@font-face\s*\{[^}]*\}/g)) {
      for (const [, url] of face.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
        assert.doesNotMatch(url, /^([a-z][\w+.-]*:)?\/\//i, `${name}: ${url} is not on this site, and the CSP allows fonts from this site only`);
        const file = path.posix.join(path.posix.dirname(name), url.split(/[?#]/)[0]);
        assert.ok(fs.existsSync(path.join(SITE, file)), `${name}: ${url} is not a file in site/`);
        faces.add(file);
      }
    }
  }
  assert.ok(faces.size > 0);
  let preloads = 0;
  for (const [name, html] of siteFiles('.html')) {
    for (const [link] of html.matchAll(/<link\b[^>]*\brel="preload"[^>]*>/g)) {
      if (!/\bas="font"/.test(link)) continue;
      // Fonts are fetched in CORS mode, so a preload without crossorigin is not reused and the font downloads twice.
      assert.match(link, /\scrossorigin\b/, `${name}: ${link}`);
      const href = link.match(/\bhref="([^"]+)"/)[1];
      const file = href.startsWith('/') ? href.slice(1) : path.posix.join(path.posix.dirname(name), href);
      assert.ok(faces.has(file), `${name}: preloads ${href}, which no stylesheet's @font-face names`);
      preloads++;
    }
  }
  assert.ok(preloads > 0);
});
