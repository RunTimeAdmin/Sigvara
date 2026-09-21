'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeExternalScore, MAX_EXTERNAL_SCORE } = require('./external');
const external = require('./external');

// ---- computeExternalScore (the pure normalization) -------------------------

test('externalScore: no rows = 0', () => {
  assert.equal(computeExternalScore([]), 0);
});

test('externalScore: only unrecognized tags = 0 (excluded, not guessed)', () => {
  const rows = [
    { value: 1500, tag: 'glicko2-mu' },
    { value: 2, tag: 'match-count' },
    { value: 5, tag: 'swap-execution' },
  ];
  assert.equal(computeExternalScore(rows), 0);
});

test('externalScore: a perfect 0-100 quality rating = 15', () => {
  assert.equal(computeExternalScore([{ value: 100, tag: 'quality' }]), MAX_EXTERNAL_SCORE);
});

test('externalScore: a zero rating = 0', () => {
  assert.equal(computeExternalScore([{ value: 0, tag: 'quality' }]), 0);
});

test('externalScore: normalizes different scales onto 0..1 before averaging', () => {
  // quality 80/100 = 0.8, win-rate 0.6, e2e-test 4/5 = 0.8 -> mean 0.733 -> 18
  const rows = [
    { value: 80, tag: 'quality' },
    { value: 0.6, tag: 'win-rate' },
    { value: 4, tag: 'e2e-test' },
  ];
  assert.equal(computeExternalScore(rows), 18);
});

test('externalScore: excludes unrecognized tags from the mean', () => {
  // only the quality=100 counts; glicko2-mu is dropped -> 15, not dragged down
  const rows = [
    { value: 100, tag: 'quality' },
    { value: 1500, tag: 'glicko2-mu' },
  ];
  assert.equal(computeExternalScore(rows), MAX_EXTERNAL_SCORE);
});

test('externalScore: negative rating clamps to 0 contribution', () => {
  // reliability -20 -> clamp01(-0.2)=0, quality 100 -> 1 ; mean 0.5 -> 13 (rounded)
  const rows = [
    { value: -20, tag: 'reliability' },
    { value: 100, tag: 'quality' },
  ];
  assert.equal(computeExternalScore(rows), 13);
});

// -------------------------------------------------------------------------
// configured()
// -------------------------------------------------------------------------

test('configured(): false until all three EXTERNAL_* values are present', () => {
  // Partial config is the dangerous case. Two of three set looks configured to a
  // reader of the env file and is inert at runtime, which is how externalScore can
  // read 0 for every agent while the roadmap says the feature is live.
  external.init({ externalRpc: '', externalIdentity: '', externalReputation: '' });
  assert.equal(external.configured(), false);

  external.init({
    externalRpc: 'https://sepolia.base.org',
    externalIdentity: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    externalReputation: '',
  });
  assert.equal(external.configured(), false, 'two of three is not configured');

  external.init({
    externalRpc: 'https://sepolia.base.org',
    externalIdentity: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    externalReputation: '0x8004B663056A597Dffe9eCcC1965A193B7388713',
  });
  assert.equal(external.configured(), true);

  // Leave the module inert for any test that runs after this one.
  external.init({ externalRpc: '', externalIdentity: '', externalReputation: '' });
});

test('externalScoreFor: returns 0 and does not throw when unconfigured', () => {
  // The fail-safe the epoch depends on: an unconfigured or unreachable external
  // registry must cost a factor, never an epoch.
  external.init({ externalRpc: '', externalIdentity: '', externalReputation: '' });
  return external.externalScoreFor(1, '0x0000000000000000000000000000000000000001')
    .then(v => assert.equal(v, 0));
});
