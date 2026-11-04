'use strict';

// The status page (site/assets/status.js) judges the services in the visitor's browser. These tests
// hold that judgement to the limits scripts/check-live.mjs applies on a schedule, and to what a page
// must say when an endpoint is unwell: a 503 from an operator is a service down, while no answer at
// all may be the visitor's connection.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const status = require('../site/assets/status.js');

const { assessOracle, assessIndex, assessDivergence, assessChain, overall } = status;
const HOUR = 3600 * 1000;
const NOW = 1_800_000_000_000;
const answered = (body, httpStatus = 200) => ({ status: 'fulfilled', value: { httpStatus, body } });
const noAnswer = (message) => ({ status: 'rejected', reason: new Error(message) });
const health = (over = {}) => ({
  ok: true,
  epochMs: HOUR,
  uptimeSeconds: 7200,
  lastSuccessfulEpochMs: NOW - 20 * 60 * 1000,
  timeSinceLastEpochMs: 20 * 60 * 1000,
  storeWritable: true,
  statePersisted: true,
  epochRunning: false,
  commit: 'a'.repeat(40),
  ...over,
});

test('an operator that ran within two epochs is running', () => {
  const { state, text } = assessOracle(answered(health()));
  assert.equal(state, 'ok');
  assert.match(text, /finished 20 minutes ago/);
  assert.match(text, /one every 60 minutes/);
  assert.match(text, /aaaaaaa/);
});

test('an operator is late after two epochs, and down after three as check-live says', () => {
  const after = (hours) => assessOracle(answered(health({ timeSinceLastEpochMs: hours * HOUR }))).state;
  assert.equal(after(2), 'ok');
  assert.equal(after(2.5), 'attention');
  assert.equal(after(3), 'attention');
  assert.equal(after(3.1), 'down');
});

test('the limits follow the epoch length the operator reports', () => {
  const quick = { epochMs: HOUR / 2, timeSinceLastEpochMs: 1.2 * HOUR };
  assert.equal(assessOracle(answered(health(quick))).state, 'attention');
});

test('an operator that just started and has not finished an epoch is not called late', () => {
  const started = health({ lastSuccessfulEpochMs: 0, timeSinceLastEpochMs: null, uptimeSeconds: 600 });
  const { state, text } = assessOracle(answered(started));
  assert.equal(state, 'ok');
  assert.match(text, /No epoch has finished since it started 10 minutes ago/);
});

test('a 503 from an operator is down, and still says when it last ran', () => {
  const { state, text } = assessOracle(answered(health({ ok: false, timeSinceLastEpochMs: 8 * HOUR }), 503));
  assert.equal(state, 'down');
  assert.match(text, /HTTP 503/);
  assert.match(text, /finished 8 hours ago/);
});

test('an error status is down, even from a body that says ok', () => {
  assert.equal(assessOracle(answered(health(), 500)).state, 'down');
  assert.equal(assessIndex(answered({ ok: true, toBlock: 100 }, 500), { status: 'fulfilled', value: 100 }).state, 'down');
});

test('an operator whose state is not being saved is down, even if it says ok', () => {
  for (const over of [{ storeWritable: false }, { statePersisted: false }]) {
    const { state, text } = assessOracle(answered(health(over)));
    assert.equal(state, 'down');
    assert.match(text, /not being saved/);
  }
});

test('an answer that is not the expected shape is not taken for healthy', () => {
  for (const body of [null, 'nonsense', {}, { ok: 'true' }]) {
    assert.equal(assessOracle(answered(body)).state, 'down');
    assert.equal(assessIndex(answered(body), { status: 'fulfilled', value: 100 }).state, 'down');
  }
});

test('no answer is its own state, because it can be the visitor rather than the service', () => {
  for (const read of [assessOracle(noAnswer('Failed to fetch')), assessIndex(noAnswer('Failed to fetch'), noAnswer('x')), assessDivergence(noAnswer('Failed to fetch')), assessChain(noAnswer('Failed to fetch'))]) {
    assert.equal(read.state, 'unreachable');
    assert.match(read.text, /Failed to fetch/);
  }
});

test('a time-out reads as a time-out', () => {
  const aborted = Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
  assert.match(assessOracle({ status: 'rejected', reason: aborted }).text, /timed out/);
});

test('the index lag comes from the chain as this browser read it', () => {
  const index = (over) => answered({ ok: true, toBlock: 1000, behind: 20, ...over });
  const head = (value) => ({ status: 'fulfilled', value });
  assert.match(assessIndex(index(), head(1020)).text, /^20 blocks behind the chain, about 10 seconds/);
  assert.match(assessIndex(index(), head(1000)).text, /^0 blocks behind/);
  assert.match(assessIndex(index(), head(1001)).text, /^1 block behind/);
  assert.match(assessIndex(index(), head(990)).text, /^0 blocks behind/);
  assert.equal(assessIndex(index(), head(1600)).state, 'ok');
  // An index saying all is well while the chain has moved on does not get the last word.
  assert.equal(assessIndex(index(), head(1601)).state, 'attention');
});

test('the index falls back on its own figure when the chain did not answer', () => {
  const index = answered({ ok: true, toBlock: 1000, behind: 700 });
  const { state, text } = assessIndex(index, noAnswer('rate limit exceeded'));
  assert.equal(state, 'attention');
  assert.match(text, /^700 blocks behind/);
  const silent = assessIndex(answered({ ok: true }), noAnswer('rate limit exceeded'));
  assert.equal(silent.state, 'attention');
  assert.match(silent.text, /does not say/);
});

test('an index that fails its own health check is down, and gives its error escaped', () => {
  const { state, text } = assessIndex(answered({ ok: false, toBlock: 5, lastError: '<img src=x>' }, 503), { status: 'fulfilled', value: 10 });
  assert.equal(state, 'down');
  assert.match(text, /&lt;img src=x&gt;/);
  assert.doesNotMatch(text, /<img/);
});

const divergence = (over = {}) => ({ mode: 'checker', seesProposals: true, challengeWindowHours: 6, total: 0, truncated: false, divergences: [], ...over });
const record = (hoursAgo) => ({ at: NOW - hoursAgo * HOUR, proposedAt: Math.floor((NOW - hoursAgo * HOUR) / 1000) });

test('no disagreements is fine, and does not claim the operators agreed', () => {
  const { state, text } = assessDivergence(answered(divergence()), NOW);
  assert.equal(state, 'ok');
  assert.match(text, /not a confirmation/);
});

test('a settled disagreement stays counted and needs no attention, as check-live decided', () => {
  const { state, label, text } = assessDivergence(answered(divergence({ total: 2, divergences: [record(300), record(100)] })), NOW);
  assert.equal(state, 'ok');
  assert.equal(label, 'none open');
  assert.match(text, /^2 disagreements on record/);
  assert.match(text, /none can still be rejected/);
});

test('a disagreement inside the challenge window needs attention', () => {
  const { state, text } = assessDivergence(answered(divergence({ total: 2, divergences: [record(300), record(5)] })), NOW);
  assert.equal(state, 'attention');
  assert.match(text, /1 can still be rejected/);
  assert.equal(assessDivergence(answered(divergence({ total: 1, divergences: [record(7)] })), NOW).state, 'ok');
});

test('a record with no readable proposal time, or no window, counts as open', () => {
  const bare = { at: NOW - 300 * HOUR };
  assert.equal(assessDivergence(answered(divergence({ total: 1, divergences: [bare] })), NOW).state, 'attention');
  assert.equal(assessDivergence(answered(divergence({ total: 1, challengeWindowHours: null, divergences: [record(300)] })), NOW).state, 'attention');
});

test('a checker that cannot see proposals, or is not a checker, needs attention', () => {
  assert.equal(assessDivergence(answered(divergence({ seesProposals: false })), NOW).state, 'attention');
  const wrong = assessDivergence(answered(divergence({ mode: '<b>primary</b>' })), NOW);
  assert.equal(wrong.state, 'attention');
  assert.doesNotMatch(wrong.text, /<b>/);
});

test('a truncated list says at least', () => {
  assert.match(assessDivergence(answered(divergence({ total: 500, truncated: true, divergences: [record(300)] })), NOW).text, /^At least 500/);
});

test('an error from the divergence endpoint is down', () => {
  assert.equal(assessDivergence(answered(null, 500), NOW).state, 'down');
});

test('the top line takes the worst row', () => {
  const rows = (...states) => states.map((state) => ({ state }));
  assert.equal(overall(rows('ok', 'ok')), 'ok');
  assert.equal(overall(rows('ok', 'attention', 'ok')), 'attention');
  assert.equal(overall(rows('attention', 'unreachable')), 'unreachable');
  assert.equal(overall(rows('down', 'unreachable', 'ok')), 'down');
});
