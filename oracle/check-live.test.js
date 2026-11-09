'use strict';

// What scripts/check-live.mjs makes of an oracle's /health and of the event index's pages.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const checkLive = () => import('../scripts/check-live.mjs');
const HOUR = 3_600_000;

test('the live check reads a missing last epoch as none yet, not as one just now', async () => {
  const { epochProblem } = await checkLive();
  // Up four hours and no epoch has completed: the oracle answers null, which Number() makes 0.
  assert.match(epochProblem({ timeSinceLastEpochMs: null, uptimeSeconds: 4 * 3600 }) ?? '', /no epoch has completed in the 240 minutes since it started/);
  // Just restarted: its first epoch is not due yet.
  assert.equal(epochProblem({ timeSinceLastEpochMs: null, uptimeSeconds: 600 }), null);
  assert.equal(epochProblem({ timeSinceLastEpochMs: HOUR, uptimeSeconds: 9 * 3600 }), null);
  assert.match(epochProblem({ timeSinceLastEpochMs: 4 * HOUR, uptimeSeconds: 9 * 3600 }) ?? '', /no completed epoch for 240 minutes/);
});

test('the live check reads every page of slash filings the event index holds', async () => {
  const { indexLogs } = await checkLive();
  const log = (n) => ({ topics: ['0xtopic', `0x${String(n).padStart(64, '0')}`] });
  const pages = { '': { logs: [log(1), log(2)], next: '100:0' }, '100:0': { logs: [log(3)], next: '200:4' }, '200:4': { logs: [log(4)], next: null } };
  const asked = [];
  const logs = await indexLogs('address=0xstaking&topic0=0xtopic', async (url) => {
    asked.push(url);
    return pages[new URL(url).searchParams.get('after') ?? ''];
  });
  assert.equal(logs.length, 4, `read ${logs.length} of 4 logs`);
  assert.equal(asked.length, 3);
  await assert.rejects(indexLogs('q', async () => ({ logs: [], next: 'same' })), /same page twice/);
});
