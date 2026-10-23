'use strict';

// End-to-end tests for POST /attest, run against the real index.js with only the chain
// stubbed (test-support/). The route had no test of any kind, and the first one written found
// that every payment-backed attestation threw a ReferenceError: a variable declared inside an
// `if` block and read after it. Nothing since 25 September had been able to credit a payment
// or an outcome through this route.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { World, startOracle, runToExit, wallet, ASSET } = require('./test-support/oracle-harness');

const USDC = 1_000_000n;
const ADMIN = 'a'.repeat(64);
const AUDITOR = 'c'.repeat(64);
const MIN = 10_000n; // one cent of 6-decimal USDC

const REQUIRED_ENV = {
  PAYMENT_VERIFICATION: 'required',
  PAYMENT_ASSET: ASSET,
  PAYMENT_MIN_AMOUNT: String(MIN),
  PAYMENT_MAX_PER_PAYER: '4',
  ORACLE_ADMIN_TOKEN: ADMIN,
  ORACLE_TOKEN_COUNTERAUDIT: AUDITOR,
};

let world;
let oracle;

before(async () => {
  world = new World();
  oracle = await startOracle({ world, env: REQUIRED_ENV });
});

after(async () => {
  await oracle.stop();
});

const attest = (didHash, txHash, { success, token } = {}) => oracle.call(
  'POST',
  '/attest',
  { didHash, ...(success === undefined ? {} : { success }), payment: { txHash } },
  token,
);
const evidence = async (didHash) => (await oracle.call('GET', `/evidence/${didHash}`)).body.evidence;
const score = async (didHash) => (await oracle.call('GET', `/score/${didHash}`)).body;

// ---- a payer the node cannot answer for ------------------------------------------------

test('/score does not serve a number built on a payer it could not read', async () => {
  const agent = world.addAgent();
  const payer = wallet();
  const tx = world.addTx([{ from: payer, to: agent.agentAddress, value: 5n * USDC }]);
  assert.equal((await attest(agent.didHash, tx, { success: true })).status, 200);

  // The node throttles the read of that payer's standing. Scored as "no standing" this would have been a
  // lower number than the true one, and a checker that read it successfully would flag it as a divergence.
  world.set('standingFails', { [payer.toLowerCase()]: true });
  const failed = await oracle.call('GET', `/score/${agent.didHash}`);
  assert.equal(failed.status, 502, failed.text);
  assert.equal(failed.body.code, 'rpc_error');

  world.set('standingFails', {});
  const ok = await oracle.call('GET', `/score/${agent.didHash}`);
  assert.equal(ok.status, 200, ok.text);
});

// ---- the route works -------------------------------------------------------------------

test('a payment-backed attestation from a stranger is accepted and credits the payment', async () => {
  const agent = world.addAgent();
  const customer = wallet();
  const tx = world.addTx([{ from: customer, to: agent.agentAddress, value: 5n * USDC }]);

  const r = await attest(agent.didHash, tx, { success: true });

  assert.equal(r.status, 200, r.text); // was 400 "info is not defined"
  assert.equal(r.body.attester, customer, 'the payer comes off the chain');
  assert.equal(r.body.payment.amount, String(5n * USDC));
  const ev = await evidence(agent.didHash);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].payer, customer);
});

test('a stranger records the payment and no outcome, however they put it', async () => {
  const agent = world.addAgent();
  const tx = world.addTx([{ from: wallet(), to: agent.agentAddress, value: 5n * USDC }]);

  const r = await attest(agent.didHash, tx, { success: true });

  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.outcomeRecorded, false, 'the response says so');
  assert.equal((await evidence(agent.didHash))[0].success, null);
  const s = await score(agent.didHash);
  assert.equal(s.weighted.attestations.total, 0, 'it never reaches the success ratio');
});

test('a credential holder\'s outcome is recorded, negative or positive', async () => {
  const bad = world.addAgent();
  const good = world.addAgent();
  const txBad = world.addTx([{ from: wallet(), to: bad.agentAddress, value: 5n * USDC }]);
  const txGood = world.addTx([{ from: wallet(), to: good.agentAddress, value: 5n * USDC }]);

  const rb = await attest(bad.didHash, txBad, { success: false, token: AUDITOR });
  const rg = await attest(good.didHash, txGood, { success: true, token: AUDITOR });

  assert.equal(rb.status, 200, rb.text);
  assert.equal(rg.status, 200, rg.text);
  assert.equal(rb.body.outcomeRecorded, true);
  assert.equal((await evidence(bad.didHash))[0].success, false);
  assert.equal((await evidence(good.didHash))[0].success, true);
  const sg = await score(good.didHash);
  assert.ok(sg.weighted.attestations.successful > 0, 'the success counts toward the ratio');
  const sb = await score(bad.didHash);
  assert.ok(sb.weighted.attestations.total > 0 && sb.weighted.attestations.successful === 0);
});

test('a credential holder can give a stranger-credited payment its outcome', async () => {
  const agent = world.addAgent();
  const customer = wallet();
  const tx = world.addTx([{ from: customer, to: agent.agentAddress, value: 5n * USDC }]);

  // The agent's operator files it first, as a stranger, claiming success.
  assert.equal((await attest(agent.didHash, tx, { success: true })).status, 200);
  assert.equal((await evidence(agent.didHash))[0].success, null);

  // The auditor's report is not refused as a replay, and is not held up by a cooldown.
  const r = await attest(agent.didHash, tx, { success: false, token: AUDITOR });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.outcomeRecorded, true);
  const ev = await evidence(agent.didHash);
  assert.equal(ev.length, 1, 'the same payment, not a second one');
  assert.equal(ev[0].success, false);
});

test('an outcome, once recorded, cannot be changed', async () => {
  const agent = world.addAgent();
  const tx = world.addTx([{ from: wallet(), to: agent.agentAddress, value: 5n * USDC }]);
  assert.equal((await attest(agent.didHash, tx, { success: false, token: AUDITOR })).status, 200);

  const again = await attest(agent.didHash, tx, { success: true, token: AUDITOR });

  assert.equal(again.status, 409);
  assert.equal(again.body.code, 'outcome_recorded');
  assert.equal((await evidence(agent.didHash))[0].success, false, 'the audited result stands');
});

// ---- replays and cooldowns -------------------------------------------------------------

test('a refused replay does not lock the payer out of the agent', async () => {
  const agent = world.addAgent();
  const payer = wallet();
  const tx1 = world.addTx([{ from: payer, to: agent.agentAddress, value: 5n * USDC }]);
  const tx2 = world.addTx([{ from: payer, to: agent.agentAddress, value: 6n * USDC }]);
  assert.equal((await attest(agent.didHash, tx1, { success: true, token: AUDITOR })).status, 200);

  // A stranger replays the payer's public settlement. It is refused...
  const replay = await attest(agent.didHash, tx1, { success: true });
  assert.equal(replay.status, 409);
  assert.equal(replay.body.code, 'replayed');

  // ...and the refusal must not have armed the payer's cooldown, or this is a 429.
  const next = await attest(agent.didHash, tx2, { success: true });
  assert.equal(next.status, 200, next.text);
});

test('a stranger is held to the cooldown, and the refusal does not burn the receipt', async () => {
  const agent = world.addAgent();
  const payer = wallet();
  const tx1 = world.addTx([{ from: payer, to: agent.agentAddress, value: 5n * USDC }]);
  const tx2 = world.addTx([{ from: payer, to: agent.agentAddress, value: 6n * USDC }]);
  assert.equal((await attest(agent.didHash, tx1, { success: true })).status, 200);

  const second = await attest(agent.didHash, tx2, { success: true });
  assert.equal(second.status, 429, 'the same payer, the same agent, within the hour');

  // tx2 was not spent by the refusal: a credential holder can still file it.
  const filed = await attest(agent.didHash, tx2, { success: true, token: AUDITOR });
  assert.equal(filed.status, 200, filed.text);
});

// ---- what counts as a payment ----------------------------------------------------------

test('the operator\'s own leg inside a customer\'s transaction is skipped, not credited', async () => {
  const agent = world.addAgent();
  const customer = wallet();
  // The customer is the largest sender, so the attestation stands; the operator's leg is not
  // arm's-length trade. The per-leg check for exactly this is the line that used to throw.
  const tx = world.addTx([
    { from: customer, to: agent.agentAddress, value: 5n * USDC },
    { from: agent.operator, to: agent.agentAddress, value: 3n * USDC },
  ]);

  const r = await attest(agent.didHash, tx, { success: true });

  assert.equal(r.status, 200, r.text);
  const ev = await evidence(agent.didHash);
  assert.deepEqual(ev.map((e) => e.payer), [customer]);
});

test('an attestation whose largest sender is the operator is refused', async () => {
  const agent = world.addAgent();
  const tx = world.addTx([
    { from: agent.operator, to: agent.agentAddress, value: 5n * USDC },
    { from: wallet(), to: agent.agentAddress, value: 3n * USDC },
  ]);

  const r = await attest(agent.didHash, tx, { success: true });

  assert.equal(r.status, 402);
  assert.equal(r.body.code, 'self_payment');
});

test('zero-value legs riding on a real payment are not credited as counterparties', async () => {
  const agent = world.addAgent();
  const customer = wallet();
  const named = [wallet(), wallet(), wallet(), wallet(), wallet()];
  for (const a of named) world.setStanding(a, 25); // full standing, as a forger would pick
  const tx = world.addTx([
    { from: customer, to: agent.agentAddress, value: 5n * USDC },
    ...named.map((from) => ({ from, to: agent.agentAddress, value: 0n })),
  ]);

  const r = await attest(agent.didHash, tx, { success: true });

  assert.equal(r.status, 200, r.text);
  const ev = await evidence(agent.didHash);
  assert.deepEqual(ev.map((e) => e.payer), [customer], 'only the sender who paid is evidence');
  const s = await score(agent.didHash);
  assert.equal(s.scores.propagationScore, 0, 'nobody vouched by naming full-standing agents');
});

test('a transaction of only zero-value transfers is not a payment', async () => {
  const agent = world.addAgent();
  const tx = world.addTx([{ from: wallet(), to: agent.agentAddress, value: 0n }]);

  const r = await attest(agent.didHash, tx, { success: true });

  assert.equal(r.status, 402);
  assert.equal(r.body.code, 'no_transfer');
  assert.equal((await evidence(agent.didHash)).length, 0);
});

test('a payment under the minimum is refused', async () => {
  const agent = world.addAgent();
  const tx = world.addTx([{ from: wallet(), to: agent.agentAddress, value: MIN - 1n }]);

  const r = await attest(agent.didHash, tx, { success: true });

  assert.equal(r.status, 402);
  assert.equal(r.body.code, 'below_minimum');
});

// ---- authorisation and input -----------------------------------------------------------

test('a negative attestation still needs a token', async () => {
  const agent = world.addAgent();
  const tx = world.addTx([{ from: wallet(), to: agent.agentAddress, value: 5n * USDC }]);

  const r = await attest(agent.didHash, tx, { success: false });

  assert.equal(r.status, 401);
  assert.equal((await evidence(agent.didHash)).length, 0);
});

test('success must be a boolean, so the string "false" cannot count as a success', async () => {
  const agent = world.addAgent();
  const tx = world.addTx([{ from: wallet(), to: agent.agentAddress, value: 5n * USDC }]);

  const r = await attest(agent.didHash, tx, { success: 'false', token: AUDITOR });

  assert.equal(r.status, 400);
  assert.match(r.body.error, /success must be/);
  assert.equal((await evidence(agent.didHash)).length, 0, 'nothing was credited');
  const s = await score(agent.didHash);
  assert.equal(s.attestations.successful, 0);
});

test('an unregistered agent is refused', async () => {
  const tx = world.addTx([{ from: wallet(), to: wallet(), value: 5n * USDC }]);
  const r = await attest(`0x${'ab'.repeat(32)}`, tx, { success: true });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /unknown didHash/);
});

// ---- tenure ----------------------------------------------------------------------------

test('an agent that was never paid scores no tenure, however long ago it registered', async () => {
  const idle = world.addAgent({ registeredDaysAgo: 400 });
  const s = await score(idle.didHash);
  assert.equal(s.scores.ageScore, 0, 'a year on the registry is not work');
});

// ---- startup ---------------------------------------------------------------------------

test('the oracle refuses to start with verification on and no minimum payment', async () => {
  const { code, log } = await runToExit({
    world: new World(),
    env: { ...REQUIRED_ENV, PAYMENT_MIN_AMOUNT: '0' },
  });
  assert.equal(code, 1);
  assert.match(log, /PAYMENT_MIN_AMOUNT above 0/);

  const unset = await runToExit({
    world: new World(),
    env: { ...REQUIRED_ENV, PAYMENT_MIN_AMOUNT: '' },
  });
  assert.equal(unset.code, 1, 'an unset minimum is a zero minimum');
});

// ---- verification off: the old path is unchanged -----------------------------------------

test('with verification off, attestations keep their tally and their cooldown', async () => {
  const offWorld = new World();
  const off = await startOracle({
    world: offWorld,
    env: { PAYMENT_VERIFICATION: 'off', ORACLE_ADMIN_TOKEN: ADMIN },
  });
  try {
    const agent = offWorld.addAgent();
    const post = (body, token) => off.call('POST', '/attest', body, token);

    const stranger = await post({ didHash: agent.didHash, success: true, attester: 'x' });
    assert.equal(stranger.status, 401, 'without verification every attestation needs the token');

    const first = await post({ didHash: agent.didHash, success: true, attester: 'x' }, ADMIN);
    assert.equal(first.status, 200, first.text);
    assert.deepEqual([first.body.successful, first.body.total], [1, 1]);

    const second = await post({ didHash: agent.didHash, success: true, attester: 'x' }, ADMIN);
    assert.equal(second.status, 429, 'the cooldown still applies to a credential holder here');

    const other = await post({ didHash: agent.didHash, success: false, attester: 'y' }, ADMIN);
    assert.equal(other.status, 200, other.text);
    assert.deepEqual([other.body.successful, other.body.total], [1, 2]);
  } finally {
    await off.stop();
  }
});
