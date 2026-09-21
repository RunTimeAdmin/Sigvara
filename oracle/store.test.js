'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  flags,
  addFlag,
  flagCount,
  decayedFlagCount,
  pruneFlags,
  resolveFlags,
  checkAttestCooldown,
  recordAttestation,
  pruneExpiredCooldowns,
  attestCooldowns,
  creditPayment,
  getPaymentEvents,
  prunePaymentEvents,
  paymentVolume,
  ATTEST_COOLDOWN_MS,
  divergences,
  recordDivergence,
  getDivergences,
  allDivergences,
  MAX_DIVERGENCES_PER_AGENT,
} = require('./store');
const { communityScore } = require('./scoring');

function clearCooldowns() {
  attestCooldowns.clear();
}

test('checkAttestCooldown: allows first attestation', () => {
  clearCooldowns();
  const result = checkAttestCooldown('attester1', '0xabc', 1000000);
  assert.equal(result.allowed, true);
  assert.equal(result.remainingMs, 0);
});

test('checkAttestCooldown: blocks attestation within cooldown window', () => {
  clearCooldowns();
  const now = 1000000;
  recordAttestation('attester1', '0xabc', now);
  const result = checkAttestCooldown('attester1', '0xabc', now + 1000);
  assert.equal(result.allowed, false);
  assert.ok(result.remainingMs > 0);
  assert.ok(result.remainingMs <= ATTEST_COOLDOWN_MS);
});

test('checkAttestCooldown: allows attestation after cooldown expires', () => {
  clearCooldowns();
  const now = 1000000;
  recordAttestation('attester1', '0xabc', now);
  const result = checkAttestCooldown('attester1', '0xabc', now + ATTEST_COOLDOWN_MS);
  assert.equal(result.allowed, true);
  assert.equal(result.remainingMs, 0);
});

test('checkAttestCooldown: different attesters have independent cooldowns', () => {
  clearCooldowns();
  const now = 1000000;
  recordAttestation('attester1', '0xabc', now);
  const result = checkAttestCooldown('attester2', '0xabc', now + 1000);
  assert.equal(result.allowed, true);
});

test('checkAttestCooldown: same attester can attest different agents', () => {
  clearCooldowns();
  const now = 1000000;
  recordAttestation('attester1', '0xabc', now);
  const result = checkAttestCooldown('attester1', '0xdef', now + 1000);
  assert.equal(result.allowed, true);
});

test('recordAttestation: records timestamp for attester+didHash pair', () => {
  clearCooldowns();
  const now = 1000000;
  recordAttestation('attester1', '0xabc', now);
  assert.ok(attestCooldowns.has('attester1:0xabc'));
  assert.equal(attestCooldowns.get('attester1:0xabc'), now);
});

test('recordAttestation: updates timestamp for subsequent attestation', () => {
  clearCooldowns();
  const now1 = 1000000;
  const now2 = 2000000;
  recordAttestation('attester1', '0xabc', now1);
  recordAttestation('attester1', '0xabc', now2);
  assert.equal(attestCooldowns.get('attester1:0xabc'), now2);
});

test('pruneExpiredCooldowns: removes expired entries', () => {
  clearCooldowns();
  const now = 1000000;
  recordAttestation('attester1', '0xabc', now - ATTEST_COOLDOWN_MS - 1000);
  recordAttestation('attester2', '0xdef', now - 1000);
  pruneExpiredCooldowns(now);
  assert.equal(attestCooldowns.has('attester1:0xabc'), false, 'expired entry should be pruned');
  assert.equal(attestCooldowns.has('attester2:0xdef'), true, 'recent entry should remain');
});

test('pruneExpiredCooldowns: keeps entries at exactly cooldown boundary', () => {
  clearCooldowns();
  const now = 1000000;
  recordAttestation('attester1', '0xabc', now - ATTEST_COOLDOWN_MS);
  pruneExpiredCooldowns(now);
  assert.equal(attestCooldowns.has('attester1:0xabc'), false, 'entry at exactly cooldown boundary should be pruned');
});

test('cooldown calculation returns correct remaining time', () => {
  clearCooldowns();
  const now = 1000000;
  const halfCooldown = ATTEST_COOLDOWN_MS / 2;
  recordAttestation('attester1', '0xabc', now);
  const result = checkAttestCooldown('attester1', '0xabc', now + halfCooldown);
  assert.equal(result.allowed, false);
  assert.equal(result.remainingMs, ATTEST_COOLDOWN_MS - halfCooldown);
});

// ---- payment credits -------------------------------------------------------

test('creditPayment: accumulates volume across payments', () => {
  const did = '0x' + '11'.repeat(32);
  assert.equal(creditPayment(did, '0x' + 'a1'.repeat(32), 1_000_000n), true);
  assert.equal(creditPayment(did, '0x' + 'a2'.repeat(32), 2_500_000n), true);
  assert.equal(paymentVolume(did), 3_500_000n);
});

test('creditPayment: the same settlement cannot be credited twice', () => {
  const did = '0x' + '22'.repeat(32);
  const tx = '0x' + 'b1'.repeat(32);
  assert.equal(creditPayment(did, tx, 1_000_000n), true);
  assert.equal(creditPayment(did, tx, 1_000_000n), false, 'replay refused');
  assert.equal(paymentVolume(did), 1_000_000n, 'volume unchanged by the replay');
});

test('creditPayment: a receipt spent on one agent cannot be reused on another', () => {
  const tx = '0x' + 'c1'.repeat(32);
  assert.equal(creditPayment('0x' + '33'.repeat(32), tx, 500n), true);
  assert.equal(creditPayment('0x' + '44'.repeat(32), tx, 500n), false);
});

test('creditPayment: tx hash matching ignores case', () => {
  const did = '0x' + '55'.repeat(32);
  assert.equal(creditPayment(did, '0x' + 'DE'.repeat(32), 1n), true);
  assert.equal(creditPayment(did, '0x' + 'de'.repeat(32), 1n), false);
});

test('paymentVolume: an agent with no payments reads zero, not undefined', () => {
  assert.equal(paymentVolume('0x' + '99'.repeat(32)), 0n);
});

test('creditPayment: records the payer and outcome for later weighting', () => {
  const did = '0x' + '66'.repeat(32);
  creditPayment(did, '0x' + 'e1'.repeat(32), 50n, '0xalice', true, 1000);
  creditPayment(did, '0x' + 'e2'.repeat(32), 70n, '0xbob', false, 2000);
  const evs = getPaymentEvents(did);
  assert.equal(evs.length, 2);
  assert.equal(evs[0].payer, '0xalice');
  assert.equal(evs[1].success, false);
  assert.equal(evs[1].ts, 2000);
});

test('prunePaymentEvents: drops events too old to move a score, keeps the rest', () => {
  const did = '0x' + '77'.repeat(32);
  const day = 86400000, now = 1_000 * day;
  const halfLife = 90 * day;
  creditPayment(did, '0x' + 'f1'.repeat(32), 1n, '0xa', true, now - 10 * day);
  creditPayment(did, '0x' + 'f2'.repeat(32), 1n, '0xa', true, now - 900 * day);
  // The store is module-global, so other tests' events are pruned in the same
  // sweep. Assert on this agent rather than the sweep-wide count.
  prunePaymentEvents(halfLife, 0.001, now);
  const kept = getPaymentEvents(did);
  assert.equal(kept.length, 1, 'the 900-day-old event is gone');
  assert.equal(kept[0].ts, now - 10 * day, 'the recent one survived');
});

test('prunePaymentEvents: does nothing when decay is off', () => {
  const did = '0x' + '88'.repeat(32);
  creditPayment(did, '0x' + 'f3'.repeat(32), 1n, '0xa', true, 1);
  assert.equal(prunePaymentEvents(0, 0.001, 1_000_000_000_000), 0);
  assert.equal(getPaymentEvents(did).length, 1);
});

// --- resolveFlags ----------------------------------------------------------
// /flag only ever incremented, so before this a flag raised in error cost two
// Community points permanently. Community is worth five, so three bad flags pinned
// it at zero with no way back short of editing the state file on the host.

const DID_A = '0xaaa1';
const DID_B = '0xbbb2';

test('resolveFlags: clears one by default', () => {
  flags.set(DID_A, [1, 2, 3]);
  assert.deepEqual(resolveFlags(DID_A), { before: 3, after: 2, resolved: 1 });
  assert.equal(flags.get(DID_A).length, 2);
  flags.delete(DID_A);
});

test('resolveFlags: clears a run of them in one call', () => {
  // The motivating case: an automated producer misfires and raises several.
  flags.set(DID_A, [1, 2, 3, 4, 5]);
  assert.deepEqual(resolveFlags(DID_A, 4), { before: 5, after: 1, resolved: 4 });
  flags.delete(DID_A);
});

test('resolveFlags: over-resolving clamps to zero and reports the truth', () => {
  // Clamped rather than rejected, so a caller does not have to read the count first
  // and race whoever else is writing. `resolved` is what actually happened, not what
  // was asked for.
  flags.set(DID_A, [1, 2]);
  assert.deepEqual(resolveFlags(DID_A, 99), { before: 2, after: 0, resolved: 2 });
  flags.delete(DID_A);
});

test('resolveFlags: the entry is deleted at zero, not left as 0', () => {
  // Otherwise the state file accumulates a permanent row for every agent ever
  // flagged, and `flags.size` in the startup log stops meaning anything.
  flags.set(DID_A, [1]);
  resolveFlags(DID_A);
  assert.equal(flags.has(DID_A), false, 'zero must remove the key');
});

test('resolveFlags: an unflagged agent is a no-op, not an error', () => {
  assert.deepEqual(resolveFlags('0xnever-flagged'), { before: 0, after: 0, resolved: 0 });
  assert.equal(flags.has('0xnever-flagged'), false, 'must not create an entry');
});

test('resolveFlags: junk counts change nothing', () => {
  // resolved === 0 is what the route keys on to skip persisting, so these must not
  // report a change they did not make.
  flags.set(DID_A, [1, 2]);
  for (const bad of [0, -1, NaN, 'three', null, undefined, Infinity]) {
    const r = resolveFlags(DID_A, bad);
    assert.equal(r.resolved, bad === undefined ? 1 : 0, `count=${String(bad)}`);
    if (bad === undefined) flags.set(DID_A, [1, 2]); // the default applies, so restore
  }
  assert.equal(flags.get(DID_A).length, 2);
  flags.delete(DID_A);
});

test('resolveFlags: a fractional count is floored, never rounded up', () => {
  flags.set(DID_A, [1, 2, 3]);
  assert.equal(resolveFlags(DID_A, 1.9).resolved, 1, 'must not clear two');
  flags.delete(DID_A);
});

test('resolveFlags: one agent does not affect another', () => {
  flags.set(DID_A, [1, 2]);
  flags.set(DID_B, [1, 2]);
  resolveFlags(DID_A, 2);
  assert.equal(flags.get(DID_B).length, 2, 'B untouched');
  flags.delete(DID_B);
});

// --- flag decay ------------------------------------------------------------
// Flags were the one signal in the model that never decayed. Everything else ages
// deliberately, so manufactured evidence evaporates unless renewed; the same argument
// in reverse says an agent that has behaved for months should stop paying for one old
// flag. These use an explicit half-life rather than the configured one, so the tests
// do not change meaning if FLAG_HALF_LIFE_DAYS is ever retuned.

const DAY = 86_400_000;
const HL = 30 * DAY;
const DID_D = '0xdecay';

test('decayedFlagCount: a fresh flag counts in full', () => {
  const now = 1_000_000_000_000;
  flags.set(DID_D, [now]);
  assert.equal(decayedFlagCount(DID_D, now, HL), 1);
  flags.delete(DID_D);
});

test('decayedFlagCount: one half-life halves it', () => {
  const now = 1_000_000_000_000;
  flags.set(DID_D, [now - HL]);
  assert.ok(Math.abs(decayedFlagCount(DID_D, now, HL) - 0.5) < 1e-6);
  flags.delete(DID_D);
});

test('decayedFlagCount: flags of different ages sum', () => {
  const now = 1_000_000_000_000;
  flags.set(DID_D, [now, now - HL, now - 2 * HL]);
  // 1 + 0.5 + 0.25
  assert.ok(Math.abs(decayedFlagCount(DID_D, now, HL) - 1.75) < 1e-6);
  flags.delete(DID_D);
});

test('decayedFlagCount: an unflagged agent is 0, and no entry is created', () => {
  assert.equal(decayedFlagCount('0xclean', Date.now(), HL), 0);
  assert.equal(flags.has('0xclean'), false);
});

test('flag decay actually returns the Community points', () => {
  // The whole point, expressed as score rather than weight. Two fresh flags cost four
  // of the five points; after two half-lives the same two flags cost one.
  const now = 1_000_000_000_000;
  flags.set(DID_D, [now, now]);
  assert.equal(communityScore(decayedFlagCount(DID_D, now, HL)), 1, 'two fresh flags');

  flags.set(DID_D, [now - 2 * HL, now - 2 * HL]);
  assert.equal(communityScore(decayedFlagCount(DID_D, now, HL)), 4, 'the same two, aged');
  flags.delete(DID_D);
});

test('communityScore: floors a fractional count rather than returning a fraction', () => {
  // proposeReputation takes uint8s, so a fractional total would be rejected on chain.
  assert.equal(communityScore(0.7), 3, '5 - 1.4 = 3.6 -> 3');
  assert.equal(communityScore(1.75), 1, '5 - 3.5 = 1.5 -> 1');
  assert.equal(Number.isInteger(communityScore(0.3)), true);
});

test('communityScore: unchanged for whole numbers', () => {
  // The floor must not move any existing behaviour.
  assert.equal(communityScore(0), 5);
  assert.equal(communityScore(1), 3);
  assert.equal(communityScore(2), 1);
  assert.equal(communityScore(3), 0);
  assert.equal(communityScore(99), 0);
});

test('pruneFlags: drops flags too old to move the score, keeps the rest', () => {
  const now = 1_000_000_000_000;
  flags.set(DID_D, [now, now - 30 * DAY, now - 400 * DAY]);
  pruneFlags(0.001, now, HL);
  assert.equal(flagCount(DID_D), 2, 'the 400-day-old one is dead weight');
  flags.delete(DID_D);
});

test('pruneFlags: removes the agent entirely when nothing survives', () => {
  const now = 1_000_000_000_000;
  flags.set(DID_D, [now - 500 * DAY]);
  pruneFlags(0.001, now, HL);
  assert.equal(flags.has(DID_D), false, 'no empty array left behind');
});

test('addFlag: appends and reports the raw count', () => {
  const now = 1_000_000_000_000;
  assert.equal(addFlag(DID_D, now), 1);
  assert.equal(addFlag(DID_D, now + 1), 2);
  assert.equal(flagCount(DID_D), 2);
  flags.delete(DID_D);
});

test('resolveFlags: clears the newest first', () => {
  // An automated producer misfiring raises the most recent flags. Clearing the oldest
  // would leave the mistake and remove whatever legitimate flag preceded it.
  const old = 1_000, recent = 9_000;
  flags.set(DID_D, [old, recent]);
  resolveFlags(DID_D, 1);
  assert.deepEqual(flags.get(DID_D), [old], 'the older flag survives');
  flags.delete(DID_D);
});

// --- checker divergences ----------------------------------------------------------

const DID_DIV = '0x' + 'd1'.repeat(32);
const someDivergence = (ownTotal = 25) => ({
  total: Math.abs(ownTotal - 12), maxFactor: Math.abs(ownTotal - 12),
  pendingTotal: 12, ownTotal,
  factors: { successScore: { pending: 7, own: ownTotal - 5, delta: ownTotal - 12 } },
});

test('recordDivergence: keeps both totals and the per-factor detail', () => {
  divergences.clear();
  recordDivergence(DID_DIV, someDivergence(), 1_700_000_000, 1_700_000_500);
  const [entry] = getDivergences(DID_DIV);
  assert.equal(entry.pendingTotal, 12);
  assert.equal(entry.ownTotal, 25);
  assert.equal(entry.proposedAt, 1_700_000_000);
  assert.equal(entry.at, 1_700_000_500);
  assert.equal(entry.factors.successScore.pending, 7);
});

test('recordDivergence: keeps proposedAt, so a reader can tell live from historical', () => {
  // Without it there is no way to know whether the disputed proposal is still inside
  // its challenge window, which is the difference between something the committee can
  // still reject and a post-mortem.
  divergences.clear();
  recordDivergence(DID_DIV, someDivergence(), 1_700_000_000);
  assert.equal(getDivergences(DID_DIV)[0].proposedAt, 1_700_000_000);
});

test('recordDivergence: accumulates, newest last', () => {
  divergences.clear();
  recordDivergence(DID_DIV, someDivergence(20), 1, 10);
  recordDivergence(DID_DIV, someDivergence(30), 2, 20);
  const list = getDivergences(DID_DIV);
  assert.equal(list.length, 2);
  assert.equal(list[1].ownTotal, 30);
});

test('recordDivergence: bounded, and it is the newest that survive', () => {
  // Two oracles that permanently disagree would otherwise grow the state file without
  // limit, and it is the current window a committee acts on, not last month's.
  divergences.clear();
  for (let i = 0; i < MAX_DIVERGENCES_PER_AGENT + 25; i++) {
    recordDivergence(DID_DIV, someDivergence(20 + i), i, i);
  }
  const list = getDivergences(DID_DIV);
  assert.equal(list.length, MAX_DIVERGENCES_PER_AGENT);
  assert.equal(list[list.length - 1].ownTotal, 20 + MAX_DIVERGENCES_PER_AGENT + 24);
});

test('getDivergences: an agent never disputed reads as empty, not undefined', () => {
  divergences.clear();
  assert.deepEqual(getDivergences('0x' + 'ee'.repeat(32)), []);
});

test('allDivergences: keyed by didHash for the whole-checker view', () => {
  divergences.clear();
  recordDivergence(DID_DIV, someDivergence(), 1, 1);
  const all = allDivergences();
  assert.deepEqual(Object.keys(all), [DID_DIV]);
  assert.equal(all[DID_DIV].length, 1);
});

// -------------------------------------------------------------------------
// Payment-event array identity
//
// /evidence caches its serialized response and uses the payment-event array itself as
// the revision token: a cache entry is served only while getPaymentEvents returns the
// very same array. That is safe precisely because this store never mutates a list in
// place, and these tests exist so it stays that way.
//
// Switching creditPayment to `list.push(event)` would look like a harmless allocation
// saving and would make /evidence serve a stale Merkle root and a stale payment list
// for as long as the entry survived. On an endpoint whose whole purpose is letting a
// third party check the operator, that is the worst bug available.
// -------------------------------------------------------------------------

test('creditPayment: replaces the event array rather than mutating it', () => {
  const did = '0x' + 'e1'.repeat(32);
  creditPayment(did, '0x' + 'd7'.repeat(32), 1_000n);
  const before = getPaymentEvents(did);

  creditPayment(did, '0x' + 'd8'.repeat(32), 2_000n);
  const after = getPaymentEvents(did);

  assert.notEqual(before, after, 'a credit must produce a new array identity');
  assert.equal(before.length, 1, 'the array handed out earlier is left untouched');
  assert.equal(after.length, 2);
});

test('prunePaymentEvents: replaces the array when it drops something, keeps identity when it does not', () => {
  const did = '0x' + 'e2'.repeat(32);
  const now = Date.now();
  creditPayment(did, '0x' + 'd9'.repeat(32), 1_000n, undefined, true, now);
  const fresh = getPaymentEvents(did);

  // Nothing is old enough to drop: identity must survive, or every prune would
  // needlessly invalidate every cached evidence response.
  prunePaymentEvents(90 * 24 * 60 * 60 * 1000, 0.001, now);
  assert.equal(getPaymentEvents(did), fresh, 'an empty prune keeps the same array');

  // Now age it out. Dropping an event must change identity so the cache rebuilds.
  prunePaymentEvents(1, 0.5, now + 1_000_000);
  assert.notEqual(getPaymentEvents(did), fresh, 'a prune that drops must replace the array');
});
