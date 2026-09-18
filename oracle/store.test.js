'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  checkAttestCooldown,
  recordAttestation,
  pruneExpiredCooldowns,
  attestCooldowns,
  creditPayment,
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
