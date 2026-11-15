'use strict';

// GET /evidence/:didHash end to end: the whole body, its pages, and what the cache keeps
// (performance review, 15 November).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const merkle = require('./merkle');
const { World, startOracle } = require('./test-support/oracle-harness');

const N = 600;
let world;
let oracle;
let agent;

before(async () => {
  world = new World();
  agent = world.addRegisteredAgent({ registeredDaysAgo: 30 });
  const nowMs = world.data.nowSec * 1000;
  const events = Array.from({ length: N }, (_, i) => ({
    txHash: `0x${(i + 1).toString(16).padStart(64, '0')}`,
    ts: nowMs - (N - i) * 60_000,
    amount: '5000000',
    payer: `0x${String((i % 7) + 1).repeat(40)}`,
    success: i % 3 === 0 ? null : true,
  }));
  // No payment verification, so the epoch reads none of these payments again: they are on no chain here.
  oracle = await startOracle({ world, files: { 'state.json': JSON.stringify({ schemaVersion: 1, paymentEvents: { [agent.didHash]: events } }) } });
  // Nothing below may meet the startup epoch changing the list.
  await oracle.waitForLog(/epoch done/);
});

after(async () => {
  await oracle.stop();
});

const get = (query = '') => oracle.call('GET', `/evidence/${agent.didHash}${query}`);

test('the whole body is built a slice at a time, and is the bytes JSON.stringify gives', async () => {
  const r = await get();
  assert.equal(r.status, 200, r.text);
  assert.equal(JSON.stringify(JSON.parse(r.text)), r.text);
  assert.equal(r.body.count, N);
  assert.equal(r.body.evidence.length, N);
  for (const i of [0, 255, 256, 599]) {
    assert.ok(merkle.verifyProof(r.body.evidence[i].leaf, r.body.evidence[i].proof, r.body.evidenceRoot), `proof ${i}`);
  }
});

// The body is every payment with its proof: 31.6 MB for an agent at the cap of 25,000, 41.2 MB with payer outcomes.
test('pages of the body, asked for by offset and limit, put together are the whole list', async () => {
  const whole = (await get()).body;
  const pages = [];
  for (let offset = 0; offset !== null;) {
    const r = await get(`?offset=${offset}&limit=250`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.offset, offset);
    assert.equal(r.body.evidenceRoot, whole.evidenceRoot);
    assert.equal(r.body.count, N);
    pages.push(r.body);
    offset = r.body.next;
  }
  assert.deepEqual(pages.map((p) => p.next), [250, 500, null]);
  assert.deepEqual(pages.flatMap((p) => p.evidence), whole.evidence);
  for (const bad of ['?limit=0', '?limit=1001', '?offset=-1', '?offset=1.5', '?offset=abc']) {
    assert.equal((await get(bad)).status, 400, bad);
  }
});

// One agent's hash has many spellings, and each used to be its own entry and its own Merkle rebuild.
test('the cache is keyed on the stored spelling, not the caller\'s', async () => {
  const metric = async (re) => Number((await oracle.call('GET', '/metrics')).text.match(re)[1]);
  const ENTRIES = /^sigvara_oracle_evidence_cache_entries (\d+)$/m;
  const HITS = /^sigvara_oracle_evidence_cache_total\{result="hit"\} (\d+)$/m;
  await get();
  const [entries, hits] = [await metric(ENTRIES), await metric(HITS)];
  const upper = `0x${agent.didHash.slice(2).toUpperCase()}`;
  const mixed = `0x${agent.didHash.slice(2, 10).toUpperCase()}${agent.didHash.slice(10)}`;
  for (const spelling of [upper, mixed]) assert.equal((await oracle.call('GET', `/evidence/${spelling}`)).status, 200);
  assert.equal(await metric(ENTRIES), entries, 'no entry of their own');
  assert.equal(await metric(HITS), hits + 2, 'both served from the one there is');
});

// One body stored for every didHash anyone asked about pushed out the bodies worth keeping.
test('an agent with nothing to list is not cached', async () => {
  const entries = async () => Number((await oracle.call('GET', '/metrics')).text.match(/^sigvara_oracle_evidence_cache_entries (\d+)$/m)[1]);
  await get();
  const held = await entries();
  for (let i = 0; i < 3; i += 1) {
    const r = await oracle.call('GET', `/evidence/0x${String(i + 1).repeat(64)}`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.count, 0);
  }
  assert.equal(await entries(), held);
});
