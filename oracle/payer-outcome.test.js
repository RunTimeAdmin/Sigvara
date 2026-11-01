'use strict';

// Outcomes signed by the payer (docs/adr/0006-payer-signed-outcomes.md): the module's checks on
// their own, then POST /attest end to end against the stubbed chain.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { ethers } = require('ethers');
const payerOutcome = require('./payer-outcome');
const { World, startOracle, runToExit, ASSET } = require('./test-support/oracle-harness');

const USDC = 1_000_000n;
const MIN = 10_000n;
const AUDITOR = 'c'.repeat(64);
const ADMIN = 'a'.repeat(64);
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
  test('bounds how long after its deadline an import may arrive, whatever block its peer names', () => {
    const value = { signedAt: 1_000, deadline: 2_000 };
    const grace = 6 * 3_600_000;
    assert.equal(payerOutcome.importLateProblem(value, 2_000_000, grace), null, 'at the deadline');
    assert.equal(payerOutcome.importLateProblem(value, 2_000_000 + grace, grace), null, 'at the end of the grace');
    assert.match(payerOutcome.importLateProblem(value, 2_000_001 + grace, grace), /more than 6 hours after its deadline/);
    assert.match(payerOutcome.importLateProblem(value, 2_000_001, 0), /more than 0 hours/, 'no grace');
  });

  test('reads its settings, off by default, negatives priced at the payment minimum', () => {
    const cfg = payerOutcome.readConfig({}, { minAmount: MIN });
    assert.deepEqual(cfg, { mode: 'off', windowMs: 14 * 86_400_000, negativeMinAmount: MIN, publish: false, peers: [], importGraceMs: 6 * 3_600_000 });
    assert.equal(payerOutcome.readConfig({ PAYER_OUTCOMES_IMPORT_GRACE_HOURS: '0.5' }, { minAmount: MIN }).importGraceMs, 1_800_000);
    for (const bad of ['-1', 'soon', 'Infinity']) {
      assert.throws(() => payerOutcome.readConfig({ PAYER_OUTCOMES_IMPORT_GRACE_HOURS: bad }, { minAmount: MIN }), bad);
    }
    assert.equal(payerOutcome.readConfig({ PAYER_OUTCOMES: 'POSITIVE' }, { minAmount: MIN }).mode, 'positive');
    assert.throws(() => payerOutcome.readConfig({ PAYER_OUTCOMES: 'yes' }, { minAmount: MIN }));
    assert.throws(() => payerOutcome.readConfig({ PAYER_NEGATIVE_MIN_AMOUNT: '1.5' }, { minAmount: MIN }));
    // A window that is not a number would let a credentialed outcome be replaced forever.
    for (const bad of ['14d', 'abc', '-1', 'Infinity']) {
      assert.throws(() => payerOutcome.readConfig({ PAYER_OUTCOME_WINDOW_DAYS: bad }, { minAmount: MIN }), bad);
    }
    assert.equal(payerOutcome.readConfig({ PAYER_OUTCOME_WINDOW_DAYS: '0' }, { minAmount: MIN }).windowMs, 0);
  });

  test('reads the peers to import from as base URLs, and only where payer outcomes are on', () => {
    const peers = (v, mode = 'positive') => payerOutcome.readConfig({ PAYER_OUTCOMES: mode, PAYER_OUTCOMES_PEERS: v }, { minAmount: MIN }).peers;
    assert.deepEqual(peers(' https://checker.example/ , http://10.0.0.2:3000 '), ['https://checker.example', 'http://10.0.0.2:3000']);
    for (const bad of ['checker.example', 'ftp://checker.example', 'https://u:p@checker.example', 'https://checker.example/?a=1']) {
      assert.throws(() => peers(bad), /PAYER_OUTCOMES_PEERS/, bad);
    }
    assert.throws(() => peers('https://checker.example', 'off'), /needs PAYER_OUTCOMES/);
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

  test('refuses a signature dated before the payment, from the future, or with a deadline too far out', () => {
    const t = now();
    const settledMs = (t - 600) * 1000;
    const base = { signedAt: t - 60, deadline: t + 3_600 };
    assert.equal(payerOutcome.timingProblem(base, settledMs), null);
    assert.match(payerOutcome.timingProblem({ ...base, signedAt: t - 1_200 }, settledMs), /before the payment/);
    assert.match(payerOutcome.timingProblem({ ...base, signedAt: t + 3_000 }, settledMs), /future/);
    assert.match(payerOutcome.timingProblem({ ...base, deadline: base.signedAt + 31 * 86_400 }, settledMs), /30 days/);
  });

  test('judges the deadline at the checked block\'s time, and refuses a block from well before the signature', () => {
    const t = now();
    const value = { signedAt: t - 600, deadline: t - 60 };
    // Past its deadline by this host's clock, not at the block it was checked at.
    assert.equal(payerOutcome.checkedBlockProblem(value, (t - 300) * 1000), null);
    assert.match(payerOutcome.checkedBlockProblem(value, (t - 60) * 1000), /passed/);
    // A confirmed block a little behind the signature is ordinary; one from long before is not.
    const lag = payerOutcome.MAX_CHECK_LAG_SECONDS;
    assert.equal(payerOutcome.checkedBlockProblem({ signedAt: t, deadline: t + 600 }, (t - lag) * 1000), null);
    assert.match(payerOutcome.checkedBlockProblem({ signedAt: t, deadline: t + 600 }, (t - lag - 1) * 1000), /before it was signed/);
  });

  test('checks an imported outcome by recovery when the payer has no code now, without reading old state', async () => {
    const payer = ethers.Wallet.createRandom();
    const didHash = ethers.id('agent');
    const txHash = ethers.id('tx');
    const signed = await signOutcome(didHash, txHash, payer);
    const msg = payerOutcome.message(didHash, txHash, signed);
    const reads = [];
    const provider = (codeAt) => ({
      getCode: async (_a, block) => { reads.push(['code', block]); return codeAt(block); },
      call: async ({ blockTag }) => { reads.push(['call', blockTag]); return `0x1626ba7e${'0'.repeat(56)}`; },
    });
    const run = (codeAt, signature = signed.signature) => payerOutcome.verifyImported({
      provider: provider(codeAt), dom: DOMAIN, msg, signature, blockNumber: 50, headBlock: 900,
    });
    assert.deepEqual(await run(() => '0x'), { valid: true, signer: 'eoa' });
    assert.deepEqual(reads, [['code', 900]], 'only the head is read');
    // Code now: the recorded block decides, as the accepting operator saw it.
    reads.length = 0;
    assert.deepEqual(await run(() => '0x6080', '0x01'), { valid: true, signer: 'contract' });
    assert.deepEqual(reads, [['code', 900], ['code', 50], ['call', 50]]);
    // Code gained after the outcome was taken (EIP-7702): recovery, as it was then.
    reads.length = 0;
    assert.deepEqual(await run((block) => (block === 900 ? '0x6080' : '0x')), { valid: true, signer: 'eoa' });
    assert.deepEqual(reads, [['code', 900], ['code', 50]]);
  });

  test('reads a peer\'s page only as a capped, unredirected JSON list', async () => {
    let answer = () => ({ status: 200, body: JSON.stringify({ more: true, outcomes: [] }) });
    const server = http.createServer((req, res) => {
      const { status, body, headers = {} } = answer(req);
      res.writeHead(status, { 'content-type': 'application/json', ...headers });
      res.end(body);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const peer = `http://127.0.0.1:${server.address().port}`;
    try {
      assert.deepEqual(await payerOutcome.fetchOutcomesPage(peer, 0), { outcomes: [], more: true });
      answer = (req) => {
        assert.match(req.url, /^\/outcomes\?since=42$/);
        return { status: 200, body: JSON.stringify({ outcomes: Array.from({ length: 600 }, (_, i) => ({ i })) }) };
      };
      const padded = await payerOutcome.fetchOutcomesPage(peer, 42);
      assert.equal(padded.outcomes.length, payerOutcome.OUTCOMES_PAGE, 'no more than a page');
      assert.equal(padded.more, false);
      answer = () => ({ status: 302, body: '', headers: { location: 'http://169.254.169.254/' } });
      await assert.rejects(payerOutcome.fetchOutcomesPage(peer, 0), 'a redirect is not followed');
      answer = () => ({ status: 200, body: 'not json' });
      await assert.rejects(payerOutcome.fetchOutcomesPage(peer, 0));
      answer = () => ({ status: 200, body: JSON.stringify({ outcomes: 'none' }) });
      await assert.rejects(payerOutcome.fetchOutcomesPage(peer, 0), /no outcomes list/);
      answer = () => ({ status: 200, body: JSON.stringify({ outcomes: ['x'.repeat(4096)] }) });
      await assert.rejects(payerOutcome.fetchOutcomesPage(peer, 0, { maxBytes: 1024 }), /more than 1024 bytes/);
      answer = () => ({ status: 500, body: '{}' });
      await assert.rejects(payerOutcome.fetchOutcomesPage(peer, 0), /returned 500/);
    } finally {
      server.close();
    }
  });

  test('takes a served outcome only in the shape GET /outcomes gives it', () => {
    const payer = ethers.Wallet.createRandom().address;
    const good = {
      didHash: ethers.id('agent'), txHash: ethers.id('tx'), payer, outcome: 1, evidence: ethers.ZeroHash,
      signedAt: 1, deadline: 2, signature: '0xab', checkedAtBlock: 7, acceptedAt: 1_700_000_000_000, signer: 'eoa',
    };
    const ok = payerOutcome.parseServed(good);
    assert.equal(ok.ok, true);
    assert.deepEqual(Object.keys(ok.value).sort(), ['acceptedAt', 'checkedAtBlock', 'didHash', 'packetId', 'signed', 'txHash']);
    assert.equal(ok.value.packetId, null);
    // The CounterAudit packet beside it, when there is one shaped like a packet id. Anything else is
    // left off rather than refused: the outcome stands on its signature, not on the pointer.
    const packetId = '0b7d9f3e-2c4a-4e8b-8f1d-5a6b7c8d9e0f';
    assert.equal(payerOutcome.parseServed({ ...good, counterauditPacketId: packetId }).value.packetId, packetId);
    for (const odd of ['x', 7, null, `${packetId}0`]) {
      const parsed = payerOutcome.parseServed({ ...good, counterauditPacketId: odd });
      assert.equal(parsed.ok, true);
      assert.equal(parsed.value.packetId, null);
    }
    for (const bad of [
      null,
      [],
      { ...good, didHash: '0x12' },
      { ...good, txHash: undefined },
      { ...good, checkedAtBlock: -1 },
      { ...good, checkedAtBlock: '7' },
      { ...good, acceptedAt: 1.5 },
      { ...good, outcome: 3 },
    ]) {
      assert.equal(payerOutcome.parseServed(bad).ok, false, JSON.stringify(bad));
    }
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

// ---- the shared vectors ------------------------------------------------------------------

describe('the shared vectors (test/vectors/payment-outcome.json)', () => {
  const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test', 'vectors', 'payment-outcome.json'), 'utf8'));
  const dom = payerOutcome.domain(vectors.domain.chainId, vectors.domain.verifyingContract);
  const erc1271 = new ethers.Interface(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)']);

  /**
   * A node holding the vectors' smart account, answering as test/PaymentOutcome.t.sol's accounts do.
   * Every read must be at block 1, and a call must go to the account.
   */
  const vectorNode = (account) => ({
    getCode: async (address, blockTag) => {
      assert.equal(blockTag, 1);
      return account && address.toLowerCase() === vectors.addresses.account.toLowerCase() ? '0x6080' : '0x';
    },
    call: async ({ to, data, blockTag }) => {
      assert.equal(blockTag, 1);
      assert.equal(String(to).toLowerCase(), vectors.addresses.account.toLowerCase());
      const [hash, signature] = erc1271.decodeFunctionData('isValidSignature', data);
      let yes = false;
      try {
        yes = ethers.recoverAddress(hash, signature) === account.owner;
      } catch { /* not a signature */ }
      const word = `${yes ? '0x1626ba7e' : '0xffffffff'}${'0'.repeat(56)}`;
      if (account.kind === 'longer') return `${word}${'0'.repeat(63)}1`;
      if (account.kind === 'short') return word.slice(0, 10);
      return word;
    },
  });

  test('has the type, domain and digests this oracle signs over', () => {
    assert.equal(ethers.TypedDataEncoder.from(payerOutcome.TYPES).encodeType('PaymentOutcome'), vectors.typeString);
    assert.equal(ethers.TypedDataEncoder.hashDomain(dom), vectors.domainSeparator);
    for (const c of vectors.cases) {
      const msg = payerOutcome.message(c.message.didHash, c.message.txHash, c.message);
      assert.equal(ethers.TypedDataEncoder.hash(dom, payerOutcome.TYPES, msg), c.digest, c.name);
      assert.equal(payerOutcome.parse({ ...c.message, signature: c.signature }).ok, true, c.name);
    }
  });

  test('gives every case OpenZeppelin\'s verdict', async () => {
    const offChain = vectors.cases.filter((c) => !c.onChainOnly);
    assert.ok(offChain.length >= 11);
    for (const c of offChain) {
      const msg = payerOutcome.message(c.message.didHash, c.message.txHash, c.message);
      const verdict = await payerOutcome.verifySignature({
        provider: vectorNode(c.account), dom, msg, signature: c.signature, blockNumber: 1,
      });
      assert.deepEqual(verdict, { valid: c.valid, signer: c.account ? 'contract' : 'eoa' }, c.name);
    }
  });

  test('applies the timing cases', () => {
    const says = {
      before_settlement: /before the payment/,
      future: /future/,
      deadline_too_far: /30 days/,
      deadline_passed: /passed/,
      checked_before_signed: /before it was signed/,
    };
    for (const c of vectors.timing) {
      const value = { signedAt: c.signedAt, deadline: c.deadline };
      const why = payerOutcome.timingProblem(value, c.settledAt * 1000, c.now * 1000)
        ?? payerOutcome.checkedBlockProblem(value, c.checkedAt * 1000);
      if (c.refusal === null) assert.equal(why, null, c.name);
      else assert.match(why ?? '', says[c.refusal], c.name);
    }
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

/** An agent paid by `payer` in a block `days` before the stub's clock. */
function paidLongAgo(w, payer, days) {
  const block = w.data.head - 500 - Math.floor(Math.random() * 400);
  w.set('blockTimes', { ...(w.data.blockTimes || {}), [block]: w.data.nowSec - days * 86_400 });
  const agent = w.addAgent();
  const txHash = w.addTx([{ from: payer.address, to: agent.agentAddress, value: 5n * USDC }], { blockNumber: block });
  return { agent, txHash };
}

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
    // Past by the time of the block it is checked at, which the stub puts a minute before its clock.
    const lapsed = await post(oracle, agent.didHash, txHash, await signOutcome(agent.didHash, txHash, payer, { deadline: world.data.nowSec - 3_600 }));
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
    // The payment settled 20 days before the block the signature is checked at.
    const { agent, txHash } = paidLongAgo(world, payer, 20);
    assert.equal((await oracle.call('POST', '/attest', { didHash: agent.didHash, success: false, payment: { txHash } }, AUDITOR)).status, 200);
    const r = await post(oracle, agent.didHash, txHash, await signOutcome(agent.didHash, txHash, payer));
    assert.equal(r.status, 409, r.text);
    assert.equal(r.body.code, 'outcome_recorded');
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

  test('keeps the CounterAudit packet whoever carried the outcome names, and serves it beside the outcome', async () => {
    const payer = ethers.Wallet.createRandom();
    const { agent, txHash } = paid(payer);
    const packetId = '6f1c2a40-5b7e-4c1d-9a2e-3f4b5c6d7e8f';
    const r = await post(oracle, agent.didHash, txHash, await signOutcome(agent.didHash, txHash, payer), { packetId });
    assert.equal(r.status, 200, r.text);
    assert.equal((await evidence(oracle, agent.didHash))[0].counterauditPacketId, packetId);
    const outcomes = (await oracle.call('GET', '/outcomes?since=0')).body.outcomes;
    assert.equal(outcomes.find((o) => o.txHash === txHash).counterauditPacketId, packetId);

    // In place of the credential holder's, when the payer's outcome replaces theirs.
    const replaced = paid(payer);
    const auditorPacket = '56ccbfd3-3868-4b98-8e56-97faa0aec031';
    await oracle.call('POST', '/attest', {
      didHash: replaced.agent.didHash, success: true, payment: { txHash: replaced.txHash }, packetId: auditorPacket,
    }, AUDITOR);
    const swap = await post(oracle, replaced.agent.didHash, replaced.txHash,
      await signOutcome(replaced.agent.didHash, replaced.txHash, payer), { packetId });
    assert.equal(swap.body.recorded, 'replaced', swap.text);
    assert.equal((await evidence(oracle, replaced.agent.didHash))[0].counterauditPacketId, packetId);

    // Anything not shaped like a packet id is left off, and the outcome is still taken.
    const other = paid(payer);
    const odd = await post(oracle, other.agent.didHash, other.txHash,
      await signOutcome(other.agent.didHash, other.txHash, payer), { packetId: 'not a packet' });
    assert.equal(odd.status, 200, odd.text);
    assert.equal((await evidence(oracle, other.agent.didHash))[0].counterauditPacketId, undefined);
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

  test('serves the outcomes it took at GET /outcomes, oldest first, after a cursor', async () => {
    const payer = ethers.Wallet.createRandom();
    const first = paid(payer);
    const second = paid(payer);
    for (const p of [first, second]) {
      assert.equal((await post(oracle, p.agent.didHash, p.txHash, await signOutcome(p.agent.didHash, p.txHash, payer))).status, 200);
    }
    const all = (await oracle.call('GET', '/outcomes?since=0')).body;
    assert.deepEqual(all.domain, { name: 'Sigvara', version: '1', chainId: CHAIN_ID, verifyingContract: ethers.getAddress(REPUTATION) });
    assert.equal(all.more, false);
    const times = all.outcomes.map((o) => o.acceptedAt);
    assert.deepEqual(times, [...times].sort((x, y) => x - y));
    assert.equal(new Set(times).size, times.length, 'no two share an acceptedAt');
    assert.equal(all.next, times.at(-1));
    const mine = all.outcomes.filter((o) => o.payer === payer.address);
    assert.deepEqual(mine.map((o) => o.txHash), [first.txHash, second.txHash]);
    assert.equal(mine[0].didHash, first.agent.didHash);
    assert.equal(mine[0].checkedAtBlock, world.data.head);
    assert.equal(mine[0].signature, (await evidence(oracle, first.agent.didHash))[0].payerOutcome.signature);

    const after = (await oracle.call('GET', `/outcomes?since=${mine[0].acceptedAt}`)).body.outcomes;
    assert.equal(after[0].txHash, second.txHash);
    assert.deepEqual((await oracle.call('GET', `/outcomes?since=${all.next}`)).body.outcomes, []);
    for (const bad of ['-1', '1.5', 'x', '99999999999999999']) {
      assert.equal((await oracle.call('GET', `/outcomes?since=${bad}`)).status, 400, bad);
    }
    // Not where publishing is off.
    assert.equal((await positiveOnly.call('GET', '/outcomes?since=0')).status, 404);
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

// ---- import from other operators ---------------------------------------------------------

/** Points one world at several running oracles, so they read the same chain. */
function shareWorld(world, ...oracles) {
  const files = oracles.map((o) => path.join(o.dir, 'world.json'));
  world.flush = function flush() {
    for (const f of files) fs.writeFileSync(f, JSON.stringify(this.data));
  };
  world.flush();
}

/** A peer that serves whatever the test gives it, the way a broken or dishonest operator might. */
async function fakePeer() {
  let items = [];
  const server = http.createServer((req, res) => {
    const since = Number(new URL(req.url, 'http://peer').searchParams.get('since') || 0);
    const due = items.filter((i) => !Number.isFinite(i?.acceptedAt) || i.acceptedAt > since);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ more: false, outcomes: due }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    serve: (list) => { items = list; },
    close: () => new Promise((r) => server.close(r)),
  };
}

// One summary line per peer per run, whether it read the peer or not.
const importLines = (o, peer) => o.logs().split('\n').filter(
  (l) => l.includes(`payer outcomes from ${peer}:`) || l.includes(`payer outcome import from ${peer} failed`),
);

async function waitForImports(o, peers, n) {
  const deadline = Date.now() + 15_000;
  while (peers.some((p) => importLines(o, p).length < n)) {
    if (Date.now() > deadline) throw new Error(`no import run ${n} from every peer:\n${o.logs()}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe('importing payer-signed outcomes from other operators', () => {
  const ON = { ...BASE_ENV, PAYER_OUTCOMES: 'both', PAYER_OUTCOMES_PUBLISH: 'on' };
  let world;
  let a;
  let b;
  let c;
  let peers;
  let runs = 1;

  before(async () => {
    world = new World();
    a = await startOracle({ world, env: ON });
    c = await fakePeer();
    peers = [`http://127.0.0.1:${a.port}`, c.url];
    // B checks the clock against the chain's before it imports, and one test moves the chain on.
    b = await startOracle({ world, env: { ...ON, PAYER_OUTCOMES_PEERS: peers.join(','), MAX_CLOCK_SKEW_SECONDS: '864000' } });
    shareWorld(world, a, b);
    await waitForImports(b, peers, runs);
  });

  after(async () => {
    await a.stop();
    await b.stop();
    await c.close();
  });

  const post = (o, didHash, txHash, signed) => o.call('POST', '/attest', { didHash, payment: { txHash }, payerOutcome: signed });
  const evidence = async (o, didHash) => (await o.call('GET', `/evidence/${didHash}`)).body.evidence;
  const lastRun = (peer) => importLines(b, peer).at(-1);

  async function runImport() {
    for (;;) {
      const r = await b.call('POST', '/epoch', undefined, ADMIN);
      if (r.status === 202) break;
      assert.equal(r.status, 409, r.text);
      await new Promise((res) => setTimeout(res, 50));
    }
    runs += 1;
    await waitForImports(b, peers, runs);
  }

  function paid(payer) {
    const agent = world.addAgent();
    const txHash = world.addTx([{ from: payer.address, to: agent.agentAddress, value: 5n * USDC }]);
    return { agent, txHash };
  }

  /** What GET /outcomes would serve for a signed outcome. */
  const served = (agent, txHash, signed, extra = {}) => ({
    didHash: agent.didHash, txHash, ...signed, checkedAtBlock: world.data.head, acceptedAt: Date.now(), ...extra,
  });

  test('imports an outcome another operator took, checked at the block it recorded, and serves it on', async () => {
    const payer = ethers.Wallet.createRandom();
    const { agent, txHash } = paid(payer);
    assert.equal((await post(a, agent.didHash, txHash, await signOutcome(agent.didHash, txHash, payer))).status, 200);
    const [taken] = await evidence(a, agent.didHash);
    assert.equal((await evidence(b, agent.didHash)).length, 0, 'B has not seen it yet');

    await runImport();
    assert.match(lastRun(peers[0]), /1 imported, 0 refused/);
    const [e] = await evidence(b, agent.didHash);
    assert.equal(e.success, true);
    assert.equal(e.outcomeSource, 'payer_signed');
    assert.equal(e.leaf, taken.leaf, 'the same leaf on both operators');
    assert.equal(e.payerOutcome.signature, taken.payerOutcome.signature);
    assert.equal(e.payerOutcome.checkedAtBlock, taken.payerOutcome.checkedAtBlock);
    const onward = (await b.call('GET', '/outcomes?since=0')).body.outcomes;
    assert.ok(onward.some((o) => o.txHash === txHash), 'B serves it to the next operator');

    // Held now, so the next run checks nothing again.
    await runImport();
    assert.match(lastRun(peers[0]), /0 imported, 0 refused/);
  });

  test('carries the CounterAudit packet a peer serves beside an outcome', async () => {
    const payer = ethers.Wallet.createRandom();
    const { agent, txHash } = paid(payer);
    const packetId = '0b7d9f3e-2c4a-4e8b-8f1d-5a6b7c8d9e0f';
    const r = await a.call('POST', '/attest', {
      didHash: agent.didHash, payment: { txHash }, payerOutcome: await signOutcome(agent.didHash, txHash, payer), packetId,
    });
    assert.equal(r.status, 200, r.text);
    await runImport();
    const [e] = await evidence(b, agent.didHash);
    assert.equal(e.outcomeSource, 'payer_signed');
    assert.equal(e.counterauditPacketId, packetId);
  });

  test('refuses what a peer serves that is forged, malformed or checked before its payment, and takes what is genuine', async () => {
    const payer = ethers.Wallet.createRandom();
    const forgedFor = paid(payer);
    const earlyFor = paid(payer);
    const genuineFor = paid(payer);
    const forged = await signOutcome(forgedFor.agent.didHash, forgedFor.txHash, payer, { signer: ethers.Wallet.createRandom() });
    const early = await signOutcome(earlyFor.agent.didHash, earlyFor.txHash, payer);
    const genuine = await signOutcome(genuineFor.agent.didHash, genuineFor.txHash, payer);
    const t = Date.now();
    c.serve([
      { nonsense: true },
      served(forgedFor.agent, forgedFor.txHash, forged, { acceptedAt: t + 1 }),
      served(earlyFor.agent, earlyFor.txHash, early, { acceptedAt: t + 2, checkedAtBlock: world.data.head - 100 }),
      served(genuineFor.agent, genuineFor.txHash, genuine, { acceptedAt: t + 3 }),
    ]);
    await runImport();
    assert.match(lastRun(c.url), /1 imported, 3 refused/);
    assert.match(b.logs(), new RegExp(`refused ${forgedFor.txHash} from ${c.url}: bad_signature`));
    assert.match(b.logs(), new RegExp(`refused ${earlyFor.txHash} from ${c.url}: bad_checked_block`));
    assert.equal((await evidence(b, forgedFor.agent.didHash)).length, 0, 'a forged outcome credits nothing');
    assert.equal((await evidence(b, genuineFor.agent.didHash))[0].success, true, 'a peer needs no trust to carry a real one');
  });

  test('checks a smart account at the block the accepting operator recorded, after the account rotates its owner', async () => {
    const owner = ethers.Wallet.createRandom();
    const account = ethers.Wallet.createRandom().address;
    const key = account.toLowerCase();
    world.set('accounts', { ...(world.data.accounts || {}), [key]: { owners: [{ fromBlock: 0, owner: owner.address }] } });
    const agent = world.addAgent();
    const txHash = world.addTx([{ from: account, to: agent.agentAddress, value: 5n * USDC }]);
    const asAccount = { address: account, signTypedData: (...x) => owner.signTypedData(...x) };
    assert.equal((await post(a, agent.didHash, txHash, await signOutcome(agent.didHash, txHash, asAccount, { signer: owner }))).status, 200);
    const checkedAt = (await evidence(a, agent.didHash))[0].payerOutcome.checkedAtBlock;

    // The account changes hands after A accepted, and the chain moves on.
    world.set('accounts', {
      ...world.data.accounts,
      [key]: { owners: [{ fromBlock: 0, owner: owner.address }, { fromBlock: checkedAt + 1, owner: ethers.Wallet.createRandom().address }] },
    });
    world.set('head', world.data.head + 20);
    await runImport();
    const [e] = await evidence(b, agent.didHash);
    assert.equal(e.success, true, 'valid at the recorded block, so B agrees with A');
    assert.equal(e.payerOutcome.checkedAtBlock, checkedAt);
  });

  test('waits for a block this node has not confirmed, and passes over an outcome that stays stuck', async () => {
    const payer = ethers.Wallet.createRandom();
    const ahead = paid(payer);
    const stuck = paid(payer);
    const behind = paid(payer);
    const t = Date.now();
    c.serve([
      served(ahead.agent, ahead.txHash, await signOutcome(ahead.agent.didHash, ahead.txHash, payer), { acceptedAt: t + 1, checkedAtBlock: world.data.head + 5 }),
    ]);
    await runImport();
    assert.match(lastRun(c.url), /stopped early \(not_yet_confirmed\)/);
    world.set('head', world.data.head + 5);
    await runImport();
    assert.match(lastRun(c.url), /1 imported/);
    assert.equal((await evidence(b, ahead.agent.didHash))[0].success, true);

    // One that never becomes checkable holds up the rest for a few runs, not for good.
    c.serve([
      served(stuck.agent, stuck.txHash, await signOutcome(stuck.agent.didHash, stuck.txHash, payer), { acceptedAt: t + 2, checkedAtBlock: world.data.head + 1_000_000 }),
      served(behind.agent, behind.txHash, await signOutcome(behind.agent.didHash, behind.txHash, payer), { acceptedAt: t + 3 }),
    ]);
    await runImport();
    await runImport();
    assert.equal((await evidence(b, behind.agent.didHash)).length, 0);
    await runImport();
    assert.match(b.logs(), new RegExp(`passing over ${stuck.txHash}`));
    assert.equal((await evidence(b, behind.agent.didHash))[0].success, true);
  });

  test('judges the replacement window by this operator\'s own head, as a post here would be', async () => {
    const payer = ethers.Wallet.createRandom();
    const fresh = paid(payer);
    const old = paidLongAgo(world, payer, 20);
    for (const p of [fresh, old]) {
      // B holds an auditor's outcome; A holds none, so it takes the payer's outright.
      assert.equal((await b.call('POST', '/attest', { didHash: p.agent.didHash, success: false, payment: { txHash: p.txHash } }, AUDITOR)).status, 200);
      assert.equal((await post(a, p.agent.didHash, p.txHash, await signOutcome(p.agent.didHash, p.txHash, payer))).body.recorded, 'set');
    }
    await runImport();
    assert.equal((await evidence(b, fresh.agent.didHash))[0].success, true, 'inside the window, the payer\'s replaces the auditor\'s');
    assert.equal((await evidence(b, old.agent.didHash))[0].success, false, 'outside it, the auditor\'s stays final');
    assert.match(b.logs(), new RegExp(`refused ${old.txHash} from http://127.0.0.1:${a.port}: outcome_recorded`));
  });

  test('does not let a peer reopen the window by naming an old block', async () => {
    const payer = ethers.Wallet.createRandom();
    // Paid 25 days ago; B holds an auditor's outcome for it.
    const old = paidLongAgo(world, payer, 25);
    const paidBlock = world.data.receipts[old.txHash].blockNumber;
    assert.equal((await b.call('POST', '/attest', { didHash: old.agent.didHash, success: false, payment: { txHash: old.txHash } }, AUDITOR)).status, 200);
    // A fresh signature, served as if checked at the payment's own block.
    const fresh = await signOutcome(old.agent.didHash, old.txHash, payer);
    // One dated back to a day after the payment, served as if checked then: a payer and a peer working together.
    const day1 = world.data.nowSec - 24 * 86_400;
    const dayBlock = paidBlock + 1;
    world.set('blockTimes', { ...world.data.blockTimes, [dayBlock]: day1 });
    const backdated = await signOutcome(old.agent.didHash, old.txHash, payer, { signedAt: day1, deadline: day1 + 29 * 86_400 });
    const t = Date.now();
    c.serve([
      served(old.agent, old.txHash, fresh, { acceptedAt: t + 1, checkedAtBlock: paidBlock }),
      served(old.agent, old.txHash, backdated, { acceptedAt: t + 2, checkedAtBlock: dayBlock }),
    ]);
    await runImport();
    assert.match(lastRun(c.url), /0 imported, 2 refused/);
    assert.match(b.logs(), new RegExp(`refused ${old.txHash} from ${c.url}: outcome_window`));
    assert.match(b.logs(), new RegExp(`refused ${old.txHash} from ${c.url}: outcome_recorded`));
    assert.equal((await evidence(b, old.agent.didHash))[0].success, false, 'the auditor\'s outcome stays');
  });

  test('keeps what it holds when a peer serves a different outcome for the same payment, and counts it', async () => {
    const payer = ethers.Wallet.createRandom();
    const { agent, txHash } = paid(payer);
    assert.equal((await post(b, agent.didHash, txHash, await signOutcome(agent.didHash, txHash, payer))).status, 200);
    const t = Date.now();
    c.serve([
      served(agent, txHash, await signOutcome(agent.didHash, txHash, payer), { acceptedAt: t + 1 }),
      served(agent, txHash, await signOutcome(agent.didHash, txHash, payer, { outcome: 2 }), { acceptedAt: t + 2 }),
    ]);
    await runImport();
    assert.match(lastRun(c.url), /0 imported, 0 refused/);
    assert.match(b.logs(), new RegExp(`a peer serves outcome 2 for ${txHash}`));
    assert.match((await b.call('GET', '/metrics')).text, /sigvara_oracle_payer_outcome_conflicts_total 1/);
    assert.equal((await evidence(b, agent.didHash))[0].success, true);
  });

  test('judges the deadline at the recorded block when the import arrives within the grace', async () => {
    const payer = ethers.Wallet.createRandom();
    const { agent, txHash } = paid(payer);
    const { head, nowSec } = world.data;
    // The payment's block and the one A checks at keep their times when the chain moves on.
    world.set('blockTimes', { ...(world.data.blockTimes || {}), [head - 10]: nowSec - 60, [head]: nowSec - 60 });
    const signed = await signOutcome(agent.didHash, txHash, payer, { deadline: nowSec + 600 });
    assert.equal((await post(a, agent.didHash, txHash, signed)).status, 200);
    // An hour past the deadline by the chain's clock: B was behind, within the six-hour grace.
    world.set('nowSec', nowSec + 600 + 3_600);
    world.set('head', head + 1_000);
    try {
      await runImport();
      assert.equal((await evidence(b, agent.didHash))[0].success, true);
    } finally {
      world.set('nowSec', nowSec);
    }
  });

  test('refuses an outcome a peer passes on past the grace, naming a block before the deadline', async () => {
    const payer = ethers.Wallet.createRandom();
    const { agent, txHash } = paid(payer);
    const { head, nowSec } = world.data;
    world.set('blockTimes', { ...(world.data.blockTimes || {}), [head - 10]: nowSec - 60, [head]: nowSec - 60 });
    // Signed with a ten-minute deadline; the peer held it and serves it two days later as if it had
    // checked it at the head block, before the deadline. Nothing proves when it took it (review M-02).
    const signed = await signOutcome(agent.didHash, txHash, payer, { deadline: nowSec + 600 });
    world.set('nowSec', nowSec + 2 * 86_400);
    world.set('head', head + 50_000);
    try {
      c.serve([served(agent, txHash, signed, { acceptedAt: Date.now(), checkedAtBlock: head })]);
      await runImport();
      assert.match(lastRun(c.url), /0 imported, 1 refused/);
      assert.match(b.logs(), new RegExp(`refused ${txHash} from ${c.url}: outcome_window`));
      assert.equal((await evidence(b, agent.didHash)).length, 0, 'it credits nothing on B');
    } finally {
      world.set('nowSec', nowSec);
    }
  });
});

test('refuses to start importing outcomes when it takes none', async () => {
  const { code, log } = await runToExit({
    world: new World(),
    env: { ...BASE_ENV, PAYER_OUTCOMES_PEERS: 'https://checker.example' },
  });
  assert.equal(code, 1);
  assert.match(log, /PAYER_OUTCOMES_PEERS needs PAYER_OUTCOMES/);
});

test('refuses to start taking payer outcomes without the chain id they are signed for', async () => {
  const { code, log } = await runToExit({
    world: new World(),
    env: { ...BASE_ENV, EXPECTED_CHAIN_ID: '', PAYER_OUTCOMES: 'positive' },
  });
  assert.equal(code, 1);
  assert.match(log, /PAYER_OUTCOMES=positive needs EXPECTED_CHAIN_ID/);
});
