import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCast, PROFILES, INDEX } from '../src/cast.mjs';
import { planHour, HOURS, DAYS, SLASHES, demandOn } from '../src/plan.mjs';
import { rng } from '../src/rng.mjs';

const SEED = 'test-seed';
const cast = buildCast(rng(`${SEED}:cast`));
const all = Array.from({ length: HOURS }, (_, h) => planHour(cast, SEED, h)).flat();
const pays = all.filter((a) => a.type === 'pay');
const agentById = new Map(cast.agents.map((a) => [a.id, a]));

test('the cast is the size the docs describe', () => {
  assert.equal(cast.agents.length, 20);
  assert.equal(cast.payers.length, 40);
  assert.equal(cast.agents.filter((a) => a.profile === 'ring').length, 3);
  assert.equal(new Set([...cast.agents, ...cast.payers, ...cast.ringPayers, ...cast.operators].map((x) => x.id)).size,
    cast.agents.length + cast.payers.length + cast.ringPayers.length + cast.operators.length, 'every wallet index is distinct');
  assert.ok(cast.operators.every((o) => o.id >= INDEX.operator && o.id < INDEX.agent));
});

test('the same seed plans the same run, and another seed a different one', () => {
  assert.deepEqual(planHour(cast, SEED, 300), planHour(buildCast(rng(`${SEED}:cast`)), SEED, 300));
  assert.notDeepEqual(planHour(cast, SEED, 300), planHour(cast, 'other-seed', 300));
});

test('every action id is unique across the run, so nothing is done twice', () => {
  const ids = all.filter((a) => a.type !== 'enforce').map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('nothing is planned outside the run', () => {
  assert.deepEqual(planHour(cast, SEED, -1), []);
  assert.deepEqual(planHour(cast, SEED, HOURS), []);
  assert.equal(HOURS, DAYS * 24);
});

test('every agent registers and bonds once, on its day', () => {
  for (const a of cast.agents) {
    const reg = all.filter((x) => x.type === 'register' && x.agent === a.id);
    assert.equal(reg.length, 1);
    assert.ok(planHour(cast, SEED, a.day * 24).some((x) => x.id === `stake:${a.id}`));
  }
});

test('no agent is paid before the hour after its bond', () => {
  for (const p of pays) {
    const hour = Number(p.id.split(':')[1]);
    assert.ok(hour > agentById.get(p.agent).day * 24, `${p.id} pays agent ${p.agent} too early`);
  }
});

test('the ring is sealed off: only ring payers pay it, and they pay nothing else', () => {
  const ringPayers = new Set(cast.ringPayers.map((p) => p.id));
  for (const p of pays) {
    const ring = agentById.get(p.agent).profile === 'ring';
    assert.equal(ring, ringPayers.has(p.payer), `${p.id}`);
  }
  assert.ok(pays.some((p) => ringPayers.has(p.payer)), 'the ring is active');
});

test('payments go only to cast agents, at prices the profile allows', () => {
  for (const p of pays) {
    const a = agentById.get(p.agent);
    assert.ok(a, `${p.id} pays an unknown agent`);
    const [lo, hi] = PROFILES[a.profile].price;
    assert.ok(Number.isInteger(p.amount) && p.amount >= lo && p.amount <= hi, `${p.id} amount ${p.amount}`);
  }
});

test('an undelivered job never carries a signed outcome', () => {
  assert.ok(pays.some((p) => !p.delivered));
  for (const p of pays) if (!p.delivered) assert.equal(p.post, false, p.id);
});

test('delivery rates follow the profiles', () => {
  const rate = (profile) => {
    const xs = pays.filter((p) => agentById.get(p.agent).profile === profile);
    return xs.filter((p) => p.delivered).length / xs.length;
  };
  assert.ok(rate('steady') > 0.88);
  assert.ok(rate('mediocre') > 0.55 && rate('mediocre') < 0.85);
  assert.ok(rate('failing') < 0.45);
});

test('customers drift away from agents that fail', () => {
  const failing = cast.agents.find((a) => a.profile === 'failing');
  const steady = cast.agents.find((a) => a.profile === 'steady' && a.day === 0);
  assert.ok(demandOn(failing, 21) < demandOn(failing, 0) * 0.1);
  assert.ok(demandOn(steady, 21) > demandOn(steady, 0) * 0.8);
  const week = (profile, w) => pays.filter((p) => agentById.get(p.agent).profile === profile
    && Math.floor(Number(p.id.split(':')[1]) / 168) === w).length;
  assert.ok(week('failing', 3) < week('failing', 0), 'failing agents lose jobs');
});

test('the committee is asked to file two slashes, against the ring only', () => {
  const due = all.filter((a) => a.type === 'manual');
  assert.equal(due.length, SLASHES.length);
  for (const d of due) assert.equal(agentById.get(d.agent).profile, 'ring');
  assert.deepEqual(due.map((d) => d.dispute), SLASHES.map((s) => s.dispute));
});
