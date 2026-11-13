'use strict';

// The score report on the status page (site/assets/score-report.js): the bands, the spread in bits,
// the day-by-day series and the table of what followed a score. These hold its arithmetic. The page
// itself reads the event index, the chain and the primary oracle, which these do not.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const R = require('../site/assets/score-report.js');
const X = require('../site/assets/explorer.js');

const DAY = 86400;
const T0 = 1_790_000_000 - (1_790_000_000 % DAY); // a UTC midnight
const A = '0x' + 'a'.repeat(64);
const B = '0x' + 'b'.repeat(64);
const word = (n) => BigInt(n).toString(16).padStart(64, '0');
const updated = (did, score, time) => ({ name: 'ReputationUpdated', topics: ['0x' + '1'.repeat(64), did], data: '0x' + word(score) + word(time) + word(0), time });
const zeroed = (did, time) => ({ name: 'ReputationZeroed', topics: ['0x' + '2'.repeat(64), did], data: '0x', time });
const w = (did, score, time) => ({ did, score, time });

test('the band edges are the documented thresholds, and anything that is not a score has no band', () => {
  const at = (s) => R.bandOf(s);
  assert.deepEqual([0, 29, 30, 39, 40, 49, 50, 59, 60, 79, 80, 100].map(at), [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  for (const s of [-1, 101, 1.5, NaN, '40', null]) assert.equal(at(s), -1);
});

test('the spread is 0 bits in one band, log2 of six when even, and SAID\'s 96.9% is about 0.2', () => {
  assert.equal(R.entropyBits([40, 0, 0, 0, 0, 0]), 0);
  assert.ok(Math.abs(R.entropyBits([1, 1, 1, 1, 1, 1]) - Math.log2(6)) < 1e-12);
  assert.equal(R.entropyBits([14382, 458]).toFixed(3), '0.199');
  const s = R.spread([5, 12, 35, 41, 41, 101]);
  assert.deepEqual(s.counts, [2, 1, 2, 0, 0, 0]);
  assert.equal(s.agents, 5, 'a score out of range is not counted');
  assert.equal(s.top, 0);
  assert.equal(s.topShare, 0.4);
});

test('score writes are read from both event forms and a zeroing, and malformed logs are left out', () => {
  const legacy = { ...updated(A, 47, T0 + 1), data: '0x' + word(47) + word(T0) };
  const writes = R.scoreWrites([
    updated(A, 30, T0), legacy, zeroed(B, T0 + 2),
    updated(B, 101, T0 + 3), // not a score
    { ...updated(A, 50, T0 + 4), data: '0x12' }, // too short
    { ...updated(A, 50, T0 + 5), topics: ['0x' + '1'.repeat(64), '0x12'] }, // not a didHash
    { ...updated(A, 50, T0 + 6), time: NaN }, // no time
  ]);
  assert.deepEqual(writes, [w(A, 30, T0), w(A, 47, T0 + 1), w(B, 0, T0 + 2)]);
});

test('a day\'s row counts an agent as moved only when it ends the day in another band', () => {
  const now = T0 + 3 * DAY + 100; // the third whole day ended at T0 + 3 days
  const writes = [
    w(A, 35, T0 - 10), w(B, 70, T0 - 10), // before the first day shown
    w(A, 38, T0 + 100), // same band
    w(A, 45, T0 + DAY + 100), w(A, 31, T0 + DAY + 200), // out and back within one day
    w(B, 20, T0 + 2 * DAY + 100), // moved on the third day
  ];
  const rows = R.dailySeries(writes, now, 3);
  assert.deepEqual(rows.map((r) => r.day), [T0, T0 + DAY, T0 + 2 * DAY]);
  assert.deepEqual(rows.map((r) => [r.moved, r.compared]), [[0, 2], [0, 2], [1, 2]]);
  assert.deepEqual(rows[2].counts, [1, 1, 0, 0, 0, 0]);
});

test('an agent that appears during a day is counted that day but not as moved', () => {
  const rows = R.dailySeries([w(A, 50, T0 + 10)], T0 + DAY + 1, 1);
  assert.equal(rows[0].agents, 1);
  assert.deepEqual([rows[0].moved, rows[0].compared], [0, 0]);
});

test('what followed a score counts each agent once a day, however often its score was written', () => {
  // Regression: counted per write, an agent written every hour would weigh 24 times one written daily.
  const hourly = Array.from({ length: 24 }, (_, h) => w(A, 20, T0 + h * 3600));
  const now = T0 + 40 * DAY;
  const c = R.calibration([...hourly, w(B, 65, T0 + 5)].sort((x, y) => x.time - y.time), [], now, 30);
  assert.equal(c.days, 10, 'day ends T0+1 to T0+10 have a whole 30-day window behind them by T0+40');
  assert.equal(c.rows[0].agentDays, 10);
  assert.equal(c.rows[4].agentDays, 10);
});

test('an outcome counts against a day only inside the window after it, and bad is a slash or a "not delivered"', () => {
  const writes = [w(A, 20, T0 + 10), w(B, 65, T0 + 10)];
  const end = T0 + DAY; // the first day's end
  const outcomes = [
    { did: A, time: end - 1, kind: 'slashed' }, // before the window: not counted for the first day
    { did: A, time: end + 5 * DAY, kind: 'accused' },
    { did: B, time: end + 29 * DAY, kind: 'notDelivered' },
    { did: B, time: end + 2 * DAY, kind: 'withdrew' },
  ];
  const c = R.calibration(writes, outcomes, end + 30 * DAY, 30);
  assert.equal(c.days, 1);
  assert.deepEqual(c.rows[0], { agentDays: 1, bad: 0, accused: 1, withdrew: 0 });
  assert.deepEqual(c.rows[4], { agentDays: 1, bad: 1, accused: 0, withdrew: 1 });
  const later = R.calibration(writes, [{ did: B, time: end + 30 * DAY, kind: 'slashed' }], end + 30 * DAY, 30);
  assert.equal(later.rows[4].bad, 0, 'the window is 30 days, not 30 days and a moment');
});

test('no day is counted until its window has run', () => {
  const c = R.calibration([w(A, 20, T0)], [], T0 + 10 * DAY, 30);
  assert.equal(c.days, 0);
  assert.equal(c.rows[0].agentDays, 0);
});

test('only a payer\'s "not delivered" is a negative, timed when the payer signed it', () => {
  const got = R.payerNegatives([
    { didHash: A.toUpperCase().replace('0X', '0x'), outcome: 2, signedAt: T0 },
    { didHash: A, outcome: 1, signedAt: T0 },
    { didHash: '0x12', outcome: 2, signedAt: T0 },
    { didHash: B, outcome: 2, signedAt: 'soon' },
  ]);
  assert.deepEqual(got, [{ did: A, time: T0, kind: 'notDelivered' }]);
});

test('the demo agent, the drill and the simulation are not counted as outside agents', () => {
  // Regression: the demo agent's operator is neither the deployer nor the drill's, so only its
  // didHash marks it, and the first version of this report counted it as an outside agent.
  const demo = Object.keys(X.KNOWN_AGENTS)[0];
  const agent = (didHash, operator) => ({ didHash, address: '0x' + '3'.repeat(40), operator, status: 0, total: 40 });
  const data = {
    agents: [agent(demo, '0x' + '4'.repeat(40)), agent(A, X.DRILL_OPERATOR), agent(B, '0x' + '5'.repeat(40))],
    reputation: { logs: [] },
    staking: { logs: [{ name: 'SlashInitiated', topics: ['0x' + '6'.repeat(64), A], time: T0 }] },
    payer: { outcomes: [], complete: true },
    simUnknown: false,
  };
  const r = R.build(data, T0 + DAY);
  assert.equal(r.active, 3);
  assert.equal(r.outside, 1);
  assert.deepEqual(r.against, { own: 1, outside: 0 });
  const html = R.render(r);
  assert.match(html, /1 of the 3 Active agents is an outside one/);
  assert.match(html, /The one slash, accusation or "not delivered" report so far was against Sigvara's own/);
});

test('the card says when the payer outcomes could not be read rather than counting none', () => {
  const r = R.build({ agents: [], reputation: { logs: [] }, staking: { logs: [] }, payer: { error: 'HTTP 503' }, simUnknown: false }, T0);
  const html = R.render(r);
  assert.match(html, /could not be read \(HTTP 503\)/);
  assert.match(html, /No Active agent to count/);
});
