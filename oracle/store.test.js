'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  checkAttestCooldown,
  recordAttestation,
  pruneExpiredCooldowns,
  attestCooldowns,
  creditPayment,
  getPaymentEvents,
  prunePaymentEvents,
  paymentVolume,
  ATTEST_COOLDOWN_MS,
} = require('./store');

function clearCooldowns() {
  attestCooldowns.clear();
}

test('checkAttestCooldown: allows first attestation', () => {
  clearCooldowns();
  const result = checkAttestCooldown('attester1', '0xabc', 1000000);
  assert.equal(result.allowed, true);
  assert.equal(result.remainingMs, 0);
});

test('checkAttestCooldown: blocks attestation within cooldown window', () => {
  clearCooldowns();
  const now = 1000000;
  recordAttestation('attester1', '0xabc', now);
  const result = checkAttestCooldown('attester1', '0xabc', now + 1000);
  assert.equal(result.allowed, false);
  assert.ok(result.remainingMs > 0);
  assert.ok(result.remainingMs <= ATTEST_COOLDOWN_MS);
});

test('checkAttestCooldown: allows attestation after cooldown expires', () => {
  clearCooldowns();
  const now = 1000000;
  recordAttestation('attester1', '0xabc', now);
  const result = checkAttestCooldown('attester1', '0xabc', now + ATTEST_COOLDOWN_MS);
  assert.equal(result.allowed, true);
  assert.equal(result.remainingMs, 0);
});

test('checkAttestCooldown: different attesters have independent cooldowns', () => {
  clearCooldowns();
  const now = 1000000;
  recordAttestation('attester1', '0xabc', now);
  const result = checkAttestCooldown('attester2', '0xabc', now + 1000);
  assert.equal(result.allowed, true);
});

test('checkAttestCooldown: same attester can attest different agents', () => {
  clearCooldowns();
  const now = 1000000;
  recordAttestation('attester1', '0xabc', now);
  const result = checkAttestCooldown('attester1', '0xdef', now + 1000);
  assert.equal(result.allowed, true);
});

test('recordAttestation: records timestamp for attester+didHash pair', () => {
  clearCooldowns();
  const now = 1000000;
  recordAttestation('attester1', '0xabc', now);
  assert.ok(attestCooldowns.has('attester1:0xabc'));
  assert.equal(attestCooldowns.get('attester1:0xabc'), now);
});

test('recordAttestation: updates timestamp for subsequent attestation', () => {
  clearCooldowns();
  const now1 = 1000000;
  const now2 = 2000000;
  recordAttestation('attester1', '0xabc', now1);
  recordAttestation('attester1', '0xabc', now2);
  assert.equal(attestCooldowns.get('attester1:0xabc'), now2);
});

test('pruneExpiredCooldowns: removes expired entries', () => {
  clearCooldowns();
  const now = 1000000;
  recordAttestation('attester1', '0xabc', now - ATTEST_COOLDOWN_MS - 1000);
  recordAttestation('attester2', '0xdef', now - 1000);
  pruneExpiredCooldowns(now);
  assert.equal(attestCooldowns.has('attester1:0xabc'), false, 'expired entry should be pruned');
  assert.equal(attestCooldowns.has('attester2:0xdef'), true, 'recent entry should remain');
});

test('pruneExpiredCooldowns: keeps entries at exactly cooldown boundary', () => {
  clearCooldowns();
  const now = 1000000;
  recordAttestation('attester1', '0xabc', now - ATTEST_COOLDOWN_MS);
  pruneExpiredCooldowns(now);
  assert.equal(attestCooldowns.has('attester1:0xabc'), false, 'entry at exactly cooldown boundary should be pruned');
});

test('cooldown calculation returns correct remaining time', () => {
  clearCooldowns();
  const now = 1000000;
  const halfCooldown = ATTEST_COOLDOWN_MS / 2;
  recordAttestation('attester1', '0xabc', now);
  const result = checkAttestCooldown('attester1', '0xabc', now + halfCooldown);
  assert.equal(result.allowed, false);
  assert.equal(result.remainingMs, ATTEST_COOLDOWN_MS - halfCooldown);
});

// ---- payment credits -------------------------------------------------------

test('creditPayment: accumulates volume across payments', () => {
  const did = '0x' + '11'.repeat(32);
  assert.equal(creditPayment(did, '0x' + 'a1'.repeat(32), 1_000_000n), true);
  assert.equal(creditPayment(did, '0x' + 'a2'.repeat(32), 2_500_000n), true);
  assert.equal(paymentVolume(did), 3_500_000n);
});

test('creditPayment: the same settlement cannot be credited twice', () => {
  const did = '0x' + '22'.repeat(32);
  const tx = '0x' + 'b1'.repeat(32);
  assert.equal(creditPayment(did, tx, 1_000_000n), true);
  assert.equal(creditPayment(did, tx, 1_000_000n), false, 'replay refused');
  assert.equal(paymentVolume(did), 1_000_000n, 'volume unchanged by the replay');
});

test('creditPayment: a receipt spent on one agent cannot be reused on another', () => {
  const tx = '0x' + 'c1'.repeat(32);
  assert.equal(creditPayment('0x' + '33'.repeat(32), tx, 500n), true);
  assert.equal(creditPayment('0x' + '44'.repeat(32), tx, 500n), false);
});

test('creditPayment: tx hash matching ignores case', () => {
  const did = '0x' + '55'.repeat(32);
  assert.equal(creditPayment(did, '0x' + 'DE'.repeat(32), 1n), true);
  assert.equal(creditPayment(did, '0x' + 'de'.repeat(32), 1n), false);
});

test('paymentVolume: an agent with no payments reads zero, not undefined', () => {
  assert.equal(paymentVolume('0x' + '99'.repeat(32)), 0n);
});

test('creditPayment: records the payer and outcome for later weighting', () => {
  const did = '0x' + '66'.repeat(32);
  creditPayment(did, '0x' + 'e1'.repeat(32), 50n, '0xalice', true, 1000);
  creditPayment(did, '0x' + 'e2'.repeat(32), 70n, '0xbob', false, 2000);
  const evs = getPaymentEvents(did);
  assert.equal(evs.length, 2);
  assert.equal(evs[0].payer, '0xalice');
  assert.equal(evs[1].success, false);
  assert.equal(evs[1].ts, 2000);
});

test('prunePaymentEvents: drops events too old to move a score, keeps the rest', () => {
  const did = '0x' + '77'.repeat(32);
  const day = 86400000, now = 1_000 * day;
  const halfLife = 90 * day;
  creditPayment(did, '0x' + 'f1'.repeat(32), 1n, '0xa', true, now - 10 * day);
  creditPayment(did, '0x' + 'f2'.repeat(32), 1n, '0xa', true, now - 900 * day);
  // The store is module-global, so other tests' events are pruned in the same
  // sweep. Assert on this agent rather than the sweep-wide count.
  prunePaymentEvents(halfLife, 0.001, now);
  const kept = getPaymentEvents(did);
  assert.equal(kept.length, 1, 'the 900-day-old event is gone');
  assert.equal(kept[0].ts, now - 10 * day, 'the recent one survived');
});

test('prunePaymentEvents: does nothing when decay is off', () => {
  const did = '0x' + '88'.repeat(32);
  creditPayment(did, '0x' + 'f3'.repeat(32), 1n, '0xa', true, 1);
  assert.equal(prunePaymentEvents(0, 0.001, 1_000_000_000_000), 0);
  assert.equal(getPaymentEvents(did).length, 1);
});
