import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCast, GROUPS, INDEX, REVIEW, HANDOVER, BONDING, ARC_PAYERS, BASE_PAYERS, RING_PAYERS } from '../src/batch2/cast.mjs';
import { planHour, HOURS, RETRIED } from '../src/batch2/plan.mjs';
import { buildCast as buildFirstCast } from '../src/cast.mjs';
import { rng } from '../src/rng.mjs';

const SEED = 'test-seed-2';
const cast = buildCast(rng(`${SEED}:cast`));
const all = Array.from({ length: HOURS }, (_, h) => planHour(cast, SEED, h).map((a) => ({ ...a, h }))).flat();
const pays = all.filter((a) => a.type === 'pay');
const agentById = new Map(cast.agents.map((a) => [a.id, a]));
const day = (a) => Math.floor(a.h / 24);

test('the cast is the size the docs describe, on wallets the first batch does not use', () => {
  assert.equal(cast.agents.length, 22);
  assert.equal(cast.payers.length, ARC_PAYERS + BASE_PAYERS);
  assert.equal(cast.ringPayers.length, RING_PAYERS);
  const ids = [...cast.agents, ...cast.payers, ...cast.ringPayers, ...cast.operators].map((x) => x.id).concat(cast.treasury, cast.hub);
  assert.equal(new Set(ids).size, ids.length, 'every wallet index is distinct');
  assert.ok(ids.every((id) => id >= INDEX.treasury), 'nothing below 1000, where the first batch lives');
});

test('the reviewers are first-batch steady agents from its first day, and none is this batch\'s', () => {
  const first = buildFirstCast(rng('sigvara-testnet-sim-1:cast'));
  for (const r of [...REVIEW.shared, REVIEW.operatorFunded]) {
    const a = first.agents.find((x) => x.id === r);
    assert.ok(a, `${r} is a first-batch agent`);
    assert.equal(a.profile, 'steady');
    assert.equal(a.day, 0);
  }
});

test('every payment goes to this batch\'s agents, on a chain the agent is paid on', () => {
  assert.ok(pays.length > 500);
  for (const p of pays) {
    const agent = agentById.get(p.agent);
    assert.ok(agent, `${p.id} pays a cast agent`);
    assert.ok(GROUPS[agent.group].chains.includes(p.chain), `${p.id}: ${agent.group} is not paid on ${p.chain}`);
    assert.ok(p.h > agent.day * 24, `${p.id} pays before its agent bonded`);
    if (p.chain === 'base') assert.ok(p.amount >= 1 && p.amount <= 10, 'one to ten cents, above the oracle\'s one-cent minimum');
    if (!p.delivered) assert.equal(p.post, false, 'no negative outcomes');
    assert.ok(['oracle', 'counteraudit'].includes(p.via));
  }
  assert.equal(new Set(all.map((a) => a.id)).size, all.length, 'no action id repeats');
});

test('Base volume stays a few hundred payments and under 35 USDC', () => {
  const base = pays.filter((p) => p.chain === 'base');
  assert.ok(base.length > 150 && base.length < 500, `${base.length} Base payments`);
  assert.ok(base.reduce((s, p) => s + p.amount, 0) < 3500);
});

test('the ring\'s customers pay the ring, and sometimes honest agents as cover', () => {
  const ringIds = new Set(cast.ringPayers.map((p) => p.id));
  const fromRing = pays.filter((p) => ringIds.has(p.payer));
  const toRing = fromRing.filter((p) => agentById.get(p.agent).group === 'ring2');
  assert.ok(toRing.length > fromRing.length / 2);
  assert.ok(fromRing.length > toRing.length, 'some cover');
  assert.ok(pays.filter((p) => agentById.get(p.agent).group === 'ring2').every((p) => ringIds.has(p.payer)), 'only the ring pays the ring');
});

test('the handover: bought from before, handed over on its day, refused payers after', () => {
  const ho = pays.filter((p) => p.agent === cast.handover.agent && p.tag);
  const before = ho.filter((p) => p.tag === 'buyer-before-handover');
  assert.ok(before.every((p) => p.payer === cast.handover.to && day(p) >= HANDOVER.newBuyerFrom && day(p) <= HANDOVER.newBuyerTo));
  assert.equal(before.length, 2 * (HANDOVER.newBuyerTo - HANDOVER.newBuyerFrom + 1));
  const after = ho.filter((p) => p.tag !== 'buyer-before-handover');
  assert.ok(after.every((p) => day(p) >= HANDOVER.selfPayFrom && p.post));
  assert.deepEqual(new Set(after.map((p) => p.tag)), new Set(['former-operator', 'new-operator']));
  assert.deepEqual(new Set(after.map((p) => p.chain)), new Set(['arc', 'base']));
  const offer = all.find((a) => a.type === 'offer-transfer'), accept = all.find((a) => a.type === 'accept-transfer');
  assert.equal(day(offer), HANDOVER.day);
  assert.equal(day(accept), HANDOVER.day);
  assert.equal(offer.from, cast.handover.from);
  assert.equal(accept.to, cast.handover.to);
});

test('the bonding agent leaves on its day and comes back on its day', () => {
  assert.equal(day(all.find((a) => a.type === 'leave-bond')), BONDING.leave);
  assert.equal(day(all.find((a) => a.type === 'rebond')), BONDING.back);
});

test('the reviewed agents link on day 1, and reviewers fund, pay and post in order', () => {
  const links = all.filter((a) => a.type === 'link');
  assert.deepEqual(links.map((a) => a.agent).sort(), [...cast.reviewed].sort());
  assert.ok(links.every((a) => day(a) === 1 && a.operator === cast.reviewedOperator));
  const funds = all.filter((a) => a.type === 'review-fund');
  assert.equal(funds.length, REVIEW.shared.length + 1);
  for (const f of funds) {
    assert.equal(day(f), REVIEW.fund);
    assert.equal(f.from, f.reviewer === REVIEW.operatorFunded ? cast.reviewedOperator : cast.treasury);
  }
  const reviewPays = all.filter((a) => a.type === 'review-pay'), posts = all.filter((a) => a.type === 'review-post');
  assert.equal(reviewPays.length, funds.length * cast.reviewed.length);
  assert.equal(posts.length, funds.length * cast.reviewed.length);
  assert.ok(reviewPays.every((a) => cast.reviewed.includes(a.agent) && day(a) === REVIEW.fund));
  assert.ok(posts.every((a) => cast.reviewed.includes(a.agent) && day(a) === REVIEW.post));
});

test('setup is retried and nothing is planned past the end', () => {
  for (const t of ['fund', 'fund-base', 'register', 'stake', 'link', 'offer-transfer', 'accept-transfer', 'leave-bond', 'rebond', 'review-fund', 'review-pay', 'review-post']) {
    assert.ok(RETRIED.has(t), t);
  }
  assert.ok(!RETRIED.has('pay'));
  assert.deepEqual(planHour(cast, SEED, HOURS), []);
  assert.deepEqual(planHour(cast, SEED, -1), []);
});
