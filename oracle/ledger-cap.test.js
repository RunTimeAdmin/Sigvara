'use strict';
// The payment ledger's caps (PAYMENT_MAX_EVENTS_PER_AGENT, PAYMENT_MAX_EVENTS_TOTAL). Past a cap the ledger drops the
// payment that matters least instead of refusing the next one and holding the agent, and two operators that credited
// the same payments in any order keep the same ones (store.js, creditPayments).
const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ethers } = require('ethers');
const payerOutcome = require('./payer-outcome');
const { TRANSFER_TOPIC } = require('./payments');
const { World, startOracle, wallet, ASSET } = require('./test-support/oracle-harness');

const DAY = 86_400_000;
const USDC = 1_000_000n;
const CENT = '10000';

/**
 * Runs `script` against a fresh store in a child process, with these settings, and returns the JSON it printed last.
 * `input` reaches the script as the file named by LEDGER_INPUT, since a command line has a length limit.
 */
function inChild(env, script, input = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigvara-ledger-'));
  const inputFile = path.join(dir, 'input.json');
  if (input !== null) fs.writeFileSync(inputFile, JSON.stringify(input));
  try {
    const out = execFileSync(process.execPath, ['-e', script], {
      env: { ...process.env, ORACLE_STATE_PATH: path.join(dir, 'state.json'), LEDGER_INPUT: inputFile, ...env },
      cwd: __dirname,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(out.trim().split('\n').pop());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const DEFAULT_CAPS = { PAYMENT_MAX_EVENTS_PER_AGENT: '25000', PAYMENT_MAX_EVENTS_TOTAL: '150000' };
const HELPERS = `
  const s = require('./store');
  const tx = (tag, n) => '0x' + tag + n.toString(16).padStart(62, '0');
  const addr = (n) => '0x' + n.toString(16).padStart(40, '0');
`;

test('a payer flooding an agent past its cap with one-cent payments drops the oldest of them, never a larger payment or one with an outcome', () => {
  const r = inChild(DEFAULT_CAPS, `${HELPERS}
    const victim = '0x' + 'aa'.repeat(32);
    const T0 = 1_780_000_000_000;
    // Its customers' payments as the scan finds them: five dollars each, with no outcome.
    const genuine = Array.from({ length: 20 }, (_, i) => ({ didHash: victim, txHash: tx('a1', i), amount: '5000000', payer: addr(1000 + i), ts: T0 + i * 60_000, blockNumber: 100 + i }));
    s.creditPayments(genuine);
    // One-cent payments with an outcome, a token holder's and a payer's: the smallest and the oldest it holds.
    const credentialed = [true, false, true].map((ok, i) => ({ didHash: victim, txHash: tx('a2', i), amount: '${CENT}', payer: addr(2000 + i), success: ok, ts: T0 - 86_400_000 + i }));
    s.creditPayments(credentialed);
    const signed = [0, 1].map((i) => ({ didHash: victim, txHash: tx('a3', i), amount: '${CENT}', payer: addr(3000 + i), ts: T0 - 86_400_000 + 10 + i }));
    s.creditPayments(signed);
    for (const p of signed) s.recordPayerOutcome(victim, p.txHash, p.payer, true, { outcome: 1 }, { windowMs: 0, now: p.ts + 1 });
    // 30,000 one-cent payments from one unrelated payer, newest last, in the batches a scan credits them in.
    const attacker = addr(0xbad);
    const flood = Array.from({ length: 30_000 }, (_, i) => ({ didHash: victim, txHash: tx('f0', i), amount: '${CENT}', payer: attacker, ts: T0 + 3_600_000 + i * 1000 }));
    for (let i = 0; i < flood.length; i += 1000) s.creditPayments(flood.slice(i, i + 1000));
    const held = s.getPaymentEvents(victim);
    const has = new Set(held.map((e) => e.txHash));
    const keptFlood = flood.filter((p) => has.has(p.txHash));
    console.log(JSON.stringify({
      held: held.length,
      genuineKept: genuine.every((p) => has.has(p.txHash)),
      outcomesKept: [...credentialed, ...signed].every((p) => has.has(p.txHash)),
      floodKept: keptFlood.length,
      newestKept: keptFlood.every((p) => p.ts >= flood[flood.length - keptFlood.length].ts),
      // Sent again, even with an outcome, a dropped payment stays out.
      replayed: s.creditPayment(victim, flood[0].txHash, '${CENT}', attacker, true, flood[0].ts),
      dropped: s.isDropped(flood[0].txHash, victim, attacker),
      ledger: s.ledgerStatus(),
    }));
  `);
  assert.deepEqual(r, {
    held: 25_000,
    genuineKept: true,
    outcomesKept: true,
    floodKept: 25_000 - 25,
    newestKept: true,
    replayed: false,
    dropped: true,
    ledger: {
      events: 25_000, maxTotal: 150_000, maxPerAgent: 25_000, dropped: 30_000 - (25_000 - 25),
      withOutcome: 5, droppedWithOutcome: 0, droppedKeys: 30_000 - (25_000 - 25), agentsWithFloor: 0,
    },
  });
});

// A small deterministic generator, so a failure can be run again.
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('two operators crediting the same payments in different orders keep the same events and the same evidence roots', () => {
  const BASE = 84532;
  const random = prng(7);
  const dids = ['aa', 'bb', 'cc'].map((b) => `0x${b.repeat(32)}`);
  const payments = [];
  for (const [d, didHash] of dids.entries()) {
    for (let i = 0; i < 60; i += 1) {
      // Few amounts, times and payers, so that ties are common and the tie-breaks decide.
      const cents = [1n, 2n, 5n, 500n][Math.floor(random() * 4)];
      const onBase = i % 5 === 0;
      payments.push({
        didHash,
        txHash: `0x${(d * 1000 + i).toString(16).padStart(64, '0')}`,
        // Base's fee unit is 10^12 times the scored chain's, so these are the same money.
        amount: String(cents * 10_000n * (onBase ? 10n ** 12n : 1n)),
        payer: `0x${(1 + Math.floor(random() * 5)).toString(16).padStart(40, '0')}`,
        ts: 1_780_000_000_000 + Math.floor(random() * 7) * 1000,
        ...(i % 9 === 4 ? { success: random() < 0.5 } : {}),
        ...(onBase ? { chainId: BASE } : {}),
      });
    }
  }
  const env = { PAYMENT_MAX_EVENTS_PER_AGENT: '40', PAYMENT_MAX_EVENTS_TOTAL: '100' };
  const run = (batches) => inChild(env, `${HELPERS}
    const merkle = require('./merkle');
    const { evidenceOrder } = require('./payment-chains');
    s.setLedgerFeeUnits(100000000n, [{ chainId: ${BASE}, feeUnit: 100000000000000000000n }]);
    const { payments, batches } = JSON.parse(require('fs').readFileSync(process.env.LEDGER_INPUT, 'utf8'));
    for (const batch of batches) {
      const p = payments[batch[0]];
      if (batch.length === 1) s.creditPayment(p.didHash, p.txHash, p.amount, p.payer, p.success ?? null, p.ts, null, null, p.chainId ?? null);
      else s.creditPayments(batch.map((i) => payments[i]));
    }
    const out = {};
    for (const did of ${JSON.stringify(dids)}) {
      const events = s.getPaymentEvents(did);
      out[did] = { kept: events.map((e) => (e.chainId ?? '') + ':' + e.txHash).sort(), root: merkle.rootFor([...events].sort(evidenceOrder)) };
    }
    console.log(JSON.stringify(out));
  `, { payments, batches });
  const indices = payments.map((_, i) => i);
  // One operator in the order the payments settled, seven at a time.
  const byTime = [...indices].sort((x, y) => payments[x].ts - payments[y].ts);
  const first = [];
  for (let i = 0; i < byTime.length; i += 7) first.push(byTime.slice(i, i + 7));
  // The other shuffled, in batches of 1 to 13, a batch of one through creditPayment.
  const shuffled = [...indices];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const second = [];
  for (let i = 0; i < shuffled.length;) {
    const n = 1 + Math.floor(random() * 13);
    second.push(shuffled.slice(i, i + n));
    i += n;
  }
  const a = run(first);
  const b = run(second);
  assert.deepEqual(b, a);

  // And what both keep is each one's fair share: per agent up to 40, each payer keeping its share of them, then across
  // agents up to 100, each agent keeping its share and its payers theirs. A share is every group's count up to one
  // level, the odd places to the lowest agent ids, and among payers to those whose next payment ranks highest. Within
  // a payer an outcome goes last, then the largest in fee units, then the newest, then by transaction. Written again
  // here, to check the store's.
  const key = (p) => BigInt(p.amount) * (p.chainId ? 1n : 10n ** 12n);
  const lower = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  const order = (x, y) => lower(key(x), key(y)) || (x.ts - y.ts) || lower(x.txHash, y.txHash) || lower(x.payer, y.payer)
    || ((x.chainId ?? 0) - (y.chainId ?? 0)) || lower(x.didHash, y.didHash);
  const outcome = (p) => Number(typeof p.success === 'boolean');
  const lossOrder = (x, y) => (outcome(x) - outcome(y)) || order(x, y);
  const shares = (counts, room, first = (ids) => ids.sort(lower)) => {
    const ids = [...counts.keys()];
    const fit = (level) => ids.reduce((n, id) => n + Math.min(counts.get(id), level), 0);
    let level = 0;
    while (fit(level + 1) <= room && level < Math.max(...counts.values())) level += 1;
    let spare = room - fit(level);
    const out = new Map();
    for (const id of ids) if (counts.get(id) <= level) out.set(id, counts.get(id));
    for (const id of first(ids.filter((id) => counts.get(id) > level), level)) {
      out.set(id, level + (spare > 0 ? 1 : 0));
      spare -= 1;
    }
    return out;
  };
  const trim = (list, cap) => {
    if (list.length <= cap) return list;
    const byPayer = new Map();
    for (const p of list) byPayer.set(p.payer.toLowerCase(), [...(byPayer.get(p.payer.toLowerCase()) ?? []), p]);
    for (const ps of byPayer.values()) ps.sort(lossOrder);
    const next = (who, level) => byPayer.get(who)[byPayer.get(who).length - level - 1];
    const share = shares(new Map([...byPayer].map(([who, ps]) => [who, ps.length])), cap,
      (ids, level) => ids.sort((x, y) => lossOrder(next(y, level), next(x, level))));
    return [...byPayer].flatMap(([who, ps]) => ps.slice(ps.length - share.get(who)));
  };
  const perAgent = new Map(dids.map((did) => [did, trim(payments.filter((p) => p.didHash === did), 40)]));
  const agentShare = shares(new Map([...perAgent].map(([did, ps]) => [did, ps.length])), 100);
  for (const did of dids) {
    const mine = trim(perAgent.get(did), agentShare.get(did)).map((p) => `${p.chainId ?? ''}:${p.txHash}`).sort();
    assert.deepEqual(a[did].kept, mine, `the fair share of every payment for ${did}`);
  }
  assert.equal(Object.values(a).reduce((n, x) => n + x.kept.length, 0), 100);
});

test('crediting 55,000 payments to one agent, 30,000 of them past its cap, takes well under three seconds', () => {
  const r = inChild(DEFAULT_CAPS, `${HELPERS}
    const did = '0x' + 'aa'.repeat(32);
    const payer = addr(0xbad);
    const started = Date.now();
    for (let i = 0; i < 55_000; i += 1000) {
      s.creditPayments(Array.from({ length: 1000 }, (_, j) => ({ didHash: did, txHash: tx('f0', i + j), amount: '${CENT}', payer, ts: 1_780_000_000_000 + i + j })));
    }
    console.log(JSON.stringify({ ms: Date.now() - started, held: s.getPaymentEvents(did).length }));
  `);
  assert.equal(r.held, 25_000);
  // Copying the whole list for each payment, as the store did, took over five seconds to fill the first 25,000.
  assert.ok(r.ms < 3000, `took ${r.ms} ms`);
});

test("a dropped payment's key is kept, saved, and goes only when pruning would have dropped the payment", () => {
  const r = inChild({ PAYMENT_MAX_EVENTS_PER_AGENT: '1', PAYMENT_MAX_EVENTS_TOTAL: '10' }, `${HELPERS}
    const did = '0x' + 'aa'.repeat(32);
    const payer = addr(1);
    const T = Date.now();
    s.creditPayments([
      { didHash: did, txHash: tx('a1', 1), amount: '${CENT}', payer, ts: T - 100 * ${DAY} },
      { didHash: did, txHash: tx('a1', 2), amount: '50000', payer, ts: T },
    ]);
    const r = { dropped: s.isDropped(tx('a1', 1), did, payer) };
    s.persist();
    s.usedPaymentTxs.clear();
    s.paymentEvents.clear();
    s.load();
    r.reloaded = s.isDropped(tx('a1', 1), did, payer) && s.isCredited(tx('a1', 1), did, payer);
    // At 90 days pruning keeps about 897, so the payment would still be held: its key stays.
    s.prunePaymentEvents(90 * ${DAY}, undefined, T);
    r.keptAt90 = s.isCredited(tx('a1', 1), did, payer);
    // At 10 days it keeps about 99.7, so the payment would have gone: its key goes with it.
    s.prunePaymentEvents(10 * ${DAY}, undefined, T);
    r.at10 = { credited: s.isCredited(tx('a1', 1), did, payer), dropped: s.isDropped(tx('a1', 1), did, payer), events: s.getPaymentEvents(did).length };
    // And it is too old to credit from then on.
    s.setCreditAgeLimit(10 * ${DAY});
    r.again = s.creditPayment(did, tx('a1', 1), '${CENT}', payer, true, T - 100 * ${DAY});
    console.log(JSON.stringify(r));
  `);
  assert.deepEqual(r, { dropped: true, reloaded: true, keptAt90: true, at10: { credited: false, dropped: false, events: 1 }, again: false });
});

test('payments into other agents do not push out an agent\'s payments, and its payer can still record an outcome', () => {
  const r = inChild({ PAYMENT_MAX_EVENTS_PER_AGENT: '5', PAYMENT_MAX_EVENTS_TOTAL: '12' }, `${HELPERS}
    const did = (n) => '0x' + n.toString(16).padStart(64, '0');
    const T0 = 1_780_000_000_000;
    const victim = did(0xaa);
    // A customer's three payments of 5 USDC, with no outcome yet.
    s.creditPayments([0, 1, 2].map((i) => ({ didHash: victim, txHash: tx('a1', i), amount: '5000000', payer: addr(1000 + i), ts: T0 + i })));
    // Then three agents of the attacker's own, each paid 5.01 USDC five times by its own wallets, the money going round.
    const flood = [];
    for (let a = 1; a <= 3; a++) for (let i = 0; i < 5; i++) {
      flood.push({ didHash: did(a), txHash: tx('b' + a, i), amount: '5010000', payer: addr(5000 + a * 10 + i), ts: T0 + 1000 + i });
    }
    s.creditPayments(flood);
    console.log(JSON.stringify({
      victim: s.getPaymentEvents(victim).length,
      flooded: [1, 2, 3].map((a) => s.getPaymentEvents(did(a)).length),
      outcome: s.recordPayerOutcome(victim, tx('a1', 0), addr(1000), false, { outcome: 2 }, { windowMs: 30 * 86_400_000, now: T0 + 5000 }),
      events: s.ledgerStatus().events,
    }));
  `);
  // Before fair shares the flood took the victim's three, the smallest anywhere, and the outcome was refused.
  assert.deepEqual(r, { victim: 3, flooded: [3, 3, 3], outcome: 'set', events: 12 });
});

test('a few wallets paying an agent past its cap push out their own payments, not a customer\'s', () => {
  const r = inChild({ PAYMENT_MAX_EVENTS_PER_AGENT: '10', PAYMENT_MAX_EVENTS_TOTAL: '1000' }, `${HELPERS}
    const agent = '0x' + 'aa'.repeat(32);
    const T0 = 1_780_000_000_000;
    s.creditPayment(agent, tx('c1', 1), '5000000', addr(1000), null, T0);
    // Two of the agent's own wallets, twenty payments each, every one larger than the customer's.
    for (const w of [1, 2]) {
      s.creditPayments(Array.from({ length: 20 }, (_, i) => ({ didHash: agent, txHash: tx('d' + w, i), amount: '6000000', payer: addr(7000 + w), ts: T0 + 100 + i })));
    }
    const held = s.getPaymentEvents(agent);
    console.log(JSON.stringify({
      held: held.length,
      customer: held.some((e) => e.txHash === tx('c1', 1)),
      perWallet: [1, 2].map((w) => held.filter((e) => e.payer === addr(7000 + w)).length),
    }));
  `);
  // The customer's one fits under the level. The two wallets share the other nine, and the odd one goes to the wallet
  // whose next payment ranks higher: the same amount at the same time, so the higher transaction hash, the second's.
  assert.deepEqual(r, { held: 10, customer: true, perWallet: [4, 5] });
});

test('payments with an outcome no longer hold a ledger above its cap: they go after their payer\'s others', () => {
  const r = inChild({ PAYMENT_MAX_EVENTS_PER_AGENT: '5', PAYMENT_MAX_EVENTS_TOTAL: '1000' }, `${HELPERS}
    const agent = '0x' + 'aa'.repeat(32);
    const T0 = 1_780_000_000_000;
    const many = addr(1);
    // One payer: two payments without an outcome, then six with one, all the same amount.
    s.creditPayments([0, 1].map((i) => ({ didHash: agent, txHash: tx('e0', i), amount: '${CENT}', payer: many, ts: T0 + 10 + i })));
    s.creditPayments(Array.from({ length: 6 }, (_, i) => ({ didHash: agent, txHash: tx('e1', i), amount: '${CENT}', payer: many, success: true, ts: T0 + i })));
    // Another payer's one payment.
    s.creditPayment(agent, tx('e2', 0), '${CENT}', addr(2), null, T0);
    const held = s.getPaymentEvents(agent);
    console.log(JSON.stringify({
      held: held.length,
      open: held.filter((e) => e.payer === many && e.success === null).length,
      withOutcome: held.filter((e) => e.success === true).length,
      other: held.some((e) => e.payer === addr(2)),
      ledger: s.ledgerStatus(),
    }));
  `);
  assert.deepEqual(r, {
    held: 5, open: 0, withOutcome: 4, other: true,
    ledger: { events: 5, maxTotal: 1000, maxPerAgent: 5, dropped: 4, withOutcome: 4, droppedWithOutcome: 2, droppedKeys: 4, agentsWithFloor: 0 },
  });
});

test('the dropped keys are bounded too: an agent past its share forgets its oldest and refuses payments that old, through a restart', () => {
  const r = inChild({ PAYMENT_MAX_EVENTS_PER_AGENT: '3', PAYMENT_MAX_EVENTS_TOTAL: '1000' }, `${HELPERS}
    const x = '0x' + 'aa'.repeat(32), y = '0x' + 'bb'.repeat(32);
    const payer = addr(1);
    const T0 = 1_780_000_000_000;
    // Ten to x from one payer, a millisecond apart: x keeps the newest three and drops seven, and of the seven keys
    // keeps the newest three, forgetting the four oldest, the last of them settled at T0 + 3.
    s.creditPayments(Array.from({ length: 10 }, (_, i) => ({ didHash: x, txHash: tx('f0', i), amount: '${CENT}', payer, ts: T0 + i })));
    const r = { held: s.getPaymentEvents(x).map((e) => e.ts - T0), ledger: s.ledgerStatus() };
    r.refused = {
      forgotten: s.creditPayment(x, tx('f0', 0), '${CENT}', payer, null, T0),
      atTheFloor: s.creditPayment(x, tx('f9', 1), '${CENT}', addr(2), null, T0 + 3),
    };
    r.taken = { otherAgent: s.creditPayment(y, tx('f9', 2), '${CENT}', payer, null, T0), afterTheFloor: s.creditPayment(x, tx('f9', 3), '${CENT}', addr(3), null, T0 + 4) };
    s.persist();
    r.version = JSON.parse(require('fs').readFileSync(process.env.ORACLE_STATE_PATH, 'utf8')).schemaVersion;
    s.usedPaymentTxs.clear();
    s.paymentEvents.clear();
    s.load();
    r.reloaded = { refused: s.tooOldToCredit(T0 + 3, undefined, x), keys: s.ledgerStatus().droppedKeys };
    console.log(JSON.stringify(r));
  `);
  assert.deepEqual(r, {
    held: [7, 8, 9],
    ledger: { events: 3, maxTotal: 1000, maxPerAgent: 3, dropped: 7, withOutcome: 0, droppedWithOutcome: 0, droppedKeys: 3, agentsWithFloor: 1 },
    refused: { forgotten: false, atTheFloor: false },
    taken: { otherAgent: true, afterTheFloor: true },
    version: 5,
    // Taking the payment after the floor put x one over its cap again, and its payer over its share, so a fourth key.
    // That made four, and the oldest went too.
    reloaded: { refused: true, keys: 3 },
  });
});

test('past the total cap the dropped keys go by fair share too, from the agents holding the most', () => {
  const r = inChild({ PAYMENT_MAX_EVENTS_PER_AGENT: '100', PAYMENT_MAX_EVENTS_TOTAL: '4' }, `${HELPERS}
    const x = '0x' + 'aa'.repeat(32), y = '0x' + 'bb'.repeat(32);
    const T0 = 1_780_000_000_000;
    s.creditPayments(Array.from({ length: 6 }, (_, i) => ({ didHash: x, txHash: tx('g0', i), amount: '${CENT}', payer: addr(1), ts: T0 + i })));
    s.creditPayments(Array.from({ length: 6 }, (_, i) => ({ didHash: y, txHash: tx('g1', i), amount: '${CENT}', payer: addr(2), ts: T0 + i })));
    const status = s.ledgerStatus();
    console.log(JSON.stringify({ events: status.events, keys: status.droppedKeys, floors: status.agentsWithFloor, x: s.getPaymentEvents(x).length, y: s.getPaymentEvents(y).length }));
  `);
  assert.deepEqual(r, { events: 4, keys: 4, floors: 2, x: 2, y: 2 });
});

// ---- the real oracle, against the stubbed chain ------------------------------------------------------------

const ENV = {
  PAYMENT_VERIFICATION: 'required',
  PAYMENT_ASSET: ASSET,
  PAYMENT_MIN_AMOUNT: CENT,
  ORACLE_ADMIN_TOKEN: 'a'.repeat(64),
};

let oracle;
afterEach(async () => {
  if (oracle) await oracle.stop();
  oracle = null;
});

const evidence = async (o, didHash) => (await o.call('GET', `/evidence/${didHash}`)).body;

test('an agent flooded past its cap through the payment scan is still scored, and keeps its larger payments and outcomes', async () => {
  const world = new World();
  const victim = world.addRegisteredAgent();
  const head = world.data.head;
  const log = (from, value, block, tag) => ({
    address: ASSET,
    topics: [TRANSFER_TOPIC, ethers.zeroPadValue(from, 32), ethers.zeroPadValue(victim.agentAddress, 32)],
    data: ethers.toBeHex(value, 32),
    blockNumber: block,
    transactionHash: ethers.id(tag),
    logIndex: 0,
    removed: false,
  });
  const genuine = [0, 1, 2].map((i) => log(wallet(), 5n * USDC, head - 500 + i, `genuine-${i}`));
  const attacker = wallet();
  const flood = Array.from({ length: 600 }, (_, i) => log(attacker, BigInt(CENT), head - 400 + Math.floor(i / 100), `flood-${i}`));
  world.set('scanLogs', [...genuine, ...flood]);
  // Two one-cent payments with an outcome, older than everything else: a token holder's, and a payer's.
  const tenDaysAgo = (world.data.nowSec - 10 * 86_400) * 1000;
  const credentialed = { txHash: ethers.id('credentialed'), payer: wallet(), amount: CENT, ts: tenDaysAgo, success: false };
  const signed = {
    txHash: ethers.id('signed'),
    payer: wallet(),
    amount: CENT,
    ts: tenDaysAgo,
    success: true,
    payerOutcome: {
      outcome: payerOutcome.DELIVERED,
      evidence: ethers.ZeroHash,
      signedAt: tenDaysAgo / 1000 + 60,
      deadline: tenDaysAgo / 1000 + 3_600,
      signature: `0x${'11'.repeat(65)}`,
      signer: 'eoa',
      checkedAtBlock: head - 900,
      checkedAtMs: tenDaysAgo + 120_000,
      acceptedAt: Date.now() - 1000,
    },
  };
  oracle = await startOracle({
    world,
    env: {
      ...ENV, PAYMENT_SCAN_ENABLED: '1', PAYMENT_SCAN_PACE_MS: '0', PAYMENT_SCAN_FROM_BLOCK: String(head - 1000),
      PAYMENT_MAX_EVENTS_PER_AGENT: '300',
    },
    files: { 'state.json': JSON.stringify({ schemaVersion: 1, paymentEvents: { [victim.didHash]: [credentialed, signed] } }) },
  });
  await oracle.waitForLog(/\[oracle\] epoch done/, 60_000);
  const proposed = oracle.calls().filter((c) => c.name === 'proposeScore' && c.args[0] === victim.didHash).length;
  assert.equal(proposed, 1, 'scored with its ledger full');
  assert.doesNotMatch(oracle.logs(), /ledger is full/);
  assert.match(oracle.logs(), /payment scan \d+-\d+: 603 credited/);
  const body = await evidence(oracle, victim.didHash);
  assert.equal(body.count, 300);
  const held = new Set(body.evidence.map((e) => e.txHash));
  for (const p of [...genuine.map((l) => l.transactionHash), credentialed.txHash, signed.txHash]) assert.ok(held.has(p), p);
  const ledger = (await oracle.call('GET', '/health')).body.paymentLedger;
  assert.equal(ledger.dropped, 603 + 2 - 300);
});

const CHAIN_ID = 5042;
const DOMAIN = payerOutcome.domain(CHAIN_ID, `0x${'33'.repeat(20)}`);
async function signDelivered(didHash, txHash, payer) {
  const now = Math.floor(Date.now() / 1000);
  const value = { payer: payer.address, outcome: payerOutcome.DELIVERED, evidence: ethers.ZeroHash, signedAt: now, deadline: now + 3_600 };
  return { ...value, signature: await payer.signTypedData(DOMAIN, payerOutcome.TYPES, payerOutcome.message(didHash, txHash, value)) };
}

test("a payer's outcome for a payment the cap dropped is refused as payment_dropped, and one for a new payment is taken", async () => {
  const world = new World();
  const agent = world.addAgent();
  oracle = await startOracle({
    world,
    env: { ...ENV, EXPECTED_CHAIN_ID: String(CHAIN_ID), PAYER_OUTCOMES: 'positive', PAYMENT_MAX_EVENTS_PER_AGENT: '2' },
  });
  const pay = (from, value) => world.addTx([{ from: from.address, to: agent.agentAddress, value }]);
  const attest = (txHash) => oracle.call('POST', '/attest', { didHash: agent.didHash, success: true, payment: { txHash } });
  const [p, q, r, s] = [0, 1, 2, 3].map(() => ethers.Wallet.createRandom());
  // Credited without an outcome, as a stranger's attestation or the scan credits them. The third drops the one-cent one.
  const small = pay(p, BigInt(CENT));
  for (const txHash of [small, pay(q, 5n * USDC), pay(r, 5n * USDC)]) {
    const res = await attest(txHash);
    assert.equal(res.status, 200, res.text);
  }
  const late = await oracle.call('POST', '/attest', { didHash: agent.didHash, payment: { txHash: small }, payerOutcome: await signDelivered(agent.didHash, small, p) });
  assert.equal(late.status, 409, late.text);
  assert.equal(late.body.code, 'payment_dropped');
  // A one-cent payment its payer reports on as it is credited is kept with its outcome, however full the ledger.
  const fresh = pay(s, BigInt(CENT));
  const taken = await oracle.call('POST', '/attest', { didHash: agent.didHash, payment: { txHash: fresh }, payerOutcome: await signDelivered(agent.didHash, fresh, s) });
  assert.equal(taken.status, 200, taken.text);
  const body = await evidence(oracle, agent.didHash);
  assert.equal(body.count, 2);
  assert.equal(body.evidence.find((e) => e.txHash === fresh)?.success, true);
  assert.equal((await oracle.call('GET', '/health')).body.paymentLedger.dropped, 2);
});
