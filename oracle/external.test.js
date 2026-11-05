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

// ---- tags are chosen by whoever posts the feedback --------------------------

test('externalScore: a tag that names an Object.prototype member is just an unrecognized tag', () => {
  const honest = [{ value: 40, tag: 'quality' }];
  const baseline = computeExternalScore(honest);
  assert.equal(baseline, 10);
  // 'constructor' used to resolve to Object, so Object(100) joined the mean and pinned the factor at the cap.
  assert.equal(computeExternalScore([...honest, { value: 100, tag: 'constructor' }]), baseline);
  // '__proto__' used to resolve to Object.prototype, which is not a function, so the whole computation threw.
  assert.doesNotThrow(() => computeExternalScore([...honest, { value: 1, tag: '__proto__' }]));
  assert.equal(computeExternalScore([...honest, { value: 1, tag: '__proto__' }]), baseline);
  // On their own they carry no evidence at all.
  assert.equal(computeExternalScore([{ value: 100, tag: 'constructor' }, { value: 100, tag: '__proto__' }]), 0);
});

// ---- the tags the ERC-8004 spec and its best-practices guide give ------------

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

test('externalScore: starred, successRate and uptime are read as 0-100', () => {
  near(external.meanRating([{ value: 87, tag: 'starred' }]), 0.87);
  near(external.meanRating([{ value: 89, tag: 'successrate' }]), 0.89);
  near(external.meanRating([{ value: 99.77, tag: 'uptime' }]), 0.9977);
  // A catalog's five stars are starred 100, its one star starred 20.
  assert.equal(computeExternalScore([{ value: 100, tag: 'starred' }]), MAX_EXTERNAL_SCORE);
  near(external.meanRating([{ value: 20, tag: 'starred' }]), 0.2);
  assert.equal(computeExternalScore([{ value: 150, tag: 'uptime' }]), MAX_EXTERNAL_SCORE, 'clamped at 1');
});

test('externalScore: reachable is 0 or 1, and anything else is clamped', () => {
  assert.equal(external.meanRating([{ value: 1, tag: 'reachable' }]), 1);
  assert.equal(external.meanRating([{ value: 0, tag: 'reachable' }]), 0);
  assert.equal(external.meanRating([{ value: 7, tag: 'reachable' }]), 1);
  assert.equal(external.meanRating([{ value: -1, tag: 'reachable' }]), 0);
});

test('externalScore: the guide tags that are not ratings are ignored', () => {
  const rows = [
    { value: 1, tag: 'ownerverified' },
    { value: 560, tag: 'responsetime' },
    { value: 4, tag: 'blocktimefreshness' },
    { value: 560, tag: 'revenues' },
    { value: -3.2, tag: 'tradingyield' },
  ];
  assert.equal(external.meanRating(rows), null);
  assert.equal(computeExternalScore(rows), 0);
});

test('readFeedbackRows: the guide examples arrive scaled, lowercased and counted', async () => {
  const client = '0x' + '33'.repeat(20);
  // As ethers returns them: int128 and uint8 are bigints, and tags keep the poster's case.
  const feedback = [
    { value: 9977n, valueDecimals: 2n, tag1: 'uptime', tag2: '', isRevoked: false },
    { value: 89n, valueDecimals: 0n, tag1: 'successRate', tag2: '', isRevoked: false },
    { value: 87n, valueDecimals: 0n, tag1: 'starred', tag2: '', isRevoked: false },
    { value: 0n, valueDecimals: 0n, tag1: 'reachable', tag2: '', isRevoked: true },
  ];
  external.init(CFG, {
    provider: {},
    idContract: {},
    repContract: {
      getClients: async () => [client],
      getLastIndex: async () => BigInt(feedback.length),
      readFeedback: async (_agentId, _client, index) => feedback[Number(index) - 1],
    },
  });
  const rows = await external.readFeedbackRows(7);
  external.init({ externalRpc: '', externalIdentity: '', externalReputation: '' });

  assert.deepStrictEqual(rows.map((r) => r.tag), ['uptime', 'successrate', 'starred'], 'the revoked entry is skipped');
  near(rows[0].value, 99.77);
  assert.equal(rows[1].value, 89);
  near(external.meanRating(rows), (0.9977 + 0.89 + 0.87) / 3);
  assert.equal(computeExternalScore(rows), Math.round(((0.9977 + 0.89 + 0.87) / 3) * MAX_EXTERNAL_SCORE));
});

// ---- a node that cannot answer is not an agent with no feedback -------------

// As the real registries answered on 4 November 2026.
const noSuchAgent = () => Object.assign(new Error('execution reverted (unknown custom error)'), {
  code: 'CALL_EXCEPTION', data: `0x7e273289${'0'.repeat(63)}1`, reason: null,
});
const pastTheEnd = () => Object.assign(new Error('execution reverted: "index out of bounds"'), {
  code: 'CALL_EXCEPTION', data: '0x08c379a0', reason: 'index out of bounds',
});
const rateLimited = () => Object.assign(new Error('missing revert data (action="call", info={ "requestUrl": "https://rpc.example/v2/SECRET-KEY" })'), {
  code: 'CALL_EXCEPTION', data: null, reason: null, shortMessage: 'missing revert data',
  info: { error: { code: -32005, message: 'rate limit exceeded' } },
});
const internalError = () => Object.assign(new Error('could not coalesce error (error={ "code": -32603, "message": "internal error" })'), {
  code: 'UNKNOWN_ERROR', error: { code: -32603, message: 'internal error' },
});
const row = { value: 90n, valueDecimals: 0n, tag1: 'quality', tag2: '', isRevoked: false };
const OFF = { externalRpc: '', externalIdentity: '', externalReputation: '' };

function withRegistry(repContract, idContract = {}) {
  external.init(CFG, {
    provider: {},
    idContract,
    repContract: { getClients: async () => ['0xc1'], getLastIndex: async () => 1n, readFeedback: async () => row, ...repContract },
  });
}

test('readFeedbackRows: a revert is an index gap, and the rows around it are kept', async (t) => {
  t.after(() => external.init(OFF));
  let asked = 0;
  withRegistry({
    getLastIndex: async () => 3n,
    readFeedback: async (_a, _c, i) => { asked += 1; if (Number(i) === 2) throw pastTheEnd(); return row; },
  });
  assert.equal((await external.readFeedbackRows(7)).length, 2);
  assert.equal(asked, 3, 'a revert is an answer, so it is not asked again');
});

test('readFeedbackRows: a client whose count reverts is left out, and the others are kept', async (t) => {
  t.after(() => external.init(OFF));
  withRegistry({
    getClients: async () => ['0xc1', '0xc2'],
    getLastIndex: async (_a, c) => { if (c === '0xc1') throw pastTheEnd(); return 1n; },
  });
  assert.deepEqual((await external.readFeedbackRows(7)).map((r) => r.client), ['0xc2']);
});

test('readFeedbackRows: a read the node fails is tried again, and no row goes missing', async (t) => {
  t.after(() => external.init(OFF));
  for (const fail of [rateLimited, internalError]) {
    let tries = 0;
    withRegistry({ readFeedback: async () => { tries += 1; if (tries < 3) throw fail(); return row; } });
    assert.equal((await external.readFeedbackRows(7)).length, 1);
    assert.equal(tries, 3);
  }
});

test('readFeedbackRows: a read that never comes back is given up on, and tried again', async (t) => {
  t.after(() => external.init(OFF));
  let tries = 0;
  withRegistry({ readFeedback: () => { tries += 1; return tries === 1 ? new Promise(() => {}) : Promise.resolve(row); } });
  assert.equal((await external.readFeedbackRows(7)).length, 1);
  assert.equal(tries, 2);
});

test('readFeedbackRows: a row the node never answers for is thrown, not dropped', async (t) => {
  t.after(() => external.init(OFF));
  withRegistry({ readFeedback: async () => { throw rateLimited(); } });
  await assert.rejects(external.readFeedbackRows(7), { code: 'NETWORK_ERROR' });
});

test('readFeedbackRows: a count the node never answers for is thrown, not a client left out', async (t) => {
  t.after(() => external.init(OFF));
  withRegistry({ getLastIndex: async () => { throw internalError(); } });
  await assert.rejects(external.readFeedbackRows(7), { code: 'NETWORK_ERROR' });
});

test('verifyOwnership: no such agent is a no, and a node that cannot answer is not', async (t) => {
  t.after(() => external.init(OFF));
  withRegistry({}, { ownerOf: async () => { throw noSuchAgent(); } });
  assert.equal(await external.verifyOwnership(7, '0xabc'), false);
  withRegistry({}, { ownerOf: async () => { throw rateLimited(); } });
  await assert.rejects(external.verifyOwnership(7, '0xabc'), { code: 'NETWORK_ERROR' });
});

test('what is thrown holds none of the node\'s message, which can hold the RPC\'s key', async (t) => {
  t.after(() => external.init(OFF));
  withRegistry({}, { ownerOf: async () => { throw rateLimited(); } });
  await assert.rejects(external.verifyOwnership(7, '0xabc'), (err) => !err.message.includes('SECRET-KEY'));
});

test('what is thrown reads as the node\'s failure to every caller that sorts them', async (t) => {
  t.after(() => external.init(OFF));
  const { isTransientReadError } = require('./read-retry');
  withRegistry({}, { ownerOf: async () => { throw internalError(); } });
  await assert.rejects(external.verifyOwnership(7, '0xabc'), (err) => isTransientReadError(err));
});

test('externalScoreFor: 0 for a stranger\'s agent or one that does not exist, and the judge is not asked', async (t) => {
  t.after(() => external.init(OFF));
  const judge = () => { throw new Error('the judge should not be asked'); };
  withRegistry({}, { ownerOf: async () => '0xother' });
  assert.equal(await external.externalScoreFor(7, '0xabc', judge), 0);
  withRegistry({}, { ownerOf: async () => { throw noSuchAgent(); } });
  assert.equal(await external.externalScoreFor(7, '0xabc', judge), 0);
});

test('externalScoreFor: 0 when the registry itself refuses the list of clients', async (t) => {
  t.after(() => external.init(OFF));
  withRegistry({ getClients: async () => { throw pastTheEnd(); } }, { ownerOf: async () => '0xabc' });
  assert.equal(await external.externalScoreFor(7, '0xabc', () => 25), 0);
});

test('externalScoreFor: a node that cannot answer is thrown, at each read, and never reaches the judge', async (t) => {
  t.after(() => external.init(OFF));
  const judge = () => { throw new Error('the judge should not be asked'); };
  const owned = { ownerOf: async () => '0xabc' };
  for (const [rep, id] of [
    [{}, { ownerOf: async () => { throw rateLimited(); } }],
    [{ getClients: async () => { throw rateLimited(); } }, owned],
    [{ getLastIndex: async () => { throw rateLimited(); } }, owned],
    [{ readFeedback: async () => { throw rateLimited(); } }, owned],
  ]) {
    withRegistry(rep, id);
    await assert.rejects(external.externalScoreFor(7, '0xabc', judge), { code: 'NETWORK_ERROR' });
  }
});

test('externalScoreFor: what the judge makes of the rows when every read answers', async (t) => {
  t.after(() => external.init(OFF));
  withRegistry({}, { ownerOf: async () => '0xABC' });
  assert.equal(await external.externalScoreFor(7, '0xabc', (rows) => rows.length * 10), 10);
});

// ---- what reading an agent's feedback can cost -----------------------------

const lower = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const CHECKSUMMED = (a) => a.toUpperCase().replace('0X', '0x');

function counted(repContract) {
  const asked = { clients: 0, counts: [], rows: [] };
  withRegistry({
    getClients: async () => { asked.clients += 1; return repContract.clients; },
    getLastIndex: async (_a, c) => { asked.counts.push(c); return BigInt(repContract.lastOf?.(c) ?? 1); },
    readFeedback: async (_a, c, i) => { asked.rows.push([c, Number(i)]); return row; },
  });
  return asked;
}

test('readFeedbackRows: feedback from an address that never paid is not read at all', async (t) => {
  t.after(() => external.init(OFF));
  const payer = lower(1);
  const strangers = Array.from({ length: 500 }, (_, i) => lower(1000 + i));
  const asked = counted({ clients: [...strangers, payer] });
  const rows = await external.readFeedbackRows(7, undefined, [payer]);
  assert.deepEqual(rows.map((r) => r.client), [payer]);
  assert.equal(asked.clients, 1);
  assert.deepEqual(asked.counts, [payer], 'five hundred strangers cost one read between them');
  assert.equal(asked.rows.length, 1);
});

test('readFeedbackRows: nobody has paid, so there is nothing to ask the registry', async (t) => {
  t.after(() => external.init(OFF));
  const asked = counted({ clients: [lower(1)] });
  assert.deepEqual(await external.readFeedbackRows(7, undefined, []), []);
  assert.equal(asked.clients, 0);
});

test('readFeedbackRows: a payer who has posted nothing costs no read', async (t) => {
  t.after(() => external.init(OFF));
  const asked = counted({ clients: [lower(1)] });
  await external.readFeedbackRows(7, undefined, [lower(1), lower(2), lower(3)]);
  assert.deepEqual(asked.counts, [lower(1)]);
});

test('readFeedbackRows: finds a payer however the registry writes its address, and asks in that form', async (t) => {
  t.after(() => external.init(OFF));
  const written = CHECKSUMMED(lower(0xabc));
  const asked = counted({ clients: [written] });
  const rows = await external.readFeedbackRows(7, undefined, [lower(0xabc)]);
  assert.deepEqual(asked.counts, [written]);
  assert.deepEqual(rows.map((r) => r.client), [written]);
});

test('readFeedbackRows: at most the limit of clients, in the order paid, not the order posted', async (t) => {
  t.after(() => external.init(OFF));
  const payers = Array.from({ length: external.MAX_CLIENTS_READ + 20 }, (_, i) => lower(i + 1));
  const asked = counted({ clients: [...payers].reverse() });
  await external.readFeedbackRows(7, undefined, payers);
  assert.deepEqual(asked.counts, payers.slice(0, external.MAX_CLIENTS_READ));
});

test('readFeedbackRows: with no payers given, the limit still holds', async (t) => {
  t.after(() => external.init(OFF));
  const clients = Array.from({ length: external.MAX_CLIENTS_READ + 5 }, (_, i) => lower(i + 1));
  const asked = counted({ clients });
  await external.readFeedbackRows(7);
  assert.equal(asked.counts.length, external.MAX_CLIENTS_READ);
});

test('readFeedbackRows: the newest rows of a client, oldest of them first, and no more', async (t) => {
  t.after(() => external.init(OFF));
  const asked = counted({ clients: [lower(1)], lastOf: () => 25 });
  const rows = await external.readFeedbackRows(7, undefined, [lower(1)]);
  assert.deepEqual(asked.rows.map(([, i]) => i), [16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
  assert.equal(rows.length, external.MAX_ROWS_PER_CLIENT);
});

test('readFeedbackRows: a client with fewer rows than the limit has them all read', async (t) => {
  t.after(() => external.init(OFF));
  const asked = counted({ clients: [lower(1)], lastOf: () => 3 });
  await external.readFeedbackRows(7, undefined, [lower(1)]);
  assert.deepEqual(asked.rows.map(([, i]) => i), [1, 2, 3]);
});

test('readFeedbackRows: exactly the limit of rows has them all read', async (t) => {
  t.after(() => external.init(OFF));
  const asked = counted({ clients: [lower(1)], lastOf: () => external.MAX_ROWS_PER_CLIENT });
  await external.readFeedbackRows(7, undefined, [lower(1)]);
  assert.equal(asked.rows[0][1], 1);
  assert.equal(asked.rows.length, external.MAX_ROWS_PER_CLIENT);
});

test('externalScoreFor: hands the payers on, so the judge sees only what they posted', async (t) => {
  t.after(() => external.init(OFF));
  withRegistry({ getClients: async () => [lower(1), lower(2)] }, { ownerOf: async () => '0xabc' });
  const seen = await external.externalScoreFor(7, '0xabc', (rows) => rows.map((r) => r.client), undefined, [lower(2)]);
  assert.deepEqual(seen, [lower(2)]);
});

// ---- links made on chain (link-claims.js) ------------------------------------

const DID = `0x${'ab'.repeat(32)}`;
const OPERATOR = `0x${'a0'.repeat(20)}`;

/** An identity registry whose metadata and owner are given per block; `calls` records each read. */
function registry({ value = DID, owner = OPERATOR, logs = [] } = {}) {
  const calls = [];
  const idContract = {
    getMetadata: async (agentId, key, at) => { calls.push(['getMetadata', String(agentId), key, at?.blockTag]); return value; },
    ownerOf: async (agentId, at) => { calls.push(['ownerOf', String(agentId), at?.blockTag]); return owner; },
    filters: { MetadataSet: (agentId, key) => ({ agentId, key }) },
    queryFilter: async (filter, from, to) => { calls.push(['queryFilter', filter.key, from, to]); return logs; },
  };
  external.init(CFG, { provider: {}, idContract, repContract: {} });
  return calls;
}

test('claimHolds: the 8004 agent still names the didHash and its owner is the operator, as of the block asked', async () => {
  const calls = registry({ value: DID.toUpperCase().replace('0X', '0x'), owner: OPERATOR.toUpperCase().replace('0X', '0x') });
  assert.equal(await external.claimHolds('7', 'sigvara', DID, OPERATOR, 120), true);
  assert.deepEqual(calls, [['getMetadata', '7', 'sigvara', 120], ['ownerOf', '7', 120]]);
  external.init({ externalRpc: '', externalIdentity: '', externalReputation: '' });
});

test('claimHolds: a cleared or changed key, or an NFT that moved, does not hold', async () => {
  registry({ value: '0x' });
  assert.equal(await external.claimHolds('7', 'sigvara', DID, OPERATOR), false, 'the key was cleared');
  registry({ value: `0x${'cd'.repeat(32)}` });
  assert.equal(await external.claimHolds('7', 'sigvara', DID, OPERATOR), false, 'it names another agent now');
  registry({ owner: `0x${'b0'.repeat(20)}` });
  assert.equal(await external.claimHolds('7', 'sigvara', DID, OPERATOR), false, 'the NFT moved to another wallet');
  external.init({ externalRpc: '', externalIdentity: '', externalReputation: '' });
});

test('claimHolds: a failed read is thrown, not taken as a no', async () => {
  external.init(CFG, {
    provider: {},
    idContract: { getMetadata: async () => { throw new Error('429 too many requests'); }, ownerOf: async () => OPERATOR },
    repContract: {},
  });
  await assert.rejects(external.claimHolds('7', 'sigvara', DID, OPERATOR), /429/);
  external.init({ externalRpc: '', externalIdentity: '', externalReputation: '' });
});

test('readLinkLogs: filters on the key, and returns each log\'s agent, value and position', async () => {
  const log = (metadataKey, agentId, blockNumber, index) => ({
    args: { agentId: BigInt(agentId), metadataKey, metadataValue: DID }, blockNumber, index,
  });
  const calls = registry({ logs: [log('sigvara', 7, 120, 3), log('agentWallet', 8, 121, 0)] });
  assert.deepEqual(await external.readLinkLogs('sigvara', 100, 199), [
    { agentId: 7n, value: DID, blockNumber: 120, logIndex: 3 },
  ], 'a log for another key is dropped, though the node should not have sent it');
  assert.deepEqual(calls, [['queryFilter', 'sigvara', 100, 199]]);
  external.init({ externalRpc: '', externalIdentity: '', externalReputation: '' });
});
