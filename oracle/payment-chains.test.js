'use strict';

// Payment chains (ADR 0009): payments that settle on a chain other than the scored one, Base Sepolia
// first. What is tested here is what differs from the scored chain's scan: the config, the delay
// before a payment counts, the conversion into the scored chain's fee units, the hold when a scan
// is behind, the contract-recipient rule, finality by tag, and a leaf that names its chain.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ethers } = require('ethers');
const pc = require('./payment-chains');
const merkle = require('./merkle');
const { TRANSFER_TOPIC } = require('./payments');
const explorer = require('../site/assets/explorer.js');

const BASE_SEPOLIA = 84532;
const ARC = 5042002;
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const RPC = 'https://base-sepolia.example/v2/SECRET-KEY';

const env = (over = {}) => ({
  PAYMENT_CHAIN_IDS: String(BASE_SEPOLIA),
  [`PAYMENT_CHAIN_${BASE_SEPOLIA}_RPC_URL`]: RPC,
  [`PAYMENT_CHAIN_${BASE_SEPOLIA}_ASSET`]: USDC,
  [`PAYMENT_CHAIN_${BASE_SEPOLIA}_FROM_BLOCK`]: '1000',
  [`PAYMENT_CHAIN_${BASE_SEPOLIA}_FEE_UNIT`]: '100000000',
  [`PAYMENT_CHAIN_${BASE_SEPOLIA}_MODE`]: 'on',
  ...over,
});
const config = (over = {}, ctx = { scoredChainId: ARC }) => pc.readConfig(env(over), ctx);

// ---- config ------------------------------------------------------------------------------------

test('no PAYMENT_CHAIN_IDS means no payment chains', () => {
  const cfg = pc.readConfig({}, { scoredChainId: ARC });
  assert.deepEqual(cfg.chains, []);
});

test('a payment chain is read with its defaults', () => {
  const [c] = config().chains;
  assert.equal(c.chainId, BASE_SEPOLIA);
  assert.equal(c.asset, ethers.getAddress(USDC));
  assert.equal(c.fromBlock, 1000);
  assert.equal(c.feeUnit, 100_000_000n);
  assert.equal(c.minAmount, 0n);
  assert.equal(c.delayMs, 3_600_000);
  assert.equal(c.chunkSize, 200);
  assert.equal(c.mode, 'on');
  assert.equal(pc.readConfig(env({ [`PAYMENT_CHAIN_${BASE_SEPOLIA}_MODE`]: undefined }), { scoredChainId: ARC }).chains[0].mode, 'shadow');
});

test('a payment chain refuses anything it cannot use, and never says the RPC URL', () => {
  const p = `PAYMENT_CHAIN_${BASE_SEPOLIA}_`;
  const cases = [
    [{ [`${p}RPC_URL`]: '' }, /RPC_URL is required/],
    [{ [`${p}RPC_URL`]: 'wss://x' }, /must be https/],
    [{ [`${p}ASSET`]: 'usdc' }, /ASSET must be an address/],
    [{ [`${p}FROM_BLOCK`]: '' }, /FROM_BLOCK is required/],
    [{ [`${p}FEE_UNIT`]: '' }, /FEE_UNIT is required/],
    [{ [`${p}FEE_UNIT`]: '0' }, /FEE_UNIT must be at least 1/],
    [{ [`${p}FEE_UNIT`]: '1.5' }, /whole number/],
    [{ [`${p}MODE`]: 'enabled' }, /MODE must be/],
    [{ [`${p}DELAY_SECONDS`]: '600' }, /DELAY_SECONDS must be at least 1800/],
    [{ [`${p}RPC_URL`]: 'http://base-sepolia.example/v2/SECRET-KEY' }, /must be https/],
    [{ [`${p}MAX_BLOCKS`]: '0' }, /MAX_BLOCKS must be at least 1/],
    [{ PAYMENT_CHAIN_IDS: `${BASE_SEPOLIA},${BASE_SEPOLIA}` }, /listed twice/],
    [{ PAYMENT_CHAIN_IDS: 'base' }, /whole number/],
  ];
  for (const [over, re] of cases) {
    assert.throws(() => config(over), (err) => re.test(err.message) && !err.message.includes('SECRET-KEY'), JSON.stringify(over));
  }
  assert.throws(() => config({ PAYMENT_CHAIN_IDS: String(ARC) }), /scored chain/);
  assert.throws(() => pc.readConfig(env(), { scoredChainId: ARC, paymentRequired: false }), /PAYMENT_VERIFICATION=required/);
});

test('a shadow scan keeps its own cursor, so turning a chain on starts at FROM_BLOCK', () => {
  const on = config().chains[0];
  const shadow = config({ [`PAYMENT_CHAIN_${BASE_SEPOLIA}_MODE`]: 'shadow' }).chains[0];
  assert.notEqual(pc.stateKey(on), pc.stateKey(shadow));
});

// ---- whose address it is -----------------------------------------------------------------------

test('only an account a key controls counts: no code, or an EIP-7702 delegation', () => {
  assert.equal(pc.recipientCodeOk('0x'), true);
  assert.equal(pc.recipientCodeOk(`0xef0100${'ab'.repeat(20)}`), true);
  assert.equal(pc.recipientCodeOk(`0xEF0100${'AB'.repeat(20)}`), true);
  assert.equal(pc.recipientCodeOk('0x6080604052'), false);
  // A designator with anything after the address is not a designator.
  assert.equal(pc.recipientCodeOk(`0xef0100${'ab'.repeat(20)}00`), false);
});

// ---- which payments count, and how much ---------------------------------------------------------

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;
const arcEvent = (ts) => Object.freeze({ txHash: ethers.hexlify(ethers.randomBytes(32)), payer: ethers.Wallet.createRandom().address, amount: '5000000000000000000', ts, success: null });
const baseEvent = (ts, over = {}) => Object.freeze({ ...arcEvent(ts), amount: '250000000', chainId: BASE_SEPOLIA, ...over });

test('an agent paid only on the scored chain gets back the very same array', () => {
  const events = Object.freeze([arcEvent(NOW - 10), arcEvent(NOW)]);
  assert.equal(pc.eventsAt(events, NOW, config()), events);
  assert.equal(pc.forScoring(events, 100_000_000n, config()), events);
});

test("a payment chain's payment counts once it is older than the chain's delay", () => {
  const old = baseEvent(NOW - HOUR - 1);
  const edge = baseEvent(NOW - HOUR);
  const young = baseEvent(NOW - HOUR + 1);
  const arc = arcEvent(NOW);
  const got = pc.eventsAt([arc, old, edge, young], NOW, config());
  // The scored chain's payments in stored order, then the payment chain's in a fixed order.
  assert.deepEqual(got, [arc, old, edge]);
  assert.ok(Object.isFrozen(got));
});

test("a payment from a chain this oracle no longer reads, or reads in shadow, does not count", () => {
  const e = baseEvent(NOW - 2 * HOUR);
  const arc = arcEvent(NOW);
  // With every payment chain removed from the config, the scored chain's payments count as before.
  assert.deepEqual(pc.eventsAt([arc, e], NOW, pc.readConfig({}, { scoredChainId: ARC })), [arc]);
  assert.deepEqual(pc.eventsAt([e], NOW, pc.readConfig({}, { scoredChainId: ARC })), []);
  assert.deepEqual(pc.eventsAt([e], NOW, config({ [`PAYMENT_CHAIN_${BASE_SEPOLIA}_MODE`]: 'shadow' })), []);
});

test("a payment chain's amount is converted into the scored chain's fee units for the score only", () => {
  // 100 USDC a point on Base (6 decimals), 100 SVR a point on the scored chain (18 decimals).
  const e = baseEvent(NOW - 2 * HOUR, { amount: '250000000' }); // 250 USDC
  const [scored] = pc.forScoring([e], 100n * 10n ** 18n, config());
  assert.equal(scored.amount, (250n * 10n ** 18n).toString());
  assert.equal(e.amount, '250000000', 'the stored amount, which the leaf commits to, is untouched');
});

// ---- the hold when a scan is behind -------------------------------------------------------------

test('an operator whose payment chain scan has not reached now less the delay scores nothing', () => {
  const cfg = config();
  const key = pc.stateKey(cfg.chains[0]);
  const at = (ts) => (k) => (k === key ? { lastBlock: 1, lastBlockTs: ts } : null);
  assert.equal(pc.behind(cfg, () => null, NOW).length, 1, 'never scanned');
  assert.equal(pc.behind(cfg, at((NOW - HOUR) / 1000 - 1), NOW).length, 1, 'a second short');
  // That second exactly is not enough: the next block can carry the same whole-second time.
  assert.equal(pc.behind(cfg, at((NOW - HOUR) / 1000), NOW).length, 1, 'the second itself');
  assert.deepEqual(pc.behind(cfg, at((NOW - HOUR) / 1000 + 1), NOW), []);
  // A chain in shadow mode decides nothing, so it holds nothing.
  assert.deepEqual(pc.behind(config({ [`PAYMENT_CHAIN_${BASE_SEPOLIA}_MODE`]: 'shadow' }), () => null, NOW), []);
});

test('/health shows the mode, the delay and the cursor, and never the RPC URL', () => {
  const cfg = config();
  const view = pc.publicView(cfg, () => ({ lastBlock: 7, lastBlockTs: 99 }), new Map());
  assert.deepEqual(view, [{
    chainId: BASE_SEPOLIA, mode: 'on', asset: ethers.getAddress(USDC),
    fromBlock: 1000, feeUnit: '100000000', minAmount: '0', delaySeconds: 3600,
    lastBlock: 7, lastBlockTs: 99, lastScan: null,
  }]);
  assert.ok(!JSON.stringify(view).includes('SECRET-KEY'));
});

// ---- one scan -----------------------------------------------------------------------------------

const pad = (a) => ethers.zeroPadValue(a, 32);
function transferLog({ from, to, amount, block, tx = ethers.hexlify(ethers.randomBytes(32)), asset = USDC }) {
  return {
    address: asset, topics: [TRANSFER_TOPIC, pad(from), pad(to)],
    data: ethers.toBeHex(amount, 32), blockNumber: block, transactionHash: tx, logIndex: 0, removed: false,
  };
}

/** A payment chain: the logs it holds, the code at each address, and its finalized head. */
function fakeChain({ chainId = BASE_SEPOLIA, finalized = 2000, head = 2500, logs = [], code = {} } = {}) {
  const calls = [];
  return {
    calls,
    send: async (method) => { calls.push(method); if (method === 'eth_chainId') return ethers.toQuantity(chainId); throw new Error(method); },
    getBlock: async (tag) => {
      calls.push(`getBlock ${tag}`);
      const n = tag === 'finalized' ? finalized : tag === 'latest' ? head : tag;
      return { number: n, timestamp: 1_700_000_000 + n };
    },
    getLogs: async (f) => {
      calls.push(`getLogs ${f.fromBlock}-${f.toBlock}`);
      const wanted = new Set((f.topics[2] || []).map((t) => t.toLowerCase()));
      return logs.filter((l) => l.address.toLowerCase() === f.address.toLowerCase()
        && l.blockNumber >= f.fromBlock && l.blockNumber <= f.toBlock
        && wanted.has(l.topics[2].toLowerCase()));
    },
    getCode: async (address) => code[address.toLowerCase()] ?? '0x',
  };
}
const scored = (code = {}) => ({ getCode: async (address) => code[address.toLowerCase()] ?? '0x' });

function agent() {
  return { didHash: ethers.hexlify(ethers.randomBytes(32)), agentAddress: ethers.Wallet.createRandom().address, operator: ethers.Wallet.createRandom().address };
}

function deps(over = {}) {
  const credited = [];
  return {
    credited,
    deps: {
      provider: fakeChain(),
      scoredProvider: scored(),
      agents: [],
      state: null,
      isCredited: () => false,
      credit: (c, ts) => { credited.push({ ...c, ts }); return true; },
      registeredAtMs: async () => 0,
      knownOnChain: new Map(),
      read: (_label, fn) => fn(),
      sleep: async () => {},
      ...over,
    },
  };
}

test('a scan credits a payment to an agent up to the finalized block, at that block\'s time', async () => {
  const a = agent();
  const payer = ethers.Wallet.createRandom().address;
  const provider = fakeChain({
    finalized: 2000,
    logs: [
      transferLog({ from: payer, to: a.agentAddress, amount: 1_000_000n, block: 1500 }),
      // Past the finalized block: not yet.
      transferLog({ from: payer, to: a.agentAddress, amount: 2_000_000n, block: 2100 }),
    ],
  });
  const { deps: d, credited } = deps({ provider, agents: [a] });
  const out = await pc.scanChain(config().chains[0], d);
  assert.equal(out.credited, 1);
  assert.equal(credited.length, 1);
  assert.equal(credited[0].amount, '1000000');
  assert.equal(credited[0].payer, ethers.getAddress(payer));
  assert.equal(credited[0].ts, (1_700_000_000 + 1500) * 1000);
  assert.equal(out.from, 1000);
  assert.equal(out.to, 2000);
  assert.deepEqual({ lastBlock: out.state.lastBlock, lastBlockTs: out.state.lastBlockTs }, { lastBlock: 2000, lastBlockTs: 1_700_002_000 });
  assert.ok(!provider.calls.some((c) => /^getLogs \d+-(\d+)$/.test(c) && Number(c.split('-')[1]) > 2000));
});

test('a scan resumes after its cursor and asks in chunks the endpoint accepts', async () => {
  const provider = fakeChain({ finalized: 1600 });
  const { deps: d } = deps({ provider, agents: [agent()], state: { lastBlock: 1199, lastBlockTs: 1 } });
  const out = await pc.scanChain(config().chains[0], d);
  assert.equal(out.from, 1200);
  const ranges = provider.calls.filter((c) => c.startsWith('getLogs')).map((c) => c.slice(8));
  assert.deepEqual(ranges, ['1200-1399', '1400-1599', '1600-1600']);
});

test('a payment to an agent whose address is a contract on either chain is skipped', async () => {
  const onBase = agent();
  const onArc = agent();
  const delegated = agent();
  const payer = ethers.Wallet.createRandom().address;
  const provider = fakeChain({
    logs: [onBase, onArc, delegated].map((x) => transferLog({ from: payer, to: x.agentAddress, amount: 1_000_000n, block: 1500 })),
    code: {
      [onBase.agentAddress.toLowerCase()]: '0x6080604052',
      [delegated.agentAddress.toLowerCase()]: `0xef0100${'cd'.repeat(20)}`,
    },
  });
  const { deps: d, credited } = deps({
    provider,
    scoredProvider: scored({ [onArc.agentAddress.toLowerCase()]: '0x6080604052' }),
    agents: [onBase, onArc, delegated],
  });
  const out = await pc.scanChain(config().chains[0], d);
  assert.deepEqual(credited.map((c) => c.didHash), [delegated.didHash]);
  assert.equal(out.reasons.contract_recipient, 2);
});

test('the rules of the scored chain apply: a payment from the agent or its operator is refused', async () => {
  const a = agent();
  const provider = fakeChain({
    logs: [
      transferLog({ from: a.operator, to: a.agentAddress, amount: 1_000_000n, block: 1500 }),
      transferLog({ from: ethers.Wallet.createRandom().address, to: a.agentAddress, amount: 9n, block: 1501 }),
    ],
  });
  const minimum = config({ [`PAYMENT_CHAIN_${BASE_SEPOLIA}_MIN_AMOUNT`]: '10000' }).chains[0];
  const { deps: d, credited } = deps({ provider, agents: [a] });
  const out = await pc.scanChain(minimum, d);
  assert.equal(credited.length, 0);
  assert.deepEqual(out.reasons, { self_payment: 1, below_minimum: 1 });
});

test('in shadow mode a scan reports what it would credit and credits nothing', async () => {
  const a = agent();
  const provider = fakeChain({ logs: [transferLog({ from: ethers.Wallet.createRandom().address, to: a.agentAddress, amount: 1_000_000n, block: 1500 })] });
  const { deps: d, credited } = deps({ provider, agents: [a] });
  const out = await pc.scanChain(config({ [`PAYMENT_CHAIN_${BASE_SEPOLIA}_MODE`]: 'shadow' }).chains[0], d);
  assert.equal(out.credited, 1);
  assert.equal(credited.length, 0);
  assert.equal(out.state.lastBlock, 2000);
});

test('a scan refuses an endpoint that serves another chain, before reading anything', async () => {
  const provider = fakeChain({ chainId: 8453 });
  const { deps: d } = deps({ provider, agents: [agent()] });
  await assert.rejects(pc.scanChain(config().chains[0], d), /serves chain 8453/);
  assert.deepEqual(provider.calls, ['eth_chainId']);
});

test('an empty scan is believed only once the same filter finds a payment already held', async () => {
  const a = agent();
  const known = { txHash: ethers.hexlify(ethers.randomBytes(32)), blockNumber: 900, chainId: BASE_SEPOLIA };
  // The held payment is not on this chain any more: the canary fails and the cursor stays.
  const { deps: d } = deps({ provider: fakeChain(), agents: [a], knownOnChain: new Map([[a.didHash, [known]]]) });
  const out = await pc.scanChain(config().chains[0], d);
  assert.equal(out.canary, 'failed');
  assert.equal(out.state, null);
  // And when it is there, the range was really empty.
  const provider = fakeChain({ logs: [transferLog({ from: ethers.Wallet.createRandom().address, to: a.agentAddress, amount: 1n, block: 900, tx: known.txHash })] });
  const again = await pc.scanChain(config().chains[0], deps({ provider, agents: [a], knownOnChain: new Map([[a.didHash, [known]]]) }).deps);
  assert.equal(again.canary, 'passed');
  assert.equal(again.state.lastBlock, 2000);
});

// ---- the leaf -----------------------------------------------------------------------------------

const VECTOR = Object.freeze({
  chainId: BASE_SEPOLIA, txHash: `0x${'ab'.repeat(32)}`, payer: `0x${'11'.repeat(20)}`,
  amount: '1000000', ts: 1_700_000_000_000, success: null,
});

test("a payment chain's leaf puts the chain first, and matches the ABI encoding of that", () => {
  const inner = ethers.AbiCoder.defaultAbiCoder().encode(
    ['uint256', 'bytes32', 'address', 'uint256', 'uint256', 'uint8'],
    [BigInt(BASE_SEPOLIA), VECTOR.txHash, ethers.getAddress(VECTOR.payer), 1_000_000n, 1_700_000_000n, 2],
  );
  assert.equal(merkle.leafFor(VECTOR), ethers.keccak256(ethers.keccak256(inner)));
  // Pinned, so a change to the encoding cannot pass unnoticed.
  assert.equal(merkle.leafFor(VECTOR), '0x103dc346c3ba80385b6ece79600032b4a0af08aabdc9df0a63903f7e39ff4036');
  const { chainId, ...onScoredChain } = VECTOR;
  assert.equal(merkle.leafFor(onScoredChain), '0xe5b9c0e3fd34ce7bf8d3c33f2ca52a295e71bd23366ddbf6d79f369e79c1adfb',
    "the scored chain's leaf is unchanged");
  assert.throws(() => merkle.leafFor({ ...VECTOR, chainId: -1 }), /not a chain id/);
});

test("the browser rebuilds a payment chain's leaf, and a root over a delayed payment", () => {
  const served = (e) => ({
    ...(e.chainId != null ? { chainId: e.chainId } : {}),
    txHash: e.txHash, payer: e.payer, amount: e.amount, settledAt: merkle.settledSeconds(e), success: e.success,
  });
  assert.equal(explorer.leafOf(served(VECTOR)), merkle.leafFor(VECTOR));

  // A proposal at NOW committed to the Arc payment and the Base payment old enough by then.
  const arc = arcEvent(NOW - 10 * 60_000);
  const base = baseEvent(NOW - 2 * HOUR);
  const youngBase = baseEvent(NOW - 30 * 60_000);
  const root = merkle.rootFor(pc.eventsAt([arc, base, youngBase], NOW, config()));
  const list = [arc, base, youngBase].map(served);
  const delays = { [BASE_SEPOLIA]: 3600 };
  const m = explorer.matchRoot(list, root, { at: NOW / 1000, delays });
  assert.ok(m, 'reproduced at the proposal time');
  assert.equal(m.events.length, 2);
  assert.ok(explorer.matchRoot(list, root, { delays }), 'and found among the candidate cut-offs');
  assert.equal(explorer.matchRoot(list, root, { at: NOW / 1000 }), null, 'without the delay it is not');
});

// ---- the store ----------------------------------------------------------------------------------

function inChild(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigvara-paychain-'));
  try {
    const stdout = execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, ORACLE_STATE_PATH: path.join(dir, 'state.json') },
      cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    // The store logs too; the answer is the last line.
    return JSON.parse(stdout.trim().split('\n').at(-1));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the store keeps a payment chain\'s credits apart and out of the outcome paths, and saves them', () => {
  const out = inChild(`
    const s = require('./store');
    const did = '0x' + 'aa'.repeat(32), tx = '0x' + 'bb'.repeat(32), payer = '0x' + '11'.repeat(20);
    const r = {};
    r.base = s.creditPayment(did, tx, '1000000', payer, null, 1, null, 7, ${BASE_SEPOLIA});
    r.baseAgain = s.creditPayment(did, tx, '1000000', payer, null, 1, null, 7, ${BASE_SEPOLIA});
    r.creditedOnScored = s.isCredited(tx, did, payer);
    r.arc = s.creditPayment(did, tx, '5', payer, null, 2, null, 8);
    r.outcome = s.setPaymentOutcome(did, tx, payer, true);
    r.chainIds = s.getPaymentEvents(did).map((e) => e.chainId ?? null);
    r.successes = s.getPaymentEvents(did).map((e) => e.success);
    s.setPaymentChainScanState('${BASE_SEPOLIA}', { lastBlock: 9, lastBlockTs: 10 });
    s.persist();
    for (const k of [...s.usedPaymentTxs]) s.usedPaymentTxs.delete(k);
    s.paymentEvents.clear();
    s.setPaymentChainScanState('${BASE_SEPOLIA}', null);
    s.load();
    r.reloaded = s.getPaymentEvents(did).map((e) => e.chainId ?? null);
    r.cursor = s.getPaymentChainScanState('${BASE_SEPOLIA}');
    r.baseAfterLoad = s.isCredited(tx, did, payer, ${BASE_SEPOLIA});
    console.log(JSON.stringify(r));
  `);
  assert.equal(out.base, true);
  assert.equal(out.baseAgain, false, 'a payment chain credit is refused a second time');
  assert.equal(out.creditedOnScored, false, 'and does not mark the same hash used on the scored chain');
  assert.equal(out.arc, true);
  // The credentialed outcome goes to the scored chain's payment, never the payment chain's.
  assert.equal(out.outcome, 'set');
  assert.deepEqual(out.chainIds, [BASE_SEPOLIA, null]);
  assert.deepEqual(out.successes, [null, true]);
  assert.deepEqual(out.reloaded, [BASE_SEPOLIA, null]);
  assert.deepEqual(out.cursor, { lastBlock: 9, lastBlockTs: 10 });
  assert.equal(out.baseAfterLoad, true);
});

test('a stored payment with a chain id that is not one is dropped on load', () => {
  const { paymentEventError } = require('./store');
  const good = { txHash: `0x${'ab'.repeat(32)}`, payer: `0x${'11'.repeat(20)}`, amount: '1', ts: 1, success: null };
  assert.equal(paymentEventError({ ...good, chainId: BASE_SEPOLIA }), null);
  assert.match(paymentEventError({ ...good, chainId: '84532' }), /chainId/);
  assert.match(paymentEventError({ ...good, chainId: 0 }), /chainId/);
});

// ---- fixes from the review of this change --------------------------------------------------------

test('a payment made before the agent registered is skipped, so the scan time cannot decide it', async () => {
  const a = agent();
  const payer = ethers.Wallet.createRandom().address;
  const provider = fakeChain({
    logs: [
      transferLog({ from: payer, to: a.agentAddress, amount: 1_000_000n, block: 1500 }),
      transferLog({ from: payer, to: a.agentAddress, amount: 2_000_000n, block: 1700 }),
    ],
  });
  // Registered between the two: block 1600's time.
  const { deps: d, credited } = deps({ provider, agents: [a], registeredAtMs: async () => (1_700_000_000 + 1600) * 1000 });
  const out = await pc.scanChain(config().chains[0], d);
  assert.deepEqual(credited.map((c) => c.amount), ['2000000']);
  assert.equal(out.reasons.before_registration, 1);
});

test('a catch-up scan covers at most MAX_BLOCKS and moves its cursor that far', async () => {
  const provider = fakeChain({ finalized: 9000 });
  const capped = config({ [`PAYMENT_CHAIN_${BASE_SEPOLIA}_MAX_BLOCKS`]: '500' }).chains[0];
  const { deps: d } = deps({ provider, agents: [agent()] });
  const out = await pc.scanChain(capped, d);
  assert.equal(out.to, 1499);
  assert.deepEqual({ lastBlock: out.state.lastBlock, lastBlockTs: out.state.lastBlockTs }, { lastBlock: 1499, lastBlockTs: 1_700_001_499 });
});

test('two operators that credited the same payments in a different order commit to the same root', () => {
  const cfg = config();
  const old = arcEvent(NOW - 5 * HOUR);
  const y = baseEvent(NOW - 3 * HOUR);
  const x = arcEvent(NOW - 2 * HOUR);
  const a = Object.freeze([old, y, x]);
  const b = Object.freeze([old, x, y]);
  assert.notEqual(merkle.rootFor(a), merkle.rootFor(b), 'in storage order they differ');
  assert.deepEqual(pc.eventsAt(a, NOW, cfg), pc.eventsAt(b, NOW, cfg));
  assert.equal(merkle.rootFor(pc.eventsAt(a, NOW, cfg)), merkle.rootFor(pc.eventsAt(b, NOW, cfg)));
});

test('the same stored array and the same counted set give back the same array, so caches hit', () => {
  const cfg = config();
  const events = Object.freeze([arcEvent(NOW - 3 * HOUR), baseEvent(NOW - 2 * HOUR)]);
  const first = pc.eventsAt(events, NOW, cfg);
  assert.equal(first.length, 2);
  assert.equal(pc.eventsAt(events, NOW + 60_000, cfg), first);
  // Before the Base payment counts: a different set, and a different array.
  assert.equal(pc.eventsAt(events, NOW - 90 * 60_000, cfg).length, 1);
});

test('an RPC error is logged by its code and short message, never with the URL', () => {
  const err = Object.assign(new Error(`server response 429 Too Many Requests (request={ }, info={ "requestUrl": "${RPC}" }, code=SERVER_ERROR)`), {
    code: 'SERVER_ERROR', shortMessage: 'server response 429 Too Many Requests',
  });
  const out = pc.rpcError(err, RPC);
  assert.equal(out.message, 'server response 429 Too Many Requests');
  assert.equal(out.code, 'SERVER_ERROR');
  const bare = pc.rpcError(new Error(`cannot reach ${RPC} (info={})`), RPC);
  assert.ok(!bare.message.includes('SECRET-KEY'));
  // The JSON-RPC error's code is kept, its text is not.
  const ranged = pc.rpcError(Object.assign(new Error('could not coalesce error (error={ })'), {
    shortMessage: 'could not coalesce error', error: { code: -32614, message: `limited to 200 for ${RPC}` },
  }), RPC);
  assert.equal(ranged.message, 'could not coalesce error (rpc -32614)');
});

test('an RPC URL is https, or http only to this host or a private network', () => {
  const ok = (url) => () => config({ [`PAYMENT_CHAIN_${BASE_SEPOLIA}_RPC_URL`]: url });
  for (const url of ['http://127.0.0.1:8545', 'http://localhost:8545', 'http://base-node:8545', 'http://10.0.0.5:8545', 'http://192.168.1.9', 'http://172.20.0.3:8545']) {
    assert.doesNotThrow(ok(url), url);
  }
  for (const url of ['http://base.example.com/KEY', 'http://8.8.8.8:8545', 'http://172.32.0.1',
    'http://10.attacker.example/KEY', 'http://127.0.0.1.nip.io/KEY', 'http://192.168.evil.com/KEY']) {
    assert.throws(ok(url), /must be https/, url);
  }
});

test('a score is cut at a whole minute, and a checker finds that cut from the proposal alone', () => {
  const { evidenceAsOf } = require('./evidence-as-of');
  const cfg = config();
  const C = NOW + 25_000;          // the primary's clock when it scored this agent
  const T = pc.cutFor(C, cfg);
  assert.equal(T, NOW - 60_000, 'a whole minute, one before');
  assert.equal(pc.cutFor(C, pc.readConfig({}, { scoredChainId: ARC })), C, 'no cut without payment chains');
  const P = C + 3 * 60_000;        // its proposal transaction's block
  const old = arcEvent(T - 5 * HOUR);
  const arcLate = arcEvent(T + 10_000);         // settled after the cut: not in the proposal
  const between = baseEvent(T - HOUR + 30_000); // counts after the cut: not in the proposal either
  const stored = Object.freeze([old, arcLate, between]);
  const proposed = pc.eventsAt(stored, T, cfg);
  assert.deepEqual(proposed, [old]);
  const root = merkle.rootFor(proposed);
  const atP = pc.eventsAt(stored, P, cfg);
  assert.equal(atP.length, 3);
  assert.equal(evidenceAsOf(atP, P, root).matchedRoot, false, 'one cut at the proposal time misses it');
  const options = { eligibleAt: (e) => pc.eligibleAtMs(e, cfg), cuts: pc.auditCuts(P, cfg) };
  assert.equal(options.cuts.length, 30, 'every whole minute in the half hour');
  const found = evidenceAsOf(atP, P, root, options);
  assert.equal(found.matchedRoot, true);
  assert.deepEqual(found.events, [old]);
  // Evidence cut more than half an hour before the proposal is not believed.
  const lagged = merkle.rootFor(pc.eventsAt(Object.freeze([old, arcEvent(T - 40 * 60_000)]), T - 35 * 60_000, cfg));
  assert.equal(evidenceAsOf(pc.eventsAt(Object.freeze([old, arcEvent(T - 40 * 60_000)]), P, cfg), P, lagged, options).matchedRoot, false);
  // And the browser finds it too, from the proposal's time and what /evidence serves.
  const served = (e) => ({ ...(e.chainId != null ? { chainId: e.chainId } : {}), txHash: e.txHash, payer: e.payer, amount: e.amount, settledAt: merkle.settledSeconds(e), success: e.success });
  const evidenceCut = { quantumSeconds: 60, windowSeconds: 1800 };
  const m = explorer.matchRoot(atP.map(served), root, { at: Math.floor(P / 1000), delays: { [BASE_SEPOLIA]: 3600 }, evidenceCut });
  assert.ok(m);
  assert.equal(m.events.length, 1);
  assert.equal(explorer.matchRoot(atP.map(served), root, { at: Math.floor(P / 1000), delays: { [BASE_SEPOLIA]: 3600 } }), null,
    'without the served cut rule the site tries the proposal time only');
});

test('the evidence that counts depends on the cut-off, not on what an operator holds beyond it', () => {
  const cfg = config();
  const a1 = arcEvent(NOW - 5 * HOUR);
  const a2 = arcEvent(NOW - 5 * HOUR);
  const a3 = arcEvent(NOW - 5 * HOUR);
  const youngBase = baseEvent(NOW - 30 * 60_000); // does not count by NOW yet
  // One operator has already credited the Base payment, the other has not.
  const holding = Object.freeze([a1, a2, a3, youngBase]);
  const notYet = Object.freeze([a1, a2, a3]);
  assert.equal(merkle.rootFor(pc.eventsAt(holding, NOW, cfg)), merkle.rootFor(pc.eventsAt(notYet, NOW, cfg)));
});

test('the state file says format 2 only once it holds a payment chain\'s data', () => {
  const out = inChild(`
    const fs = require('fs');
    const s = require('./store');
    const did = '0x' + 'aa'.repeat(32), payer = '0x' + '11'.repeat(20);
    s.creditPayment(did, '0x' + 'cc'.repeat(32), '5', payer, null, 1, null, 3);
    s.persist();
    const before = JSON.parse(fs.readFileSync(process.env.ORACLE_STATE_PATH, 'utf8')).schemaVersion;
    s.creditPayment(did, '0x' + 'dd'.repeat(32), '5', payer, null, 2, null, 4, ${BASE_SEPOLIA});
    s.persist();
    const after = JSON.parse(fs.readFileSync(process.env.ORACLE_STATE_PATH, 'utf8')).schemaVersion;
    console.log(JSON.stringify({ before, after }));
  `);
  assert.deepEqual(out, { before: 1, after: 2 });
});

// ---- the third review: a cut-off this operator can stand behind ----------------------------------

test('a chain in shadow changes nothing about scoring: no cut-off, no reordering', () => {
  const shadow = config({ [`PAYMENT_CHAIN_${BASE_SEPOLIA}_MODE`]: 'shadow' });
  assert.equal(pc.active(shadow), false);
  assert.equal(pc.cutFor(NOW + 25_000, shadow), NOW + 25_000);
  assert.deepEqual(pc.auditCuts(NOW, shadow), []);
  const arc = Object.freeze([arcEvent(NOW + 5_000), arcEvent(NOW - 10)]);
  assert.equal(pc.eventsAt(arc, NOW, shadow), arc, 'the stored array, even with a payment after the time');
  assert.equal(pc.active(config()), true);
});

test("the cut-off comes down to where this operator's scans have reached", () => {
  const cfg = config();
  const key = pc.stateKey(cfg.chains[0]);
  const want = pc.cutFor(NOW + 25_000, cfg); // NOW - 60 s
  const baseReached = (tsSec) => (k) => (k === key ? { lastBlock: 1, lastBlockTs: tsSec } : null);
  // Both scans well past it: the cut stands.
  assert.equal(pc.coveredCut(want, NOW, cfg, baseReached(NOW / 1000 - 900)), want);
  // The scored chain's scan reached only NOW - 3 min, to the second: the minute before that.
  assert.equal(pc.coveredCut(want, NOW - 180_000, cfg, baseReached(NOW / 1000 - 900)), NOW - 240_000);
  // Base reached NOW - 75 min, with an hour's delay: a payment counting after NOW - 15 min is unseen.
  assert.equal(pc.coveredCut(want, NOW, cfg, baseReached(NOW / 1000 - 75 * 60)), NOW - 16 * 60_000);
  // A chain that is on and was never scanned: no cut at all.
  assert.equal(pc.coveredCut(want, NOW, cfg, () => null), null);
});
