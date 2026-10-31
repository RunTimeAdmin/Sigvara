'use strict';

// Outcomes signed by the payer (docs/adr/0006-payer-signed-outcomes.md): the module's checks on
// their own, then POST /attest end to end against the stubbed chain.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const payerOutcome = require('./payer-outcome');
const { World, startOracle, runToExit, ASSET } = require('./test-support/oracle-harness');

const USDC = 1_000_000n;
const MIN = 10_000n;
const AUDITOR = 'c'.repeat(64);
const CHAIN_ID = 5042;
// The harness's REPUTATION_ADDRESS.
const REPUTATION = `0x${'33'.repeat(20)}`;
const DOMAIN = payerOutcome.domain(CHAIN_ID, REPUTATION);

const now = () => Math.floor(Date.now() / 1000);

/** A payer outcome for one leg, signed by `signer` (by default the payer's own key). */
async function signOutcome(didHash, txHash, payer, {
  outcome = 1,
  signer = payer,
  dom = DOMAIN,
  signedAt = now(),
  deadline = now() + 3_600,
  evidence = ethers.ZeroHash,
} = {}) {
  const value = { payer: payer.address, outcome, evidence, signedAt, deadline };
  const signature = await signer.signTypedData(dom, payerOutcome.TYPES, payerOutcome.message(didHash, txHash, value));
  return { ...value, signature };
}

// ---- the module on its own --------------------------------------------------------------

describe('payer-outcome', () => {
  test('reads its settings, off by default, negatives priced at the payment minimum', () => {
    const cfg = payerOutcome.readConfig({}, { minAmount: MIN });
    assert.deepEqual(cfg, { mode: 'off', windowMs: 14 * 86_400_000, negativeMinAmount: MIN, publish: false });
    assert.equal(payerOutcome.readConfig({ PAYER_OUTCOMES: 'POSITIVE' }, { minAmount: MIN }).mode, 'positive');
    assert.throws(() => payerOutcome.readConfig({ PAYER_OUTCOMES: 'yes' }, { minAmount: MIN }));
    assert.throws(() => payerOutcome.readConfig({ PAYER_NEGATIVE_MIN_AMOUNT: '1.5' }, { minAmount: MIN }));
    // A window that is not a number would let a credentialed outcome be replaced forever.
    for (const bad of ['14d', 'abc', '-1', 'Infinity']) {
      assert.throws(() => payerOutcome.readConfig({ PAYER_OUTCOME_WINDOW_DAYS: bad }, { minAmount: MIN }), bad);
    }
    assert.equal(payerOutcome.readConfig({ PAYER_OUTCOME_WINDOW_DAYS: '0' }, { minAmount: MIN }).windowMs, 0);
  });

  test('takes only the outcomes and shapes the type allows', () => {
    const payer = ethers.Wallet.createRandom().address;
    const good = { payer, outcome: 1, signedAt: 1, deadline: 2, signature: '0xab' };
    assert.equal(payerOutcome.parse(good).ok, true);
    assert.equal(payerOutcome.parse(good).value.evidence, ethers.ZeroHash, 'evidence defaults to zero');
    for (const bad of [
      { ...good, outcome: 0 },
      { ...good, outcome: 3 },
      { ...good, outcome: '1' },
      { ...good, payer: 'nobody' },
      { ...good, evidence: '0x12' },
      { ...good, signedAt: -1 },
      { ...good, deadline: 1.5 },
      { ...good, signature: 'ab' },
      null,
    ]) {
      assert.equal(payerOutcome.parse(bad).ok, false, JSON.stringify(bad));
    }
  });

  test('refuses a signature dated before the payment, from the future, or past its deadline', () => {
    const t = now();
    const settledMs = (t - 600) * 1000;
    const base = { signedAt: t - 60, deadline: t + 3_600 };
    assert.equal(payerOutcome.timingProblem(base, settledMs), null);
    assert.match(payerOutcome.timingProblem({ ...base, signedAt: t - 1_200 }, settledMs), /before the payment/);
    assert.match(payerOutcome.timingProblem({ ...base, signedAt: t + 3_000 }, settledMs), /future/);
    assert.match(payerOutcome.timingProblem({ ...base, deadline: t - 1 }, settledMs), /passed/);
    assert.match(payerOutcome.timingProblem({ ...base, deadline: base.signedAt + 31 * 86_400 }, settledMs), /30 days/);
  });

  test('checks an account without code by recovery, and refuses the malleable twin of a good signature', async () => {
    const payer = ethers.Wallet.createRandom();
    const didHash = ethers.id('agent');
    const txHash = ethers.id('tx');
    const signed = await signOutcome(didHash, txHash, payer);
    const msg = payerOutcome.message(didHash, txHash, signed);
    const provider = { getCode: async () => '0x' };
    const check = (signature) => payerOutcome.verifySignature({ provider, dom: DOMAIN, msg, signature, blockNumber: 1 });

    assert.deepEqual(await check(signed.signature), { valid: true, signer: 'eoa' });
    // Same r, s' = n - s, v flipped: recovers to the same key, and OpenZeppelin refuses it.
    const sig = ethers.Signature.from(signed.signature);
    const n = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
    const twin = ethers.concat([sig.r, ethers.toBeHex(n - BigInt(sig.s), 32), ethers.toBeHex(sig.v === 27 ? 28 : 27, 1)]);
    assert.deepEqual(await check(twin), { valid: false, signer: 'eoa' });
    const other = await signOutcome(didHash, txHash, payer, { signer: ethers.Wallet.createRandom() });
    assert.equal((await check(other.signature)).valid, false);
  });

  test('asks a contract account at the given block, and a revert or a wrong answer is a no', async () => {
    const msg = payerOutcome.message(ethers.id('agent'), ethers.id('tx'), {
      payer: ethers.Wallet.createRandom().address, outcome: 1, evidence: ethers.ZeroHash, signedAt: 1, deadline: 2,
    });
    const asked = [];
    const provider = (answer) => ({
      getCode: async () => '0x6080',
      call: async (tx) => { asked.push(tx.blockTag); return answer(); },
    });
    const run = (answer) => payerOutcome.verifySignature({ provider: provider(answer), dom: DOMAIN, msg, signature: '0x01', blockNumber: 77 });

    assert.deepEqual(await run(() => `0x1626ba7e${'0'.repeat(56)}`), { valid: true, signer: 'contract' });
    assert.equal((await run(() => `0xffffffff${'0'.repeat(56)}`)).valid, false);
    assert.equal((await run(() => '0x1626ba7e')).valid, false, 'not a full word');
    assert.equal((await run(() => { throw Object.assign(new Error('reverted'), { code: 'CALL_EXCEPTION' }); })).valid, false);
    await assert.rejects(run(() => { throw new Error('socket hang up'); }), { code: 'rpc_error' });
    assert.deepEqual([...new Set(asked)], [77]);
  });
});

test('a node that cannot answer the ERC-1271 call is an RPC failure, not a bad signature', async () => {
  // A real JsonRpcProvider, because ethers reports every eth_call error as CALL_EXCEPTION.
  const http = require('node:http');
  const answers = {
    reverted: { code: 3, message: 'execution reverted', data: '0x' },
    header: { code: -32000, message: 'header not found' },
    trie: { code: -32000, message: 'missing trie node 1234 (path ) state 0x0 is not available' },
    limit: { code: -32005, message: 'request rate exceeded' },
  };
  let mode = 'reverted';
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      const one = (m) => (m.method === 'eth_getCode'
        ? { jsonrpc: '2.0', id: m.id, result: '0x6080' }
        : m.method === 'eth_call' ? { jsonrpc: '2.0', id: m.id, error: answers[mode] } : { jsonrpc: '2.0', id: m.id, result: '0x1' });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(body) ? body.map(one) : one(body)));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${server.address().port}`, CHAIN_ID, { staticNetwork: true });
  try {
    const msg = payerOutcome.message(ethers.id('agent'), ethers.id('tx'), {
      payer: ethers.Wallet.createRandom().address, outcome: 1, evidence: ethers.ZeroHash, signedAt: 1, deadline: 2,
    });
    const run = () => payerOutcome.verifySignature({ provider, dom: DOMAIN, msg, signature: '0x01', blockNumber: 100 });
    assert.deepEqual(await run(), { valid: false, signer: 'contract' }, 'a revert is the account saying no');
    for (mode of ['header', 'trie', 'limit']) {
      await assert.rejects(run(), { code: 'rpc_error' }, mode);
    }
  } finally {
    provider.destroy();
    server.close();
  }
});

// ---- POST /attest end to end -------------------------------------------------------------

const BASE_ENV = {
  PAYMENT_VERIFICATION: 'required',
  PAYMENT_ASSET: ASSET,
  PAYMENT_MIN_AMOUNT: String(MIN),
  ORACLE_ADMIN_TOKEN: 'a'.repeat(64),
  ORACLE_TOKEN_COUNTERAUDIT: AUDITOR,
  EXPECTED_CHAIN_ID: String(CHAIN_ID),
};

describe('POST /attest with a payer-signed outcome', () => {
  // One world per oracle: the harness points a world at the last oracle started with it.
  let world;
  let world2;
  let oracle;
  let positiveOnly;

  before(async () => {
    world = new World();
    world2 = new World();
    oracle = await startOracle({
      world,
      env: { ...BASE_ENV, PAYER_OUTCOMES: 'both', PAYER_OUTCOMES_PUBLISH: 'on', PAYER_NEGATIVE_MIN_AMOUNT: String(2n * USDC) },
    });
    positiveOnly = await startOracle({ world: world2, env: { ...BASE_ENV, PAYER_OUTCOMES: 'positive' } });
  });

  after(async () => {
    await oracle.stop();
    await positiveOnly.stop();
  });

  const post = (o, didHash, txHash, signed, extra = {}) =>
    o.call('POST', '/attest', { didHash, payment: { txHash }, payerOutcome: signed, ...extra });
  const evidence = async (o, didHash) => (await o.call('GET', `/evidence/${didHash}`)).body.evidence;

  /** An agent paid by `payer` (a Wallet) in a new transaction. */
  function paid(payer, value = 5n * USDC, w = world) {
    const agent = w.addAgent();
    const txHash = w.addTx([{ from: payer.address, to: agent.agentAddress, value }]);
    return { agent, txHash };
  }

  test('records the payer\'s "delivered" on its own leg, without a token', async () => {
    const payer = ethers.Wallet.createRandom();
    const { agent, txHash } = paid(payer);
    const r = await post(oracle, agent.didHash, txHash, await signOutcome(agent.didHash, txHash, payer));
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.outcomeSource, 'payer_signed');
    assert.equal(r.body.recorded, 'set');
    const [e] = await evidence(oracle, agent.didHash);
    assert.equal(e.success, true);
    assert.equal(e.outcomeSource, 'payer_signed');
    assert.equal(e.payerOutcome.signer, 'eoa');
    // Recorded for every signer: under EIP-7702 an address can gain code later.
    assert.equal(e.payerOutcome.checkedAtBlock, world.data.head);
  });

  test('refuses a second signature from the same payer for the same leg, whatever it says', async () => {
    const payer = ethers.Wallet.createRandom();
    const { agent, txHash } = paid(payer);
    assert.equal((await post(oracle, agent.didHash, txHash, await signOutcome(agent.didHash, txHash, payer))).status, 200);
    const again = await post(oracle, agent.didHash, txHash, await signOutcome(agent.didHash, txHash, payer, { outcome: 2 }));
    assert.equal(again.status, 409, again.text);
    assert.equal(again.body.code, 'outcome_recorded');
    assert.equal((await evidence(oracle, agent.didHash))[0].success, true);
  });

  test('refuses a payer with no leg in the transaction, and a signature for another sender\'s leg', async () => {
    const payer = ethers.Wallet.createRandom();
    const stranger = ethers.Wallet.createRandom();
    const other = ethers.Wallet.createRandom();
    const agent = world.addAgent();
    const txHash = world.addTx([
      { from: payer.address, to: agent.agentAddress, value: 5n * USDC },
      { from: other.address, to: agent.agentAddress, value: 3n * USDC },
    ]);
    const none = await post(oracle, agent.didHash, txHash, await signOutcome(agent.didHash, txHash, stranger));
    assert.equal(none.status, 402, none.text);
    assert.equal(none.body.code, 'payer_mismatch');
    // The payer signs, naming the other sender's leg.
    const forged = await post(oracle, agent.didHash, txHash, await signOutcome(agent.didHash, txHash, other, { signer: payer }));
    assert.equal(forged.status, 400, forged.text);
    assert.equal(forged.body.code, 'bad_signature');
    // The other sender's own outcome goes on its own leg, not on the largest.
    const own = await post(oracle, agent.didHash, txHash, await signOutcome(agent.didHash, txHash, other));
    assert.equal(own.status, 200, own.text);
    const ev = await evidence(oracle, agent.didHash);
    assert.equal(ev.find((e) => e.payer === other.address).success, true);
    assert.equal(ev.find((e) => e.payer === payer.address).success, null);
  });

  test('refuses a signature for another chain or another contract', async () => {
    const payer = ethers.Wallet.createRandom();
    const { agent, txHash } = paid(payer);
    for (const dom of [
      payerOutcome.domain(1, REPUTATION),
      payerOutcome.domain(CHAIN_ID, `0x${'44'.repeat(20)}`),
    ]) {
      const r = await post(oracle, agent.didHash, txHash, await signOutcome(agent.didHash, txHash, payer, { dom }));
      assert.equal(r.body.code, 'bad_signature', r.text);
    }
  });

  test('refuses a signature dated before settlement or after its deadline', async () => {
    const payer = ethers.Wallet.createRandom();
    const { agent, txHash } = paid(payer);
    const early = await post(oracle, agent.didHash, txHash, await signOutcome(agent.didHash, txHash, payer, { signedAt: now() - 3_600 }));
    assert.equal(early.body.code, 'outcome_window', early.text);
    const lapsed = await post(oracle, agent.didHash, txHash, await signOutcome(agent.didHash, txHash, payer, { deadline: now() - 1 }));
    assert.equal(lapsed.body.code, 'outcome_window', lapsed.text);
  });

  test('takes a "not delivered" only where negatives are on, and only above their minimum', async () => {
    const payer = ethers.Wallet.createRandom();
    const { agent, txHash } = paid(payer);
    const elsewhere = paid(payer, 5n * USDC, world2);
    const off = await post(positiveOnly, elsewhere.agent.didHash, elsewhere.txHash,
      await signOutcome(elsewhere.agent.didHash, elsewhere.txHash, payer, { outcome: 2 }));
    assert.equal(off.status, 400, off.text);
    assert.equal(off.body.code, 'negative_not_accepted');

    const small = ethers.Wallet.createRandom();
    const cheap = paid(small, USDC);
    const below = await post(oracle, cheap.agent.didHash, cheap.txHash, await signOutcome(cheap.agent.didHash, cheap.txHash, small, { outcome: 2 }));
    assert.equal(below.status, 402, below.text);
    assert.equal(below.body.code, 'below_minimum');

    const ok = await post(oracle, agent.didHash, txHash, await signOutcome(agent.didHash, txHash, payer, { outcome: 2 }));
    assert.equal(ok.status, 200, ok.text);
    assert.equal((await evidence(oracle, agent.didHash))[0].success, false);
  });

  test('replaces a credentialed outcome inside the window, and a credentialed one never replaces it', async () => {
    const payer = ethers.Wallet.createRandom();
    const { agent, txHash } = paid(payer);
    const audited = await oracle.call('POST', '/attest', { didHash: agent.didHash, success: false, payment: { txHash } }, AUDITOR);
    assert.equal(audited.status, 200, audited.text);
    const r = await post(oracle, agent.didHash, txHash, await signOutcome(agent.didHash, txHash, payer));
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.recorded, 'replaced');
    assert.equal((await evidence(oracle, agent.didHash))[0].success, true);
    const again = await oracle.call('POST', '/attest', { didHash: agent.didHash, success: false, payment: { txHash } }, AUDITOR);
    assert.equal(again.status, 409, again.text);
    assert.equal(again.body.code, 'outcome_recorded');
  });

  test('leaves a credentialed outcome final once the window has passed', async () => {
    const payer = ethers.Wallet.createRandom();
    const nowSec = world.data.nowSec;
    // The payment settled 20 days ago.
    world.set('nowSec', nowSec - 20 * 86_400);
    try {
      const { agent, txHash } = paid(payer);
      assert.equal((await oracle.call('POST', '/attest', { didHash: agent.didHash, success: false, payment: { txHash } }, AUDITOR)).status, 200);
      const r = await post(oracle, agent.didHash, txHash, await signOutcome(agent.didHash, txHash, payer));
      assert.equal(r.status, 409, r.text);
      assert.equal(r.body.code, 'outcome_recorded');
    } finally {
      world.set('nowSec', nowSec);
    }
  });

  test('checks a smart account through ERC-1271 at a recorded block', async () => {
    const owner = ethers.Wallet.createRandom();
    const account = ethers.Wallet.createRandom().address;
    world.set('accounts', { ...(world.data.accounts || {}), [account.toLowerCase()]: { owners: [{ fromBlock: 0, owner: owner.address }] } });
    const agent = world.addAgent();
    const txHash = world.addTx([{ from: account, to: agent.agentAddress, value: 5n * USDC }]);
    // The account's owner signs for it.
    const asAccount = { address: account, signTypedData: (...a) => owner.signTypedData(...a) };
    const wrongOwner = await signOutcome(agent.didHash, txHash, asAccount, { signer: ethers.Wallet.createRandom() });
    assert.equal((await post(oracle, agent.didHash, txHash, { ...wrongOwner, payer: account })).body.code, 'bad_signature');
    const r = await post(oracle, agent.didHash, txHash, await signOutcome(agent.didHash, txHash, asAccount, { signer: owner }));
    assert.equal(r.status, 200, r.text);
    const [e] = await evidence(oracle, agent.didHash);
    assert.equal(e.payerOutcome.signer, 'contract');
    assert.equal(e.payerOutcome.checkedAtBlock, world.data.head);
    const body = (await oracle.call('GET', `/evidence/${agent.didHash}`)).body;
    assert.deepEqual(body.payerOutcomeDomain, { name: 'Sigvara', version: '1', chainId: CHAIN_ID, verifyingContract: ethers.getAddress(REPUTATION) });
  });

  test('refuses an agent signing for its own payment, both kinds of outcome in one request, and an oracle with them off', async () => {
    const agent = world.addAgent();
    const operatorKey = ethers.Wallet.createRandom();
    // Make the payer the agent's own operator.
    world.data.agents[agent.didHash].operator = operatorKey.address;
    world.flush();
    const txHash = world.addTx([{ from: operatorKey.address, to: agent.agentAddress, value: 5n * USDC }]);
    const self = await post(oracle, agent.didHash, txHash, await signOutcome(agent.didHash, txHash, operatorKey));
    assert.equal(self.status, 402, self.text);
    assert.equal(self.body.code, 'self_payment');

    const payer = ethers.Wallet.createRandom();
    const p = paid(payer);
    const both = await post(oracle, p.agent.didHash, p.txHash, await signOutcome(p.agent.didHash, p.txHash, payer), { success: true });
    assert.equal(both.body.code, 'bad_payer_outcome', both.text);

    const world3 = new World();
    const q = paid(payer, 5n * USDC, world3);
    const offOracle = await startOracle({ world: world3, env: BASE_ENV });
    try {
      const off = await post(offOracle, q.agent.didHash, q.txHash, await signOutcome(q.agent.didHash, q.txHash, payer));
      assert.equal(off.status, 400, off.text);
      assert.equal(off.body.code, 'payer_outcomes_off');
      // A null payerOutcome is no payerOutcome, as it was before the field existed.
      const asBefore = await offOracle.call('POST', '/attest', { didHash: q.agent.didHash, success: true, payment: { txHash: q.txHash }, payerOutcome: null });
      assert.equal(asBefore.status, 200, asBefore.text);
    } finally {
      await offOracle.stop();
    }
  });

  test('takes a customer\'s outcome when the agent\'s own operator paid a larger leg of the same transaction', async () => {
    const agent = world.addAgent();
    const customer = ethers.Wallet.createRandom();
    const txHash = world.addTx([
      { from: agent.operator, to: agent.agentAddress, value: 9n * USDC },
      { from: customer.address, to: agent.agentAddress, value: 5n * USDC },
    ]);
    const r = await post(oracle, agent.didHash, txHash, await signOutcome(agent.didHash, txHash, customer));
    assert.equal(r.status, 200, r.text);
    const ev = await evidence(oracle, agent.didHash);
    assert.deepEqual(ev.map((e) => e.payer), [customer.address], 'the operator\'s own leg is not credited');
  });

  test('does not let one payer among several overturn a credentialed outcome for the whole job', async () => {
    const customer = ethers.Wallet.createRandom();
    const coPayer = ethers.Wallet.createRandom();
    const agent = world.addAgent();
    const txHash = world.addTx([
      { from: customer.address, to: agent.agentAddress, value: 5n * USDC },
      { from: coPayer.address, to: agent.agentAddress, value: 6n * USDC },
    ]);
    // The auditor's outcome goes on the largest leg, the co-payer's.
    assert.equal((await oracle.call('POST', '/attest', { didHash: agent.didHash, success: false, payment: { txHash } }, AUDITOR)).status, 200);
    const r = await post(oracle, agent.didHash, txHash, await signOutcome(agent.didHash, txHash, coPayer));
    assert.equal(r.status, 409, r.text);
    assert.equal(r.body.code, 'outcome_recorded');
    assert.equal((await evidence(oracle, agent.didHash)).find((e) => e.payer === coPayer.address).success, false);
  });

  test('counts a replaced outcome once, and drops the credential holder\'s packet with it', async () => {
    const payer = ethers.Wallet.createRandom();
    const { agent, txHash } = paid(payer);
    const packetId = '56ccbfd3-3868-4b98-8e56-97faa0aec031';
    const audited = await oracle.call('POST', '/attest', { didHash: agent.didHash, success: false, payment: { txHash }, packetId }, AUDITOR);
    assert.equal(audited.body.total, 1);
    const r = await post(oracle, agent.didHash, txHash, await signOutcome(agent.didHash, txHash, payer));
    assert.equal(r.body.recorded, 'replaced');
    assert.deepEqual([r.body.total, r.body.successful], [1, 1]);
    assert.equal((await evidence(oracle, agent.didHash))[0].counterauditPacketId, undefined);
  });

  test('slows down repeated bad signatures for one payment', async () => {
    const payer = ethers.Wallet.createRandom();
    const { agent, txHash } = paid(payer);
    const forged = await signOutcome(agent.didHash, txHash, payer, { signer: ethers.Wallet.createRandom() });
    for (let i = 0; i < 5; i += 1) {
      assert.equal((await post(oracle, agent.didHash, txHash, forged)).body.code, 'bad_signature');
    }
    const sixth = await post(oracle, agent.didHash, txHash, forged);
    assert.equal(sixth.status, 429, sixth.text);
    assert.equal(sixth.body.code, 'bad_signature_throttled');
  });

  test('serves the signed payload only where publishing is on', async () => {
    const payer = ethers.Wallet.createRandom();
    const { agent, txHash } = paid(payer, 5n * USDC, world2);
    assert.equal((await post(positiveOnly, agent.didHash, txHash, await signOutcome(agent.didHash, txHash, payer))).status, 200);
    const [e] = await evidence(positiveOnly, agent.didHash);
    assert.equal(e.outcomeSource, 'payer_signed');
    assert.equal(e.payerOutcome, undefined);
  });
});

test('refuses to start taking payer outcomes without the chain id they are signed for', async () => {
  const { code, log } = await runToExit({
    world: new World(),
    env: { ...BASE_ENV, EXPECTED_CHAIN_ID: '', PAYER_OUTCOMES: 'positive' },
  });
  assert.equal(code, 1);
  assert.match(log, /PAYER_OUTCOMES=positive needs EXPECTED_CHAIN_ID/);
});
