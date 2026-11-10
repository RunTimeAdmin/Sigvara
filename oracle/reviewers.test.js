'use strict';

// Which ERC-8004 feedback counts (reviewers.js). The registry takes feedback from anyone, so
// every test here is about a way of posting it that should not buy the factor.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  snapshotOf, parsePublicFunders, verdictFor, scoreReviews, scoreFeedback,
  payersByAmount, evidenceDigest,
  REVIEWER_MIN_TENURE_DAYS, REVIEWER_MIN_SCORE, FULL_WEIGHT_CLUSTERS, FUNDING_FLOOR,
} = require('./reviewers');
const { MAX_EXTERNAL_SCORE } = require('./external');
const { createFunderReader, UNREAD } = require('./funder-scan');
const { World, startOracle, runToExit, wallet } = require('./test-support/oracle-harness');

const DAY_MS = 86_400_000;
const NOW_MS = 1_800_000_000_000;
const addr = (n) => `0x${n.toString(16).padStart(40, '0')}`;
const AGENT = { operator: addr(0xa0), agentAddress: addr(0xa1) };
const FAUCET = addr(0xfa);
const ZERO = addr(0);

/** A reviewer that passes every rule: Active, bonded, a year old, scored 60. */
function goodStanding(operator) {
  return { registered: true, operator, status: 0, registeredAt: (NOW_MS - 365 * DAY_MS) / 1000, matured: 60, bonded: true };
}

/**
 * `n` reviewers who each paid the agent: each has its own operator, and is funded by its own
 * wallet, which a faucet funded, unless the test says otherwise.
 */
function world(n, { paidDaysAgo = 0 } = {}) {
  const clients = Array.from({ length: n }, (_, i) => addr(0x100 + i));
  const events = clients.map((c) => ({ payer: c, ts: NOW_MS - paidDaysAgo * DAY_MS, amount: '1000000', txHash: c }));
  const own = (a) => (clients.includes(a) ? addr(0x300 + clients.indexOf(a)) : FAUCET);
  const deps = {
    standingOf: async (c) => goodStanding(addr(0x200 + clients.indexOf(c))),
    funderOf: async (a) => ({ funder: own(a), block: 10 }),
    paymentBlock: async () => 100,
    snapshotBlock: 1000,
    publicFunders: new Set([FAUCET]),
  };
  return { clients, ctx: { agent: AGENT, events, nowMs: NOW_MS }, deps, own };
}
const rated = (clients, value = 100) => clients.map((client) => ({ client, value, tag: 'quality' }));
const funding = (map) => async (a) => (map(a) === null ? null : { funder: map(a), block: 10 });

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

test('one independent reviewer who paid recently is worth a fifth of the cap', async () => {
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
  deps.funderOf = funding((a) => (clients.includes(a) ? shared : FAUCET));
  const r = await scoreFeedback(rated(clients), ctx, deps);
  assert.equal(r.clusters, 1);
  assert.equal(r.score, MAX_EXTERNAL_SCORE / FULL_WEIGHT_CLUSTERS);
});

test('a shared funder two hops back still joins them, and a public one does not', async () => {
  // Each reviewer has its own funder, and every one of those was funded by the same treasury.
  const treasury = addr(0x888);
  const { clients, ctx, deps, own } = world(5);
  const middle = (a) => Number(a) >= 0x300 && Number(a) < 0x305; // each reviewer's own funder
  deps.funderOf = funding((a) => (middle(a) ? treasury : own(a)));
  assert.equal((await scoreFeedback(rated(clients), ctx, deps)).clusters, 1);

  // The same shape through a faucet, or through the zero address a mint comes from, is five
  // independent reviewers.
  deps.funderOf = funding((a) => (middle(a) ? FAUCET : own(a)));
  assert.equal((await scoreFeedback(rated(clients), ctx, deps)).clusters, 5);
  deps.funderOf = funding((a) => (clients.includes(a) ? ZERO : FAUCET));
  assert.equal((await scoreFeedback(rated(clients), ctx, deps)).clusters, 5);
});

test('reviewers whose operators one treasury funded count once between them', async () => {
  const treasury = addr(0x999);
  const { clients, ctx, deps, own } = world(5);
  const operator = (a) => Number(a) >= 0x200 && Number(a) < 0x205;
  deps.funderOf = funding((a) => (operator(a) ? treasury : own(a)));
  assert.equal((await scoreFeedback(rated(clients), ctx, deps)).clusters, 1);
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

test('the agent cannot review itself, nor fund its reviewers or their operators', async () => {
  const { ctx, deps } = world(1);
  const self = { ...ctx, events: [{ payer: AGENT.operator, ts: NOW_MS, amount: '1', txHash: '0x1' }] };
  assert.equal((await verdictFor(AGENT.operator, self, deps)).reason, 'self');

  // Funded by the agent's operator directly, through one wallet in between, and the reviewer's
  // operator funded by the agent.
  const direct = world(1);
  direct.deps.funderOf = funding(() => AGENT.operator);
  assert.equal((await verdictFor(direct.clients[0], direct.ctx, direct.deps)).reason, 'self-funded');
  const twoHops = world(1);
  const middle = addr(0x444);
  twoHops.deps.funderOf = funding((a) => (a === middle ? AGENT.agentAddress : middle));
  assert.equal((await verdictFor(twoHops.clients[0], twoHops.ctx, twoHops.deps)).reason, 'self-funded');
  const viaOperator = world(1);
  viaOperator.deps.funderOf = funding((a) => (a === addr(0x200) ? AGENT.operator : viaOperator.own(a)));
  assert.equal((await verdictFor(viaOperator.clients[0], viaOperator.ctx, viaOperator.deps)).reason, 'self-funded');
});

test('a reviewer whose funder cannot be found is not counted; an operator\'s is just untraced', async () => {
  const { clients, ctx, deps, own } = world(1);
  deps.funderOf = funding(() => null);
  assert.equal((await verdictFor(clients[0], ctx, deps)).reason, 'unknown-funder');
  deps.funderOf = funding((a) => (a === addr(0x200) ? null : own(a)));
  assert.equal((await verdictFor(clients[0], ctx, deps)).ok, true);
});

test('a reviewer whose funding is not read yet is not counted, at either hop or through its operator', async () => {
  const first = world(1);
  const asked = [];
  first.deps.funderOf = async (a) => { asked.push(a); return UNREAD; };
  assert.equal((await verdictFor(first.clients[0], first.ctx, first.deps)).reason, 'funder-unread');
  assert.deepEqual(asked, [first.clients[0], addr(0x200)], "the operator's is asked for at once, so both are read together");
  const r = await scoreFeedback(rated(first.clients), first.ctx, first.deps);
  assert.equal(r.score, 0);
  assert.deepEqual(r.excluded, { 'funder-unread': 1 });
  // The reviewer's funder is known and that wallet's own is not. Taken for "no funder further back", the
  // reviewer counted as independent of everyone.
  const second = world(1);
  second.deps.funderOf = async (a) => (a === addr(0x300) ? UNREAD : { funder: second.own(a), block: 10 });
  assert.equal((await verdictFor(second.clients[0], second.ctx, second.deps)).reason, 'funder-unread');
  const third = world(1);
  third.deps.funderOf = async (a) => (a === addr(0x200) ? UNREAD : { funder: third.own(a), block: 10 });
  assert.equal((await verdictFor(third.clients[0], third.ctx, third.deps)).reason, 'funder-unread');
  // What already rules it out does not wait for the rest.
  const known = world(1);
  known.deps.funderOf = async (a) => (a === addr(0x200) ? { funder: AGENT.operator, block: 10 } : UNREAD);
  assert.equal((await verdictFor(known.clients[0], known.ctx, known.deps)).reason, 'self-funded');
});

test('the reviewer\'s funding is searched up to its first payment, and an operator\'s up to the snapshot', async () => {
  const { clients, ctx, deps, own } = world(1);
  ctx.events.push({ payer: clients[0], ts: NOW_MS - 10 * DAY_MS, amount: '1', txHash: 'early' });
  deps.paymentBlock = async (e) => (e.txHash === 'early' ? 42 : 100);
  const caps = [];
  deps.funderOf = async (a, cap) => { caps.push([a, cap]); return { funder: own(a), block: 7 }; };
  await verdictFor(clients[0], ctx, deps);
  // The second hop is searched up to the block the first was funded in.
  assert.deepEqual(caps, [[clients[0], 42], [addr(0x300), 7], [addr(0x200), 1000]]);
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

test('snapshotOf: the start of the UTC day', () => {
  assert.equal(snapshotOf(86_400 * 20_000 + 3_599), 86_400 * 20_000);
  assert.equal(snapshotOf(86_400 * 20_000), 86_400 * 20_000);
});

// ---- the first funder -------------------------------------------------------------------

/**
 * A node over `transfers` [{ from, to, value, block }], as Arc logs native transfers: Transfer from
 * 0xffff…fffe for every one. Balances and nonces are answered too, so the old search can run on it.
 */
function arcNode(transfers) {
  const word = (a) => `0x${'0'.repeat(24)}${a.slice(2)}`;
  return {
    getBalance: async (a, b) => transfers.filter((t) => t.block <= b)
      .reduce((sum, t) => sum + (t.to === a ? t.value : 0n) - (t.from === a ? t.value : 0n), 0n),
    getTransactionCount: async () => 0,
    getLogs: async ({ address, fromBlock, toBlock, topics }) => {
      assert.equal(address, '0xfffffffffffffffffffffffffffffffffffffffe');
      return transfers
        .map((t, i) => ({ ...t, i }))
        .filter((t) => word(t.to) === topics[2] && t.block >= fromBlock && t.block <= toBlock)
        .map((t) => ({ topics: [topics[0], word(t.from), word(t.to)], data: `0x${t.value.toString(16).padStart(64, '0')}`, blockNumber: t.block, index: t.i }));
    },
  };
}

function onNode(chain, transfers) {
  const provider = arcNode(transfers);
  chain.init({ rpcUrl: 'unused', identityAddress: addr(1), reputationAddress: addr(2) }, {
    provider, wallet: provider, identityContract: {}, reputationContract: {},
  });
}

test('chain.firstFunder: dust below the floor does not make its sender the funder', async () => {
  // A griefer seeds the reviewer with a fraction of a cent at block 100; the real funding,
  // two USDC, arrives at block 200. Counted from the first wei, the griefer would be the funder,
  // and every agent it seeded would share it.
  const chain = require('./chain');
  const griefer = addr(0x66);
  const treasury = addr(0x77);
  const reviewer = addr(0x42);
  onNode(chain, [
    { from: griefer, to: reviewer, value: 10n ** 15n, block: 100 },
    { from: treasury, to: reviewer, value: 2n * FUNDING_FLOOR, block: 200 },
  ]);
  assert.equal(await chain.firstFunder(reviewer, 1000), UNREAD, 'asking reads nothing');
  await chain.readFunders();
  assert.deepEqual(await chain.firstFunder(reviewer, 1000), { funder: treasury, block: 200 });
});

test('chain.firstFunder: a wallet funded, emptied by a permit and funded again is named by its first funding', async () => {
  // USDC is Arc's gas token and moves by EIP-3009, which spends a balance without a nonce. The agent's
  // operator funds the reviewer at block 100, a permit the reviewer signed empties it at 150, and a
  // faucet tops it up at 300. "Holds the floor or has sent a transaction" is true, false, true, and a
  // binary search for where it turns true landed on the faucet.
  const chain = require('./chain');
  const reviewer = addr(0x43);
  onNode(chain, [
    { from: AGENT.operator, to: reviewer, value: 5n * FUNDING_FLOOR, block: 100 },
    { from: reviewer, to: addr(0x99), value: 5n * FUNDING_FLOOR, block: 150 },
    { from: FAUCET, to: reviewer, value: 20n * FUNDING_FLOOR, block: 300 },
  ]);
  let found = await chain.firstFunder(reviewer, 1000);
  for (let i = 0; found === 'unread' && i < 5; i++) {
    await chain.readFunders();
    found = await chain.firstFunder(reviewer, 1000);
  }
  assert.deepEqual(found, { funder: AGENT.operator, block: 100 }, 'the funding the faucet came after');
  // So the reviewer is the agent's own, where the faucet made it look independent.
  const { ctx, deps } = world(1);
  deps.standingOf = async () => goodStanding(addr(0x200));
  deps.funderOf = chain.firstFunder;
  assert.equal((await verdictFor(reviewer, { ...ctx, events: [{ ...ctx.events[0], payer: reviewer }] }, deps)).reason, 'self-funded');
});

/** Native transfers as Arc logs them, and funderOf reading them through the real reader. */
function ledger(transfers) {
  const reader = createFunderReader({
    floor: FUNDING_FLOOR,
    readIn: async (a, from, to) => transfers
      .map((t, i) => ({ from: t.from, to: t.to, value: t.value, blockNumber: t.block, logIndex: i }))
      .filter((t) => t.to === a && t.blockNumber >= from && t.blockNumber <= to),
  });
  return async (a, cap) => {
    if ((await reader.funderOf(a, cap)) === UNREAD) await reader.readWanted();
    return reader.funderOf(a, cap);
  };
}

test('a transfer too small to cross the floor by itself names nobody, and two in one block do not add up', async () => {
  const funderOf = ledger([
    { from: addr(5), to: addr(1), value: FUNDING_FLOOR - 1n, block: 40 },
    { from: addr(6), to: addr(2), value: FUNDING_FLOOR / 2n, block: 40 },
    { from: addr(7), to: addr(2), value: FUNDING_FLOOR / 2n, block: 40 },
    { from: addr(8), to: addr(3), value: 3n, block: 40 },
    { from: addr(9), to: addr(3), value: FUNDING_FLOOR, block: 40 },
    { from: addr(4), to: addr(3), value: 2n * FUNDING_FLOOR, block: 41 },
  ]);
  assert.equal(await funderOf(addr(1), 100), null);
  assert.equal(await funderOf(addr(2), 100), null);
  assert.deepEqual(await funderOf(addr(3), 100), { funder: addr(9), block: 40 }, 'the first block with one, not the largest overall');
});

const CENT = FUNDING_FLOOR / 100n;

test('one treasury topping its reviewers up through throwaway wallets is not five independent reviewers', async () => {
  // Each reviewer gets 0.99 from the treasury, which never counts, and 0.02 from a throwaway the
  // treasury gave 0.05. The throwaway used to be named the funder, its own funder came back empty as
  // its first touched block is its own send, and the treasury was in no cluster: 25 of 25.
  const { clients, ctx, deps } = world(5);
  const treasury = addr(0x7e);
  deps.publicFunders = new Set();
  const transfers = [];
  clients.forEach((c, i) => {
    const helper = addr(0x500 + i);
    transfers.push(
      { from: treasury, to: helper, value: 5n * CENT, block: 10 + i },
      { from: treasury, to: c, value: 99n * CENT, block: 20 + i },
      { from: helper, to: c, value: 2n * CENT, block: 30 + i },
    );
  });
  deps.funderOf = ledger(transfers);
  const r = await scoreFeedback(rated(clients), ctx, deps);
  assert.equal(r.score, 0);
  assert.deepEqual(r.excluded, { 'unknown-funder': 5 });
});

test('the same treasury funding them directly is one cluster, as it always was', async () => {
  const { clients, ctx, deps } = world(5);
  const treasury = addr(0x7e);
  deps.publicFunders = new Set();
  deps.funderOf = ledger(clients.map((c, i) => ({ from: treasury, to: c, value: FUNDING_FLOOR, block: 20 + i })));
  const r = await scoreFeedback(rated(clients), ctx, deps);
  assert.equal(r.clusters, 1);
  assert.equal(r.score, Math.round(MAX_EXTERNAL_SCORE / FULL_WEIGHT_CLUSTERS));
});

test('a throwaway given enough to count leads back to the treasury, so they are still one cluster', async () => {
  const { clients, ctx, deps } = world(5);
  const treasury = addr(0x7e);
  deps.publicFunders = new Set();
  const transfers = [];
  clients.forEach((c, i) => {
    const helper = addr(0x500 + i);
    transfers.push(
      { from: treasury, to: helper, value: 2n * FUNDING_FLOOR, block: 10 + i },
      { from: helper, to: c, value: FUNDING_FLOOR, block: 30 + i },
    );
  });
  deps.funderOf = ledger(transfers);
  assert.equal((await scoreFeedback(rated(clients), ctx, deps)).clusters, 1);
});

test('reviewers funded straight from a faucet with no funder of its own still count', async () => {
  // Arc's faucet wallets are like this: 20 USDC a drip, and no transfer in that their first touched
  // block shows. A rule against any trace ending with no funder would have excluded all of these.
  const { clients, ctx, deps } = world(5);
  const faucet = addr(0xfb);
  deps.publicFunders = new Set();
  deps.funderOf = ledger([
    { from: addr(0xee), to: faucet, value: 0n, block: 1 },
    { from: faucet, to: addr(0xdd), value: 1n, block: 2 },
    ...clients.map((c, i) => ({ from: faucet, to: c, value: 20n * FUNDING_FLOOR, block: 20 + i })),
  ]);
  const r = await scoreFeedback(rated(clients), ctx, deps);
  assert.deepEqual(r.excluded, {});
  assert.equal(r.reviewers, 5);
  assert.equal(r.clusters, 1, 'one faucet wallet, until it is listed as a public funder');
  deps.publicFunders = new Set([faucet]);
  assert.equal((await scoreFeedback(rated(clients), ctx, deps)).clusters, 5);
});

test('payersByAmount: totals each payer, the most paid first, and lowercases', () => {
  const big = '0xABC0000000000000000000000000000000000001';
  const events = [
    { payer: addr(1), amount: '5' },
    { payer: big, amount: '3' },
    { payer: big.toLowerCase(), amount: '4' },
    { payer: addr(2), amount: '6' },
  ];
  assert.deepEqual(payersByAmount(events), [big.toLowerCase(), addr(2), addr(1)]);
});

test('payersByAmount: the same evidence gives the same list, whatever order it is in', () => {
  const events = [{ payer: addr(9), amount: '5' }, { payer: addr(3), amount: '5' }, { payer: addr(6), amount: '5' }];
  assert.deepEqual(payersByAmount(events), [addr(3), addr(6), addr(9)]);
  assert.deepEqual(payersByAmount([...events].reverse()), [addr(3), addr(6), addr(9)]);
});

test('payersByAmount: amounts past what a double can hold, and an event with no payer', () => {
  const events = [
    { payer: addr(1), amount: '9007199254740992' },
    { payer: addr(2), amount: '9007199254740993' },
    { amount: '100000000000000000000' },
  ];
  assert.deepEqual(payersByAmount(events), [addr(2), addr(1)]);
  assert.deepEqual(payersByAmount([]), []);
});

test('evidenceDigest: changes with anything a judgment reads, and not otherwise', () => {
  const event = { payer: addr(1), ts: 1000, amount: '5', txHash: '0xa' };
  const base = evidenceDigest([event]);
  assert.equal(evidenceDigest([{ ...event }]), base);
  assert.equal(evidenceDigest([{ ...event, payer: addr(1).toUpperCase().replace('0X', '0x') }]), base, 'however the address is written');
  for (const change of [{ payer: addr(2) }, { ts: 1001 }, { amount: '6' }, { txHash: '0xb' }]) {
    assert.notEqual(evidenceDigest([{ ...event, ...change }]), base, JSON.stringify(change));
  }
  assert.notEqual(evidenceDigest([event, event]), base);
  assert.notEqual(evidenceDigest([]), base);
});

test('parsePublicFunders: a list of addresses, and nothing else', () => {
  assert.deepEqual([...parsePublicFunders(undefined).set], []);
  assert.deepEqual([...parsePublicFunders(' , ').set], []);
  const a = '0xD844ba11f64d23a7481e24474d2f184e350b9b3d';
  assert.deepEqual([...parsePublicFunders(`${a}, ${addr(1)}`).set], [a.toLowerCase(), addr(1)]);
  assert.match(parsePublicFunders(`${a},faucet`).error, /"faucet", which is not an address/);
});

// ---- end to end: what a primary proposes, and what a checker makes of it --------------------

const ADMIN = 'a'.repeat(64);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const counter = (text, name) => Number((text.match(new RegExp(`^${escapeRe(name)} (\\d+)`, 'm')) || [])[1]);

/**
 * A linked agent and `n` reviewers who each paid it an hour before today's snapshot, in a world
 * the stub chain reads.
 */
function linkedWorld(n) {
  const w = new World();
  const agent = w.addRegisteredAgent();
  const reviewers = Array.from({ length: n }, () => wallet().toLowerCase());
  const paidMs = snapshotOf(w.data.nowSec) * 1000 - 3_600_000;
  const events = reviewers.map((payer, i) => ({
    payer, ts: paidMs, amount: '1000000', txHash: `0x${(i + 1).toString(16).padStart(64, '0')}`,
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

async function untilEpoch(oracle) {
  for (let i = 0; i < 300; i++) {
    const text = (await oracle.call('GET', '/metrics')).text;
    if ((counter(text, 'sigvara_oracle_epochs_total{status="succeeded"}') || 0) >= 1) return text;
    await sleep(50);
  }
  throw new Error(`no epoch finished:\n${oracle.logs()}`);
}

async function proposed(w, files, env = {}) {
  const oracle = await startOracle({ world: w, env: { ORACLE_ADMIN_TOKEN: ADMIN, ...env }, files });
  try {
    await untilEpoch(oracle);
    const call = oracle.calls().find((c) => c.name === 'proposeScore');
    assert.ok(call, `nothing was proposed:\n${oracle.logs()}`);
    return { scores: call.args[1], logs: oracle.logs() };
  } finally {
    await oracle.stop();
  }
}

test('end to end: five independent paying reviewers carry a linked agent to the cap, and spam adds nothing', async () => {
  const { w, files } = linkedWorld(5);
  const spam = Array.from({ length: 20 }, () => ({ client: wallet().toLowerCase(), value: 100, tag: 'quality' }));
  w.set('externalFeedback', [...w.data.externalFeedback, ...spam]);
  const { scores, logs } = await proposed(w, files);
  assert.equal(scores.externalScore, MAX_EXTERNAL_SCORE);
  assert.match(logs, /external: 25\/25 from 5 reviewer\(s\) in 5 cluster\(s\); not counted: unpaid 20/);
});

test('end to end: the same five funded from one wallet are worth one', async () => {
  const { w, reviewers, files } = linkedWorld(5);
  const treasury = wallet().toLowerCase();
  w.set('funders', Object.fromEntries(reviewers.map((r) => [r, treasury])));
  assert.equal((await proposed(w, files)).scores.externalScore, MAX_EXTERNAL_SCORE / FULL_WEIGHT_CLUSTERS);
});

test('end to end: a payment made since the snapshot counts from the next one', async () => {
  const { w, agent, reviewers, files } = linkedWorld(5);
  const state = JSON.parse(files['state.json']);
  state.paymentEvents[agent.didHash][4].ts = snapshotOf(w.data.nowSec) * 1000 + 1;
  assert.equal(
    (await proposed(w, { 'state.json': JSON.stringify(state) })).scores.externalScore,
    4 * MAX_EXTERNAL_SCORE / FULL_WEIGHT_CLUSTERS,
    `the fifth reviewer, ${reviewers[4]}, paid after today's snapshot`,
  );
});

test('end to end: a reviewer the node cannot answer for skips the agent this epoch, and the epoch goes on', async () => {
  // Scoring 0 on it would propose a number known to be wrong, which the checker, whose reads
  // worked, would then dispute.
  const { w, reviewers, files } = linkedWorld(5);
  w.set('reviewers', { ...w.data.reviewers, [reviewers[2]]: 'throw' });
  const oracle = await startOracle({ world: w, env: { ORACLE_ADMIN_TOKEN: ADMIN }, files });
  try {
    await untilEpoch(oracle);
    assert.deepEqual(oracle.calls().filter((c) => c.name === 'proposeScore'), [], 'nothing proposed on a guess');
    assert.match(oracle.logs(), /reviewer read failed/);
  } finally {
    await oracle.stop();
  }
});

test('end to end: a reviewer whose funding is not read yet is not counted, and its agent waits for the read', async () => {
  // An operator that has read it may count it, so a proposal now would be disputed for a reading the
  // other side had not finished. /score leaves it out meanwhile.
  const { w, agent, reviewers, files } = linkedWorld(5);
  w.set('funders', { ...w.data.funders, [reviewers[2]]: 'unread' });
  const oracle = await startOracle({ world: w, env: { ORACLE_ADMIN_TOKEN: ADMIN }, files });
  try {
    await untilEpoch(oracle);
    assert.deepEqual(oracle.calls().filter((c) => c.name === 'proposeScore'), [], 'nothing proposed while it is read');
    assert.match(oracle.logs(), /not counted: funder-unread 1/);
    assert.match(oracle.logs(), /1 reviewer\(s\) with funding not read yet, skipping/);
    const served = await oracle.call('GET', `/score/${agent.didHash}`);
    assert.equal(served.body.scores.externalScore, 4 * MAX_EXTERNAL_SCORE / FULL_WEIGHT_CLUSTERS);
  } finally {
    await oracle.stop();
  }
});

test('end to end: a checker whose reading of a reviewer\'s funding is not finished checks the proposal later', async () => {
  const { w, agent, reviewers, files } = linkedWorld(5);
  const { scores } = await proposed(w, files);
  w.file = null;
  w.set('funders', { ...w.data.funders, [reviewers[0]]: 'unread' });
  w.setFor('pending', agent.didHash, { exists: true, proposedAt: w.data.nowSec - 100, data: scores, evidenceRoot: null });
  const oracle = await startOracle({
    world: w, env: { ORACLE_ADMIN_TOKEN: ADMIN, ORACLE_MODE: 'checker', DIVERGENCE_TOLERANCE: '0' }, files,
  });
  try {
    const text = await untilEpoch(oracle);
    assert.equal(counter(text, 'sigvara_oracle_checker_comparisons_total{verdict="diverged"}'), 0, oracle.logs());
    assert.equal(counter(text, 'sigvara_oracle_checker_comparisons_total{verdict="agreed"}'), 0);
    assert.match(oracle.logs(), /with funding not read yet, skipping/);
  } finally {
    await oracle.stop();
  }
});

test('end to end: a linked agent reached just before a UTC midnight is proposed after it, not across it', async () => {
  // The checker reads the external factor at the snapshot of the proposal's own block. A proposal scored at
  // 23:59:30 lands after midnight, in the next snapshot, and was disputed for a reading it was never given.
  const { w, files } = linkedWorld(5);
  const midnight = snapshotOf(w.data.nowSec) + 86_400;
  w.set('nowSec', midnight - 30);
  const oracle = await startOracle({ world: w, env: { ORACLE_ADMIN_TOKEN: ADMIN, MAX_CLOCK_SKEW_SECONDS: String(2 * 86_400) }, files });
  try {
    await untilEpoch(oracle);
    assert.deepEqual(oracle.calls().filter((c) => c.name === 'proposeScore'), [], 'nothing proposed across the midnight');
    assert.match(oracle.logs(), /its external factor's snapshot changes before a proposal could land; proposing next epoch/);

    w.set('nowSec', midnight + 60);
    assert.equal((await oracle.call('POST', '/epoch', {}, ADMIN)).status, 202);
    for (let i = 0; i < 300 && !oracle.calls().some((c) => c.name === 'proposeScore'); i++) await sleep(50);
    const call = oracle.calls().find((c) => c.name === 'proposeScore');
    assert.ok(call, `nothing was proposed after the midnight:\n${oracle.logs()}`);
    assert.equal(call.args[1].externalScore, MAX_EXTERNAL_SCORE);
  } finally {
    await oracle.stop();
  }
});

test('end to end: a checker re-measures the external factor of a proposal and agrees with it exactly', async () => {
  const { w, agent, files } = linkedWorld(5);
  const { scores } = await proposed(w, files);
  assert.equal(scores.externalScore, MAX_EXTERNAL_SCORE);

  // The same world for the checker; the first oracle's directory went with it.
  w.file = null;
  w.setFor('pending', agent.didHash, { exists: true, proposedAt: w.data.nowSec - 100, data: scores, evidenceRoot: null });
  const oracle = await startOracle({
    world: w, env: { ORACLE_ADMIN_TOKEN: ADMIN, ORACLE_MODE: 'checker', DIVERGENCE_TOLERANCE: '0' }, files,
  });
  try {
    const text = await untilEpoch(oracle);
    assert.equal(counter(text, 'sigvara_oracle_checker_comparisons_total{verdict="agreed"}'), 1, oracle.logs());
    assert.equal(counter(text, 'sigvara_oracle_checker_comparisons_total{verdict="diverged"}'), 0);
  } finally {
    await oracle.stop();
  }
});

test('a malformed EXTERNAL_PUBLIC_FUNDERS stops the oracle at startup', async () => {
  const { code, log } = await runToExit({ world: new World(), env: { ORACLE_ADMIN_TOKEN: ADMIN, EXTERNAL_PUBLIC_FUNDERS: 'faucet' } });
  assert.equal(code, 1);
  assert.match(log, /EXTERNAL_PUBLIC_FUNDERS has "faucet", which is not an address/);
});
