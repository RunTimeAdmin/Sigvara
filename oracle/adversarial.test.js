'use strict';

/**
 * Adversarial scoring tests: what does a fake score cost?
 *
 * Every other suite here checks that the scoring pipeline does what it was written to
 * do. None of them ask what it does against someone trying to buy a number. That is a
 * different question, and the honest answer belongs in the documentation rather than in
 * a reader's imagination.
 *
 * These feed attacker-crafted payment sets into the real pipeline: the same
 * payments.byPayer / diversifiedVolume / diversifiedAttestations / propagationScore /
 * activityWindow calls the oracle makes each epoch, assembled exactly as
 * measuredFactorsFor assembles them, then through the real computeScore. No stubs, so a
 * change that weakens a cap fails here rather than passing quietly.
 *
 * The central economic fact the caps do not price: in a wash ring the money comes back.
 * An attacker paying its own agent from its own wallets is not spending the payments,
 * only floating them. The cost is gas and working capital, not the volume.
 *
 *   node --test oracle/adversarial.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const payments = require('./payments');
const { computeScore } = require('./scoring');

const USDC = 1_000_000n;                  // 6 decimals
const DAY = 86_400_000;
const NOW = 1_800_000_000_000;

const cfg = payments.readConfig({
  PAYMENT_VERIFICATION: 'required',
  PAYMENT_ASSET: '0x41De2D6D55318e197a00E8f5B496eA2790e23E6c',
});

/** One settled payment, as store.creditPayment records it. */
let n = 0;
const pay = (payer, usdc, agoDays = 0, success = true) => ({
  txHash: `0x${(++n).toString(16).padStart(64, '0')}`,
  ts: NOW - agoDays * DAY,
  amount: (BigInt(usdc) * USDC).toString(),
  payer,
  success,
});

/**
 * Mirrors index.js measuredFactorsFor + computeScore. Kept in one place so every
 * scenario below scores the way production scores.
 */
function scoreOf(events, { payerScores = null, registeredAt = null, flags = 0, externalScore = 0, now = NOW } = {}) {
  const grouped = payments.byPayer(events, cfg.halfLifeMs, now);
  const volume = payments.diversifiedVolume(events, cfg, now, payerScores, grouped);
  const measured = {
    measuredFeeScore: payments.feeScoreFromVolume(volume, cfg.feeUnit),
    measuredAttestations: payments.diversifiedAttestations(events, cfg, now, payerScores, grouped),
    propagation: payments.propagationScore(events, payerScores),
    activity: payments.activityWindow(events, cfg.halfLifeMs, now),
    distinctPayers: grouped.size,
  };
  const s = computeScore({
    registeredAt: registeredAt ?? Math.floor((now - 400 * DAY) / 1000),
    attestations: measured.measuredAttestations,
    flags,
    externalScore,
    measuredFeeScore: measured.measuredFeeScore,
    activity: measured.activity,
    propagation: measured.propagation,
  });
  return { ...s, distinctPayers: measured.distinctPayers };
}

/** A ring of `wallets` sybil payers, each sending `usdcEach`, spread over `spanDays`. */
function washRing(wallets, usdcEach, spanDays = 40) {
  const out = [];
  for (let w = 0; w < wallets; w++) {
    for (let d = 0; d <= spanDays; d += Math.max(1, Math.floor(spanDays / 8))) {
      out.push(pay(`0xsybil${w}`, Math.ceil(usdcEach / 9), d));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------
// 1. The single-payer cap. One wallet paying forever must not look like a business.
// ---------------------------------------------------------------------------------

test('one payer cannot buy more than maxPerPayer points, however much it sends', () => {
  const modest = scoreOf([pay('0xwhale', 500, 10)]);
  const absurd = scoreOf(Array.from({ length: 50 }, (_, i) => pay('0xwhale', 100_000, i)));
  assert.ok(absurd.feeScore <= cfg.maxPerPayer,
    `one payer reached feeScore ${absurd.feeScore}, cap is ${cfg.maxPerPayer}`);
  assert.ok(absurd.feeScore >= modest.feeScore);
});

test('splitting one payer across many small payments does not defeat the cap', () => {
  // The obvious evasion: same wallet, thousands of dust payments.
  const dust = scoreOf(Array.from({ length: 500 }, (_, i) => pay('0xwhale', 20, i % 60)));
  assert.ok(dust.feeScore <= cfg.maxPerPayer,
    `dust splitting reached feeScore ${dust.feeScore}, cap is ${cfg.maxPerPayer}`);
});

// ---------------------------------------------------------------------------------
// 2. The wash ring. This is the one the caps do not price.
// ---------------------------------------------------------------------------------

test('MEASURED: what a wash ring buys, by wallet count', () => {
  // Each wallet contributes at most maxPerPayer points, so the attacker's lever is
  // wallet count, not money. The money returns to them either way.
  const rows = [];
  for (const wallets of [1, 3, 6, 10, 20]) {
    const s = scoreOf(washRing(wallets, 600));
    rows.push({ wallets, fee: s.feeScore, success: s.successScore, age: s.ageScore, community: s.communityScore, total: s.total });
  }
  console.log('\n  wash ring, 600 USDC per wallet, 40-day span:');
  console.log('  wallets | fee | success | tenure | community | TOTAL');
  for (const r of rows) {
    console.log(`  ${String(r.wallets).padStart(7)} | ${String(r.fee).padStart(3)} | ${String(r.success).padStart(7)} | ${String(r.age).padStart(6)} | ${String(r.community).padStart(9)} | ${String(r.total).padStart(5)}`);
  }
  // Six wallets is the documented threshold for maxing fee score.
  const six = rows.find(r => r.wallets === 6);
  assert.equal(six.fee, 30, 'six payers should max the 30-point fee factor');
});

test('MEASURED: the ceiling a ring reaches with no external identity and no real time', () => {
  const s = scoreOf(washRing(20, 1000));
  console.log(`\n  20-wallet ring ceiling: ${s.total}/100` +
    ` (fee ${s.feeScore}, success ${s.successScore}, tenure ${s.ageScore},` +
    ` external ${s.externalScore}, community ${s.communityScore}, propagation ${s.propagationScore})`);
  // Recorded as a bound, not an aspiration. If a change makes this cheaper, this fails.
  assert.ok(s.total <= 85, `ring reached ${s.total}; the factors that should resist are not resisting`);
});

// ---------------------------------------------------------------------------------
// 3. Sybils that are themselves scored agents. trustMultiplier raises their caps and
//    propagationScore starts paying, so the question is whether the bootstrap holds.
// ---------------------------------------------------------------------------------

test('a ring of fresh agents grants each other nothing', () => {
  // The property the design depends on: zero-scored counterparties raise no caps.
  const ring = washRing(6, 600);
  const allZero = Object.fromEntries(Array.from({ length: 6 }, (_, w) => [`0xsybil${w}`, 0]));
  const withScores = scoreOf(ring, { payerScores: allZero });
  const without = scoreOf(ring);
  assert.equal(withScores.feeScore, without.feeScore, 'zero-scored payers raised the cap');
  assert.equal(withScores.propagationScore, 0, 'zero-scored payers granted propagation');
});

test('MEASURED: farming the sybils themselves now buys nothing', () => {
  // payerScores carries HARD standing (ERC-8004 capped by the matured total), not the
  // total score. A sybil that wash-traded itself to 100 has no external history, so it
  // reads 0 here and launders nothing into its target. Before this change a farmed
  // sybil doubled its target per-payer cap and counted as a full voucher: four scored
  // payers maxed the 30-point fee factor where six are supposed to be needed.
  const ring = washRing(6, 600);
  const cases = [
    ['farmed to 100, no ERC-8004', 0],
    ['real 8004 standing 7/15', 7],
    ['full 8004 standing 15/15', 15],
  ];
  console.log('');
  console.log('  6-wallet ring, by the counterparties HARD standing:');
  console.log('  counterparties             | fee | propagation | TOTAL');
  const rows = [];
  for (const [label, hard] of cases) {
    const scores = Object.fromEntries(Array.from({ length: 6 }, (_, w) => [`0xsybil${w}`, hard]));
    const s = scoreOf(ring, { payerScores: scores });
    rows.push(s);
    console.log(`  ${label.padEnd(26)} | ${String(s.feeScore).padStart(3)} | ${String(s.propagationScore).padStart(11)} | ${String(s.total).padStart(5)}`);
  }
  const unscored = scoreOf(ring);
  assert.equal(rows[0].total, unscored.total,
    'a farmed counterparty must be worth exactly what an anonymous wallet is worth');
  assert.equal(rows[0].propagationScore, 0, 'farmed standing must not propagate');
  assert.ok(rows[2].total > rows[0].total, 'genuine outside standing should still count');
});

// ---------------------------------------------------------------------------------
// 4. Time. Tenure and decay are the factors money cannot shortcut.
// ---------------------------------------------------------------------------------

test('MEASURED: tenure against elapsed span, the factor money cannot buy', () => {
  console.log('\n  tenure (max 20) by span of paid activity, ring active to today:');
  for (const span of [1, 7, 31, 90, 365]) {
    const s = scoreOf(washRing(6, 600, span));
    console.log(`  ${String(span).padStart(4)} days -> tenure ${s.ageScore}, total ${s.total}`);
  }
  const oneDay = scoreOf(washRing(6, 600, 1));
  const oneYear = scoreOf(washRing(6, 600, 365));
  assert.ok(oneYear.ageScore > oneDay.ageScore, 'tenure must reward elapsed time');
});

test('a farm that stops paying decays rather than holding its score', () => {
  // The property that stops a bought score sitting forever.
  const ring = washRing(6, 600, 40);
  const fresh = scoreOf(ring);
  const abandoned = scoreOf(ring, { now: NOW + 400 * DAY });
  assert.ok(abandoned.total < fresh.total,
    `abandoned farm held ${abandoned.total} against ${fresh.total}`);
  console.log(`\n  abandoned for 400 days: ${fresh.total} -> ${abandoned.total}`);
});

// ---------------------------------------------------------------------------------
// 5. Failure reporting. An attacker controls which outcomes get attested.
// ---------------------------------------------------------------------------------

test('hiding failures is bounded by the prior, not free', () => {
  const honest = scoreOf([...washRing(6, 600)].map((e, i) => i % 4 === 0 ? { ...e, success: false } : e));
  const liar = scoreOf(washRing(6, 600));
  assert.ok(liar.successScore >= honest.successScore);
  console.log(`\n  success factor: all-success ${liar.successScore} vs 25% failures ${honest.successScore}`);
});

test('a handful of perfect outcomes cannot outrank sustained evidence', () => {
  // The Bayesian prior: three lucky jobs must not beat thirty solid ones.
  const three = scoreOf([pay('0xa', 600, 1), pay('0xb', 600, 2), pay('0xc', 600, 3)]);
  assert.ok(three.successScore < 25 * 0.6,
    `three perfect outcomes scored ${three.successScore}/25, the prior is not damping`);
});

// ---------------------------------------------------------------------------------
// 6. Flags. What a credentialed integration can do to a competitor.
// ---------------------------------------------------------------------------------

test('MEASURED: the damage one credentialed flagger can do', () => {
  const clean = scoreOf(washRing(6, 600));
  console.log('\n  community factor under flagging:');
  for (const f of [0, 1, 2, 3, 5]) {
    const s = scoreOf(washRing(6, 600), { flags: f });
    console.log(`  ${f} flags -> community ${s.communityScore}, total ${s.total}`);
  }
  const flagged = scoreOf(washRing(6, 600), { flags: 5 });
  assert.equal(flagged.communityScore, 0);
  // Bounded blast radius: flags cost 5 points, not the whole score.
  assert.equal(clean.total - flagged.total, 5,
    'flags should cost exactly the community factor, no more');
});
