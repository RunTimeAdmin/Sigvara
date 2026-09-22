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

// ---------------------------------------------------------------------------
// Chain id reporting
//
// These exist because `configured()` reported success for four rounds while the
// container held an RPC for a different chain. A status that cannot fail is not a
// status, so the point of every test below is that this one can.
// ---------------------------------------------------------------------------

const CFG = {
  externalRpc: 'https://example.invalid',
  externalIdentity: '0x' + '11'.repeat(20),
  externalReputation: '0x' + '22'.repeat(20),
};

test('chainState: disabled when the feed is not configured', () => {
  external.init({ externalRpc: '', externalIdentity: '', externalReputation: '' });
  assert.deepStrictEqual(external.chainState(), { status: 'disabled', chainId: null });
});

test('chainState: configured but unreachable is NOT reported as configured', async () => {
  // The whole point. Three non-empty strings used to read as success.
  external.init(CFG, {
    provider: { getNetwork: async () => { throw new Error('ECONNREFUSED'); } },
    idContract: {}, repContract: {},
  });
  await external.refreshChainId();

  const s = external.chainState();
  assert.strictEqual(s.status, 'unreachable');
  assert.strictEqual(s.chainId, null);
  assert.match(s.error, /ECONNREFUSED/);
});

test('chainState: reports the chain it actually reached', async () => {
  external.init(CFG, {
    provider: { getNetwork: async () => ({ chainId: 5042002n }) },
    idContract: {}, repContract: {},
  });
  await external.refreshChainId();

  assert.deepStrictEqual(external.chainState(), { status: 'configured', chainId: 5042002 });
});

test('chainState: a cached id from the old chain does not survive a re-init', async () => {
  // Re-init means the feed was repointed. Reporting the previous chain afterwards is
  // precisely the failure this was written to make visible.
  external.init(CFG, {
    provider: { getNetwork: async () => ({ chainId: 84532n }) },
    idContract: {}, repContract: {},
  });
  await external.refreshChainId();
  assert.strictEqual(external.chainState().chainId, 84532);

  external.init(CFG, {
    provider: { getNetwork: async () => ({ chainId: 5042002n }) },
    idContract: {}, repContract: {},
  });
  assert.strictEqual(external.chainState().status, 'unreachable', 'stale id must be dropped immediately');

  await external.refreshChainId();
  assert.strictEqual(external.chainState().chainId, 5042002);
});

test('refreshChainId: never throws, whatever the provider does', async () => {
  external.init(CFG, {
    provider: { getNetwork: async () => { throw new Error('boom'); } },
    idContract: {}, repContract: {},
  });
  assert.strictEqual(await external.refreshChainId(), null);

  external.init({ externalRpc: '', externalIdentity: '', externalReputation: '' });
  assert.strictEqual(await external.refreshChainId(), null, 'disabled feed resolves to null, not an error');
});

test('refreshChainId: a hung provider does not hang the caller forever', async () => {
  external.init(CFG, {
    provider: { getNetwork: () => new Promise(() => {}) }, // never settles
    idContract: {}, repContract: {},
  });
  const started = Date.now();
  const id = await external.refreshChainId();
  assert.strictEqual(id, null);
  assert.ok(Date.now() - started < 20_000, 'must time out rather than wait on a dead RPC');
  assert.match(external.chainState().error, /timeout/i);
});
