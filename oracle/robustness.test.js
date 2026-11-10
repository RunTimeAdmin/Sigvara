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

const merkle = require('./merkle');

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

test('a fresh start beside a backup keeps the old backup out of the save rotation', async () => {
  // The live file is missing and the backup is the only copy of the old state left. The
  // fresh start's saves used to rotate it away: the first removed it, the second replaced
  // it with the new empty state.
  await withOracle({ world: new World(), env: BASE_ENV, files: { 'state.json.bak': GOOD_STATE } }, async (oracle) => {
    assert.equal((await oracle.call('GET', '/health')).body.stateSource, 'fresh', 'the fresh start is kept');
    await eventually(oracle, () => oracle.files()['state.json'], 'the first save');
    // A second save, so the rotation that used to lose it has run.
    assert.equal((await oracle.call('POST', '/flag', { didHash: DID }, ADMIN)).status, 200);
    await eventually(oracle, () => oracle.files()['state.json.bak'], 'the second save');
    const orphaned = Object.entries(oracle.files()).filter(([n]) => n.startsWith('state.json.bak.orphaned-'));
    assert.equal(orphaned.length, 1, 'the old backup is kept under its own name');
    assert.equal(orphaned[0][1], GOOD_STATE);
    assert.match(oracle.logs(), /a backup with no state file beside it was kept at/);
  });
});

test('an ORACLE_MODE that is not a mode stops the process instead of starting a primary', async () => {
  for (const mode of ['Checker', 'CHECKER', 'checker ', 'chekcer']) {
    const { code, log } = await runToExit({ world: new World(), env: { ...BASE_ENV, ORACLE_MODE: mode } });
    assert.equal(code, 1, `ORACLE_MODE=${JSON.stringify(mode)}`);
    assert.match(log, /ORACLE_MODE=".*" is not a mode/);
  }
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

test('the score an epoch proposes is the score GET /score serves for that agent', async () => {
  // Both go through scoreAt. They used to be separate copies of one computation, each
  // kept in step with the other by hand.
  const world = new World();
  const agent = world.addRegisteredAgent();
  const state = JSON.stringify({
    schemaVersion: 1,
    chainId: 5042,
    attestations: { [agent.didHash]: { successful: 7, total: 9 } },
    flags: { [agent.didHash]: [world.data.nowSec * 1000] },
  });
  await inEpoch({ world, env: BASE_ENV, files: { 'state.json': state } }, async ({ oracle, calls }) => {
    const sent = calls.find((c) => c.name === 'proposeScore');
    assert.ok(sent, 'the agent was proposed');
    const served = await oracle.call('GET', `/score/${agent.didHash}`);
    assert.equal(served.status, 200, served.text);
    assert.equal(served.body.attestations.total, 9, 'the seeded evidence is what was scored');
    assert.equal(served.body.flags, 1);
    assert.deepEqual(served.body.scores, sent.args[1]);
  });
});

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

test('an agent already charged this epoch is scored without being charged again', async () => {
  const world = new World();
  world.addRegisteredAgent();
  for (const [k, v] of Object.entries(FEES)) world.set(k, v);
  world.set('charge', 'already_charged');

  await inEpoch({ world, env: BASE_ENV }, ({ text, calls, logs }) => {
    assert.deepEqual(names(calls), ['canPropose', 'chargeEpoch', 'proposeScore'], 'it is scored all the same');
    assert.match(logs, /already charged this epoch; scoring without charging again/);
    assert.equal(counter(text, 'sigvara_oracle_fee_charges_total{result="already_paid"}'), 1);
    assert.equal(counter(text, 'sigvara_oracle_fee_charges_total{result="error"}'), 0, 'not a failure');
    assert.equal(counter(text, 'sigvara_oracle_fee_charges_total{result="ok"}'), 0, 'and not a charge');
    assert.equal(counter(text, 'sigvara_oracle_propose_total{result="success"}'), 1);
  });
});

test('without epoch fees nothing is simulated or charged, and the proposal goes straight out', async () => {
  const world = new World();
  world.addRegisteredAgent();
  await inEpoch({ world, env: BASE_ENV }, ({ calls }) => {
    assert.deepEqual(names(calls), ['proposeScore']);
  });
});

test('agents below the minimum stake are logged in one line for the epoch, not one each', async () => {
  const world = new World();
  const shy = Array.from({ length: 12 }, () => world.addRegisteredAgent().didHash);
  for (const didHash of shy) world.setFor('bonded', didHash, false);
  world.addRegisteredAgent();
  await inEpoch({ world, env: BASE_ENV }, ({ text, calls, logs }) => {
    assert.deepEqual(names(calls), ['proposeScore'], 'the bonded agent is still proposed');
    assert.equal(counter(text, 'sigvara_oracle_skipped_unbonded_total'), 12);
    assert.equal((logs.match(/below minimum stake/g) || []).length, 1);
    assert.match(logs, /12 agent\(s\) below minimum stake, skipped: (0x[0-9a-f]{8}…, ){9}0x[0-9a-f]{8}…, and 2 more/);
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

// ---- the boot check on who may sign ----------------------------------------------------------
//
// The contracts accept a proposal from an active operator or from the signer one has named, so
// the oracle's wallet may be either. The check is reported and not enforced: the contract
// decides, and an oracle that cannot propose should say so at boot and not once an hour.

const BOND_REGISTRY = `0x${'b0'.repeat(20)}`;

test('a wallet that is neither an operator nor a signer is told so at boot, and the epoch still runs', async () => {
  const world = new World();
  world.addRegisteredAgent();
  world.set('operatorStanding', { enforced: true, allowed: false, operatorBond: BOND_REGISTRY });

  await inEpoch({ world, env: BASE_ENV }, ({ text, logs }) => {
    assert.match(logs, /WARNING: this wallet is neither an admitted operator in 0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0 nor the signer one has named/);
    assert.match(logs, /until its operator has bonded, been admitted and named this wallet with setSigner/);
    assert.doesNotMatch(logs, /bonded operator check passed/);
    assert.equal(counter(text, EPOCHS_OK), 1, 'reported, not enforced');
  });
});

test('a wallet that is an operator, or the signer of one, passes the boot check quietly', async () => {
  const world = new World();
  world.addRegisteredAgent();
  world.set('operatorStanding', { enforced: true, allowed: true, operatorBond: BOND_REGISTRY });

  await inEpoch({ world, env: BASE_ENV }, ({ logs }) => {
    assert.match(logs, /bonded operator check passed \(registry 0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0\)/);
    assert.doesNotMatch(logs, /WARNING: this wallet/);
  });
});

test('with no operator registry configured the boot check says nothing either way', async () => {
  const world = new World();
  world.addRegisteredAgent();

  await inEpoch({ world, env: BASE_ENV }, ({ logs }) => {
    assert.doesNotMatch(logs, /bonded operator check passed/);
    assert.doesNotMatch(logs, /WARNING: this wallet/);
  });
});

// ---- a proposer that has lost its authority ----------------------------------------------
//
// The contract stores who made the pending proposal and will not finalize it once that
// proposer is no longer an active operator, a signer of one, or a holder of ORACLE_ROLE.
// Nobody can finalize such a proposal, so the oracle must neither retry it for ever nor call
// it a failure: the primary replaces it, and a checker takes the slot over.

const STRANDED = 'sigvara_oracle_proposals_stranded_total';
const DIVERGED = 'sigvara_oracle_checker_comparisons_total{verdict="diverged"}';
const CHECKER_ENV = { ...BASE_ENV, ORACLE_MODE: 'checker', DIVERGENCE_TOLERANCE: '3' };
const ZERO_SCORE = { feeScore: 0, successScore: 0, ageScore: 0, externalScore: 0, communityScore: 0, propagationScore: 0 };
// Far from anything an agent with no payments computes, so a checker is bound to disagree.
const HIGH_SCORE = { feeScore: 40, successScore: 25, ageScore: 10, externalScore: 0, communityScore: 5, propagationScore: 5 };

// The checker's grace when CHECKER_GRACE_MINUTES is unset: twice the 24-hour default epoch.
const DEFAULT_GRACE = 2 * 86_400;

function pendingProposal(world, { agedPastWindow = false, agedPastGrace = false, data = ZERO_SCORE, ...extra } = {}) {
  return {
    exists: true,
    proposedAt: world.data.nowSec - (agedPastGrace ? 21_600 + DEFAULT_GRACE + 600 : agedPastWindow ? 30_000 : 100),
    data,
    evidenceRoot: null,
    ...extra,
  };
}

// ---- a window changed after the proposal ---------------------------------------------------
//
// The contract fixes a proposal's deadline when it is made and keeps it, so a window changed later moves
// no proposal already pending. The oracle follows that stored deadline and not proposedAt plus the window
// in force now.

const SIX_HOURS = 21_600;
const TWELVE_HOURS = 43_200;

/** A pending proposal made `ageSeconds` ago under a window of `madeUnder` seconds. */
function proposalUnder(world, { ageSeconds, madeUnder, ...rest }) {
  const proposedAt = world.data.nowSec - ageSeconds;
  return { exists: true, proposedAt, finalizableAt: proposedAt + madeUnder, data: ZERO_SCORE, evidenceRoot: null, ...rest };
}

test('a proposal made under a longer window is finalized at its own deadline, not at the one in force now', async () => {
  // Made 7 hours ago under 6 hours, so it can be finalized now. The window has since been lengthened to 12.
  const world = new World();
  const agent = world.addRegisteredAgent();
  world.set('challengeWindow', TWELVE_HOURS);
  world.setFor('pending', agent.didHash, proposalUnder(world, { ageSeconds: 7 * 3600, madeUnder: SIX_HOURS }));

  await inEpoch({ world, env: BASE_ENV }, ({ text, calls, logs }) => {
    assert.deepEqual(names(calls), ['finalizeScore', 'proposeScore']);
    assert.doesNotMatch(logs, /score still pending/);
    assert.equal(counter(text, 'sigvara_oracle_finalize_total{result="success"}'), 1);
  });
});

test('a proposal made under a shorter window is left alone until its own deadline', async () => {
  // Made 7 hours ago under 12 hours, so the contract still refuses to finalize it. The window has since been
  // shortened to 6, which would say it is ready: the oracle used to send a finalize the contract refused.
  const world = new World();
  const agent = world.addRegisteredAgent();
  world.set('challengeWindow', SIX_HOURS);
  world.setFor('pending', agent.didHash, proposalUnder(world, { ageSeconds: 7 * 3600, madeUnder: TWELVE_HOURS }));

  await inEpoch({ world, env: BASE_ENV }, ({ text, calls, logs }) => {
    assert.deepEqual(names(calls), [], 'nothing was sent');
    assert.match(logs, /score still pending, waiting out challenge window/);
    assert.equal(counter(text, 'sigvara_oracle_finalize_total{result="error"}'), 0);
    assert.equal(counter(text, EPOCHS_OK), 1);
  });
});

test('a proposal from before the deadline was stored is still judged against the live window', async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  world.setFor('pending', agent.didHash, pendingProposal(world, { agedPastWindow: true }));

  await inEpoch({ world, env: BASE_ENV }, ({ calls }) => {
    assert.deepEqual(names(calls), ['finalizeScore', 'proposeScore']);
  });
});

test('a checker says whether a disagreement can still be rejected by the deadline the contract holds', async () => {
  // Past the window in force now, before the deadline the proposal was made under: the committee can still
  // reject it, and the log must say so.
  const open = new World();
  const a = open.addRegisteredAgent();
  open.set('challengeWindow', SIX_HOURS);
  open.setFor('pending', a.didHash, proposalUnder(open, { ageSeconds: 7 * 3600, madeUnder: TWELVE_HOURS, data: HIGH_SCORE }));
  await inEpoch({ world: open, env: CHECKER_ENV }, ({ logs }) => {
    assert.match(logs, /DIVERGENCE .* challenge window OPEN, committee can still reject/);
  });

  // The other way: inside the window in force now, past the deadline the proposal was made under.
  const closed = new World();
  const b = closed.addRegisteredAgent();
  closed.set('challengeWindow', TWELVE_HOURS);
  closed.setFor('pending', b.didHash, proposalUnder(closed, { ageSeconds: 7 * 3600, madeUnder: SIX_HOURS, data: HIGH_SCORE }));
  await inEpoch({ world: closed, env: CHECKER_ENV }, ({ logs }) => {
    assert.match(logs, /DIVERGENCE .* window closed/);
  });
});

test('a pending proposal whose proposer has lost its authority is replaced, not counted as a failure', async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  world.setFor('pending', agent.didHash, pendingProposal(world, { agedPastWindow: true, proposerDead: true }));

  await inEpoch({ world, env: BASE_ENV }, ({ text, calls, logs }) => {
    assert.deepEqual(names(calls), ['finalizeScore', 'proposeScore'], 'finalize was tried, then the fresh proposal went out');
    assert.match(logs, /the pending proposal's proposer is no longer authorized; replacing it/);
    assert.equal(counter(text, STRANDED), 1);
    assert.equal(counter(text, 'sigvara_oracle_finalize_total{result="error"}'), 0);
    assert.equal(counter(text, 'sigvara_oracle_finalize_total{result="success"}'), 0, 'nothing was finalized');
    assert.equal(counter(text, 'sigvara_oracle_propose_total{result="success"}'), 1);
    assert.equal(counter(text, EPOCHS_OK), 1);
  });
});

test('a pending proposal from a proposer that is still authorized is finalized as before', async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  world.setFor('pending', agent.didHash, pendingProposal(world, { agedPastWindow: true }));

  await inEpoch({ world, env: BASE_ENV }, ({ text, calls }) => {
    assert.deepEqual(names(calls), ['finalizeScore', 'proposeScore']);
    assert.equal(counter(text, STRANDED), 0);
    assert.equal(counter(text, 'sigvara_oracle_finalize_total{result="success"}'), 1);
  });
});

test('a checker covers for a pending proposal whose proposer has lost its authority', async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  world.setFor('pending', agent.didHash, pendingProposal(world, { data: HIGH_SCORE, proposerDead: true }));
  // Scored a minute ago, so being stranded is the only thing that lets it cover at once.
  world.setFor('reputation', agent.didHash, { lastUpdated: world.data.nowSec - 60 });

  await inEpoch({ world, env: CHECKER_ENV }, ({ text, calls, logs }) => {
    assert.deepEqual(
      calls.map((c) => [c.name, c.args[3]]),
      [['canPropose', true], ['proposeScore', true]],
      'asked whether the compare-and-swap would be accepted over the occupied slot, then sent it',
    );
    assert.match(logs, /the pending proposal's proposer is no longer authorized; covering for it/);
    assert.equal(counter(text, STRANDED), 1);
    assert.equal(counter(text, DIVERGED), 0, 'a dead proposal is not compared, so it is not a divergence');
    assert.equal(counter(text, 'sigvara_oracle_propose_total{result="success"}'), 1);
  });
});

test('a checker leaves a live proposal alone, however far it disagrees with it', async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  world.setFor('pending', agent.didHash, pendingProposal(world, { data: HIGH_SCORE }));

  await inEpoch({ world, env: CHECKER_ENV }, ({ text, calls }) => {
    assert.deepEqual(names(calls), ['canPropose'], 'the probe was refused, so nothing was sent');
    assert.equal(counter(text, STRANDED), 0);
    assert.equal(counter(text, DIVERGED), 1, 'it says it disagrees, which is all a checker may do');
    assert.equal(counter(text, 'sigvara_oracle_propose_total{result="success"}'), 0);
  });
});

test('a checker that cannot ask whether the proposer is gone treats the proposal as live', async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  world.setFor('pending', agent.didHash, pendingProposal(world, { data: HIGH_SCORE, proposerDead: true }));
  world.setFor('canPropose', agent.didHash, 'throw');

  await inEpoch({ world, env: CHECKER_ENV }, ({ text, calls }) => {
    assert.deepEqual(names(calls), ['canPropose'], 'nothing was sent on a guess');
    assert.equal(counter(text, STRANDED), 0);
    assert.equal(counter(text, 'sigvara_oracle_propose_total{result="success"}'), 0);
  });
});

/** What this oracle computes for an agent with no payments: the scores a primary would propose. */
function computedScores() {
  const world = new World();
  world.addRegisteredAgent();
  return inEpoch({ world, env: BASE_ENV }, ({ calls }) => {
    const { feeScore, successScore, ageScore, externalScore, communityScore, propagationScore } = calls[0].args[1];
    return { feeScore, successScore, ageScore, externalScore, communityScore, propagationScore };
  });
}

test('a checker finalizes a proposal it agrees with once the primary is a grace period late', async () => {
  const agreed = await computedScores();
  const world = new World();
  const agent = world.addRegisteredAgent();
  world.setFor('pending', agent.didHash, pendingProposal(world, { agedPastGrace: true, data: agreed }));

  await inEpoch({ world, env: CHECKER_ENV }, ({ text, calls }) => {
    assert.deepEqual(names(calls), ['canPropose', 'finalizeScore'], 'it asked, found a live proposer, and finalized');
    assert.equal(counter(text, 'sigvara_oracle_finalize_total{result="success"}'), 1);
    assert.equal(counter(text, STRANDED), 0);
  });
});

test('a checker that finds the proposer gone only when it finalizes leaves the slot for the next epoch', async () => {
  const agreed = await computedScores();
  const world = new World();
  const agent = world.addRegisteredAgent();
  // The probe is told the proposer was live when it asked, and the finalize that it is not: the
  // operator was removed in between.
  world.setFor('pending', agent.didHash, pendingProposal(world, { agedPastGrace: true, data: agreed, proposerDead: true }));
  world.setFor('canPropose', agent.didHash, { ok: false, reason: 'ScoreAlreadyPending' });

  await inEpoch({ world, env: CHECKER_ENV }, ({ text, calls, logs }) => {
    assert.deepEqual(names(calls), ['canPropose', 'finalizeScore']);
    assert.match(logs, /the proposer is no longer authorized; covering for it next epoch/);
    assert.equal(counter(text, STRANDED), 1);
    assert.equal(counter(text, 'sigvara_oracle_finalize_total{result="error"}'), 0, 'not a failed finalize');
    assert.equal(counter(text, 'sigvara_oracle_propose_total{result="success"}'), 0, 'and nothing proposed on a guess');
    assert.equal(counter(text, EPOCHS_OK), 1);
  });
});

// ---- a checker leaves the primary its turn ----------------------------------------------
//
// The primary finalizes and proposes again in one epoch, so a slot is empty only for moments. A
// checker that finalized as soon as a window passed emptied the slot itself, and then often
// proposed into it before the primary did: 35 of the first 262 proposals on Arc testnet, none of
// them recomputed, since a primary never compares (docs/divergence-log.md, 2026-11-03). It now
// waits out CHECKER_GRACE_MINUTES before doing either.

const DEFERRED_FINALIZE = 'sigvara_oracle_checker_deferred_total{action="finalize"}';
const DEFERRED_PROPOSE = 'sigvara_oracle_checker_deferred_total{action="propose"}';
// For tests that move the chain's clock between epochs: the oracle refuses an epoch when the
// chain and this host disagree by more than MAX_CLOCK_SKEW_SECONDS, and these jump days ahead.
const MOVING_CLOCK_ENV = { ...CHECKER_ENV, MAX_CLOCK_SKEW_SECONDS: String(4 * 86_400) };

test('a checker leaves a finalize to the primary until the primary is a grace period late', async () => {
  const agreed = await computedScores();
  const world = new World();
  const agent = world.addRegisteredAgent();
  // Past its window by two and a half hours, well inside the grace.
  world.setFor('pending', agent.didHash, pendingProposal(world, { agedPastWindow: true, data: agreed }));

  await inEpoch({ world, env: CHECKER_ENV }, ({ text, calls, logs }) => {
    assert.deepEqual(names(calls), ['canPropose'], 'it asked whether the proposer is live, and sent nothing');
    assert.match(logs, /agreed; leaving the finalize to the primary until /);
    assert.equal(counter(text, DEFERRED_FINALIZE), 1);
    assert.equal(counter(text, AGREED), 1, 'it still says it agrees');
    assert.equal(counter(text, 'sigvara_oracle_finalize_total{result="success"}'), 0);
  });
});

test('a checker leaves a slot emptied by a finalize to the primary', async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  world.setFor('reputation', agent.didHash, { lastUpdated: world.data.nowSec - 3600 });

  await inEpoch({ world, env: CHECKER_ENV }, ({ text, calls, logs }) => {
    assert.deepEqual(names(calls), [], 'nothing was proposed');
    assert.match(logs, /slot empty, counted from .*; leaving it to the primary until /);
    assert.equal(counter(text, DEFERRED_PROPOSE), 1);
    assert.equal(counter(text, 'sigvara_oracle_propose_total{result="success"}'), 0);
  });
});

test('a checker leaves a newly registered agent to the primary too', async () => {
  const world = new World();
  // Registered an hour ago and never scored.
  world.addRegisteredAgent({ registeredDaysAgo: 1 / 24 });

  await inEpoch({ world, env: CHECKER_ENV }, ({ text, calls }) => {
    assert.deepEqual(names(calls), []);
    assert.equal(counter(text, DEFERRED_PROPOSE), 1);
  });
});

test('a checker covers for a primary that has left a slot empty for the whole grace', async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  world.setFor('reputation', agent.didHash, { lastUpdated: world.data.nowSec - DEFAULT_GRACE - 600 });

  await withOracle({ world, env: MOVING_CLOCK_ENV }, async (oracle) => {
    // The first epoch to find the slot empty starts the count, however old the last score is.
    let text = await epochsFinished(oracle, 1);
    assert.deepEqual(names(oracle.calls()), []);
    assert.equal(counter(text, DEFERRED_PROPOSE), 1);

    world.set('nowSec', world.data.nowSec + DEFAULT_GRACE);
    assert.equal((await oracle.call('POST', '/epoch', {}, ADMIN)).status, 202);
    text = await epochsFinished(oracle, 2);
    assert.deepEqual(
      oracle.calls().map((c) => [c.name, c.args[3]]),
      [['proposeScore', true]],
      'proposed through the compare-and-swap entry point',
    );
    assert.equal(counter(text, DEFERRED_PROPOSE), 1, 'deferred once, not again');
    assert.equal(counter(text, 'sigvara_oracle_propose_total{result="success"}'), 1);
  });
});

test('a checker leaves the primary a slot emptied by a rejection, though the last score is old', async () => {
  // A committee rejection deletes the proposal and leaves lastUpdated where it was, here ten days
  // back. Counted from there, the checker proposed at once, ahead of the primary, on the very
  // agent the committee had just acted on.
  const world = new World();
  const agent = world.addRegisteredAgent();
  world.setFor('reputation', agent.didHash, { lastUpdated: world.data.nowSec - 10 * 86_400 });

  await inEpoch({ world, env: CHECKER_ENV }, ({ text, calls }) => {
    assert.deepEqual(names(calls), []);
    assert.equal(counter(text, DEFERRED_PROPOSE), 1);
  });
});

test('a checker that finalized for a late primary covers the slot at its next epoch', async () => {
  const agreed = await computedScores();
  const world = new World();
  const agent = world.addRegisteredAgent();
  world.setFor('pending', agent.didHash, pendingProposal(world, { agedPastGrace: true, data: agreed }));

  await withOracle({ world, env: MOVING_CLOCK_ENV }, async (oracle) => {
    await epochsFinished(oracle, 1);
    assert.deepEqual(names(oracle.calls()), ['canPropose', 'finalizeScore']);

    // The finalize landed: the slot is empty, and its score was finalized a moment ago.
    world.setFor('pending', agent.didHash, { exists: false });
    world.setFor('reputation', agent.didHash, { lastUpdated: world.data.nowSec });
    world.set('nowSec', world.data.nowSec + 3600);
    assert.equal((await oracle.call('POST', '/epoch', {}, ADMIN)).status, 202);
    const text = await epochsFinished(oracle, 2);
    assert.deepEqual(names(oracle.calls()), ['canPropose', 'finalizeScore', 'proposeScore'], 'no second grace');
    assert.equal(counter(text, DEFERRED_PROPOSE), 0);
  });
});

test('a checker that cannot read when a slot was last scored sends nothing for that agent', async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  world.setFor('reputation', agent.didHash, 'throw');

  await inEpoch({ world, env: CHECKER_ENV }, ({ text, calls, logs }) => {
    assert.deepEqual(names(calls), [], 'skipped, not proposed on a guess');
    assert.match(logs, /reputation read failed/);
    assert.equal(counter(text, EPOCHS_OK), 1, 'the epoch carries on');
  });
});

test('a checker counts the grace afresh for an agent it stopped looking at while it was unbonded', async () => {
  // The first epoch to find the slot empty starts the count. The agent is then unbonded for longer than the
  // grace, so neither operator scores it, and bonded again. That is not a primary a grace late.
  const world = new World();
  const agent = world.addRegisteredAgent();
  world.setFor('reputation', agent.didHash, { lastUpdated: world.data.nowSec - DEFAULT_GRACE - 600 });

  await withOracle({ world, env: MOVING_CLOCK_ENV }, async (oracle) => {
    let text = await epochsFinished(oracle, 1);
    assert.equal(counter(text, DEFERRED_PROPOSE), 1);

    world.setFor('bonded', agent.didHash, false);
    world.set('nowSec', world.data.nowSec + DEFAULT_GRACE);
    assert.equal((await oracle.call('POST', '/epoch', {}, ADMIN)).status, 202);
    text = await epochsFinished(oracle, 2);
    assert.equal(counter(text, 'sigvara_oracle_skipped_unbonded_total'), 1);

    world.setFor('bonded', agent.didHash, true);
    world.set('nowSec', world.data.nowSec + 600);
    assert.equal((await oracle.call('POST', '/epoch', {}, ADMIN)).status, 202);
    text = await epochsFinished(oracle, 3);
    assert.deepEqual(names(oracle.calls()), [], 'nothing proposed ahead of the primary');
    assert.equal(counter(text, DEFERRED_PROPOSE), 2, 'deferred again, counted from the epoch it was bonded');
  });
});

test('a checker that loses a finalize to another party says so, and never calls it a committee rejection', async () => {
  // The checker's finalize reverts NoScorePending and the slot is empty. getTotalScore serves the matured
  // score, lower than the one just finalized, so compared against it a finalize read as a rejection. A
  // rejection is not possible here at all: the checker finalizes only past the deadline, and the committee
  // can reject only before it.
  const agreed = await computedScores();
  for (const finalizedAsProposed of [true, false]) {
    const world = new World();
    const agent = world.addRegisteredAgent();
    const pending = pendingProposal(world, { agedPastGrace: true, data: agreed });
    world.setFor('pending', agent.didHash, pending);
    world.setFor('reputation', agent.didHash, finalizedAsProposed
      ? { ...agreed, lastUpdated: pending.proposedAt }
      : { ...agreed, lastUpdated: pending.proposedAt - 86_400 });
    world.setFor('totalScore', agent.didHash, 1);
    world.set('finalize', 'raced');

    await inEpoch({ world, env: CHECKER_ENV }, ({ text, calls, logs }) => {
      assert.deepEqual(names(calls), ['canPropose', 'finalizeScore']);
      assert.doesNotMatch(logs, /committee rejection/);
      assert.equal(counter(text, 'sigvara_oracle_proposals_rejected_total'), 0, 'no rejection is counted');
      if (finalizedAsProposed) {
        assert.match(logs, /already finalized by another party/);
        assert.equal(counter(text, 'sigvara_oracle_finalize_total{result="success"}'), 1);
      } else {
        assert.match(logs, /the pending proposal is gone, and the live score is not the one it proposed/);
        assert.equal(counter(text, 'sigvara_oracle_finalize_total{result="success"}'), 0);
      }
    });
  }
});

test('two epochs disputing one proposal leave one divergence record, dated by both', async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  world.setFor('pending', agent.didHash, pendingProposal(world, { data: HIGH_SCORE }));

  await withOracle({ world, env: CHECKER_ENV }, async (oracle) => {
    await epochsFinished(oracle, 1);
    const [first] = (await oracle.call('GET', '/divergence')).body.divergences;
    assert.equal((await oracle.call('POST', '/epoch', {}, ADMIN)).status, 202);
    const text = await epochsFinished(oracle, 2);
    assert.equal(counter(text, DIVERGED), 2, 'disputed at both epochs');
    const page = (await oracle.call('GET', '/divergence')).body;
    assert.equal(page.total, 1, 'one record for one proposal');
    assert.equal(page.divergences[0].firstAt, first.at, 'first seen at the first epoch');
    assert.ok(page.divergences[0].at > first.at, 'and dated by the newest');
  });
});

test('an agent slashed since the batch read loses its divergence records, as one slashed before it does', async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  // Active at the batch read, slashed at the guard read just after it.
  world.data.agents[agent.didHash].slashedFromRead = 2;
  world.flush();
  const record = { at: Date.now() - 60_000, proposedAt: world.data.nowSec - 3600, pendingTotal: 80, ownTotal: 40, factors: {} };

  await inEpoch({
    world,
    env: CHECKER_ENV,
    files: { 'state.json': JSON.stringify({ schemaVersion: 1, divergences: { [agent.didHash]: [record] } }) },
  }, async ({ oracle, logs }) => {
    assert.match(logs, /slashed since the batch read, skipping/);
    assert.deepEqual((await oracle.call('GET', `/divergence/${agent.didHash}`)).body.divergences, []);
  });
});

test('a throttled finalize is counted once, as a throttled finalize, and nothing is proposed over it', async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  world.setFor('pending', agent.didHash, pendingProposal(world, { agedPastWindow: true }));
  world.set('finalize', 'throttled');

  await inEpoch({ world, env: BASE_ENV }, ({ text, calls, logs }) => {
    assert.deepEqual(names(calls), ['finalizeScore'], 'the slot is still held, so no proposal');
    assert.match(logs, /RPC throttled the finalize; retrying next epoch/);
    assert.doesNotMatch(logs, /throttled the proposal/);
    assert.equal(counter(text, 'sigvara_oracle_finalize_throttled_total'), 1);
    assert.equal(counter(text, 'sigvara_oracle_finalize_total{result="error"}'), 0);
    assert.equal(counter(text, 'sigvara_oracle_propose_throttled_total'), 0);
    assert.equal(counter(text, 'sigvara_oracle_propose_total{result="error"}'), 0);
  });
});

test('a finalize not seen mined, or refused inside its window, is counted once and not as a failed proposal', async () => {
  for (const [mode, once] of [
    ['unconfirmed', 'sigvara_oracle_tx_refused_total{reason="unconfirmed"}'],
    ['window_active', 'sigvara_oracle_finalize_total{result="error"}'],
  ]) {
    const world = new World();
    const agent = world.addRegisteredAgent();
    world.setFor('pending', agent.didHash, pendingProposal(world, { agedPastWindow: true }));
    world.set('finalize', mode);

    await inEpoch({ world, env: BASE_ENV }, ({ text, calls }) => {
      assert.deepEqual(names(calls), ['finalizeScore'], mode);
      assert.equal(counter(text, once), 1, mode);
      const counted = ['sigvara_oracle_finalize_total{result="error"}', 'sigvara_oracle_tx_refused_total{reason="unconfirmed"}',
        'sigvara_oracle_propose_total{result="error"}', 'sigvara_oracle_propose_throttled_total']
        .reduce((sum, name) => sum + counter(text, name), 0);
      assert.equal(counted, 1, `${mode}: counted once in all`);
    });
  }
});

test('the active agents gauge counts the agents an epoch scored, not the proposals it made', async () => {
  const agreed = await computedScores();
  const world = new World();
  const agent = world.addRegisteredAgent();
  world.setFor('pending', agent.didHash, pendingProposal(world, { data: agreed }));

  await inEpoch({ world, env: CHECKER_ENV }, ({ text, calls }) => {
    assert.deepEqual(names(calls), ['canPropose'], 'it agreed, and sent nothing');
    assert.equal(counter(text, 'sigvara_oracle_active_agents'), 1);
  });
});

test("a checker weighs this operator's flags at the proposal's time, not at its own", async () => {
  const agreed = await computedScores();
  const world = new World();
  const agent = world.addRegisteredAgent();
  const proposedAt = world.data.nowSec - 3 * 3600;
  // Raised an hour short of a half-life (30 days) before the proposal, so it then weighed just over one half
  // and cost two points. It has passed the half-life since, and now costs one.
  const raisedMs = (proposedAt - 30 * 86_400 + 3600) * 1000;
  world.setFor('pending', agent.didHash, { exists: true, proposedAt, data: { ...agreed, communityScore: 3 }, evidenceRoot: null });

  await inEpoch({
    world,
    env: { ...CHECKER_ENV, DIVERGENCE_TOLERANCE: '0' },
    files: { 'state.json': JSON.stringify({ schemaVersion: 1, flags: { [agent.didHash]: [raisedMs] } }) },
  }, ({ text, logs }) => {
    assert.doesNotMatch(logs, /DIVERGENCE/);
    assert.equal(counter(text, AGREED), 1);
  });
});

test('a grace shorter than the checker\'s own epoch stops it at startup', async () => {
  for (const [grace, why] of [['30', /shorter than this checker's epoch of 1440 minutes/], ['-5', /CHECKER_GRACE_MINUTES="-5" is below the minimum of 0/]]) {
    const { code, log } = await runToExit({ world: new World(), env: { ...CHECKER_ENV, CHECKER_GRACE_MINUTES: grace } });
    assert.equal(code, 1, `CHECKER_GRACE_MINUTES=${grace}`);
    assert.match(log, why);
  }
});

test('a checker whose own wallet would be refused leaves the proposal alone', async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  world.setFor('pending', agent.didHash, pendingProposal(world, { data: HIGH_SCORE, proposerDead: true }));
  world.setFor('canPropose', agent.didHash, { ok: false, reason: 'OperatorNotBonded' });

  await inEpoch({ world, env: CHECKER_ENV }, ({ text, calls }) => {
    assert.deepEqual(names(calls), ['canPropose']);
    assert.equal(counter(text, STRANDED), 0);
    assert.equal(counter(text, 'sigvara_oracle_propose_total{result="success"}'), 0);
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

// ---- a checker judges a proposal by the evidence it was made on ----------------------------
//
// A payment that settles after a proposal is evidence its proposer could not have had. A checker
// that counted it called an honest proposal wrong and asked the committee to reject it: on
// 2026-11-01 a proposal made at 23:06 was disputed over two payments at 23:15 and 00:02.

const CHECKER_PAYMENT_ENV = { ...PAYMENT_ENV, ORACLE_MODE: 'checker', DIVERGENCE_TOLERANCE: '3' };
const AGREED = 'sigvara_oracle_checker_comparisons_total{verdict="agreed"}';

/** Payments from `count` different payers, settled `secondsAgo` before the world's now. */
function paymentsAt(world, count, secondsAgo, tag) {
  return Array.from({ length: count }, (_, i) => ({
    txHash: require('ethers').ethers.id(`${tag}-${i}`),
    ts: (world.data.nowSec - secondsAgo) * 1000,
    amount: '5000000',
    payer: require('ethers').ethers.Wallet.createRandom().address,
    success: true,
  }));
}

/** The score a primary holding these payments proposes for the agent. */
async function proposedFor(agentWorld, events) {
  const world = new World();
  world.data = structuredClone(agentWorld.data);
  world.flush();
  const [didHash] = world.data.registered;
  return inEpoch(
    { world, env: PAYMENT_ENV, files: { 'state.json': JSON.stringify({ schemaVersion: 1, paymentEvents: { [didHash]: events } }) } },
    ({ calls }) => {
      const propose = calls.find((c) => c.name === 'proposeScore');
      const { feeScore, successScore, ageScore, externalScore, communityScore, propagationScore } = propose.args[1];
      return { feeScore, successScore, ageScore, externalScore, communityScore, propagationScore };
    },
  );
}

test('a checker agrees with a proposal made before payments it now holds', async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  const before = paymentsAt(world, 2, 40 * 86_400, 'before');
  // Settled after the proposal, which was made 100 seconds ago: enough new payers to move the score.
  const after = paymentsAt(world, 6, 50, 'after');
  const data = await proposedFor(world, before);
  world.setFor('pending', agent.didHash, pendingProposal(world, { data }));

  await inEpoch({
    world,
    env: CHECKER_PAYMENT_ENV,
    files: { 'state.json': JSON.stringify({ schemaVersion: 1, paymentEvents: { [agent.didHash]: [...before, ...after] } }) },
  }, ({ text, logs }) => {
    assert.doesNotMatch(logs, /DIVERGENCE/);
    assert.equal(counter(text, DIVERGED), 0, 'payments after the proposal are not held against it');
    assert.equal(counter(text, AGREED), 1);
  });
});

test('two operators holding the same payments in different orders commit to the same root', async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  const [a, b, c, d] = paymentsAt(world, 4, 40 * 86_400, 'order');
  const orders = [[a, b, c, d], [b, c, a, d]];
  assert.notEqual(merkle.rootFor(orders[0]), merkle.rootFor(orders[1]), 'in storage order they differ');
  const seen = [];
  for (const stored of orders) {
    world.file = null;
    await inEpoch({
      world, env: PAYMENT_ENV, files: { 'state.json': JSON.stringify({ schemaVersion: 1, paymentEvents: { [agent.didHash]: stored } }) },
    }, async ({ oracle, calls }) => {
      const ev = await oracle.call('GET', `/evidence/${agent.didHash}`);
      seen.push({ proposed: calls.find((call) => call.name === 'proposeScore').args[2], served: ev.body.evidenceRoot, txs: ev.body.evidence.map((e) => e.txHash) });
    });
  }
  assert.equal(seen[0].proposed, seen[1].proposed);
  assert.equal(seen[0].served, seen[1].served);
  assert.equal(seen[0].served, seen[0].proposed);
  assert.deepEqual(seen[0].txs, seen[1].txs, 'served in the order the root is built over');
});

// Checkers once also read the order this operator credited payments in, for proposals made before the
// order was fixed (2026-11-04). None can still be pending, so a root over any other order is a disagreement.
test('a checker reads only the fixed order: a proposal over another, with an outcome signed since, is disputed', async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  // A second apart, so that the fixed order is this one.
  const [a, b, c, d] = paymentsAt(world, 4, 40 * 86_400, 'transition').map((e, i) => ({ ...e, success: null, ts: e.ts + i * 1000 }));
  const stored = [b, c, a, d];
  assert.notEqual(merkle.rootFor(stored), merkle.rootFor([a, b, c, d]), 'the stored order and the fixed one give different roots');
  const proposedAt = world.data.nowSec - 100;
  const data = await proposedFor(world, stored);
  world.setFor('pending', agent.didHash, pendingProposal(world, { data, evidenceRoot: merkle.rootFor(stored) }));
  // Since then the checker has taken a payer's positive outcome, which would move the score if it counted.
  const signedSince = { ...d, success: true, payerOutcome: { outcome: 1, acceptedAt: (proposedAt + 60) * 1000 } };
  await inEpoch({
    world,
    env: { ...CHECKER_PAYMENT_ENV, DIVERGENCE_TOLERANCE: '0' },
    files: { 'state.json': JSON.stringify({ schemaVersion: 1, paymentEvents: { [agent.didHash]: [b, c, a, signedSince] } }) },
  }, ({ text, logs }) => {
    assert.match(logs, /DIVERGENCE/);
    assert.equal(counter(text, DIVERGED), 1, logs);
  });
});

test('a checker still disputes a proposal that left out a payment settled before it', async () => {
  const world = new World();
  const agent = world.addRegisteredAgent();
  const before = paymentsAt(world, 6, 40 * 86_400, 'omitted');
  const data = await proposedFor(world, []);
  world.setFor('pending', agent.didHash, pendingProposal(world, { data }));

  await inEpoch({
    world,
    env: CHECKER_PAYMENT_ENV,
    files: { 'state.json': JSON.stringify({ schemaVersion: 1, paymentEvents: { [agent.didHash]: before } }) },
  }, ({ text, logs }) => {
    assert.match(logs, /DIVERGENCE/);
    assert.equal(counter(text, DIVERGED), 1);
  });
});
