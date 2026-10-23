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
  paymentEventError,
  getLastPersist,
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

// This replaced a test asserting that one settlement could credit only one agent, full
// stop. That held when an attestation was the only way in and named a single agent. The
// pull scanner reads every agent's transfers from the same logs, so a transaction paying
// several agents at once is now ordinary traffic rather than a sign of abuse.
//
// What stops a receipt being spent on an agent it never paid is the recipient check, in
// both entry paths and not here: verifyPayment only counts transfers to the agent's own
// address, and planCredits derives the agent from the log's `to` field. Refusing the
// second agent here did not add to that. It only discarded money that had demonstrably
// moved, permanently, because the scan checkpoint moves past the block either way.
test('creditPayment: one settlement paying two agents credits both', () => {
  const tx = '0x' + 'c1'.repeat(32);
  const a = '0x' + '33'.repeat(32);
  const b = '0x' + '44'.repeat(32);
  assert.equal(creditPayment(a, tx, 500n), true);
  assert.equal(
    creditPayment(b, tx, 700n), true,
    'a batch payment credits every agent it actually paid, not just the first one seen'
  );
  assert.equal(paymentVolume(a), 500n);
  assert.equal(paymentVolume(b), 700n);
});

test('creditPayment: the same settlement still cannot be credited twice for one agent', () => {
  const tx = '0x' + 'c3'.repeat(32);
  const did = '0x' + '5b'.repeat(32);
  assert.equal(creditPayment(did, tx, 500n), true);
  assert.equal(creditPayment(did, tx, 500n), false, 'replay of the same pair refused');
  assert.equal(paymentVolume(did), 500n, 'volume unchanged by the replay');
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

// The configured half-life is read once, when the module loads, so each value gets a process of its
// own. A blank FLAG_HALF_LIFE_DAYS used to read as zero, which switched flag decay off.
test('FLAG_HALF_LIFE_DAYS: blank is the default, and zero still turns decay off', () => {
  const { spawnSync } = require('node:child_process');
  const read = (value) => {
    const env = { ...process.env, ORACLE_STATE_PATH: '/nonexistent/state.json' };
    if (value === undefined) delete env.FLAG_HALF_LIFE_DAYS; else env.FLAG_HALF_LIFE_DAYS = value;
    const r = spawnSync(
      process.execPath,
      ['-e', "process.stdout.write(String(require('./store').FLAG_HALF_LIFE_MS))"],
      { cwd: __dirname, env, encoding: 'utf8' },
    );
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  assert.equal(read(undefined), String(30 * DAY));
  assert.equal(read(''), String(30 * DAY));
  assert.equal(read('   '), String(30 * DAY));
  assert.equal(read('10'), String(10 * DAY));
  assert.equal(read('0'), '0');
});

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

// ---------------------------------------------------------------------------
// State file durability and validation
//
// Driven in a child process because STATE_PATH is read from the environment when the
// module loads, so the only honest way to exercise load() is a fresh process with its
// own env and its own temp file. Testing around it would prove nothing about the path
// that actually runs on the operators.
// ---------------------------------------------------------------------------

const { execFileSync } = require('node:child_process');
const os = require('node:os');
const fsx = require('node:fs');
const pathx = require('node:path');

function inChildWithState(stateObject, script) {
  const dir = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'sigvara-store-'));
  const statePath = pathx.join(dir, 'oracle-state.json');
  if (stateObject !== null) fsx.writeFileSync(statePath, JSON.stringify(stateObject));
  try {
    return execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, ORACLE_STATE_PATH: statePath },
      cwd: __dirname,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally {
    fsx.rmSync(dir, { recursive: true, force: true });
  }
}

const goodEvent = {
  txHash: '0x' + 'ab'.repeat(32),
  payer: '0x' + '11'.repeat(20),
  amount: '1000000',
  ts: 1_700_000_000_000,
  success: true,
};

test('paymentEventError: rejects exactly what the scoring maths cannot convert', () => {
  assert.equal(paymentEventError(goodEvent), null);
  // The three shapes a hand-seeded state file actually produces. Each one used to throw
  // from inside decayWeight or decayedVolume, naming neither the agent nor the field.
  assert.match(paymentEventError({ ...goodEvent, amount: '1.5' }), /amount/);
  assert.match(paymentEventError({ ...goodEvent, amount: '1_000_000' }), /amount/);
  assert.match(paymentEventError({ ...goodEvent, ts: undefined }), /ts/);
  assert.match(paymentEventError({ ...goodEvent, txHash: '0xnope' }), /txHash/);
  assert.match(paymentEventError(null), /not an object/);
  // A missing payer is pre-existing behaviour: it counts as volume under the empty-string
  // key. Not something to start refusing state over.
  assert.equal(paymentEventError({ ...goodEvent, payer: undefined }), null);
});

test('load: drops an unusable payment event and still scores every other agent', () => {
  const out = inChildWithState({
    paymentEvents: {
      'did-poisoned': [{ ...goodEvent, amount: '1.5' }],
      'did-healthy': [{ ...goodEvent, txHash: '0x' + 'cd'.repeat(32) }],
    },
  }, `
    const s = require('./store');
    const p = require('./payments');
    s.load();
    const poisoned = s.getPaymentEvents('did-poisoned');
    const healthy = s.getPaymentEvents('did-healthy');
    // The whole point: the bad event is gone and the good agent is untouched and scorable.
    console.log(JSON.stringify({
      poisoned: poisoned.length,
      healthy: healthy.length,
      volume: p.decayedVolume(healthy, 7776000000, 1700000001000).toString(),
    }));
  `);
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.equal(r.poisoned, 0, 'the unusable event is dropped rather than crashing the load');
  assert.equal(r.healthy, 1, 'the healthy agent keeps its event');
  assert.equal(r.volume, '1000000', 'and still scores, which it could not do if load threw');
});

test('persist: a failed write is recorded rather than swallowed', () => {
  const out = inChildWithState(null, `
    const fs = require('fs');
    const real = fs.writeFileSync;
    const s = require('./store');
    // Fail only the state write, so mkdir and the rest behave normally.
    fs.writeFileSync = (p, d) => {
      if (String(p).includes('oracle-state.json')) {
        const e = new Error('no space left on device'); e.code = 'ENOSPC'; throw e;
      }
      return real(p, d);
    };
    s.creditPayment('did-x', '0x' + 'ee'.repeat(32), '5', '0x' + '22'.repeat(20), true, 1);
    s.persist();
    console.log(JSON.stringify(s.getLastPersist()));
  `);
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.equal(r.ok, false, 'a failed persist is visible, so /health can turn 503');
  assert.match(r.error, /no space left on device/);
  assert.ok(r.at, 'and carries when it happened');
});

test('creditPayment: the stored event list is frozen, so the cache revision cannot lie', () => {
  const did = '0x' + 'f7'.repeat(32);
  creditPayment(did, '0x' + 'f8'.repeat(32), 10n, '0x' + '33'.repeat(20), true, 1);
  const list = getPaymentEvents(did);
  assert.ok(Object.isFrozen(list), 'frozen in place: identity is what the cache keys on');
  assert.throws(() => list.push({ amount: '1' }), TypeError);
});

// The settlement's block, stored rather than re-derived.
//
// The canary proves an empty scan was really empty by re-issuing the scan's own filter
// against a settlement known to exist. It needs that settlement's block number, the event
// did not carry one, so it refetched the receipt — and both live endpoints prune the
// transaction index: about 6 days on Circle's, about 13 on QuickNode's. Measured 3 Oct
// 2026. So the lookup returned null, the canary reported `unavailable`, and no empty scan
// could be believed.
//
// Both entry paths already know the block: verifyPayment returns it and planCredits
// carries it. Neither stored it. Storing it removes the dependency on an index that is
// guaranteed to age out.
test('creditPayment: records the settlement block when the caller knows it', () => {
  const did = '0x' + '7a'.repeat(32);
  const tx = '0x' + '7b'.repeat(32);
  assert.equal(creditPayment(did, tx, 500n, '0x' + '01'.repeat(20), true, 1000, null, 64100000), true);
  const [e] = getPaymentEvents(did);
  assert.equal(e.blockNumber, 64100000);
});

test('creditPayment: an event stays valid without a block, as every stored one is', () => {
  const did = '0x' + '9c'.repeat(32);
  const tx = '0x' + '9d'.repeat(32);
  assert.equal(creditPayment(did, tx, 500n, '0x' + '02'.repeat(20), true, 1000), true);
  const [e] = getPaymentEvents(did);
  assert.ok(!('blockNumber' in e), 'absent rather than null, so the stored shape is unchanged');
});

test('creditPayment: a mixed-case didHash is filed where scoring reads it', () => {
  const lower = '0x' + '5e'.repeat(32);
  const upper = '0x' + '5E'.repeat(32);
  const tx = '0x' + '7e'.repeat(32);
  const payer = '0x' + '33'.repeat(20);
  assert.equal(creditPayment(upper, tx, 1_000_000n, payer, true, 1_700_000_000_000), true);
  // Under the lowercase key the epoch and /evidence use, from either spelling.
  assert.equal(getPaymentEvents(lower).length, 1);
  assert.equal(getPaymentEvents(upper).length, 1);
  // And the receipt is still spent once: the same payment in lowercase is a replay.
  assert.equal(creditPayment(lower, tx, 1_000_000n, payer, true, 1_700_000_000_001), false);
  assert.equal(getPaymentEvents(lower).length, 1);
});

test('load: credits stored under a mixed-case didHash are folded back into the agent', () => {
  const lower = '0x' + '6f'.repeat(32);
  const out = inChildWithState({
    paymentEvents: {
      [lower]: [goodEvent],
      ['0x' + '6F'.repeat(32)]: [{ ...goodEvent, txHash: '0x' + 'ef'.repeat(32) }],
      'did-healthy': [{ ...goodEvent, txHash: '0x' + 'cd'.repeat(32) }],
    },
  }, `
    const s = require('./store');
    s.load();
    console.log(JSON.stringify({
      merged: s.getPaymentEvents('${lower}').map((e) => e.txHash),
      keys: [...s.allPaymentEvents().keys()].sort(),
    }));
  `);
  const r = JSON.parse(out.trim().split('\n').pop());
  assert.deepEqual(r.merged, [goodEvent.txHash, '0x' + 'ef'.repeat(32)], 'both credits, existing one first');
  assert.deepEqual(r.keys, [lower, 'did-healthy'].sort(), 'no mixed-case key survives');
});

// ---- setPaymentOutcome ------------------------------------------------------
//
// A payment found by the scan, or attested by someone with no token, is credited without an
// outcome. The party that audited the work must still be able to record one afterwards.

const { setPaymentOutcome } = require('./store');
const OUTCOME_PAYER = '0x45D8c79e1188A429dbDfd8400A2869316d6fCe8D';

test('setPaymentOutcome: gives a payment credited without an outcome its first one', () => {
  const did = '0x' + 'd1'.repeat(32);
  const tx = '0x' + 'e1'.repeat(32);
  assert.equal(creditPayment(did, tx, 500n, OUTCOME_PAYER, null), true);
  const before = getPaymentEvents(did);
  assert.equal(setPaymentOutcome(did, tx, OUTCOME_PAYER, false), 'set');
  const after = getPaymentEvents(did);
  assert.equal(after[0].success, false);
  assert.notEqual(after, before, 'a new array, so the evidence cache sees a new revision');
  assert.equal(before[0].success, null, 'the earlier array was not edited in place');
  assert.ok(Object.isFrozen(after), 'the new array is frozen like every other version');
});

test('setPaymentOutcome: an outcome, once recorded, is final', () => {
  const did = '0x' + 'd2'.repeat(32);
  const tx = '0x' + 'e2'.repeat(32);
  assert.equal(creditPayment(did, tx, 500n, OUTCOME_PAYER, true), true);
  assert.equal(setPaymentOutcome(did, tx, OUTCOME_PAYER, false), 'already_set');
  assert.equal(getPaymentEvents(did)[0].success, true, 'the audited result was not overwritten');
});

test('setPaymentOutcome: matches the hash and payer without regard to case, and only that payer', () => {
  const did = '0x' + 'd3'.repeat(32);
  const tx = '0x' + 'AB'.repeat(32);
  const other = '0x18CBcE50390f5f6ebe4E20Fc17833F25c8D94811';
  assert.equal(creditPayment(did, tx, 500n, OUTCOME_PAYER, null), true);
  assert.equal(creditPayment(did, tx, 700n, other, null), true, 'a second sender in the same transaction');
  assert.equal(setPaymentOutcome(did.toUpperCase().replace('0X', '0x'), tx.toLowerCase(), OUTCOME_PAYER.toLowerCase(), true), 'set');
  const events = getPaymentEvents(did);
  assert.equal(events.find((e) => e.payer === OUTCOME_PAYER).success, true);
  assert.equal(events.find((e) => e.payer === other).success, null, 'the other sender is untouched');
});

test('setPaymentOutcome: a settlement that was never credited is not_found', () => {
  const did = '0x' + 'd4'.repeat(32);
  assert.equal(setPaymentOutcome(did, '0x' + 'e4'.repeat(32), OUTCOME_PAYER, true), 'not_found');
});

test('setPaymentOutcome: refuses anything but a boolean, which would be recorded as no outcome', () => {
  const did = '0x' + 'd5'.repeat(32);
  const tx = '0x' + 'e5'.repeat(32);
  creditPayment(did, tx, 500n, OUTCOME_PAYER, null);
  assert.throws(() => setPaymentOutcome(did, tx, OUTCOME_PAYER, 'false'), TypeError);
  assert.throws(() => setPaymentOutcome(did, tx, OUTCOME_PAYER, null), TypeError);
  assert.equal(getPaymentEvents(did)[0].success, null);
});

// ---------------------------------------------------------------------------
// A state file that cannot be read
//
// Any error but "no such file" used to be logged as "starting fresh", and the next save
// wrote an empty state over the original. What is in that file cannot be rebuilt from the
// chain: attested outcomes, flags, links, and the record of which settlements were already
// credited. A stray comma from editing it by hand was enough to lose all of it, and to
// credit the same settlement twice.
// ---------------------------------------------------------------------------

// Writes `main` and `backup` (an object, a string for raw content, or null for no file) into
// a fresh directory and runs a script against them in a child process.
function inChildWithFiles({ main = null, backup = null }, script) {
  const dir = fsx.mkdtempSync(pathx.join(os.tmpdir(), 'sigvara-store-'));
  const statePath = pathx.join(dir, 'oracle-state.json');
  const put = (p, v) => {
    if (v !== null) fsx.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v));
  };
  put(statePath, main);
  put(`${statePath}.bak`, backup);
  try {
    return execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, ORACLE_STATE_PATH: statePath },
      cwd: __dirname,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally {
    fsx.rmSync(dir, { recursive: true, force: true });
  }
}

const lastJson = (out) => JSON.parse(out.trim().split('\n').pop());

const goodState = {
  attestations: { 'did-a': { successful: 3, total: 4 } },
  flags: { 'did-a': [1_700_000_000_000] },
  usedPaymentTxs: ['0x' + 'ab'.repeat(32) + '|did-a|0x' + '11'.repeat(20)],
  savedAt: '2026-10-01T00:00:00.000Z',
};

// What every script below reports, so the assertions read as the facts they are about.
const REPORT = `
  const report = (extra = {}) => console.log(JSON.stringify({
    attestations: [...s.attestations.keys()],
    flags: [...s.flags.keys()],
    used: s.usedPaymentTxs.size,
    load: s.getLoadReport(),
    files: fs.readdirSync(require('path').dirname(process.env.ORACLE_STATE_PATH)).sort(),
    ...extra,
  }));
`;

test('load: a state file that cannot be read stops the load, with the file untouched', () => {
  const out = inChildWithFiles({ main: '{"attestations": {"did-a": ' }, `
    const fs = require('fs');
    const s = require('./store');
    ${REPORT}
    let error = null;
    try { s.load(); } catch (e) { error = { name: e.constructor.name, message: e.message }; }
    report({ error, stillThere: fs.readFileSync(process.env.ORACLE_STATE_PATH, 'utf8') });
  `);
  const r = lastJson(out);
  assert.equal(r.error.name, 'StateLoadError', 'it must throw, not carry on empty');
  assert.match(r.error.message, /cannot be used/);
  assert.match(r.error.message, /no backup/);
  assert.equal(r.stillThere, '{"attestations": {"did-a": ', 'the original is exactly as it was');
  assert.deepEqual(r.attestations, [], 'and nothing was loaded');
});

test('load: a file that reads only in part applies none of it', () => {
  // attestations are fine and usedPaymentTxs is not a list. The old loader had already
  // filled the attestations by the time it reached the second, which is how a settlement
  // came to be credited twice.
  const out = inChildWithFiles({ main: { ...goodState, usedPaymentTxs: 'oops' } }, `
    const fs = require('fs');
    const s = require('./store');
    ${REPORT}
    let error = null;
    try { s.load(); } catch (e) { error = e.message; }
    report({ error });
  `);
  const r = lastJson(out);
  assert.match(r.error, /usedPaymentTxs is not a list/);
  assert.deepEqual(r.attestations, [], 'nothing from the half-readable file was applied');
  assert.deepEqual(r.flags, []);
});

test('load: an unusable file falls back to the previous save, keeps the bad one, and says so', () => {
  const out = inChildWithFiles({ main: 'not json at all', backup: goodState }, `
    const fs = require('fs');
    const s = require('./store');
    ${REPORT}
    s.load();
    report();
  `);
  const r = lastJson(out);
  assert.equal(r.load.source, 'backup');
  assert.match(r.load.detail, /JSON/);
  assert.deepEqual(r.attestations, ['did-a'], 'the previous save was used');
  assert.equal(r.used, 1);
  assert.ok(r.files.some((f) => f.startsWith('oracle-state.json.corrupt-')), 'the bad file was kept');
  assert.ok(!r.files.includes('oracle-state.json'), 'and moved out of the way, not overwritten');
});

test('load: an unusable file and an unusable backup is a refusal that names both', () => {
  const out = inChildWithFiles({ main: 'garbage', backup: '{"flags": []' }, `
    const s = require('./store');
    ${REPORT.replace('fs.readdirSync', 'require("fs").readdirSync')}
    let error = null;
    try { s.load(); } catch (e) { error = e.message; }
    report({ error });
  `);
  const r = lastJson(out);
  assert.match(r.error, /cannot be used/);
  assert.match(r.error, /backup from the previous save is unusable/);
  assert.match(r.error, /move the file aside/);
  assert.deepEqual(r.attestations, []);
});

test('load: a missing file is a fresh start even when a backup exists', () => {
  // Deleting the state file is the documented way to rescan from FROM_BLOCK. A backup must
  // not quietly bring back what the operator removed on purpose.
  const out = inChildWithFiles({ main: null, backup: goodState }, `
    const s = require('./store');
    ${REPORT.replace('fs.readdirSync', 'require("fs").readdirSync')}
    s.load();
    report();
  `);
  const r = lastJson(out);
  assert.equal(r.load.source, 'fresh');
  assert.deepEqual(r.attestations, []);
});

test('load: the version this build writes is read, and the very next one is not', () => {
  const { STATE_SCHEMA_VERSION } = require('./store');
  for (const [version, loads] of [[STATE_SCHEMA_VERSION, true], [STATE_SCHEMA_VERSION + 1, false]]) {
    const out = inChildWithFiles({ main: { ...goodState, schemaVersion: version } }, `
      const s = require('./store');
      let error = null;
      try { s.load(); } catch (e) { error = e.constructor.name; }
      console.log(JSON.stringify({ error }));
    `);
    assert.equal(lastJson(out).error, loads ? null : 'StateLoadError', `schemaVersion ${version}`);
  }
});

test('load: a file written by a newer version is refused, and the backup does not stand in for it', () => {
  const out = inChildWithFiles({ main: { ...goodState, schemaVersion: 99 }, backup: goodState }, `
    const s = require('./store');
    ${REPORT.replace('fs.readdirSync', 'require("fs").readdirSync')}
    let error = null;
    try { s.load(); } catch (e) { error = { name: e.constructor.name, message: e.message }; }
    report({ error });
  `);
  const r = lastJson(out);
  assert.equal(r.error.name, 'StateLoadError');
  assert.match(r.error.message, /format version 99/);
  assert.match(r.error.message, /newer version/);
  assert.deepEqual(r.attestations, [], 'older state would be saved over everything the newer build recorded');
  assert.ok(!r.files.some((f) => f.includes('corrupt')), 'and the file is not moved aside as if damaged');
});

test('load: a file with no version is read as the original format', () => {
  const out = inChildWithFiles({ main: goodState }, `
    const s = require('./store');
    ${REPORT.replace('fs.readdirSync', 'require("fs").readdirSync')}
    s.load();
    report();
  `);
  assert.equal(lastJson(out).load.source, 'file');
});

test('load: a field of the wrong kind is unusable, not read as empty', () => {
  for (const bad of [
    { attestations: [1, 2] },
    { flags: 'many' },
    { paymentEvents: 7 },
    { chainId: 'arc' },
    { schemaVersion: 'one' },
    [],
  ]) {
    const out = inChildWithFiles({ main: bad }, `
      const s = require('./store');
      let error = null;
      try { s.load(); } catch (e) { error = e.constructor.name; }
      console.log(JSON.stringify({ error }));
    `);
    assert.equal(lastJson(out).error, 'StateLoadError', JSON.stringify(bad));
  }
});

test('persist: writes the format version and the chain, and load reads the chain back', () => {
  const out = inChildWithFiles({}, `
    const fs = require('fs');
    const s = require('./store');
    s.setStateChainId(5042);
    s.persist();
    const written = JSON.parse(fs.readFileSync(process.env.ORACLE_STATE_PATH, 'utf8'));
    s.setStateChainId(null);
    s.load();
    console.log(JSON.stringify({ version: written.schemaVersion, chainId: written.chainId, back: s.getStateChainId(), current: s.STATE_SCHEMA_VERSION }));
  `);
  const r = lastJson(out);
  assert.equal(r.version, r.current);
  assert.equal(r.chainId, 5042);
  assert.equal(r.back, 5042);
});

test('persist: keeps the previous save as a backup that a later load can use', () => {
  const out = inChildWithFiles({}, `
    const fs = require('fs');
    const s = require('./store');
    s.addFlag('did-first');
    s.persist();                       // save 1: only did-first
    s.addFlag('did-second');
    s.persist();                       // save 2: both; the backup is save 1
    const backup = JSON.parse(fs.readFileSync(s.BACKUP_PATH, 'utf8'));
    fs.writeFileSync(process.env.ORACLE_STATE_PATH, '{ broken');   // the live file is damaged
    s.flags.clear();
    s.load();
    console.log(JSON.stringify({ backupFlags: Object.keys(backup.flags), recovered: [...s.flags.keys()], source: s.getLoadReport().source }));
  `);
  const r = lastJson(out);
  assert.deepEqual(r.backupFlags, ['did-first']);
  assert.deepEqual(r.recovered, ['did-first'], 'the damaged file is replaced by the save before it');
  assert.equal(r.source, 'backup');
});

test('persist: copes with a filesystem that cannot hard link, and never fails the save over a backup', () => {
  const out = inChildWithFiles({}, `
    const fs = require('fs');
    const s = require('./store');
    const realLink = fs.linkSync;
    fs.linkSync = () => { const e = new Error('operation not permitted'); e.code = 'EPERM'; throw e; };
    s.addFlag('did-a'); s.persist();
    s.addFlag('did-b'); s.persist();
    const viaCopy = fs.existsSync(s.BACKUP_PATH) && Object.keys(JSON.parse(fs.readFileSync(s.BACKUP_PATH, 'utf8')).flags);
    const okAfterCopy = s.getLastPersist().ok;
    // And with neither a link nor a copy possible, the save itself still lands.
    fs.copyFileSync = () => { throw new Error('disk full'); };
    s.addFlag('did-c'); s.persist();
    console.log(JSON.stringify({ viaCopy, okAfterCopy, okWithoutBackup: s.getLastPersist().ok }));
  `);
  const r = lastJson(out);
  assert.deepEqual(r.viaCopy, ['did-a'], 'the copy fallback holds the previous save');
  assert.equal(r.okAfterCopy, true);
  assert.equal(r.okWithoutBackup, true);
});

test('creditPayment: the events it keeps are frozen, which merkle.js relies on to cache leaves and roots', () => {
  const did = '0x' + 'f1'.repeat(32);
  assert.equal(creditPayment(did, '0x' + '01'.repeat(32), '5', '0x' + '22'.repeat(20), true, 1_700_000_000_000, 'pkt-1', 77), true);
  const list = getPaymentEvents(did);
  assert.ok(Object.isFrozen(list), 'the array');
  assert.ok(list.every((e) => Object.isFrozen(e)), 'and every event in it, optional fields included');
  assert.equal(list[0].packetId, 'pkt-1');
  assert.equal(list[0].blockNumber, 77);
});

test('setPaymentOutcome: the replacement event is a new frozen object and the old one is left alone', () => {
  const did = '0x' + 'f2'.repeat(32);
  const tx = '0x' + '02'.repeat(32);
  const payer = '0x' + '33'.repeat(20);
  creditPayment(did, tx, '5', payer, null, 1_700_000_000_000);
  const before = getPaymentEvents(did);
  assert.equal(setPaymentOutcome(did, tx, payer, true), 'set');
  const after = getPaymentEvents(did);
  assert.notEqual(after, before, 'a new array');
  assert.notEqual(after[0], before[0], 'and a new event');
  assert.equal(before[0].success, null, 'the old event still says what it said');
  assert.ok(Object.isFrozen(after) && after.every((e) => Object.isFrozen(e)));
});

test('load: the payment events it restores are frozen as well', () => {
  const out = inChildWithState({ paymentEvents: { 'did-frozen': [goodEvent] } }, `
    const s = require('./store');
    s.load();
    const list = s.getPaymentEvents('did-frozen');
    console.log(JSON.stringify({ n: list.length, array: Object.isFrozen(list), events: list.every((e) => Object.isFrozen(e)) }));
  `);
  assert.deepEqual(JSON.parse(out.trim().split('\n').pop()), { n: 1, array: true, events: true });
});
