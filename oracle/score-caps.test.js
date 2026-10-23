'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CAPS } = require('./score-caps');

const SOL = path.join(__dirname, '..', 'src', 'SigvaraReputation.sol');

// The name the contract gives each factor's cap.
const CONTRACT_NAME = {
  fee: 'MAX_FEE_SCORE',
  success: 'MAX_SUCCESS_SCORE',
  age: 'MAX_AGE_SCORE',
  external: 'MAX_EXTERNAL_SCORE',
  community: 'MAX_COMMUNITY_SCORE',
  propagation: 'MAX_PROPAGATION_SCORE',
};

test('every factor cap equals the one SigvaraReputation.sol enforces', () => {
  const source = fs.readFileSync(SOL, 'utf8');
  for (const [factor, name] of Object.entries(CONTRACT_NAME)) {
    const m = new RegExp(`uint8\\s+public\\s+constant\\s+${name}\\s*=\\s*(\\d+)\\s*;`).exec(source);
    assert.ok(m, `${name} was not found in SigvaraReputation.sol`);
    assert.equal(CAPS[factor], Number(m[1]), `${factor}: oracle ${CAPS[factor]}, contract ${m[1]}`);
  }
});

test('the six caps sum to 100', () => {
  assert.equal(Object.values(CAPS).reduce((a, b) => a + b, 0), 100);
});

test('the caps cannot be changed at run time', () => {
  assert.throws(() => { CAPS.fee = 99; }, TypeError);
});

test('payer hard standing is scaled by the external cap, as the web of trust assumes', () => {
  // payments.js documents what happens if these drift: a fully trusted counterparty stops counting as one.
  assert.equal(require('./payments').MAX_HARD_SCORE, require('./external').MAX_EXTERNAL_SCORE);
});
