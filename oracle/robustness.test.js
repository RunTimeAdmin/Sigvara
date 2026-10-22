'use strict';

// End-to-end tests for what the oracle does when something it depends on is wrong: a state
// file it cannot read, an RPC on the wrong chain, a setting it cannot use, a clock that
// disagrees with the chain's, a proposal the contract would refuse. The real index.js and
// watcher.js run as child processes with the chain stubbed (test-support/).
//
// The unit tests beside the modules say each piece is right. These say the pieces are wired
// to each other: that a refusal in chain.js is a refusal at the point where money would move.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { World, startOracle, runToExit, ASSET } = require('./test-support/oracle-harness');

const ADMIN = 'a'.repeat(64);
const DID = `0x${'ab'.repeat(32)}`;
const BASE_ENV = { ORACLE_ADMIN_TOKEN: ADMIN };
// A primary that commits to its evidence, so the proposals below carry a root.
const PAYMENT_ENV = {
  ...BASE_ENV,
  PAYMENT_VERIFICATION: 'required',
  PAYMENT_ASSET: ASSET,
  PAYMENT_MIN_AMOUNT: '10000',
  PAYMENT_MAX_PER_PAYER: '4',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const names = (calls) => calls.map((c) => c.name);

async function withOracle(opts, fn) {
  const oracle = await startOracle(opts);
  try {
    return await fn(oracle);
  } finally {
    await oracle.stop();
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const counter = (text, name) => {
  const m = text.match(new RegExp(`^${escapeRe(name)} (\\d+)`, 'm'));
  return m ? Number(m[1]) : NaN;
};
const EPOCHS_OK = 'sigvara_oracle_epochs_total{status="succeeded"}';
const EPOCHS_FAILED = 'sigvara_oracle_epochs_total{status="failed"}';

/** Poll until `probe` returns something truthy, or fail with the oracle's own output. */
async function eventually(oracle, probe, what, ms = 15_000) {
  const deadline = Date.now() + ms;
  for (;;) {
    const got = await probe();
    if (got) return got;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}:\n${oracle.logs()}`);
    await sleep(50);
  }
}

/** The /metrics text once `count` epochs have finished, however they ended. */
async function epochsFinished(oracle, count = 1) {
  return eventually(oracle, async () => {
    const text = (await oracle.call('GET', '/metrics')).text;
    const done = (counter(text, EPOCHS_OK) || 0) + (counter(text, EPOCHS_FAILED) || 0);
    return done >= count ? text : null;
  }, `${count} epoch(s) to finish`);
}

/** Start an oracle, let its startup epoch finish, and hand the result to `fn`. */
function inEpoch(opts, fn) {
  return withOracle(opts, async (oracle) => {
    const text = await epochsFinished(oracle);
    return fn({ oracle, text, calls: oracle.calls(), logs: oracle.logs() });
  });
}

// ---- the saved state ---------------------------------------------------------------------

const GOOD_STATE = JSON.stringify({
  schemaVersion: 1,
  chainId: 5042,
  attestations: { [DID]: { successful: 3, total: 4 } },
});
const CUT_OFF = '{"schemaVersion":1,"attestations":{"0xab';

test('a state file that cannot be read stops the oracle, and is left exactly as it was', async () => {
  const { code, log, files } = await runToExit({
    world: new World(), env: BASE_ENV, files: { 'state.json': CUT_OFF },
  });
  assert.equal(code, 1);
  assert.match(log, /^\[oracle\] the state file .* cannot be used/m, 'said as a message, not as a stack trace');
  assert.doesNotMatch(log, /\n\s+at /);
  assert.match(log, /there is no backup from an earlier save/);
  assert.match(log, /move the file aside to start empty on purpose/);
  assert.equal(files['state.json'], CUT_OFF, 'the original is not overwritten with an empty state');
  assert.deepEqual(
    Object.keys(files).filter((n) => n.startsWith('state.json') && n !== 'state.json'),
    [],
    'nothing is written beside it either',
  );
});

test('an unreadable state file is replaced by the previous save, and the oracle says so', async () => {
  await withOracle({
    world: new World(),
    env: BASE_ENV,
    files: { 'state.json': CUT_OFF, 'state.json.bak': GOOD_STATE },
  }, async (oracle) => {
    const health = await oracle.call('GET', '/health');
    assert.equal(health.body.stateSource, 'backup', 'a recovery is visible without reading logs');
    assert.match(oracle.logs(), /RECOVERED: the state file was unusable/);
    assert.match(oracle.logs(), /state\.json\.bak: 1 attestations/);

    const kept = Object.entries(oracle.files()).filter(([n]) => n.startsWith('state.json.corrupt-'));
    assert.equal(kept.length, 1, 'the bad file is kept for inspection');
    assert.equal(kept[0][1], CUT_OFF);
  });
});

test('a state file from a newer build is refused even when an older backup would load', async () => {
  const newer = JSON.stringify({ schemaVersion: 99, attestations: {} });
  const { code, log, files } = await runToExit({
    world: new World(), env: BASE_ENV, files: { 'state.json': newer, 'state.json.bak': GOOD_STATE },
  });
  assert.equal(code, 1);
  assert.match(log, /format version 99/);
  assert.equal(files['state.json'], newer);
  assert.equal(files['state.json.bak'], GOOD_STATE, 'the older backup is not promoted over newer data');
});

test('a first start records which chain the state belongs to, and a restart keeps it', async () => {
  const first = await withOracle({ world: new World(), env: BASE_ENV }, async (oracle) => {
    assert.equal((await oracle.call('GET', '/health')).body.stateSource, 'fresh');
    const saved = await eventually(oracle, () => {
      const text = oracle.files()['state.json'];
      return text && JSON.parse(text).chainId === 5042 ? text : null;
    }, 'the state to record its chain');
    assert.equal(JSON.parse(saved).schemaVersion, 1);
    return saved;
  });

  await withOracle({ world: new World(), env: BASE_ENV, files: { 'state.json': first } }, async (oracle) => {
    assert.equal((await oracle.call('GET', '/health')).body.stateSource, 'file');
  });
});

// ---- which chain -------------------------------------------------------------------------

test('an RPC on a different chain from EXPECTED_CHAIN_ID stops the oracle before it signs anything', async () => {
  const world = new World();
  world.set('chainId', 1);
  const { code, log, files } = await runToExit({ world, env: { ...BASE_ENV, EXPECTED_CHAIN_ID: '5042' } });
  assert.equal(code, 1);
  assert.match(log, /EXPECTED_CHAIN_ID is 5042 but the RPC reports chain 1/);
  const asked = (files['calls.jsonl'] || '').split('\n').filter(Boolean).map((l) => JSON.parse(l).name);
  assert.deepEqual(asked.filter((n) => n !== 'init'), [], 'nothing was asked of the chain');
});

test('state saved on one chain is not used on another', async () => {
  const saved = JSON.stringify({ schemaVersion: 1, chainId: 1, attestations: { [DID]: { successful: 1, total: 1 } } });
  const { code, log, files } = await runToExit({
    world: new World(), env: BASE_ENV, files: { 'state.json': saved },
  });
  assert.equal(code, 1);
  assert.match(log, /state file belongs to chain 1 but the RPC reports chain 5042/);
  assert.equal(files['state.json'], saved, 'the other chain\'s state is not overwritten');
});

test('the chain is checked again before every epoch, and an epoch on the wrong chain does not run', async () => {
  const world = new World();
  world.addRegisteredAgent();
  await withOracle({ world, env: { ...BASE_ENV, EXPECTED_CHAIN_ID: '5042' } }, async (oracle) => {
    await epochsFinished(oracle, 1);
    assert.deepEqual(names(oracle.calls()), ['proposeScore'], 'the first epoch ran on the right chain');

    // A failover lands on another chain.
    world.set('chainId', 1);
    assert.equal((await oracle.call('POST', '/epoch', {}, ADMIN)).status, 202);
    await eventually(oracle, async () => {
      const text = (await oracle.call('GET', '/metrics')).text;
      return counter(text, EPOCHS_FAILED) >= 1;
    }, 'the second epoch to fail');

    assert.match(oracle.logs(), /epoch aborted: EXPECTED_CHAIN_ID is 5042 but the RPC reports chain 1/);
    assert.deepEqual(names(oracle.calls()), ['proposeScore'], 'nothing more was sent');
    assert.ok(oracle.alive(), 'a bad epoch is skipped, not fatal');
  });
});

test('with EXPECTED_CHAIN_ID unset the oracle warns once at startup, and says which chain it found', async () => {
  await withOracle({ world: new World(), env: BASE_ENV }, async (oracle) => {
    await oracle.waitForLog(/EXPECTED_CHAIN_ID is not set.*chain 5042 now.*Set EXPECTED_CHAIN_ID=5042/);
    const health = await eventually(oracle, async () => {
      const h = (await oracle.call('GET', '/health')).body;
      return h.chainId === 5042 ? h : null;
    }, '/health to report the chain');
    assert.equal(health.expectedChainId, null);
  });
});

test('with EXPECTED_CHAIN_ID set and right, /health reports both and nothing warns', async () => {
  await withOracle({ world: new World(), env: { ...BASE_ENV, EXPECTED_CHAIN_ID: '5042' } }, async (oracle) => {
    const health = await eventually(oracle, async () => {
      const h = (await oracle.call('GET', '/health')).body;
      return h.chainId === 5042 ? h : null;
    }, '/health to report the chain');
    assert.equal(health.expectedChainId, 5042);
    assert.doesNotMatch(oracle.logs(), /EXPECTED_CHAIN_ID is not set/);
  });
});

// ---- settings ----------------------------------------------------------------------------

test('settings that are not numbers are refused at startup, each one named', async () => {
  const { code, log } = await runToExit({
    world: new World(),
    env: {
      ...BASE_ENV,
      PAYMENT_MAX_PER_PAYER: 'four',   // used to remove the per-payer cap
      PAYMENT_HALF_LIFE_DAYS: '90d',   // used to remove decay
      TX_WAIT_SECONDS: '0',
      MAX_FEE_GWEI: '-5',
      EXPECTED_CHAIN_ID: '5042.5',
      ATTEST_COOLDOWN_MS: '',          // blank means unset, and is not a problem
    },
  });
  assert.equal(code, 1);
  assert.match(log, /these settings are not usable/);
  for (const name of ['PAYMENT_MAX_PER_PAYER="four"', 'PAYMENT_HALF_LIFE_DAYS="90d"', 'TX_WAIT_SECONDS="0"',
    'MAX_FEE_GWEI="-5"', 'EXPECTED_CHAIN_ID="5042.5"']) {
    assert.ok(log.includes(name), `${name} is named in:\n${log}`);
  }
  assert.ok(!log.includes('ATTEST_COOLDOWN_MS'), 'a blank setting is not a complaint');
});

test('the transaction settings reach the chain module', async () => {
  const env = {
    ...BASE_ENV, TX_WAIT_SECONDS: '90', MAX_FEE_GWEI: '250', MAX_TX_COST: '0.25', EXPECTED_CHAIN_ID: '5042',
  };
  await withOracle({ world: new World(), env }, async (oracle) => {
    assert.deepEqual(oracle.chainInit(), {
      txWaitMs: 90_000, maxFeeGwei: 250, maxTxCost: '0.25', expectedChainId: 5042,
    });
  });
  // Unset, the caps are left to the chain module's own defaults.
  await withOracle({ world: new World(), env: BASE_ENV }, async (oracle) => {
    assert.deepEqual(oracle.chainInit(), { txWaitMs: 60_000, expectedChainId: null });
  });
});

test('the watcher refuses a setting that is not a number', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigvara-e2e-'));
  try {
    const run = spawnSync(process.execPath, [path.join(__dirname, 'watcher.js')], {
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        RPC_URL: 'http://127.0.0.1:9',
        REPUTATION_ADDRESS: `0x${'33'.repeat(20)}`,
        CHECKER_URL: 'http://127.0.0.1:9',
        MAX_SILENCE_MINUTES: '2h',   // used to mean the checker was never decided silent
      },
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /\[watcher\].*MAX_SILENCE_MINUTES="2h" is not a number/s);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the epoch ---------------------------------------------------------------------------

const FEES = { feeGating: true, epochFee: '1000' };

test('the fee is taken only after the contract has said the proposal would be accepted', async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  for (const [k, v] of Object.entries(FEES)) world.set(k, v);

  await inEpoch({ world, env: PAYMENT_ENV }, ({ text, calls }) => {
    assert.deepEqual(names(calls), ['canPropose', 'chargeEpoch', 'proposeScore']);
    const [check, , send] = calls;
    assert.equal(check.args[0], agent.didHash);
    assert.ok(check.args[2], 'the evidence root is part of what is checked');
    assert.deepEqual(check.args, send.args, 'the proposal that was checked is the proposal that was sent');
    assert.equal(counter(text, 'sigvara_oracle_fee_charges_total{result="ok"}'), 1);
    assert.equal(counter(text, 'sigvara_oracle_fee_charges_total{result="skipped"}'), 0);
    assert.equal(counter(text, 'sigvara_oracle_propose_total{result="success"}'), 1);
  });
});

test('a proposal the contract would refuse costs the agent nothing', async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  for (const [k, v] of Object.entries(FEES)) world.set(k, v);
  world.setFor('canPropose', agent.didHash, { ok: false, reason: 'OperatorNotBonded' });

  await inEpoch({ world, env: BASE_ENV }, ({ text, calls, logs, oracle }) => {
    assert.deepEqual(names(calls), ['canPropose'], 'no charge and no proposal');
    assert.match(logs, /the contract would refuse this proposal \(OperatorNotBonded\); no fee taken/);
    assert.equal(counter(text, 'sigvara_oracle_fee_charges_total{result="skipped"}'), 1);
    assert.equal(counter(text, 'sigvara_oracle_fee_charges_total{result="ok"}'), 0);
    assert.equal(counter(text, EPOCHS_OK), 1, 'the epoch still completes');
    assert.ok(oracle.alive());
  });
});

test('when the check cannot be made, the agent is skipped and not charged', async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  for (const [k, v] of Object.entries(FEES)) world.set(k, v);
  world.setFor('canPropose', agent.didHash, 'throw');

  await inEpoch({ world, env: BASE_ENV }, ({ text, calls, logs }) => {
    assert.deepEqual(names(calls), ['canPropose']);
    assert.match(logs, /could not check the proposal before charging, skipping/);
    assert.equal(counter(text, 'sigvara_oracle_fee_charges_total{result="skipped"}'), 1);
  });
});

test('one agent being refused does not stop the next being scored', async () => {
  const world = new World();
  const refused = world.addRegisteredAgent();
  const accepted = world.addRegisteredAgent();
  for (const [k, v] of Object.entries(FEES)) world.set(k, v);
  world.setFor('canPropose', refused.didHash, { ok: false, reason: 'AgentNotScorable' });

  await inEpoch({ world, env: BASE_ENV }, ({ calls }) => {
    assert.deepEqual(
      calls.map((c) => [c.name, c.args[0]]),
      [
        ['canPropose', refused.didHash],
        ['canPropose', accepted.didHash],
        ['chargeEpoch', accepted.didHash],
        ['proposeScore', accepted.didHash],
      ],
    );
  });
});

test('a fee charge that is not seen mined is counted apart, and the agent is not scored', async () => {
  const world = new World();
  world.addRegisteredAgent();
  for (const [k, v] of Object.entries(FEES)) world.set(k, v);
  world.set('charge', 'unconfirmed');

  await inEpoch({ world, env: BASE_ENV }, ({ text, calls, logs }) => {
    assert.deepEqual(names(calls), ['canPropose', 'chargeEpoch']);
    assert.match(logs, /epoch-fee charge not confirmed, not scoring/);
    assert.equal(counter(text, 'sigvara_oracle_fee_charges_total{result="error"}'), 1);
    assert.equal(counter(text, 'sigvara_oracle_tx_refused_total{reason="unconfirmed"}'), 1);
  });
});

test('a fee charge that fails outright is an error, not an unconfirmed transaction', async () => {
  const world = new World();
  world.addRegisteredAgent();
  for (const [k, v] of Object.entries(FEES)) world.set(k, v);
  world.set('charge', 'fail');

  await inEpoch({ world, env: BASE_ENV }, ({ text, calls }) => {
    assert.deepEqual(names(calls), ['canPropose', 'chargeEpoch']);
    assert.equal(counter(text, 'sigvara_oracle_fee_charges_total{result="error"}'), 1);
    assert.equal(counter(text, 'sigvara_oracle_tx_refused_total{reason="unconfirmed"}'), 0);
  });
});

test('without epoch fees nothing is simulated or charged, and the proposal goes straight out', async () => {
  const world = new World();
  world.addRegisteredAgent();
  await inEpoch({ world, env: BASE_ENV }, ({ calls }) => {
    assert.deepEqual(names(calls), ['proposeScore']);
  });
});

test('a transaction over the fee cap is counted on its own, and is not a contract refusal', async () => {
  const world = new World();
  world.addRegisteredAgent();
  world.set('propose', 'fee_cap');
  await inEpoch({ world, env: BASE_ENV }, ({ text, logs, oracle }) => {
    assert.match(logs, /the fee is above the cap/);
    assert.equal(counter(text, 'sigvara_oracle_tx_refused_total{reason="fee_cap"}'), 1);
    assert.equal(counter(text, 'sigvara_oracle_propose_total{result="error"}'), 0);
    assert.equal(counter(text, EPOCHS_OK), 1);
    assert.ok(oracle.alive());
  });
});

test('a proposal that is not seen mined is counted as unconfirmed, not as an error', async () => {
  const world = new World();
  world.addRegisteredAgent();
  world.set('propose', 'unconfirmed');
  await inEpoch({ world, env: BASE_ENV }, ({ text, logs }) => {
    assert.match(logs, /was not mined within 60s/);
    assert.equal(counter(text, 'sigvara_oracle_tx_refused_total{reason="unconfirmed"}'), 1);
    assert.equal(counter(text, 'sigvara_oracle_propose_total{result="error"}'), 0);
  });
});

test('a proposal the contract reverts is still an ordinary propose error', async () => {
  const world = new World();
  world.addRegisteredAgent();
  world.set('propose', 'revert');
  await inEpoch({ world, env: BASE_ENV }, ({ text }) => {
    assert.equal(counter(text, 'sigvara_oracle_propose_total{result="error"}'), 1);
    assert.equal(counter(text, 'sigvara_oracle_tx_refused_total{reason="fee_cap"}'), 0);
    assert.equal(counter(text, 'sigvara_oracle_tx_refused_total{reason="unconfirmed"}'), 0);
  });
});

test('a transaction left pending by an earlier epoch is warned about, and the epoch carries on', async () => {
  const world = new World();
  world.addRegisteredAgent();
  world.set('nonceGap', 2);
  await inEpoch({ world, env: BASE_ENV }, ({ logs, calls }) => {
    assert.match(logs, /WARNING: 2 transaction\(s\) from this wallet are still pending from before this epoch/);
    assert.deepEqual(names(calls), ['proposeScore']);
  });
});

// ---- the clock ---------------------------------------------------------------------------

test('an epoch does not run when the chain\'s clock is far from this host\'s', async () => {
  const world = new World();
  world.addRegisteredAgent();
  world.set('nowSec', world.data.nowSec + 3600);   // the node says it is an hour from now

  await inEpoch({ world, env: BASE_ENV }, ({ text, calls, logs, oracle }) => {
    assert.match(logs, /epoch aborted: the chain's clock is \d+s ahead of this host's/);
    assert.match(logs, /MAX_CLOCK_SKEW_SECONDS/);
    assert.doesNotMatch(logs, /agent\(s\) found/, 'it stopped before the registry was read, let alone any payment credited');
    assert.equal(counter(text, EPOCHS_FAILED), 1);
    assert.deepEqual(calls, [], 'nothing was scored, charged or proposed');
    assert.ok(oracle.alive());
  });
});

test('MAX_CLOCK_SKEW_SECONDS widens what is tolerated', async () => {
  const world = new World();
  world.addRegisteredAgent();
  world.set('nowSec', world.data.nowSec + 3600);

  await inEpoch({ world, env: { ...BASE_ENV, MAX_CLOCK_SKEW_SECONDS: '7200' } }, ({ text, calls }) => {
    assert.equal(counter(text, EPOCHS_OK), 1);
    assert.deepEqual(names(calls), ['proposeScore']);
  });
});
