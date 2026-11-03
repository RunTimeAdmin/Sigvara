'use strict';

// Which ERC-8004 feedback counts (reviewers.js). The registry takes feedback from anyone, so
// every test here is about a way of posting it that should not buy the factor.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parsePublicFunders, findFirstFunder, verdictFor, scoreReviews, scoreFeedback,
  REVIEWER_MIN_TENURE_DAYS, REVIEWER_MIN_SCORE, FULL_WEIGHT_CLUSTERS,
} = require('./reviewers');
const { MAX_EXTERNAL_SCORE } = require('./external');
const { World, startOracle, runToExit, wallet } = require('./test-support/oracle-harness');

const DAY_MS = 86_400_000;
const NOW_MS = 1_800_000_000_000;
const addr = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const AGENT = { operator: addr(0xa0), agentAddress: addr(0xa1) };

/** A reviewer that passes every rule: paid today, Active, bonded, a year old, scored 60. */
function goodStanding(operator) {
  return { registered: true, operator, status: 0, registeredAt: (NOW_MS - 365 * DAY_MS) / 1000, matured: 60, bonded: true };
}

/**
 * A world of reviewers: each has its own operator and is funded by its own wallet, which a
 * faucet funded, unless the test says otherwise.
 */
function world(n, { standing = {}, funders = {}, paidDaysAgo = 0 } = {}) {
  const clients = Array.from({ length: n }, (_, i) => addr(0x100 + i));
  const events = clients.map((c) => ({ payer: c, ts: NOW_MS - paidDaysAgo * DAY_MS, amount: '1000000' }));
  const deps = {
    standingOf: async (c) => standing[c] ?? goodStanding(addr(0x200 + clients.indexOf(c))),
    funderOf: async (a) => (a in funders ? funders[a] : clients.includes(a) ? addr(0x300 + clients.indexOf(a)) : FAUCET),
    publicFunders: new Set([FAUCET]),
  };
  return { clients, ctx: { agent: AGENT, events, nowMs: NOW_MS }, deps };
}
const FAUCET = addr(0xfa);
const rated = (clients, value = 100) => clients.map((client) => ({ client, value, tag: 'quality' }));

// ---- the rules ------------------------------------------------------------------------

test('fifty fresh wallets rating an agent 100 are worth nothing', async () => {
  // What the factor used to be: any address posting quality=100 carried a linked agent to the cap.
  const spam = Array.from({ length: 50 }, (_, i) => addr(0x900 + i));
  const { ctx, deps } = world(0);
  let reads = 0;
  const counting = { ...deps, standingOf: async (c) => { reads++; return deps.standingOf(c); } };
  const r = await scoreFeedback(rated(spam), ctx, counting);
  assert.equal(r.score, 0);
  assert.deepEqual(r.excluded, { unpaid: 50 });
  assert.equal(reads, 0, 'an unpaid reviewer costs no chain read');
});

test('one independent reviewer who paid today is worth a fifth of the cap', async () => {
  const { clients, ctx, deps } = world(1);
  assert.equal((await scoreFeedback(rated(clients), ctx, deps)).score, MAX_EXTERNAL_SCORE / FULL_WEIGHT_CLUSTERS);
});

test('five independent reviewers who paid recently reach the cap', async () => {
  const { clients, ctx, deps } = world(5);
  const r = await scoreFeedback(rated(clients), ctx, deps);
  assert.equal(r.score, MAX_EXTERNAL_SCORE);
  assert.equal(r.clusters, 5);
});

test('reviewers funded from one wallet count once between them', async () => {
  const shared = addr(0x777);
  const { clients, ctx, deps } = world(5);
  deps.funderOf = async (a) => (clients.includes(a) ? shared : FAUCET);
  const r = await scoreFeedback(rated(clients), ctx, deps);
  assert.equal(r.clusters, 1);
  assert.equal(r.score, MAX_EXTERNAL_SCORE / FULL_WEIGHT_CLUSTERS);
});

test('a shared funder two hops back still joins them, and a public one does not', async () => {
  // Each reviewer has its own funder, and every one of those was funded by the same treasury.
  const treasury = addr(0x888);
  const { clients, ctx, deps } = world(5);
  const own = deps.funderOf;
  const middle = (a) => Number(a) >= 0x300 && Number(a) < 0x305; // each reviewer's own funder
  deps.funderOf = async (a) => (middle(a) ? treasury : own(a));
  assert.equal((await scoreFeedback(rated(clients), ctx, deps)).clusters, 1);

  // The same shape through a faucet is five independent reviewers.
  deps.funderOf = async (a) => (middle(a) ? FAUCET : own(a));
  assert.equal((await scoreFeedback(rated(clients), ctx, deps)).clusters, 5);
});

test('reviewers run by one operator count once between them', async () => {
  const op = addr(0x555);
  const { clients, ctx, deps } = world(5);
  deps.standingOf = async () => goodStanding(op);
  assert.equal((await scoreFeedback(rated(clients), ctx, deps)).clusters, 1);
});

test('a reviewer posting many reviews is one reviewer', async () => {
  const { clients, ctx, deps } = world(1);
  const many = Array.from({ length: 30 }, () => ({ client: clients[0], value: 100, tag: 'quality' }));
  const r = await scoreFeedback(many, ctx, deps);
  assert.equal(r.reviewers, 1);
  assert.equal(r.score, MAX_EXTERNAL_SCORE / FULL_WEIGHT_CLUSTERS);
});

test('a review counts for half once the payment behind it is ninety days old', async () => {
  const { clients, ctx, deps } = world(5, { paidDaysAgo: 90 });
  // Five reviewers at half weight are 2.5 of the 5 needed for the cap: 12.5, rounded.
  assert.equal((await scoreFeedback(rated(clients), ctx, deps)).score, 13);
});

test('each standing rule keeps a reviewer out, and says which', async () => {
  const cases = [
    ['not-an-agent', { registered: false }],
    ['unbonded', { ...goodStanding(addr(0x201)), bonded: false }],
    ['unbonded', { ...goodStanding(addr(0x201)), status: 1 }],
    ['too-new', { ...goodStanding(addr(0x201)), registeredAt: (NOW_MS - (REVIEWER_MIN_TENURE_DAYS - 1) * DAY_MS) / 1000 }],
    ['low-score', { ...goodStanding(addr(0x201)), matured: REVIEWER_MIN_SCORE - 1 }],
    ['self', goodStanding(AGENT.operator)],
  ];
  for (const [reason, standing] of cases) {
    const { clients, ctx, deps } = world(1);
    deps.standingOf = async () => standing;
    assert.deepEqual(await verdictFor(clients[0], ctx, deps), { ok: false, reason }, reason);
  }
});

test('the agent cannot review itself, nor fund its reviewers', async () => {
  const { ctx, deps } = world(1);
  const self = { ...ctx, events: [{ payer: AGENT.operator, ts: NOW_MS, amount: '1' }] };
  assert.equal((await verdictFor(AGENT.operator, self, deps)).reason, 'self');

  // Funded by the agent's operator directly, and through one wallet in between.
  const direct = world(1);
  direct.deps.funderOf = async () => AGENT.operator;
  assert.equal((await verdictFor(direct.clients[0], direct.ctx, direct.deps)).reason, 'self-funded');
  const twoHops = world(1);
  const middle = addr(0x444);
  twoHops.deps.funderOf = async (a) => (a === middle ? AGENT.agentAddress : middle);
  assert.equal((await verdictFor(twoHops.clients[0], twoHops.ctx, twoHops.deps)).reason, 'self-funded');
});

test('a reviewer whose funder cannot be found is not counted', async () => {
  const { clients, ctx, deps } = world(1);
  deps.funderOf = async () => null;
  assert.equal((await verdictFor(clients[0], ctx, deps)).reason, 'unknown-funder');
});

test('feedback in tags this oracle does not read costs no chain read and changes nothing', async () => {
  const { clients, ctx, deps } = world(5);
  let reads = 0;
  deps.standingOf = ((prev) => async (c) => { reads++; return prev(c); })(deps.standingOf);
  const r = await scoreFeedback(clients.map((client) => ({ client, value: 1500, tag: 'glicko2-mu' })), ctx, deps);
  assert.equal(r.score, 0);
  assert.equal(reads, 0);
});

test('scoreReviews is the arithmetic alone: unchecked reviewers are left out', () => {
  const rows = rated([addr(1), addr(2)]);
  const verdicts = new Map([[addr(1), { ok: true, lastPaidMs: NOW_MS, keys: [addr(1)] }]]);
  assert.deepEqual(scoreReviews(rows, verdicts, NOW_MS), {
    score: MAX_EXTERNAL_SCORE / FULL_WEIGHT_CLUSTERS, reviewers: 1, clusters: 1, excluded: { unchecked: 1 },
  });
});

// ---- the first funder -------------------------------------------------------------------

test('findFirstFunder: finds the first funding block and its sender in a few dozen reads', async () => {
  const head = 70_000_000;
  let reads = 0;
  const read = {
    head: async () => head,
    touched: async (b) => { reads++; return b >= 12_345_678; },
    inbound: async (b) => (b === 12_345_678 ? ['0xAbC0000000000000000000000000000000000001', addr(9)] : []),
  };
  assert.equal(await findFirstFunder(read, addr(1)), '0xabc0000000000000000000000000000000000001');
  assert.ok(reads <= 2 + Math.ceil(Math.log2(head)), `${reads} reads`);
});

test('findFirstFunder: null for an address never funded, or one first touched with nothing sent to it', async () => {
  const never = { head: async () => 100, touched: async () => false, inbound: async () => [] };
  assert.equal(await findFirstFunder(never, addr(1)), null);
  const sponsored = { head: async () => 100, touched: async (b) => b >= 40, inbound: async () => [] };
  assert.equal(await findFirstFunder(sponsored, addr(1)), null);
});

test('parsePublicFunders: a list of addresses, and nothing else', () => {
  assert.deepEqual([...parsePublicFunders(undefined).set], []);
  assert.deepEqual([...parsePublicFunders(' , ').set], []);
  const a = '0xD844ba11f64d23a7481e24474d2f184e350b9b3d';
  assert.deepEqual([...parsePublicFunders(`${a}, ${addr(1)}`).set], [a.toLowerCase(), addr(1)]);
  assert.match(parsePublicFunders(`${a},faucet`).error, /"faucet", which is not an address/);
});

// ---- end to end: what a primary proposes -------------------------------------------------

const ADMIN = 'a'.repeat(64);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A linked agent and `n` reviewers who each paid it an hour ago, in a world the stub chain reads. */
function linkedWorld(n) {
  const w = new World();
  const agent = w.addRegisteredAgent();
  const reviewers = Array.from({ length: n }, () => wallet().toLowerCase());
  const nowMs = w.data.nowSec * 1000;
  const events = reviewers.map((payer, i) => ({
    payer, ts: nowMs - 3_600_000, amount: '1000000', txHash: `0x${(i + 1).toString(16).padStart(64, '0')}`,
  }));
  w.set('externalOwns', true);
  w.set('externalFeedback', rated(reviewers));
  w.set('reviewers', Object.fromEntries(reviewers.map((r) => [r, {
    registered: true, operator: wallet(), status: 0, registeredAt: w.data.nowSec - 365 * 86_400, matured: 60, bonded: true,
  }])));
  w.set('funders', Object.fromEntries(reviewers.map((r) => [r, wallet().toLowerCase()])));
  const state = JSON.stringify({ schemaVersion: 1, links: { [agent.didHash]: '7' }, paymentEvents: { [agent.didHash]: events } });
  return { w, agent, reviewers, files: { 'state.json': state } };
}

async function proposedExternal(w, files, env = {}) {
  const oracle = await startOracle({ world: w, env: { ORACLE_ADMIN_TOKEN: ADMIN, ...env }, files });
  try {
    for (let i = 0; i < 300 && !oracle.calls().some((c) => c.name === 'proposeScore'); i++) await sleep(50);
    const call = oracle.calls().find((c) => c.name === 'proposeScore');
    assert.ok(call, `nothing was proposed:\n${oracle.logs()}`);
    return { external: call.args[1].externalScore, logs: oracle.logs() };
  } finally {
    await oracle.stop();
  }
}

test('end to end: five independent paying reviewers carry a linked agent to the cap, and spam adds nothing', async () => {
  const { w, files } = linkedWorld(5);
  const spam = Array.from({ length: 20 }, () => ({ client: wallet().toLowerCase(), value: 100, tag: 'quality' }));
  w.set('externalFeedback', [...w.data.externalFeedback, ...spam]);
  const { external, logs } = await proposedExternal(w, files);
  assert.equal(external, MAX_EXTERNAL_SCORE);
  assert.match(logs, /external: 25\/25 from 5 reviewer\(s\) in 5 cluster\(s\); not counted: unpaid 20/);
});

test('end to end: the same five funded from one wallet are worth one', async () => {
  const { w, reviewers, files } = linkedWorld(5);
  const treasury = wallet().toLowerCase();
  w.set('funders', Object.fromEntries(reviewers.map((r) => [r, treasury])));
  assert.equal((await proposedExternal(w, files)).external, MAX_EXTERNAL_SCORE / FULL_WEIGHT_CLUSTERS);
});

test('end to end: a reviewer the node cannot answer for leaves the factor at 0, and the epoch goes on', async () => {
  const { w, reviewers, files } = linkedWorld(5);
  w.set('reviewers', { ...w.data.reviewers, [reviewers[2]]: 'throw' });
  assert.equal((await proposedExternal(w, files)).external, 0);
});

test('a malformed EXTERNAL_PUBLIC_FUNDERS stops the oracle at startup', async () => {
  const { code, log } = await runToExit({ world: new World(), env: { ORACLE_ADMIN_TOKEN: ADMIN, EXTERNAL_PUBLIC_FUNDERS: 'faucet' } });
  assert.equal(code, 1);
  assert.match(log, /EXTERNAL_PUBLIC_FUNDERS has "faucet", which is not an address/);
});
