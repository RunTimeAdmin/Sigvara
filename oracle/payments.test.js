'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');

const {
  PaymentError,
  readConfig,
  required,
  verifyPayment,
  transfersTo,
  feeScoreFromVolume,
  decayWeight,
  decayedVolume,
  decayedAttestations,
  isSelfPayment,
  diversifiedVolume,
  diversifiedAttestations,
  distinctPayers,
  trustMultiplier,
  propagationScore,
  TRANSFER_TOPIC, activityWindow } = require('./payments');

const ASSET = '0x3600000000000000000000000000000000000000';
const AGENT = '0xCc52Cd92963f8A86d04dB29a4810d1e01D193910';
const PAYER = '0x45D8c79e1188A429dbDfd8400A2869316d6fCe8D';
const OTHER = '0x18CBcE50390f5f6ebe4E20Fc17833F25c8D94811';
const TX = '0x' + 'ab'.repeat(32);

const topicFor = addr => ethers.zeroPadValue(ethers.getAddress(addr), 32);

function transferLog({ asset = ASSET, from = PAYER, to = AGENT, value = 1_000_000n } = {}) {
  return {
    address: asset,
    topics: [TRANSFER_TOPIC, topicFor(from), topicFor(to)],
    data: ethers.zeroPadValue(ethers.toBeHex(value), 32),
  };
}

const BLOCK_TS = 1_700_000_000; // seconds

function fakeProvider({ receipt, head = 100, receiptError = null, headError = null, block = { timestamp: BLOCK_TS }, blockError = null }) {
  return {
    getTransactionReceipt: async () => {
      if (receiptError) throw new Error(receiptError);
      return receipt;
    },
    getBlockNumber: async () => {
      if (headError) throw new Error(headError);
      return head;
    },
    getBlock: async () => {
      if (blockError) throw new Error(blockError);
      return block;
    },
  };
}

const CFG = { mode: 'required', asset: ASSET, minAmount: 0n, minConfirmations: 1, feeUnit: 1_000_000n };

// ---- config ----------------------------------------------------------------

test('readConfig: defaults to off, and off needs no asset', () => {
  const cfg = readConfig({});
  assert.equal(cfg.mode, 'off');
  assert.equal(required(cfg), false);
});

test('readConfig: required without an asset is a startup failure, not a silent pass', () => {
  assert.throws(() => readConfig({ PAYMENT_VERIFICATION: 'required' }), /PAYMENT_ASSET/);
});

test('readConfig: rejects an unknown mode rather than guessing', () => {
  assert.throws(() => readConfig({ PAYMENT_VERIFICATION: 'maybe' }), /must be/);
});

test('readConfig: amounts stay BigInt so an 18-decimal token does not lose precision', () => {
  const cfg = readConfig({
    PAYMENT_VERIFICATION: 'required',
    PAYMENT_ASSET: ASSET,
    PAYMENT_MIN_AMOUNT: '1234567890123456789',
  });
  assert.equal(cfg.minAmount, 1234567890123456789n);
});

// ---- log matching ----------------------------------------------------------

test('transfersTo: ignores a transfer of a different asset', () => {
  const logs = [transferLog({ asset: OTHER })];
  assert.equal(transfersTo({ logs }, ASSET, AGENT).length, 0);
});

test('transfersTo: ignores a transfer to somebody else', () => {
  const logs = [transferLog({ to: OTHER })];
  assert.equal(transfersTo({ logs }, ASSET, AGENT).length, 0);
});

test('transfersTo: ignores a non-Transfer event from the same token', () => {
  const logs = [{ address: ASSET, topics: [ethers.id('Approval(address,address,uint256)'), topicFor(PAYER), topicFor(AGENT)], data: '0x' + '0'.repeat(64) }];
  assert.equal(transfersTo({ logs }, ASSET, AGENT).length, 0);
});

test('transfersTo: picks up several credits in one transaction', () => {
  const logs = [transferLog({ value: 10n }), transferLog({ value: 5n, from: OTHER })];
  const found = transfersTo({ logs }, ASSET, AGENT);
  assert.equal(found.length, 2);
  assert.equal(found[0].value, 10n);
});

// ---- verification ----------------------------------------------------------

test('verifyPayment: accepts a settled transfer and reports the payer from the log', async () => {
  const provider = fakeProvider({ receipt: { status: 1, blockNumber: 99, logs: [transferLog({ value: 2_500_000n })] } });
  const out = await verifyPayment({ provider, cfg: CFG }, TX, AGENT);
  assert.equal(out.payer, ethers.getAddress(PAYER));
  assert.equal(out.amount, 2_500_000n);
  assert.equal(out.txHash, TX.toLowerCase());
});

test('verifyPayment: the payer comes from the chain, not from the caller', async () => {
  // The whole point: a caller cannot name themselves as the attester.
  const provider = fakeProvider({ receipt: { status: 1, blockNumber: 99, logs: [transferLog({ from: OTHER })] } });
  const out = await verifyPayment({ provider, cfg: CFG }, TX, AGENT);
  assert.equal(out.payer, ethers.getAddress(OTHER));
});

test('verifyPayment: rejects a transaction that paid a different address', async () => {
  const provider = fakeProvider({ receipt: { status: 1, blockNumber: 99, logs: [transferLog({ to: OTHER })] } });
  await assert.rejects(() => verifyPayment({ provider, cfg: CFG }, TX, AGENT), e => e.code === 'no_transfer');
});

test('verifyPayment: rejects a reverted transaction', async () => {
  const provider = fakeProvider({ receipt: { status: 0, blockNumber: 99, logs: [transferLog()] } });
  await assert.rejects(() => verifyPayment({ provider, cfg: CFG }, TX, AGENT), e => e.code === 'reverted');
});

test('verifyPayment: rejects an unmined transaction', async () => {
  const provider = fakeProvider({ receipt: null });
  await assert.rejects(() => verifyPayment({ provider, cfg: CFG }, TX, AGENT), e => e.code === 'not_found');
});

test('verifyPayment: rejects a payment below the minimum', async () => {
  const cfg = { ...CFG, minAmount: 1_000_000n };
  const provider = fakeProvider({ receipt: { status: 1, blockNumber: 99, logs: [transferLog({ value: 999_999n })] } });
  await assert.rejects(() => verifyPayment({ provider, cfg }, TX, AGENT), e => e.code === 'below_minimum');
});

test('verifyPayment: holds off until the transfer has enough confirmations', async () => {
  const cfg = { ...CFG, minConfirmations: 6 };
  const provider = fakeProvider({ receipt: { status: 1, blockNumber: 100, logs: [transferLog()] }, head: 102 });
  await assert.rejects(() => verifyPayment({ provider, cfg }, TX, AGENT), e => e.code === 'unconfirmed');
});

test('verifyPayment: an RPC failure is reported as an RPC failure, not a bad payment', async () => {
  // A node having a bad minute must not be recorded as the caller trying it on.
  const provider = fakeProvider({ receipt: null, receiptError: 'connection reset' });
  await assert.rejects(() => verifyPayment({ provider, cfg: CFG }, TX, AGENT), e => e.code === 'rpc_error');
});

test('verifyPayment: rejects a malformed tx hash before touching the network', async () => {
  let called = false;
  const provider = { getTransactionReceipt: async () => { called = true; return null; }, getBlockNumber: async () => 1 };
  await assert.rejects(() => verifyPayment({ provider, cfg: CFG }, '0xdeadbeef', AGENT), e => e.code === 'bad_tx_hash');
  assert.equal(called, false, 'did not call the provider');
});

test('verifyPayment: timestamps the payment when it settled, not when it was reported', async () => {
  // Keying off the submission time made a year-old payment count as fresh, so
  // receipts could be hoarded and released to keep a score alive without new work.
  const provider = fakeProvider({ receipt: { status: 1, blockNumber: 99, logs: [transferLog()] } });
  const out = await verifyPayment({ provider, cfg: CFG }, TX, AGENT);
  assert.equal(out.settledAt, BLOCK_TS * 1000);
  assert.ok(Math.abs(out.settledAt - Date.now()) > 1000, 'not the current time');
});

test('verifyPayment: an unreadable block is an RPC error, never a fallback to now', async () => {
  // Falling back to the current time would silently restore the bug.
  const rpcDown = fakeProvider({ receipt: { status: 1, blockNumber: 99, logs: [transferLog()] }, blockError: 'boom' });
  await assert.rejects(() => verifyPayment({ provider: rpcDown, cfg: CFG }, TX, AGENT), e => e.code === 'rpc_error');

  const noTs = fakeProvider({ receipt: { status: 1, blockNumber: 99, logs: [transferLog()] }, block: null });
  await assert.rejects(() => verifyPayment({ provider: noTs, cfg: CFG }, TX, AGENT), e => e.code === 'rpc_error');
});

test('verifyPayment: a split payment counts as one, summed', async () => {
  const provider = fakeProvider({
    receipt: { status: 1, blockNumber: 99, logs: [transferLog({ value: 400_000n }), transferLog({ value: 600_000n })] },
  });
  const out = await verifyPayment({ provider, cfg: CFG }, TX, AGENT);
  assert.equal(out.amount, 1_000_000n);
});

// ---- fee score -------------------------------------------------------------

test('feeScoreFromVolume: one point per unit of volume', () => {
  assert.equal(feeScoreFromVolume(0n, 1_000_000n), 0);
  assert.equal(feeScoreFromVolume(999_999n, 1_000_000n), 0);
  assert.equal(feeScoreFromVolume(5_000_000n, 1_000_000n), 5);
});

test('feeScoreFromVolume: caps at 20 so the contract can never reject the score', () => {
  assert.equal(feeScoreFromVolume(10_000_000_000n, 1_000_000n), 20);
});

test('feeScoreFromVolume: handles volume beyond Number.MAX_SAFE_INTEGER', () => {
  // 18-decimal token: 5000 whole units, well past 2^53 in base units.
  assert.equal(feeScoreFromVolume(5000n * 10n ** 18n, 10n ** 18n), 20);
  assert.equal(feeScoreFromVolume(7n * 10n ** 18n, 10n ** 18n), 7);
});

test('PaymentError carries a machine-readable code', () => {
  const e = new PaymentError('below_minimum', 'too small');
  assert.equal(e.code, 'below_minimum');
  assert.ok(e instanceof Error);
});

// ---- decay -----------------------------------------------------------------

const DAY = 86_400_000;
const H90 = 90 * DAY;
const NOW = 1_800_000_000_000;
const ev = (days, amount, success = true) => ({
  ts: NOW - days * DAY, amount: String(amount), payer: '0xpayer', success,
});

test('decayWeight: full weight today, half at one half-life', () => {
  assert.equal(decayWeight(0, H90), 1_000_000n);
  assert.equal(decayWeight(H90, H90), 500_000n);
  assert.equal(decayWeight(2 * H90, H90), 250_000n);
});

test('decayWeight: a half-life of 0 disables decay', () => {
  assert.equal(decayWeight(10 * 365 * DAY, 0), 1_000_000n);
});

test('decayWeight: a timestamp in the future is treated as now, not amplified', () => {
  // Clock skew between the oracle and a client must not mint extra weight.
  assert.equal(decayWeight(-DAY, H90), 1_000_000n);
});

test('decayedVolume: halves every half-life', () => {
  assert.equal(decayedVolume([ev(0, 1000n)], H90, NOW), 1000n);
  assert.equal(decayedVolume([ev(90, 1000n)], H90, NOW), 500n);
  assert.equal(decayedVolume([ev(180, 1000n)], H90, NOW), 250n);
});

test('decayedVolume: keeps BigInt precision on an 18-decimal token', () => {
  const one = 10n ** 18n;
  // A float multiply would round this; the scaled-integer weight does not.
  assert.equal(decayedVolume([ev(90, one)], H90, NOW), one / 2n);
});

test('decayedVolume: a year of silence is worth about a sixteenth', () => {
  const v = decayedVolume([ev(360, 1_000_000n)], H90, NOW);
  assert.ok(v > 55_000n && v < 70_000n, `expected roughly 1/16, got ${v}`);
});

test('decayedVolume: sums many events at their own ages', () => {
  const v = decayedVolume([ev(0, 100n), ev(90, 100n), ev(180, 100n)], H90, NOW);
  assert.equal(v, 175n); // 100 + 50 + 25
});

test('decayedVolume: with decay off, an old payment still counts in full', () => {
  assert.equal(decayedVolume([ev(3650, 1000n)], 0, NOW), 1000n);
});

test('decayedAttestations: a stale run of successes stops masking a recent failure', () => {
  // Nine successes a year ago, one failure today. Undecayed that reads 90%.
  const events = [];
  for (let i = 0; i < 9; i++) events.push(ev(360, 1n, true));
  events.push(ev(0, 1n, false));
  const { successful, total } = decayedAttestations(events, H90, NOW);
  const ratio = successful / total;
  assert.ok(ratio < 0.4, `recent failure should dominate, got ${ratio.toFixed(2)}`);
});

test('decayedAttestations: with decay off it matches the raw tally', () => {
  const events = [ev(360, 1n, true), ev(0, 1n, false)];
  const { successful, total } = decayedAttestations(events, 0, NOW);
  assert.equal(total, 2);
  assert.equal(successful, 1);
});

test('decayedAttestations: no events reads zero, not NaN', () => {
  const { successful, total } = decayedAttestations([], H90, NOW);
  assert.equal(total, 0);
  assert.equal(successful, 0);
});

test('readConfig: half-life defaults to 90 days and 0 turns decay off', () => {
  assert.equal(readConfig({}).halfLifeMs, 90 * DAY);
  assert.equal(readConfig({ PAYMENT_HALF_LIFE_DAYS: '0' }).halfLifeMs, 0);
  assert.equal(readConfig({ PAYMENT_HALF_LIFE_DAYS: '30' }).halfLifeMs, 30 * DAY);
});

// ---- self-payment ----------------------------------------------------------

const IDENT = { operator: '0x45D8c79e1188A429dbDfd8400A2869316d6fCe8D', agentAddress: '0xCc52Cd92963f8A86d04dB29a4810d1e01D193910' };

test('isSelfPayment: the operator paying its own agent is caught', () => {
  assert.equal(isSelfPayment(IDENT.operator, IDENT), true);
});

test('isSelfPayment: the agent paying itself is caught', () => {
  assert.equal(isSelfPayment(IDENT.agentAddress, IDENT), true);
});

test('isSelfPayment: matching ignores address casing', () => {
  assert.equal(isSelfPayment(IDENT.operator.toLowerCase(), IDENT), true);
  assert.equal(isSelfPayment(IDENT.operator.toUpperCase(), IDENT), true);
});

test('isSelfPayment: a real counterparty passes', () => {
  assert.equal(isSelfPayment('0x18CBcE50390f5f6ebe4E20Fc17833F25c8D94811', IDENT), false);
});

test('isSelfPayment: an empty payer is not treated as a match', () => {
  // Guards against a blank operator field making every payment look like self-dealing.
  assert.equal(isSelfPayment('', IDENT), false);
  assert.equal(isSelfPayment('0xabc', { operator: '', agentAddress: '' }), false);
});

// ---- payer diversity -------------------------------------------------------

const DCFG = { halfLifeMs: H90, feeUnit: 100n, maxPerPayer: 5 };
const pev = (payer, amount, ok = true) => ({ ts: NOW, amount: String(amount), payer, success: ok });

test('diversifiedVolume: one payer is capped however much it sends', () => {
  const heaps = Array.from({ length: 50 }, () => pev('0xring', 100n));
  assert.equal(diversifiedVolume(heaps, DCFG, NOW), 500n); // 5 points' worth, not 50
});

test('diversifiedVolume: many payers reach the full amount', () => {
  const crowd = Array.from({ length: 50 }, (_, i) => pev('0xcust' + i, 100n));
  assert.equal(diversifiedVolume(crowd, DCFG, NOW), 5000n);
});

test('diversifiedVolume: payers are matched case-insensitively', () => {
  // Otherwise the same wallet in two casings would count as two counterparties.
  const mixed = [pev('0xAbC', 400n), pev('0xabc', 400n)];
  assert.equal(diversifiedVolume(mixed, DCFG, NOW), 500n);
});

test('diversifiedVolume: a cap of 0 disables the limit', () => {
  const heaps = Array.from({ length: 50 }, () => pev('0xring', 100n));
  assert.equal(diversifiedVolume(heaps, { ...DCFG, maxPerPayer: 0 }, NOW), 5000n);
});

test('diversifiedVolume: decay still applies underneath the cap', () => {
  const old = [{ ts: NOW - 90 * DAY, amount: '1000', payer: '0xa', success: true }];
  assert.equal(diversifiedVolume(old, { ...DCFG, maxPerPayer: 100 }, NOW), 500n);
});

test('diversifiedAttestations: one payer cannot buy full confidence', () => {
  const spam = Array.from({ length: 100 }, () => pev('0xring', 1n));
  assert.equal(diversifiedAttestations(spam, DCFG, NOW).total, 5);
});

test('diversifiedAttestations: capping scales successes, it does not change the opinion', () => {
  // Half successes from one payer should stay half after capping.
  const mixed = [];
  for (let i = 0; i < 50; i++) mixed.push(pev('0xring', 1n, i % 2 === 0));
  const { successful, total } = diversifiedAttestations(mixed, DCFG, NOW);
  assert.equal(total, 5);
  assert.ok(Math.abs(successful / total - 0.5) < 0.01, `ratio preserved, got ${successful / total}`);
});

test('distinctPayers: counts counterparties, not payments', () => {
  const ev = [pev('0xa', 1n), pev('0xa', 1n), pev('0xb', 1n)];
  assert.equal(distinctPayers(ev, H90, NOW), 2);
});

test('readConfig: maxPerPayer defaults to 5 and 0 disables it', () => {
  assert.equal(readConfig({}).maxPerPayer, 5);
  assert.equal(readConfig({ PAYMENT_MAX_PER_PAYER: '0' }).maxPerPayer, 0);
});

// ---- web of trust ----------------------------------------------------------

const TCFG = { halfLifeMs: H90, feeUnit: 100n, maxPerPayer: 5, trustWeight: 1 };
const tev = (payer, amount, ok = true) => ({ ts: NOW, amount: String(amount), payer, success: ok });

test('trustMultiplier: an unknown wallet is weighted exactly as before', () => {
  assert.equal(trustMultiplier('0xstranger', {}, 1), 1);
  assert.equal(trustMultiplier('0xstranger', null, 1), 1);
});

test('trustMultiplier: scales with HARD standing, not the total score', () => {
  // payerScores carries hard standing, 0..25 (ERC-8004 capped by the matured total),
  // because weighting by the total let a farmed score launder into someone else's cap.
  // The range tracks MAX_EXTERNAL_SCORE, which the reweight moved from 15 to 25.
  assert.equal(trustMultiplier('0xa', { '0xa': 25 }, 1), 2);
  assert.equal(trustMultiplier('0xa', { '0xa': 12.5 }, 1), 1.5);
  assert.equal(trustMultiplier('0xa', { '0xa': 999 }, 1), 2, 'a bad score cannot inflate it');
  assert.equal(trustMultiplier('0xa', { '0xa': -5 }, 1), 1);
});

test('trustMultiplier: a wash-farmed counterparty raises nothing', () => {
  // The laundering this closed. A sybil at total 100 with no external standing reads
  // as hard 0 and so leaves the cap exactly where an anonymous wallet leaves it.
  assert.equal(trustMultiplier('0xa', { '0xa': 0 }, 1), 1);
});

test('trustMultiplier: a weight of 0 disables the web of trust', () => {
  assert.equal(trustMultiplier('0xa', { '0xa': 100 }, 0), 1);
});

test('diversifiedVolume: a reputable counterparty counts for more', () => {
  const heaps = [tev('0xa', 10000n)];
  const anon = diversifiedVolume(heaps, TCFG, NOW, {});
  const trusted = diversifiedVolume(heaps, TCFG, NOW, { '0xa': 100 });
  assert.equal(anon, 500n);
  assert.equal(trusted, 1000n, 'a perfectly scored counterparty counts double');
});

test('propagationScore: one point per fully trusted counterparty', () => {
  const ev = ['0xa', '0xb', '0xc'].map(p => tev(p, 1n));
  assert.equal(propagationScore(ev, { '0xa': 100, '0xb': 100, '0xc': 100 }), 3);
});

test('propagationScore: pro-rated, so half-trusted counterparties count half', () => {
  const ev = ['0xa', '0xb', '0xc', '0xd'].map(p => tev(p, 1n));
  const scores = { '0xa': 12.5, '0xb': 12.5, '0xc': 12.5, '0xd': 12.5 };
  assert.equal(propagationScore(ev, scores), 2);
});

test('propagationScore: farmed counterparties are inherited as nothing', () => {
  // Hard standing 0 means the voucher has no ERC-8004 history, however high its total.
  const ev = ['0xa', '0xb', '0xc', '0xd', '0xe'].map(p => tev(p, 1n));
  assert.equal(propagationScore(ev, { '0xa': 0, '0xb': 0, '0xc': 0, '0xd': 0, '0xe': 0 }), 0);
  assert.equal(propagationScore(ev, { '0xa': 25, '0xb': 25, '0xc': 25, '0xd': 25, '0xe': 25 }), 5);
});

test('propagationScore: capped at 5 however many vouch', () => {
  const ev = Array.from({ length: 50 }, (_, i) => tev('0xp' + i, 1n));
  const scores = Object.fromEntries(ev.map(e => [e.payer, 100]));
  assert.equal(propagationScore(ev, scores), 5);
});

test('propagationScore: a ring of unscored agents grants nothing', () => {
  // The property that matters. A web of trust that bootstraps from nothing would be
  // worse than none: a Sybil could stand up five identities and have them vouch.
  const ev = ['0xa', '0xb', '0xc', '0xd', '0xe'].map(p => tev(p, 1n));
  const scores = Object.fromEntries(ev.map(e => [e.payer, 0]));
  assert.equal(propagationScore(ev, scores), 0);
});

test('propagationScore: breadth not size, one counterparty counts once', () => {
  const ev = Array.from({ length: 20 }, () => tev('0xwhale', 100000n));
  assert.equal(propagationScore(ev, { '0xwhale': 100 }), 1);
});

test('propagationScore: no scores available means no inherited trust', () => {
  assert.equal(propagationScore([tev('0xa', 1n)], null), 0);
  assert.equal(propagationScore([], {}), 0);
});

// ---- the clock is an input, not an ambient fact ----------------------------
//
// Every decay weight and the recency that fades tenure are measured against `now`. When
// that was Date.now(), two operators scoring the same evidence produced fractionally
// different numbers because their hosts disagreed about the time: recency 0.982146 on the
// primary against 0.982148 on the checker, on the day the second operator went live. Too
// small to move an integer factor, large enough that the two were not computing the same
// function, and hidden by the divergence tolerance rather than fixed by it.

test('activityWindow: recency moves with `now`, so two epochs minutes apart disagree', () => {
  // The measured reason the checker rescores at the proposal's timestamp instead of its
  // own. How much drift is visible depends on how far decay has already run, so no fixed
  // "N seconds is invisible" claim holds. What does hold is that two epochs minutes apart
  // produce different recency from identical evidence, and two operators on independent
  // hourly schedules are minutes or hours apart, never simultaneous.
  const settledAt = 1_789_000_000_000 - 30 * 86_400_000;
  const ev = [{ txHash: '0x1', ts: settledAt, amount: '1000000', payer: '0xa', success: true }];
  const halfLife = 90 * 86_400_000;
  const base = 1_789_000_000_000;

  assert.notEqual(
    activityWindow(ev, halfLife, base).recency,
    activityWindow(ev, halfLife, base + 300_000).recency,
    'five minutes apart must produce different recency',
  );

  // Handed one clock, any two callers agree exactly. That is the whole property.
  assert.deepEqual(activityWindow(ev, halfLife, base), activityWindow(ev, halfLife, base));
});

test('decayedVolume: the same events and clock give a bit-for-bit identical weight', () => {
  const now = 1_789_000_000_000;
  const ev = [
    { txHash: '0x1', ts: now - 10 * 86_400_000, amount: '5000000', payer: '0xa', success: true },
    { txHash: '0x2', ts: now - 40 * 86_400_000, amount: '3000000', payer: '0xb', success: true },
  ];
  const halfLife = 90 * 86_400_000;
  assert.equal(decayedVolume(ev, halfLife, now), decayedVolume(ev, halfLife, now));
  assert.notEqual(decayedVolume(ev, halfLife, now), decayedVolume(ev, halfLife, now + 3_600_000));
});
