'use strict';

// A flag, a resolve and a link are answered on the strength of having been recorded, as /attest is, so while the
// state file cannot be written they say the same thing: 202 with durable: false, not 200. They used to answer 200
// and drop the result of the save, so a caller was told a change counted and a restart before the next good save
// took it back. Run against the real index.js with only the chain stubbed (test-support/).

const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { World, startOracle } = require('./test-support/oracle-harness');

const ADMIN = 'a'.repeat(64);
const DID = `0x${'ab'.repeat(32)}`;
const OTHER = `0x${'cd'.repeat(32)}`;

// A directory where the oracle writes its temporary file: every save fails until it is gone.
const breakSaves = (o) => {
  const blocker = path.join(o.dir, 'state.json.tmp');
  fs.mkdirSync(blocker);
  return () => fs.rmdirSync(blocker);
};

const notDurable = async (o) => Number(
  ((await o.call('GET', '/metrics')).text.match(/^sigvara_oracle_writes_not_durable_total (\d+)/m) || [])[1],
);

test('a flag is not called saved while the state file cannot be written, and is once it can', async () => {
  const o = await startOracle({ world: new World(), env: { ORACLE_ADMIN_TOKEN: ADMIN } });
  try {
    const fix = breakSaves(o);

    const unsaved = await o.call('POST', '/flag', { didHash: DID }, ADMIN);
    assert.equal(unsaved.status, 202, unsaved.text);
    assert.equal(unsaved.body.durable, false);
    assert.equal(unsaved.body.flags, 1, 'what was taken is still reported');
    assert.equal((await o.call('GET', '/health')).status, 503);
    assert.equal(await notDurable(o), 1);

    fix();
    const saved = await o.call('POST', '/flag', { didHash: DID }, ADMIN);
    assert.equal(saved.status, 200, saved.text);
    assert.equal('durable' in saved.body, false, 'a saved flag says nothing extra');
    assert.equal(saved.body.flags, 2);
    assert.equal(JSON.parse(o.files()['state.json']).flags[DID].length, 2, 'the earlier one was saved with it');
    assert.equal((await o.call('GET', '/health')).status, 200);
    assert.equal(await notDurable(o), 1, 'a saved flag adds nothing to the count');
  } finally {
    await o.stop();
  }
});

test('a resolve is not called saved while the state file cannot be written, and one that clears nothing is not a save', async () => {
  const o = await startOracle({ world: new World(), env: { ORACLE_ADMIN_TOKEN: ADMIN } });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await o.call('POST', '/flag', { didHash: DID }, ADMIN)).status, 200);
    const fix = breakSaves(o);

    const unsaved = await o.call('POST', '/flag/resolve', { didHash: DID, count: 2 }, ADMIN);
    assert.equal(unsaved.status, 202, unsaved.text);
    assert.equal(unsaved.body.durable, false);
    assert.deepEqual([unsaved.body.before, unsaved.body.after, unsaved.body.resolved], [3, 1, 2]);
    assert.equal((await o.call('GET', '/health')).status, 503);
    assert.equal(await notDurable(o), 1);

    // Nothing to clear changes nothing, so there is nothing to save and nothing left unsaved.
    const none = await o.call('POST', '/flag/resolve', { didHash: OTHER }, ADMIN);
    assert.equal(none.status, 200, none.text);
    assert.equal(none.body.resolved, 0);
    assert.equal('durable' in none.body, false);
    assert.equal(await notDurable(o), 1, 'a resolve that cleared nothing is not counted');

    fix();
    const saved = await o.call('POST', '/flag/resolve', { didHash: DID }, ADMIN);
    assert.equal(saved.status, 200, saved.text);
    assert.equal('durable' in saved.body, false);
    assert.deepEqual([saved.body.before, saved.body.after, saved.body.resolved], [1, 0, 1], 'the earlier one is counted');
    assert.equal(JSON.parse(o.files()['state.json']).flags[DID], undefined, 'every flag is gone from the saved state');
    assert.equal((await o.call('GET', '/health')).status, 200);
  } finally {
    await o.stop();
  }
});

test('a link is not called saved while the state file cannot be written, and is once it can', async () => {
  const w = new World();
  const agent = w.addAgent();
  w.set('externalOwns', true);
  const o = await startOracle({ world: w, env: { ORACLE_ADMIN_TOKEN: ADMIN } });
  try {
    const fix = breakSaves(o);

    const unsaved = await o.call('POST', '/link', { didHash: agent.didHash, agentId: 7 }, ADMIN);
    assert.equal(unsaved.status, 202, unsaved.text);
    assert.equal(unsaved.body.durable, false);
    assert.equal(unsaved.body.linked, true, 'what was taken is still reported');
    assert.equal(unsaved.body.agentId, '7');
    assert.equal((await o.call('GET', '/health')).status, 503);
    assert.equal(await notDurable(o), 1);

    fix();
    const saved = await o.call('POST', '/link', { didHash: agent.didHash, agentId: 7 }, ADMIN);
    assert.equal(saved.status, 200, saved.text);
    assert.equal('durable' in saved.body, false, 'a saved link says nothing extra');
    assert.equal(JSON.parse(o.files()['state.json']).links[agent.didHash], '7');
    assert.equal((await o.call('GET', '/health')).status, 200);
  } finally {
    await o.stop();
  }
});
