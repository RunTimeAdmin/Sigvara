'use strict';

// The slash keeper (keeper.js). What matters most here is what it refuses to do: executing the
// wrong slash burns a bond and cannot be undone, so each refusal has a test of its own.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { decide, createKeeper, localSender, readConfig, revertName, STAKING_ABI } = require('./keeper');

const DAY = 86_400;
const NOW = 1_800_000_000;
const A = `0x${'aa'.repeat(32)}`;
const B = `0x${'bb'.repeat(32)}`;
const DRILL_C = '0x30b95fc4473e5ea0f187d4955ab24bcfebd7a739a0a93c1beafd5d6445f1d93a';
const [NONE, PENDING, EXECUTED, CANCELLED, DISPUTED] = [0, 1, 2, 3, 4];
const pending = (daysPastDeadline) => ({ state: PENDING, challengeDeadline: NOW - daysPastDeadline * DAY });
const policy = (over = {}) => ({ executionPeriod: 14 * DAY, disputePeriod: 14 * DAY, graceSeconds: 0, skip: new Set(), ...over });

// ---- decide ----

test('inside the challenge window it waits, to the second', () => {
  assert.deepEqual(decide(A, { state: PENDING, challengeDeadline: NOW + 1 }, NOW, policy()), { action: 'wait', until: NOW + 1 });
  // The contract reverts at block.timestamp <= deadline, so the deadline itself is still too early.
  assert.equal(decide(A, { state: PENDING, challengeDeadline: NOW }, NOW, policy()).action, 'wait');
  assert.equal(decide(A, { state: PENDING, challengeDeadline: NOW - 1 }, NOW, policy()).action, 'execute');
});

test('only a Pending proposal is ever executed', () => {
  for (const state of [NONE, EXECUTED, CANCELLED]) {
    assert.equal(decide(A, { state, challengeDeadline: NOW - DAY }, NOW, policy()).action, 'forget');
  }
  assert.equal(decide(A, { state: DISPUTED, challengeDeadline: NOW - DAY, disputedAt: NOW - DAY }, NOW, policy()).action, 'disputed');
});

test('past the lapse it does not execute, though the contract would still allow it', () => {
  const at = NOW - 14 * DAY;
  assert.equal(decide(A, { state: PENDING, challengeDeadline: at }, NOW, policy()).action, 'execute', 'the last second');
  assert.equal(decide(A, { state: PENDING, challengeDeadline: at - 1 }, NOW, policy()).action, 'lapsed', 'one second over');
});

test('an agent on the skip list is left alone, and past the lapse is reported as lapsed', () => {
  const skip = new Set([DRILL_C]);
  assert.equal(decide(DRILL_C, pending(3), NOW, policy({ skip })).action, 'held');
  assert.equal(decide(A, pending(3), NOW, policy({ skip })).action, 'execute');
  assert.equal(decide(DRILL_C, pending(15), NOW, policy({ skip })).action, 'lapsed');
});

test('a backup waits out its grace, then acts', () => {
  const cfg = policy({ graceSeconds: 3600 });
  assert.deepEqual(decide(A, { state: PENDING, challengeDeadline: NOW - 3600 }, NOW, cfg), { action: 'wait', until: NOW });
  assert.equal(decide(A, { state: PENDING, challengeDeadline: NOW - 3601 }, NOW, cfg).action, 'execute');
});

test('a dispute waits for a ruling, and is reported as unruled once its fortnight is over', () => {
  const at = (disputedAt) => decide(A, { state: DISPUTED, challengeDeadline: NOW, disputedAt }, NOW, policy());
  assert.deepEqual(at(NOW - 14 * DAY), { action: 'disputed', expiresAt: NOW });
  assert.equal(at(NOW - 14 * DAY - 1).action, 'dispute-unruled');
});

test('grace never carries it past the lapse', () => {
  assert.equal(decide(A, pending(15), NOW, policy({ graceSeconds: 2 * DAY })).action, 'lapsed');
});

// ---- the cycle ----

function harness({ mode = 'live', proposals = {}, events = [], simulate = () => null, send, over = {}, balance = 10n ** 18n, pendingTxs = 0, initial = null } = {}) {
  let saved = initial;
  let head = 1000;
  let now = NOW;
  const alerts = [];
  const sent = [];
  const scanned = [];
  const reads = {
    head: async () => head,
    blockTime: async () => now,
    slashInitiated: async (from, to) => {
      scanned.push([from, to]);
      return events.filter((e) => e.block >= from && e.block <= to).map((e) => e.didHash);
    },
    proposal: async (d) => proposals[d] ?? { state: NONE, challengeDeadline: 0 },
    simulate: async (d) => simulate(d),
    balance: async () => balance,
    pendingTxs: async () => pendingTxs,
  };
  const sender = { send: send ?? (async (d) => { sent.push(d); return `0xtx${sent.length}`; }) };
  const keeper = createKeeper({
    cfg: { mode, name: 'test', fromBlock: 100, chunkSize: 400, minBalance: 2n * 10n ** 17n, ...policy(), ...over },
    reads,
    sender,
    state: { get: () => saved && JSON.parse(JSON.stringify(saved)), set: (s) => { saved = JSON.parse(JSON.stringify(s)); }, persist: () => {} },
    notify: async (level, title, lines) => { alerts.push({ level, title, lines }); },
  });
  return {
    keeper, alerts, sent, scanned, state: () => saved,
    setHead: (n) => { head = n; }, setNow: (t) => { now = t; }, setPending: (n) => { pendingTxs = n; },
  };
}

test('it finds a filed slash from its event and executes it when it is due', async () => {
  const h = harness({ events: [{ block: 500, didHash: A }], proposals: { [A]: pending(1) } });
  const r = await h.keeper.runOnce();
  assert.deepEqual(h.sent, [A]);
  assert.deepEqual(r.executed, [{ didHash: A, hash: '0xtx1' }]);
  assert.equal(h.alerts[0].level, 'ok');
  assert.equal(h.state().executed[A], '0xtx1');
});

test('the scan stays behind the head, in chunks, and resumes where it stopped', async () => {
  const h = harness({ over: { chunkSize: 400 } });
  await h.keeper.runOnce();
  assert.deepEqual(h.scanned, [[100, 499], [500, 899], [900, 980]]);
  assert.equal(h.state().scanBlock, 981);
  h.scanned.length = 0;
  await h.keeper.runOnce();
  assert.deepEqual(h.scanned, [], 'nothing new below the margin');
});

test('a slash filed again after being dropped is watched again', async () => {
  const proposals = { [A]: { state: CANCELLED, challengeDeadline: 0 } };
  const events = [{ block: 500, didHash: A }];
  const h = harness({ proposals, events });
  await h.keeper.runOnce();
  assert.equal(h.state().open[A], undefined, 'forgotten once it is not open');
  events.push({ block: 1050, didHash: A });
  proposals[A] = pending(1);
  h.setHead(1100);
  await h.keeper.runOnce();
  assert.deepEqual(h.sent, [A]);
});

test('history read on a first run raises no alerts', async () => {
  const h = harness({
    events: [{ block: 500, didHash: A }, { block: 501, didHash: B }],
    proposals: { [A]: { state: CANCELLED, challengeDeadline: 0 }, [B]: { state: EXECUTED, challengeDeadline: 0 } },
  });
  await h.keeper.runOnce();
  assert.deepEqual(h.alerts, []);
});

test('a slash it was watching that someone else ended is reported once', async () => {
  for (const [state, words] of [[EXECUTED, /has been executed/], [CANCELLED, /was dropped/]]) {
    const proposals = { [A]: { state: PENDING, challengeDeadline: NOW + DAY } };
    const h = harness({ proposals, events: [{ block: 500, didHash: A }] });
    await h.keeper.runOnce();
    assert.deepEqual(h.alerts, [], 'waiting is not news');
    proposals[A] = { state, challengeDeadline: NOW + DAY };
    await h.keeper.runOnce();
    assert.match(h.alerts[0].title, words);
    assert.equal(h.state().open[A], undefined);
    await h.keeper.runOnce();
    assert.equal(h.alerts.length, 1);
  }
});

test('its own execution is reported when sent, and not again when it is forgotten', async () => {
  const proposals = { [A]: pending(1) };
  const h = harness({ proposals, events: [{ block: 500, didHash: A }] });
  await h.keeper.runOnce();
  assert.equal(h.alerts.length, 1);
  proposals[A] = { state: EXECUTED, challengeDeadline: 0 };
  await h.keeper.runOnce();
  assert.equal(h.alerts.length, 1);
  assert.deepEqual(h.state().executed, {});
});

test('a dispute is reported once while it waits, and daily once nobody ruled', async () => {
  const proposals = { [A]: { state: DISPUTED, challengeDeadline: NOW, disputedAt: NOW - DAY } };
  const h = harness({ proposals, events: [{ block: 500, didHash: A }] });
  const r = await h.keeper.runOnce();
  assert.equal(r.disputed.length, 1);
  assert.deepEqual(h.sent, []);
  assert.match(h.alerts[0].title, /needs a ruling/);
  await h.keeper.runOnce();
  assert.equal(h.alerts.length, 1, 'not every run');
  const old = { ...h.state(), alerted: { ...h.state().alerted, [`disputed:${A}`]: NOW - 5 * DAY } };
  const later = harness({ proposals, initial: old });
  await later.keeper.runOnce();
  assert.deepEqual(later.alerts, [], 'and not again a day later while the admin still has time');
  const unruled = harness({ proposals: { [A]: { state: DISPUTED, challengeDeadline: NOW, disputedAt: NOW - 15 * DAY } }, initial: old });
  await unruled.keeper.runOnce();
  assert.match(unruled.alerts[0].title, /never ruled on/);
  assert.deepEqual(unruled.sent, []);
});

test('the drill agent on the skip list is never simulated or sent, in live mode', async () => {
  let simulated = 0;
  const h = harness({
    events: [{ block: 500, didHash: DRILL_C }],
    proposals: { [DRILL_C]: pending(3) },
    simulate: () => { simulated += 1; return null; },
    over: { skip: new Set([DRILL_C]) },
  });
  const r = await h.keeper.runOnce();
  assert.deepEqual(h.sent, []);
  assert.equal(simulated, 0);
  assert.equal(r.held[0].didHash, DRILL_C);
  assert.deepEqual(h.alerts, []);
});

test('shadow mode sends nothing and never touches the sender', async () => {
  const h = harness({
    mode: 'shadow',
    events: [{ block: 500, didHash: A }],
    proposals: { [A]: pending(1) },
    send: async () => assert.fail('shadow mode must not send'),
  });
  const r = await h.keeper.runOnce();
  assert.deepEqual(r.wouldExecute, [{ didHash: A }]);
  assert.deepEqual(r.executed, []);
});

test('a simulated revert stops the send, and says why', async () => {
  const h = harness({
    events: [{ block: 500, didHash: A }],
    proposals: { [A]: pending(1) },
    simulate: () => 'ReporterNotAuthorized',
  });
  const r = await h.keeper.runOnce();
  assert.deepEqual(h.sent, []);
  assert.deepEqual(r.refused, [{ didHash: A, reason: 'ReporterNotAuthorized' }]);
  assert.match(h.alerts[0].lines.join(' '), /left the committee/);
});

test('losing the race to the other keeper is not a problem', async () => {
  const h = harness({
    events: [{ block: 500, didHash: A }],
    proposals: { [A]: pending(1) },
    simulate: () => 'NoActivePendingSlash',
  });
  const r = await h.keeper.runOnce();
  assert.deepEqual(h.sent, []);
  assert.deepEqual(r.refused, []);
  assert.deepEqual(h.alerts, []);
});

test('a lapsed slash raises one alert, and raises it again a day later', async () => {
  const initial = { scanBlock: 981, open: { [A]: true }, alerted: {}, executed: {} };
  const h = harness({ proposals: { [A]: pending(15) }, initial });
  const r = await h.keeper.runOnce();
  assert.deepEqual(h.sent, []);
  assert.equal(r.lapsed[0].didHash, A);
  await h.keeper.runOnce();
  assert.equal(h.alerts.length, 1, 'not every run');
  const yesterday = { ...h.state(), alerted: { [`lapsed:${A}`]: NOW - DAY } };
  const again = harness({ proposals: { [A]: pending(15) }, initial: yesterday });
  await again.keeper.runOnce();
  assert.equal(again.alerts.length, 1);
});

test('a transaction still pending blocks another', async () => {
  const h = harness({ events: [{ block: 500, didHash: A }], proposals: { [A]: pending(1) }, pendingTxs: 1 });
  const r = await h.keeper.runOnce();
  assert.deepEqual(h.sent, []);
  assert.equal(r.blocked[0].didHash, A);
});

// The admin rules for the agent, the slash is dropped, and the committee files it again with new
// evidence. A second dispute of that filing needs a ruling as much as the first did, and its alert
// used to be held back by the first one's, so the admin heard nothing until the ruling window closed.
test('a slash disputed, dropped, filed again and disputed again needs a ruling twice', async () => {
  const proposals = { [A]: { state: DISPUTED, challengeDeadline: NOW, disputedAt: NOW - DAY } };
  const events = [{ block: 500, didHash: A }];
  const h = harness({ proposals, events });
  await h.keeper.runOnce();
  proposals[A] = { state: CANCELLED, challengeDeadline: 0 }; // ruled for the agent
  await h.keeper.runOnce();
  assert.match(h.alerts.at(-1).title, /was dropped/);
  events.push({ block: 1050, didHash: A });
  proposals[A] = { state: DISPUTED, challengeDeadline: NOW + 3 * DAY, disputedAt: NOW - 60 };
  h.setHead(1100);
  await h.keeper.runOnce();
  const rulings = h.alerts.filter((a) => /needs a ruling/.test(a.title));
  assert.equal(rulings.length, 2, 'the second dispute is raised too');
});

test('a keeper stuck behind its own transaction says so once, after half an hour, and again on a new spell', async () => {
  const h = harness({ events: [{ block: 500, didHash: A }], proposals: { [A]: pending(1) }, pendingTxs: 1 });
  const stuck = () => h.alerts.filter((a) => /stuck behind a transaction/.test(a.title));
  await h.keeper.runOnce();
  h.setNow(NOW + 29 * 60);
  await h.keeper.runOnce();
  assert.equal(stuck().length, 0, 'a pending transaction is routine for a while');
  h.setNow(NOW + 30 * 60);
  await h.keeper.runOnce();
  h.setNow(NOW + 35 * 60);
  await h.keeper.runOnce();
  assert.equal(stuck().length, 1, 'once, not every run');
  h.setPending(0);
  h.setNow(NOW + 40 * 60);
  await h.keeper.runOnce(); // unblocked: it sends
  assert.equal(h.state().blockedSince, undefined);
  h.setPending(1);
  for (const t of [41, 70]) { h.setNow(NOW + t * 60); await h.keeper.runOnce(); }
  assert.equal(stuck().length, 1, 'a new spell starts its own half hour');
  h.setNow(NOW + 71 * 60);
  await h.keeper.runOnce();
  assert.equal(stuck().length, 2);
});

test('an execution is saved when it confirms, so a run that fails after it does not lose it', async () => {
  let saved = null;
  const keeper = createKeeper({
    cfg: { mode: 'live', name: 'test', fromBlock: 100, chunkSize: 1000, minBalance: 0n, ...policy() },
    reads: {
      head: async () => 1000,
      blockTime: async () => NOW,
      slashInitiated: async () => [A],
      proposal: async () => pending(1),
      simulate: async () => null,
      pendingTxs: async () => 0,
      balance: async () => { throw new Error('rate limit exceeded'); },
    },
    sender: { send: async () => '0xtx1' },
    state: { get: () => saved, set: (s) => { saved = JSON.parse(JSON.stringify(s)); }, persist: () => {} },
  });
  await assert.rejects(keeper.runOnce(), /rate limit exceeded/);
  assert.equal(saved.executed[A], '0xtx1');
});

test('a failed send is reported, stays open and is tried again', async () => {
  const h = harness({
    events: [{ block: 500, didHash: A }],
    proposals: { [A]: pending(1) },
    send: async () => { throw new Error('fee 900 gwei is above KEEPER_MAX_FEE_GWEI 100'); },
  });
  const r = await h.keeper.runOnce();
  assert.equal(r.failed.length, 1);
  assert.equal(h.alerts[0].level, 'alert');
  assert.equal(h.state().open[A], true);
});

test('one proposal failing to send does not stop the next', async () => {
  const sent = [];
  const h = harness({
    events: [{ block: 500, didHash: A }, { block: 501, didHash: B }],
    proposals: { [A]: pending(1), [B]: pending(1) },
    send: async (d) => { if (d === A) throw new Error('no'); sent.push(d); return '0xtx'; },
  });
  await h.keeper.runOnce();
  assert.deepEqual(sent, [B]);
});

test('low gas raises an alert in live mode only', async () => {
  const low = harness({ balance: 10n ** 17n });
  await low.keeper.runOnce();
  assert.match(low.alerts[0].title, /low on gas/);
  const shadow = harness({ mode: 'shadow', balance: 0n });
  await shadow.keeper.runOnce();
  assert.deepEqual(shadow.alerts, []);
});

test('one failed run is routine, and the sixth in a row is reported once', async () => {
  const h = harness();
  const err = new Error('rate limit exceeded');
  for (let i = 1; i <= 5; i++) assert.equal(await h.keeper.runFailed(err), i);
  assert.deepEqual(h.alerts, []);
  await h.keeper.runFailed(err);
  assert.equal(h.alerts.length, 1);
  await h.keeper.runFailed(err);
  assert.equal(h.alerts.length, 1, 'not again on the seventh');
  await h.keeper.runOnce();
  assert.equal(h.alerts.length, 2, 'the good run says it is running again');
  await h.keeper.runFailed(err);
  assert.equal(h.alerts.length, 2, 'a good run starts the count over');
});

test('a good run after the failure alert says the keeper is running again, once', async () => {
  const h = harness();
  const err = new Error('rate limit exceeded');
  for (let i = 1; i <= 6; i++) await h.keeper.runFailed(err);
  await h.keeper.runOnce();
  await h.keeper.runOnce();
  assert.deepEqual(h.alerts.map((a) => a.level), ['alert', 'ok']);
  assert.match(h.alerts[1].title, /running again/);
});

// The container's healthcheck (docker-compose.keeper.vps.yml), run against state files. The scan rewrites
// the file early in every run, so its age said nothing about a run finishing: a keeper whose every run
// failed after the scan stayed healthy.
test('the keeper healthcheck reads when a run last finished, not when the file was last written', () => {
  const compose = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.keeper.vps.yml'), 'utf8');
  const script = JSON.parse(`"${compose.match(/\["CMD", "node", "-e", "(.+)"\]/)[1]}"`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigvara-keeper-health-'));
  try {
    const file = path.join(dir, 'keeper-state.json');
    const healthy = (state) => {
      fs.writeFileSync(file, JSON.stringify(state));
      const run = spawnSync(process.execPath, ['-e', script.replaceAll('/data/keeper-state.json', file.replaceAll('\\', '/'))]);
      return run.status === 0;
    };
    assert.equal(healthy({ scanBlock: 5, lastRunWallMs: Date.now() - 60_000 }), true, 'a run finished a minute ago');
    assert.equal(healthy({ scanBlock: 5, lastRunWallMs: Date.now() - 2 * 3600_000 }), false, 'the file is new, the last finished run is not');
    assert.equal(healthy({ scanBlock: 5 }), true, 'a state file from before the field: the file\'s own age, until a run writes it');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('only a run that finishes stamps the time the healthcheck reads', async () => {
  let saved = null;
  let failing = true;
  const keeper = createKeeper({
    cfg: { mode: 'shadow', name: 'test', fromBlock: 100, chunkSize: 400, minBalance: 0n, ...policy() },
    reads: {
      head: async () => 1000,
      blockTime: async () => NOW,
      slashInitiated: async () => [A],
      proposal: async () => { if (failing) throw new Error('rate limit exceeded'); return pending(1); },
      simulate: async () => null,
    },
    state: { get: () => saved, set: (s) => { saved = JSON.parse(JSON.stringify(s)); }, persist: () => {} },
  });
  await assert.rejects(keeper.runOnce());
  assert.equal(saved.scanBlock, 981, 'the scan saved its progress');
  assert.equal(saved.lastRunWallMs, undefined);
  failing = false;
  const before = Date.now();
  await keeper.runOnce();
  assert.ok(saved.lastRunWallMs >= before && saved.lastRunWallMs <= Date.now());
});

test('progress survives a read failing part way through', async () => {
  let calls = 0;
  let saved = null;
  const keeper = createKeeper({
    cfg: { mode: 'shadow', name: 'test', fromBlock: 100, chunkSize: 400, minBalance: 0n, ...policy() },
    reads: {
      head: async () => 1000,
      blockTime: async () => NOW,
      slashInitiated: async () => { calls += 1; if (calls === 2) throw new Error('rate limit exceeded'); return []; },
      proposal: async () => pending(1),
      simulate: async () => null,
    },
    state: { get: () => saved, set: (s) => { saved = JSON.parse(JSON.stringify(s)); }, persist: () => {} },
  });
  await assert.rejects(keeper.runOnce());
  assert.equal(saved.scanBlock, 500, 'the chunk that succeeded is not read again');
});

// ---- settings ----

const env = (over = {}) => ({ RPC_URL: 'https://rpc.example', STAKING_ADDRESS: '0xA69d62B2a6774D21A2c15d5d83b27277eD31d35B', KEEPER_FROM_BLOCK: '70000000', ...over });
const KEY = `0x${'ab'.repeat(32)}`;
const live = (over = {}) => env({ KEEPER_MODE: 'live', KEEPER_SKIP_AGENTS: DRILL_C, KEEPER_PRIVATE_KEY: KEY, KEEPER_MAX_FEE_GWEI: '200', ...over });

test('shadow is the default and needs no key', () => {
  const c = readConfig(env());
  assert.equal(c.mode, 'shadow');
  assert.equal(c.privateKey, '');
  assert.equal(c.graceSeconds, 0);
});

test('live mode refuses to start without the skip list being said out loud', () => {
  assert.throws(() => readConfig(live({ KEEPER_SKIP_AGENTS: '' })), /KEEPER_SKIP_AGENTS is required/);
  assert.equal(readConfig(live({ KEEPER_SKIP_AGENTS: 'none' })).skip.size, 0);
  assert.ok(readConfig(live()).skip.has(DRILL_C));
});

test('the skip list is matched however it is cased, and refuses what is not a didHash', () => {
  assert.ok(readConfig(live({ KEEPER_SKIP_AGENTS: DRILL_C.toUpperCase().replace('0X', '0x') })).skip.has(DRILL_C));
  assert.throws(() => readConfig(live({ KEEPER_SKIP_AGENTS: '0x30b95fc4' })), /not a didHash/);
});

test('live mode needs a key and a fee limit, and an error never repeats the key', () => {
  assert.throws(() => readConfig(live({ KEEPER_PRIVATE_KEY: '' })), /KEEPER_PRIVATE_KEY is required/);
  assert.throws(() => readConfig(live({ KEEPER_MAX_FEE_GWEI: '' })), /KEEPER_MAX_FEE_GWEI is required/);
  const bad = 'not-a-key-but-still-a-secret';
  assert.throws(() => readConfig(live({ KEEPER_PRIVATE_KEY: bad })), (e) => {
    assert.match(e.message, /not 32 bytes/);
    assert.ok(!e.message.includes(bad));
    return true;
  });
});

test('a mode that is neither is refused', () => {
  assert.throws(() => readConfig(env({ KEEPER_MODE: 'yes' })), /shadow or live/);
});

// ---- reading a revert ----

const iface = new ethers.Interface(STAKING_ABI);

test('a revert from the contract is named', () => {
  const data = iface.encodeErrorResult('ReporterNotAuthorized', [A, ethers.ZeroAddress]);
  assert.equal(revertName({ data }, iface), 'ReporterNotAuthorized');
  assert.equal(revertName({ info: { error: { data } } }, iface), 'ReporterNotAuthorized');
});

test('a revert the ABI does not know keeps its selector', () => {
  assert.equal(revertName({ data: '0xdeadbeef' }, iface), '0xdeadbeef');
});

test('a failed read is not mistaken for a refusal', () => {
  const err = new Error('connect ETIMEDOUT');
  assert.throws(() => revertName(err, iface), /ETIMEDOUT/);
});

// ---- what watches the keepers from outside (scripts/check-live.mjs) ----

const checkLive = () => import('../scripts/check-live.mjs');

test('the live check filters on the real event and calls the real function', async () => {
  const { SLASH_INITIATED, GET_SLASH_PROPOSAL } = await checkLive();
  assert.equal(SLASH_INITIATED, iface.getEvent('SlashInitiated').topicHash);
  assert.equal(GET_SLASH_PROPOSAL, iface.getFunction('getSlashProposal').selector);
});

test('the live check reads a proposal as the contract encodes it', async () => {
  const { decodeSlashProposal } = await checkLive();
  const hex = iface.encodeFunctionResult('getSlashProposal', [[A, ethers.ZeroAddress, ethers.ZeroAddress, NOW - DAY, PENDING, '0x1234', NOW + DAY, 0]]);
  assert.deepEqual(decodeSlashProposal(A, hex), { didHash: A, state: PENDING, challengeDeadline: NOW + DAY });
});

test('the live check fails on a slash both keepers should have settled', async () => {
  const { overdueSlashes } = await checkLive();
  const six = 6 * 3600;
  const proposal = (didHash, late, state = PENDING) => ({ didHash, state, challengeDeadline: NOW - late });
  assert.deepEqual(overdueSlashes([proposal(A, six)], NOW), [], 'exactly at the limit');
  assert.deepEqual(overdueSlashes([proposal(A, six + 1)], NOW).map((o) => o.didHash), [A]);
  assert.deepEqual(overdueSlashes([proposal(A, -DAY)], NOW), [], 'still in its window');
  for (const state of [NONE, EXECUTED, CANCELLED, DISPUTED]) {
    assert.deepEqual(overdueSlashes([proposal(A, DAY, state)], NOW), [], `state ${state}`);
  }
});

test('the live check leaves the drill agent the keeper leaves alone, and no other', async () => {
  const { overdueSlashes } = await checkLive();
  const late = (didHash) => ({ didHash, state: PENDING, challengeDeadline: NOW - 3 * DAY });
  assert.deepEqual(overdueSlashes([late(DRILL_C)], NOW), []);
  assert.deepEqual(overdueSlashes([late(A), late(DRILL_C)], NOW).map((o) => o.didHash), [A]);
});

// ---- the sender ----

function senderHarness({ receipts = [], fee = { maxFeePerGas: 10n * 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n }, gas = 100_000n, waitMs = 30_000 } = {}) {
  const sent = [];
  const provider = {
    getFeeData: async () => fee,
    getTransactionReceipt: async () => {
      const next = receipts.length > 1 ? receipts.shift() : receipts[0];
      if (next instanceof Error) throw next;
      return next ?? null;
    },
  };
  const staking = {
    executeSlash: { estimateGas: async () => gas },
    connect: () => ({ executeSlash: async (didHash, opts) => { sent.push({ didHash, opts }); return { hash: '0xhash' }; } }),
  };
  const sender = localSender({ wallet: { provider }, staking, maxFeeWei: 100n * 10n ** 9n, maxGas: 1_000_000n, waitMs, pollMs: 1 });
  return { sender, sent };
}

test('a receipt is enough: it does not wait for another block', async () => {
  const h = senderHarness({ receipts: [{ status: 1 }] });
  assert.equal(await h.sender.send(A), '0xhash');
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].opts.gasLimit, 120_000n, 'the estimate with a margin');
});

test('a receipt that is slow, or a read of it that fails, is waited for', async () => {
  const h = senderHarness({ receipts: [null, new Error('rate limit exceeded'), null, { status: 1 }] });
  assert.equal(await h.sender.send(A), '0xhash');
});

test('a transaction that reverted is a failure, and names itself', async () => {
  await assert.rejects(senderHarness({ receipts: [{ status: 0 }] }).sender.send(A), /0xhash reverted/);
});

test('no receipt in time says it was sent, not that it failed', async () => {
  await assert.rejects(senderHarness({ receipts: [null], waitMs: 20 }).sender.send(A), /0xhash was sent, with no receipt.*Check it before assuming it failed/);
});

test('a fee or gas above its limit sends nothing', async () => {
  const dear = senderHarness({ fee: { maxFeePerGas: 200n * 10n ** 9n } });
  await assert.rejects(dear.sender.send(A), /above KEEPER_MAX_FEE_GWEI/);
  assert.equal(dear.sent.length, 0);
  const heavy = senderHarness({ gas: 900_000n });
  await assert.rejects(heavy.sender.send(A), /above KEEPER_MAX_GAS/);
  assert.equal(heavy.sent.length, 0);
});

test('a chain with no priority fee still sends', async () => {
  const h = senderHarness({ fee: { gasPrice: 5n * 10n ** 9n }, receipts: [{ status: 1 }] });
  await h.sender.send(A);
  assert.equal(h.sent[0].opts.maxFeePerGas, 5n * 10n ** 9n);
  assert.equal(h.sent[0].opts.maxPriorityFeePerGas, 5n * 10n ** 9n);
});

// ---- what it says about a failure leaves this machine -------------------------------------------

const RPC_KEY = 'k3yk3yk3yk3yk3yk3yk3yk3y';

// The real process and real ethers, against a fake node and webhook. `answer(call)` says what the node
// does with one call: a result, { error } for a JSON-RPC refusal, or null for an HTTP 500.
async function withKeeperProcess(answer, run) {
  const listen = (handler) => new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => handler(req, res, body));
    }).listen(0, '127.0.0.1', () => resolve(server));
  });
  const alerts = [];
  const webhook = await listen((_req, res, body) => { alerts.push(body); res.writeHead(204); res.end(); });
  const period = ethers.toBeHex(14 * DAY, 32);
  const node = await listen((_req, res, body) => {
    const j = JSON.parse(body);
    const reply = (r) => {
      if (r.method === 'eth_chainId') return { jsonrpc: '2.0', id: r.id, result: '0x1' };
      if (r.method === 'eth_call') return { jsonrpc: '2.0', id: r.id, result: period };
      const a = answer(r);
      if (a === null) return null;
      return a.error ? { jsonrpc: '2.0', id: r.id, error: a.error } : { jsonrpc: '2.0', id: r.id, result: a };
    };
    const replies = (Array.isArray(j) ? j : [j]).map(reply);
    if (replies.includes(null)) { res.writeHead(500); return res.end('oops'); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(Array.isArray(j) ? replies : replies[0]));
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigvara-keeper-'));
  const url = (s) => `http://127.0.0.1:${s.address().port}`;
  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'test-support', 'fast-interval.js'), path.join(__dirname, 'keeper.js')], {
    env: {
      ...process.env,
      RPC_URL: `${url(node)}/v2/${RPC_KEY}`,
      WEBHOOK_URL: `${url(webhook)}/hook`,
      STAKING_ADDRESS: ethers.ZeroAddress.replace(/0$/, '1'),
      KEEPER_FROM_BLOCK: '1',
      LOG_CHUNK_SIZE: '100',
      KEEPER_STATE_PATH: path.join(dir, 'state.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => { output += d; });
  child.stderr.on('data', (d) => { output += d; });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  const until = async (check, ms = 30_000) => {
    const end = Date.now() + ms;
    while (!check()) {
      assert.ok(Date.now() < end, `timed out waiting:\n${output}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  try {
    await run({ alerts, output: () => output, until });
  } finally {
    child.kill();
    await exited;
    await Promise.all([webhook, node].map((s) => new Promise((r) => { s.closeAllConnections(); s.close(r); })));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a node failing keeps the RPC URL and its key out of the alert and the log', async () => {
  await withKeeperProcess(() => null, async ({ alerts, output, until }) => {
    const failed = () => alerts.find((a) => a.includes('failed 6 runs in a row'));
    await until(failed);
    assert.match(failed(), /server response 500/, 'it still says what happened');
    assert.equal(failed().includes('request={'), false, 'and only that');
    for (const words of [failed(), output()]) {
      assert.equal(words.includes(RPC_KEY), false, 'the key');
      assert.equal(words.includes('/v2/'), false, 'the path it sits in');
    }
  });
});

test('a node refusing every read says so in its own words', async () => {
  const refuse = () => ({ error: { code: -32005, message: 'rate limit exceeded' } });
  await withKeeperProcess(refuse, async ({ alerts, until }) => {
    const failed = () => alerts.find((a) => a.includes('failed 6 runs in a row'));
    await until(failed, 60_000);
    assert.match(failed(), /rate limit exceeded/, 'not "could not coalesce error"');
    assert.equal(failed().includes('coalesce'), false);
  });
});

test('a throttled read is tried again, so a run gets through it as Arc\'s public RPCs make it do', async () => {
  let getLogs = 0;
  const answer = (call) => {
    if (call.method === 'eth_blockNumber') return ethers.toBeHex(500);
    if (call.method === 'eth_getBlockByNumber') return { number: ethers.toBeHex(500), timestamp: ethers.toBeHex(NOW), hash: `0x${'ab'.repeat(32)}`, parentHash: `0x${'cd'.repeat(32)}`, transactions: [], gasLimit: '0x1', gasUsed: '0x0', miner: ethers.ZeroAddress, difficulty: '0x0', nonce: '0x0000000000000000', extraData: '0x' };
    if (call.method === 'eth_getLogs') {
      getLogs += 1;
      return getLogs % 3 === 1 ? { error: { code: -32005, message: 'rate limit exceeded' } } : [];
    }
    return null;
  };
  await withKeeperProcess(answer, async ({ output, alerts, until }) => {
    await until(() => /\[keeper\] run at block 500: 0 open/.test(output()));
    assert.equal(/run failed/.test(output()), false, output());
    assert.match(output(), /keeper getLogs failed/, 'it did meet the throttle');
    assert.equal(alerts.length, 0);
  });
});

test('log reads are paced between chunks, not before the first or after the last', async () => {
  const order = [];
  let kept = null;
  const keeper = createKeeper({
    cfg: { mode: 'shadow', fromBlock: 1, chunkSize: 100, graceSeconds: 0, skip: new Set(), executionPeriod: 14 * DAY, disputePeriod: 14 * DAY, minBalance: 0n },
    reads: {
      head: async () => 320,
      blockTime: async () => NOW,
      slashInitiated: async (from) => { order.push(`read ${from}`); return []; },
      proposal: async () => pending(1),
    },
    state: { get: () => kept, set: (s) => { kept = s; }, persist: () => {} },
    pause: async () => { order.push('pause'); },
  });
  await keeper.runOnce();
  assert.deepEqual(order, ['read 1', 'pause', 'read 101', 'pause', 'read 201']);
});

test('an execution that fails keeps a URL out of the alert, and its own words in it', async () => {
  const notes = [];
  let kept = null;
  const reads = {
    head: async () => 100,
    blockTime: async () => NOW,
    slashInitiated: async () => [A],
    proposal: async () => pending(1),
    simulate: async () => null,
    balance: async () => 10n ** 18n,
    pendingTxs: async () => 0,
  };
  const failing = (message) => createKeeper({
    cfg: { mode: 'live', fromBlock: 1, chunkSize: 1000, graceSeconds: 0, skip: new Set(), executionPeriod: 14 * DAY, disputePeriod: 14 * DAY, minBalance: 0n, rpcUrl: 'https://node.example/v2/secretsecret' },
    reads,
    sender: { send: async () => { throw new Error(message); } },
    state: { get: () => kept, set: (s) => { kept = s; }, persist: () => {} },
    notify: async (_level, title, lines) => { notes.push([title, ...lines].join(' ')); },
  });
  const quoted = await failing('server said no (info={ "requestUrl": "https://node.example/v2/secretsecret", "x": 1 })').runOnce();
  assert.equal(quoted.failed[0].reason.includes('secretsecret'), false);
  assert.equal(notes.join(' ').includes('secretsecret'), false);

  kept = null;
  notes.length = 0;
  const ours = 'executeSlash 0xabc was sent, with no receipt after 120 seconds. Check it before assuming it failed';
  assert.equal((await failing(ours).runOnce()).failed[0].reason, ours);
  assert.ok(notes.join(' ').includes(ours), 'a person is still told which transaction to check');
});

test('the live check counts keepers among the wallets, and has no list of its own', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'check-live.mjs'), 'utf8');
  assert.equal(source.includes('deployed.keepers'), false);
  assert.equal(source.match(/async function rpcCall\(/g).length, 1);
});
