'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { checkNumericConfig, numberProblem, oracleModeError, NUMERIC } = require('./config');

// These are the values that used to turn a control off. Each parsed to NaN, a comparison
// against NaN is never true, and the failure was silent and in the unsafe direction.

test('checkNumericConfig: nothing set is nothing to complain about', () => {
  assert.deepEqual(checkNumericConfig({}), []);
});

test('checkNumericConfig: blank is how a template says unset, and is left to the module', () => {
  const blanks = Object.fromEntries(NUMERIC.map(([name]) => [name, '']));
  assert.deepEqual(checkNumericConfig(blanks), []);
  assert.deepEqual(checkNumericConfig({ PAYMENT_MAX_PER_PAYER: '   ' }), []);
});

test('checkNumericConfig: ordinary values pass', () => {
  assert.deepEqual(checkNumericConfig({
    PORT: '3030', FROM_BLOCK: '27226954', LOG_CHUNK_SIZE: '9000', ATTEST_COOLDOWN_MS: '3600000',
    PAYMENT_MIN_AMOUNT: '10000', PAYMENT_FEE_UNIT: '100000000000000000000',
    PAYMENT_MIN_CONFIRMATIONS: '1', PAYMENT_HALF_LIFE_DAYS: '90', PAYMENT_MAX_PER_PAYER: '4',
    PAYMENT_TRUST_WEIGHT: '1', FLAG_HALF_LIFE_DAYS: '30', EXPECTED_CHAIN_ID: '5042',
    TX_WAIT_SECONDS: '60', MAX_FEE_GWEI: '1000', MAX_TX_COST: '0.5', MAX_CLOCK_SKEW_SECONDS: '600',
    MAX_SILENCE_MINUTES: '120', FINAL_WARNING_MINUTES: '60', POLL_SECONDS: '300',
  }), []);
});

test('checkNumericConfig: the settings that used to fail open are refused', () => {
  for (const [name, value] of [
    ['PAYMENT_MAX_PER_PAYER', 'four'],       // removed the per-payer cap
    ['PAYMENT_MAX_PER_PAYER', '4.5'],        // threw for every agent at epoch time
    ['PAYMENT_HALF_LIFE_DAYS', '90d'],       // removed decay
    ['PAYMENT_HALF_LIFE_DAYS', '-1'],
    ['PAYMENT_TRUST_WEIGHT', 'x'],
    ['PAYMENT_MIN_CONFIRMATIONS', 'one'],    // used to fall back to 1 without a word
    ['PAYMENT_MIN_CONFIRMATIONS', '0'],
    ['PAYMENT_FEE_UNIT', '0'],               // divides by zero at scoring time
    ['PAYMENT_FEE_UNIT', '1e20'],            // BigInt() cannot read it
    ['PAYMENT_MIN_AMOUNT', '1.5'],
    ['FLAG_HALF_LIFE_DAYS', 'thirty'],
    ['MAX_SILENCE_MINUTES', '2h'],           // never judged a checker silent
    ['FINAL_WARNING_MINUTES', 'soon'],
    ['POLL_SECONDS', '10'],
    ['FROM_BLOCK', 'latest'],
    ['LOG_CHUNK_SIZE', '0'],
    ['PORT', '70000'],
    ['PORT', 'http'],
    ['EXPECTED_CHAIN_ID', 'arc'],
    ['TX_WAIT_SECONDS', '0'],
    ['MAX_FEE_GWEI', '0'],
    ['MAX_TX_COST', 'free'],
  ]) {
    const problems = checkNumericConfig({ [name]: value });
    assert.equal(problems.length, 1, `${name}=${value} was accepted`);
    assert.ok(problems[0].startsWith(`${name}=`), problems[0]);
  }
});

test('checkNumericConfig: every problem is listed, not just the first', () => {
  const problems = checkNumericConfig({ PAYMENT_MAX_PER_PAYER: 'four', FROM_BLOCK: 'latest', PORT: '3030' });
  assert.equal(problems.length, 2);
});

test('numberProblem: only a plain decimal is a number', () => {
  // Number() would read each of these, and none is a setting anybody meant to write.
  for (const odd of ['0x10', 'Infinity', '1_000', '1,000', ' ', 'NaN', '--1']) {
    assert.notEqual(numberProblem(odd, 'num'), null, odd);
  }
  assert.equal(numberProblem('1e3', 'int'), null, 'scientific notation that is a whole number');
  assert.equal(numberProblem(' 42 ', 'int'), null, 'surrounding spaces are not part of the number');
  assert.equal(numberProblem('007', 'bigint'), null);
});

test('checkNumericConfig: the message names the setting and the value but is bounded', () => {
  const [p] = checkNumericConfig({ PAYMENT_HALF_LIFE_DAYS: 'x'.repeat(500) });
  assert.ok(p.startsWith('PAYMENT_HALF_LIFE_DAYS="'));
  assert.ok(p.length < 150);
});

// A template that a startup check refuses would turn "copy the example and fill it in" into a
// crash on first run, and nobody reads a template again once it has failed.
test('the env templates we ship pass the startup check', () => {
  for (const name of ['.env.example', '.env.checker.example', '.env.watcher.example']) {
    const env = {};
    for (const line of fs.readFileSync(path.join(__dirname, name), 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
      if (m) env[m[1]] = m[2];
    }
    assert.ok(Object.keys(env).length > 3, `${name} was read`);
    assert.deepEqual(checkNumericConfig(env), [], name);
  }
});

test('oracleModeError: unset, blank, primary and checker are modes; anything else is refused', () => {
  for (const ok of [undefined, '', 'primary', 'checker']) assert.equal(oracleModeError(ok), null, String(ok));
  for (const bad of ['Checker', 'CHECKER', ' checker', 'checker ', 'chekcer', 'watcher']) {
    assert.match(oracleModeError(bad), /is not a mode/, bad);
  }
});
