'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  checkAttestCooldown,
  recordAttestation,
  pruneExpiredCooldowns,
  attestCooldowns,
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
