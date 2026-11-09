'use strict';

// The ERC-8004 publisher's cycle (publisher.js), against an in-memory chain and feedback registry.
// The rules it applies are tested in publisher-policy.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPublisher } = require('./publisher');

const DAY = 86_400;
const T0 = 20_000 * DAY + 3_600; // an hour into a UTC day
const PUBLISHER = '0x5157000000000000000000000000000000000001';
const DEPLOYER = '0x18CBcE50390f5f6ebe4E20Fc17833F25c8D94811';
const OPERATOR = '0x00000000000000000000000000000000000000a0';
const SIGVARA_AGENT = '897764';
const did = (n) => `0x${n.toString(16).padStart(64, '0')}`;

/**
 * A world with one agent `did(1)` linked on chain to 8004 agent 7, scored 47 (earned 52), and one
 * ReputationUpdated for it at block 100. Change `w` to change the world between runs.
 */
function setup({ mode = 'shadow', agentWallet = PUBLISHER } = {}) {
  const w = {
    head: 120,
    time: T0,
    events: [{ kind: 'updated', didHash: did(1), block: 100, logIndex: 0, txHash: `0x${'cd'.repeat(32)}`, evidenceRoot: `0x${'ef'.repeat(32)}` }],
    operators: { [did(1)]: OPERATOR },
    links: { [did(1)]: '7' },
    spendable: { [did(1)]: 47 },
    earned: { [did(1)]: 52 },
    agentWallet,
    balance: 10n ** 18n,
    pendingTxs: 0,
    covers: true,
    feedback: {}, // agentId -> [{ value, tag1, tag2, isRevoked }], index = position + 1
    sends: [],
    failNext: null, // 'revoke' or 'post': that send throws once and lands nothing
    lateNext: false, // the next post throws, as a timeout does, but lands all the same
  };
  let stored = null;
  const logs = [];
  const deps = {
    cfg: {
      mode, chainId: 5042002, identityRegistry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
      reputation: '0x6603C96275e85F724Cdf74666b399365e4cA29ed', publisher: PUBLISHER, sigvaraAgentId: SIGVARA_AGENT,
      fromBlock: 90, chunkSize: 1000, maxTxsPerRun: 20, allowAgentIds: null, minBalance: 10n ** 17n,
    },
    chain: { getAgentInfo: async (d) => ({ operator: w.operators[d] ?? '0x0000000000000000000000000000000000000000' }) },
    scanner: {
      scan: async () => 0,
      covers: () => w.covers,
      claimedAgentAt: async (d) => w.links[d],
    },
    reads: {
      head: async () => w.head,
      blockTime: async () => w.time,
      reputationEvents: async (from, to) => w.events.filter((e) => e.block >= from && e.block <= to),
      spendable: async (d) => w.spendable[d],
      earned: async (d) => w.earned[d],
      agentWallet: async () => w.agentWallet,
      liveFeedback: async (agentId) => (w.feedback[agentId] ?? [])
        .map((f, i) => ({ index: i + 1, ...f }))
        .filter((f) => !f.isRevoked && f.tag1 === 'sigvara' && f.tag2 === 'score')
        .reverse(),
      balance: async () => w.balance,
      pendingTxs: async () => w.pendingTxs,
    },
    signer: {
      address: async () => PUBLISHER,
      send: async (kind, agentId, args) => {
        w.sends.push({ kind, agentId: String(agentId), args });
        if (w.failNext === kind) { w.failNext = null; throw new Error(`${kind} did not confirm`); }
        const list = (w.feedback[agentId] ??= []);
        const entry = { value: BigInt(args[1]), valueDecimals: 0n, tag1: args[3], tag2: args[4], isRevoked: false };
        if (kind === 'post' && w.lateNext) {
          // Still in the mempool when the publisher stops waiting: it lands when land(w) is called.
          w.lateNext = false;
          w.inFlight = { list, entry };
          w.pendingTxs = 1;
          throw new Error('timeout waiting for the receipt');
        }
        if (kind === 'revoke') list[args[1] - 1].isRevoked = true;
        else list.push(entry);
        return `0x${String(w.sends.length).padStart(64, '0')}`;
      },
    },
    state: { get: () => stored, set: (s) => { stored = s; }, persist: () => {} },
    log: (line) => logs.push(line),
  };
  return { w, publisher: createPublisher(deps), state: () => stored, logs, deps };
}

const liveValues = (w, agentId) => (w.feedback[agentId] ?? []).filter((f) => !f.isRevoked).map((f) => f.value);
const kinds = (w) => w.sends.map((s) => s.kind);
const nextDay = (w, head) => { w.time += DAY; w.head = head; };

test('shadow mode: works out the post and sends nothing, even with every gate passing', async () => {
  const { w, publisher, state, logs, deps } = setup();
  deps.signer.send = async () => { throw new Error('shadow mode must not send'); };
  const r = await publisher.runOnce();
  assert.deepEqual(w.sends, []);
  assert.deepEqual(r.blocked, [], 'every gate passes, and still nothing is sent');
  assert.equal(r.planned.length, 1);
  assert.deepEqual(
    { agentId: r.planned[0].agentId, value: r.planned[0].value, earned: r.planned[0].earned, revokes: r.planned[0].revokes },
    { agentId: '7', value: 47, earned: 52, revokes: 0 },
  );
  assert.deepEqual(state().pending, {}, 'a shadow run does not hold the agent for the next one');
  assert.ok(logs.some((l) => /shadow: agent 7 ← 47/.test(l)));
});

test('shadow mode: says what would stop live mode', async () => {
  const { publisher } = setup({ agentWallet: DEPLOYER });
  const r = await publisher.runOnce();
  assert.match(r.blocked.join(), /agentWallet is 0x18CB.*not the publisher/);
});

test('shadow mode: follows the daily limit and the unchanged rule live mode would', async () => {
  const { w, publisher } = setup();
  await publisher.runOnce();
  w.head = 140;
  w.events.push({ kind: 'updated', didHash: did(1), block: 130, logIndex: 0, txHash: null });
  const r = await publisher.runOnce();
  assert.equal(r.planned.length, 0, 'already "posted" today');
  nextDay(w, 160);
  const r2 = await publisher.runOnce();
  assert.match(r2.skipped[0].reason, /unchanged at 47/);
});

test('agents not linked on chain, and Sigvara\'s own registration however its id is written, get nothing', async () => {
  const { w, publisher, deps } = setup({ mode: 'live' });
  deps.cfg.sigvaraAgentId = '0897764';
  w.events.push({ kind: 'updated', didHash: did(2), block: 101, logIndex: 0, txHash: null });
  w.events.push({ kind: 'updated', didHash: did(3), block: 102, logIndex: 0, txHash: null });
  w.operators[did(2)] = OPERATOR;
  w.operators[did(3)] = OPERATOR;
  w.links[did(3)] = 897764n;
  const r = await publisher.runOnce();
  assert.deepEqual(r.skipped.map((s) => s.reason).sort(), ["Sigvara's own registration", 'not linked on chain']);
  assert.deepEqual(w.sends.map((s) => s.agentId), ['7']);
});

test('live mode: nothing is sent while a gate fails, and the agent waits for it', async () => {
  const { w, publisher, state } = setup({ mode: 'live', agentWallet: DEPLOYER });
  const r = await publisher.runOnce();
  assert.deepEqual(w.sends, []);
  assert.ok(r.blocked.length);
  assert.ok(state().pending[did(1)], 'still pending');

  w.agentWallet = PUBLISHER;
  const r2 = await publisher.runOnce();
  assert.deepEqual(r2.blocked, []);
  assert.deepEqual(kinds(w), ['post']);
  assert.equal(w.sends[0].args[1], 47);
  assert.deepEqual([w.sends[0].args[3], w.sends[0].args[4]], ['sigvara', 'score']);
  assert.match(w.sends[0].args[6], /^data:application\/json;base64,/);
});

test('live mode: switching from shadow reads every agent again at once', async () => {
  const { w, publisher, deps } = setup();
  await publisher.runOnce(); // shadow, which evaluates and lets go of the agent
  deps.cfg.mode = 'live';
  await publisher.runOnce();
  assert.deepEqual(kinds(w), ['post'], 'the first live run posts, without waiting for tomorrow');
});

test('live mode: a new score revokes the old one first, so one Sigvara score stays live, and history is kept', async () => {
  const { w, publisher } = setup({ mode: 'live' });
  await publisher.runOnce();
  nextDay(w, 200);
  w.spendable[did(1)] = 55;
  w.events.push({ kind: 'updated', didHash: did(1), block: 150, logIndex: 0, txHash: null });
  await publisher.runOnce();
  assert.deepEqual(kinds(w), ['post', 'revoke', 'post']);
  assert.deepEqual(w.sends[1].args, ['7', 1]);
  assert.equal(w.feedback['7'].length, 2, 'the revoked feedback is still there');
  assert.deepEqual(liveValues(w, '7'), [55n]);
});

test('live mode: an unchanged score is not posted again', async () => {
  const { w, publisher } = setup({ mode: 'live' });
  await publisher.runOnce();
  nextDay(w, 120);
  const r = await publisher.runOnce();
  assert.deepEqual(kinds(w), ['post']);
  assert.match(r.skipped[0].reason, /unchanged at 47/);
});

test('live mode: at most one post per agent per UTC day, and the change goes out the next day', async () => {
  const { w, publisher, state } = setup({ mode: 'live' });
  await publisher.runOnce();
  w.head = 140;
  w.spendable[did(1)] = 60;
  w.events.push({ kind: 'updated', didHash: did(1), block: 130, logIndex: 0, txHash: null });
  await publisher.runOnce();
  assert.deepEqual(kinds(w), ['post'], 'held until tomorrow');
  assert.ok(state().pending[did(1)]);
  nextDay(w, 160);
  await publisher.runOnce();
  assert.deepEqual(kinds(w), ['post', 'revoke', 'post']);
  assert.equal(w.sends[2].args[1], 60);
});

test('live mode: a zero after a slash goes out at once, past the daily limit', async () => {
  const { w, publisher } = setup({ mode: 'live' });
  await publisher.runOnce();
  w.head = 140;
  w.spendable[did(1)] = 0;
  w.earned[did(1)] = 0;
  w.events.push({ kind: 'zeroed', didHash: did(1), block: 135, logIndex: 0, txHash: null });
  await publisher.runOnce();
  assert.deepEqual(kinds(w), ['post', 'revoke', 'post']);
  assert.equal(w.sends[2].args[1], 0);
});

test('live mode: a revoke that lands without its post is finished by the retry, without revoking twice', async () => {
  const { w, publisher, state } = setup({ mode: 'live' });
  await publisher.runOnce();
  nextDay(w, 140);
  w.spendable[did(1)] = 55;
  w.events.push({ kind: 'updated', didHash: did(1), block: 130, logIndex: 0, txHash: null });
  w.failNext = 'post';
  await publisher.runOnce();
  assert.deepEqual(kinds(w), ['post', 'revoke', 'post']);
  assert.ok(state().pending[did(1)], 'left pending after the failed post');
  assert.deepEqual(liveValues(w, '7'), [], 'for now the agent shows no Sigvara feedback, the safe direction');
  await publisher.runOnce();
  assert.deepEqual(kinds(w), ['post', 'revoke', 'post', 'post']);
  assert.deepEqual(liveValues(w, '7'), [55n]);
});

test('live mode: a post that times out but lands later is not posted again', async () => {
  const { w, publisher } = setup({ mode: 'live' });
  w.lateNext = true;
  await publisher.runOnce();
  // While it is still in flight, nothing more is sent: without the gate, this run posts again and
  // both posts land.
  const r = await publisher.runOnce();
  assert.match(r.blocked.join(), /1 transaction\(s\) from the publisher are still pending/);
  assert.deepEqual(kinds(w), ['post'], 'no second post while the first is in flight');
  // It lands, and reads as live with the same value.
  w.inFlight.list.push(w.inFlight.entry);
  w.pendingTxs = 0;
  await publisher.runOnce();
  assert.deepEqual(kinds(w), ['post']);
  assert.deepEqual(liveValues(w, '7'), [47n]);
});

test('live mode: an unlinked agent\'s cleanup leaves alone a score posted there since for another agent', async () => {
  // 8004 agent 7 was X's and is now Y's (the same operator re-pointed it, or sold it). Y's update
  // runs first and replaces X's score; X's cleanup must not then revoke, or zero, Y's.
  for (const xKind of ['refresh', 'zeroed']) {
    const { w, publisher } = setup({ mode: 'live' });
    await publisher.runOnce(); // X (did 1) posted 47 on 7
    delete w.links[did(1)];
    w.operators[did(4)] = OPERATOR;
    w.links[did(4)] = '7';
    w.spendable[did(4)] = 30;
    w.earned[did(4)] = 30;
    nextDay(w, 200);
    w.events.push({ kind: 'updated', didHash: did(4), block: 150, logIndex: 0, txHash: null });
    if (xKind === 'zeroed') {
      w.spendable[did(1)] = 0;
      w.earned[did(1)] = 0;
      w.events.push({ kind: 'zeroed', didHash: did(1), block: 160, logIndex: 0, txHash: null });
    }
    await publisher.runOnce();
    assert.deepEqual(liveValues(w, '7'), [30n], xKind);
    assert.deepEqual(w.sends.map((s) => `${s.kind} ${s.agentId}`), ['post 7', 'revoke 7', 'post 7'], xKind);
  }
});

test('live mode: a blocked run keeps every pending update, and posts them once the gate passes', async () => {
  const { w, publisher, deps, state } = setup({ agentWallet: DEPLOYER });
  await publisher.runOnce(); // shadow: would post 47
  deps.cfg.mode = 'live';
  nextDay(w, 160);
  await publisher.runOnce(); // live, blocked: the agentWallet is not the publisher yet
  assert.deepEqual(w.sends, []);
  assert.ok(state().pending[did(1)], 'kept, though shadow mode had "posted" the same value');
  w.agentWallet = PUBLISHER;
  await publisher.runOnce();
  assert.deepEqual(kinds(w), ['post']);
  assert.deepEqual(liveValues(w, '7'), [47n]);
});

test('live mode: two live Sigvara scores on one agent are both revoked at the next change', async () => {
  const { w, publisher } = setup({ mode: 'live' });
  w.feedback['7'] = [
    { value: 55n, valueDecimals: 0n, tag1: 'sigvara', tag2: 'score', isRevoked: false },
    { value: 55n, valueDecimals: 0n, tag1: 'sigvara', tag2: 'score', isRevoked: false },
  ];
  await publisher.runOnce(); // the score is 47 now
  assert.deepEqual(kinds(w), ['revoke', 'revoke', 'post']);
  assert.deepEqual(liveValues(w, '7'), [47n]);
});

test('live mode: an agent that unlinks has its score revoked where it was posted', async () => {
  const { w, publisher } = setup({ mode: 'live' });
  await publisher.runOnce();
  delete w.links[did(1)]; // the key cleared, or the NFT moved
  nextDay(w, 160);
  const r = await publisher.runOnce();
  assert.deepEqual(kinds(w), ['post', 'revoke']);
  assert.deepEqual(liveValues(w, '7'), []);
  assert.equal(r.skipped[0].reason, 'not linked on chain');
});

test('live mode: an agent that unlinks and is then slashed reads 0 where its score was posted', async () => {
  // Clearing the key must not keep a slashed score up on the old 8004 agent.
  const { w, publisher } = setup({ mode: 'live' });
  await publisher.runOnce();
  delete w.links[did(1)];
  w.head = 140;
  w.spendable[did(1)] = 0;
  w.earned[did(1)] = 0;
  w.events.push({ kind: 'zeroed', didHash: did(1), block: 135, logIndex: 0, txHash: null });
  await publisher.runOnce();
  assert.deepEqual(kinds(w), ['post', 'revoke', 'post']);
  assert.equal(w.sends[2].agentId, '7');
  assert.deepEqual(liveValues(w, '7'), [0n]);
});

const land = (w) => { w.inFlight.list.push(w.inFlight.entry); w.pendingTxs = 0; };
const slash = (w, block) => {
  w.head = block + 5;
  w.spendable[did(1)] = 0;
  w.earned[did(1)] = 0;
  w.events.push({ kind: 'zeroed', didHash: did(1), block, logIndex: 0, txHash: null });
};

// A live run with a gate failing (the signer tunnel down, a pending transaction, a low balance) sends
// nothing and keeps what it owes. It kept a linked agent's update, but dropped an unlinked agent's
// cleanup, so the old 8004 agent kept the score until the next day, and a slashed one then got a revoke
// instead of the 0 it is owed.
test('live mode: a blocked run keeps an unlinked agent\'s cleanup, and revokes once the gate passes', async () => {
  const { w, publisher } = setup({ mode: 'live' });
  await publisher.runOnce();
  delete w.links[did(1)];
  nextDay(w, 160);
  w.agentWallet = DEPLOYER;
  await publisher.runOnce(); // blocked: the revoke is planned, not sent
  assert.deepEqual(kinds(w), ['post']);
  w.agentWallet = PUBLISHER;
  w.head = 170;
  await publisher.runOnce();
  assert.deepEqual(kinds(w), ['post', 'revoke']);
  assert.deepEqual(liveValues(w, '7'), []);
});

test('live mode: a blocked run keeps an unlinked, slashed agent\'s zero, and posts it once the gate passes', async () => {
  const { w, publisher } = setup({ mode: 'live' });
  await publisher.runOnce();
  delete w.links[did(1)];
  slash(w, 135);
  w.agentWallet = DEPLOYER;
  await publisher.runOnce(); // blocked
  assert.deepEqual(kinds(w), ['post']);
  w.agentWallet = PUBLISHER;
  await publisher.runOnce();
  assert.deepEqual(kinds(w), ['post', 'revoke', 'post']);
  assert.deepEqual(liveValues(w, '7'), [0n]);
});

test('live mode: a post that timed out and landed is cleaned up after an unlink and a slash', async () => {
  // The run after it finds the score live and unchanged, and used to record nothing, so the cleanup
  // never knew where to go: the old 8004 agent kept the last positive score of a slashed agent.
  const { w, publisher } = setup({ mode: 'live' });
  w.lateNext = true;
  await publisher.runOnce();
  land(w);
  const unchanged = await publisher.runOnce();
  assert.equal(unchanged.skipped[0].reason, 'unchanged at 47');
  delete w.links[did(1)];
  slash(w, 135);
  await publisher.runOnce();
  assert.deepEqual(liveValues(w, '7'), [0n]);
});

test('live mode: a post that timed out is still cleaned up when the agent unlinks before the next run', async () => {
  const { w, publisher } = setup({ mode: 'live' });
  w.lateNext = true;
  await publisher.runOnce();
  land(w);
  delete w.links[did(1)];
  slash(w, 135);
  await publisher.runOnce();
  assert.deepEqual(liveValues(w, '7'), [0n]);
});

test('live mode: a post that timed out, then an unlink with no slash, has the score revoked', async () => {
  const { w, publisher } = setup({ mode: 'live' });
  w.lateNext = true;
  await publisher.runOnce();
  land(w);
  delete w.links[did(1)];
  nextDay(w, 160);
  await publisher.runOnce();
  assert.deepEqual(liveValues(w, '7'), []);
});

test('live mode: a post that failed and never landed leaves nothing to revoke, and is tried again', async () => {
  const { w, publisher } = setup({ mode: 'live' });
  w.failNext = 'post';
  await publisher.runOnce();
  assert.deepEqual(liveValues(w, '7'), []);
  await publisher.runOnce();
  assert.deepEqual(kinds(w), ['post', 'post'], 'the failed post does not start the day\'s limit');
  assert.deepEqual(liveValues(w, '7'), [47n]);
});

test('live mode: a lost state file is rebuilt from what is live, so the cleanup still works', async () => {
  const { w, publisher, deps } = setup({ mode: 'live' });
  await publisher.runOnce();
  deps.state.set(null);
  await publisher.runOnce();
  assert.deepEqual(kinds(w), ['post'], 'it finds the score there and posts nothing');
  delete w.links[did(1)];
  slash(w, 135);
  await publisher.runOnce();
  assert.deepEqual(liveValues(w, '7'), [0n]);
});

test('live mode: a score found unchanged does not start a new day\'s limit', async () => {
  const { w, publisher, state } = setup({ mode: 'live' });
  await publisher.runOnce();
  const day = state().posted['7'].day;
  nextDay(w, 120);
  await publisher.runOnce(); // the daily refresh, which finds it unchanged
  assert.equal(state().posted['7'].day, day);
  assert.equal(state().postedBy[did(1)], '7');
});

test('live mode: a score found live with no record may still change the same day', async () => {
  const { w, publisher, deps, state } = setup({ mode: 'live' });
  await publisher.runOnce();
  deps.state.set(null);
  await publisher.runOnce();
  assert.equal(state().posted['7'].day, undefined, 'nothing says what day it was posted');
  w.spendable[did(1)] = 49;
  w.events.push({ kind: 'updated', didHash: did(1), block: 121, logIndex: 0, txHash: null, evidenceRoot: null });
  w.head = 125;
  await publisher.runOnce();
  assert.deepEqual(liveValues(w, '7'), [49n]);
});

test('live mode: a blocked run records nothing it finds', async () => {
  const { w, publisher, deps, state } = setup({ mode: 'live' });
  await publisher.runOnce();
  deps.state.set(null);
  w.balance = 0n;
  await publisher.runOnce();
  assert.equal(state().postedBy[did(1)], undefined);
  assert.equal(state().posted['7'], undefined);
});

test('shadow mode: finding a score live writes nothing to the real records', async () => {
  const { w, publisher, state } = setup({ mode: 'shadow' });
  w.feedback['7'] = [{ value: 47n, valueDecimals: 0n, tag1: 'sigvara', tag2: 'score', isRevoked: false }];
  await publisher.runOnce();
  assert.deepEqual(state().posted, {});
  assert.deepEqual(state().postedBy, {});
});

test('live mode: an agent that moves to another 8004 agent has its score moved with it', async () => {
  const { w, publisher } = setup({ mode: 'live' });
  await publisher.runOnce();
  w.links[did(1)] = '9';
  nextDay(w, 160);
  await publisher.runOnce();
  assert.deepEqual(w.sends.map((s) => `${s.kind} ${s.agentId}`), ['post 7', 'revoke 7', 'post 9']);
  assert.deepEqual(liveValues(w, '7'), []);
  assert.deepEqual(liveValues(w, '9'), [47n]);
});

test('the daily refresh reads every scored agent again, since maturity moves the score with no event', async () => {
  const { w, publisher } = setup({ mode: 'live' });
  await publisher.runOnce();
  nextDay(w, 120);
  w.spendable[did(1)] = 49; // a rise released overnight, no event
  await publisher.runOnce();
  assert.deepEqual(kinds(w), ['post', 'revoke', 'post']);
  assert.equal(w.sends[2].args[1], 49);
});

test('an agent linked during the day is posted at the next run, not at the next daily refresh', async () => {
  const { w, publisher, deps } = setup({ mode: 'live' });
  delete w.links[did(1)];
  const r = await publisher.runOnce();
  assert.equal(r.skipped[0].reason, 'not linked on chain');

  // Later the same UTC day, the scan finds its link, and one for a registered agent never scored,
  // which reads 0 and must not be posted as if it had been slashed.
  w.head = 140;
  w.links[did(1)] = '7';
  w.links[did(9)] = '9';
  w.operators[did(9)] = OPERATOR;
  w.spendable[did(9)] = 0;
  w.earned[did(9)] = 0;
  deps.scanner.scan = async ({ onClaim }) => {
    onClaim({ didHash: did(1), agentId: '7', block: 130, logIndex: 0 });
    onClaim({ didHash: did(9), agentId: '9', block: 131, logIndex: 0 });
    return 2;
  };
  const r2 = await publisher.runOnce();
  assert.deepEqual(r2.sent.map((s) => [s.agentId, s.value, s.reason]), [['7', 47, 'linked']]);
  assert.deepEqual(liveValues(w, '9'), [], 'an agent with no score has nothing to post');
  const file = JSON.parse(Buffer.from(w.sends[0].args[6].split(',')[1], 'base64').toString('utf8'));
  assert.equal(file.sigvara.event, null, 'a link is not a score event');
});

test('a first link found while a slash is pending leaves the slash to go out, with its event', async () => {
  const { w, publisher, deps, state } = setup({ mode: 'live' });
  delete w.links[did(1)];
  await publisher.runOnce();
  // Slashed while unlinked, in a run whose link scan is behind, so the zero waits.
  w.head = 140;
  w.spendable[did(1)] = 0;
  w.earned[did(1)] = 0;
  w.events.push({ kind: 'zeroed', didHash: did(1), block: 135, logIndex: 0, txHash: `0x${'ab'.repeat(32)}` });
  w.covers = false;
  await publisher.runOnce();
  assert.equal(state().pending[did(1)].kind, 'zeroed');
  // Then its first link is found.
  w.covers = true;
  w.links[did(1)] = '7';
  deps.scanner.scan = async ({ onClaim }) => { onClaim({ didHash: did(1), agentId: '7', block: 138, logIndex: 0 }); return 1; };
  await publisher.runOnce();
  assert.deepEqual(w.sends.map((s) => [s.kind, s.args[1]]), [['post', 0]]);
  const file = JSON.parse(Buffer.from(w.sends[0].args[6].split(',')[1], 'base64').toString('utf8'));
  assert.equal(file.sigvara.event.kind, 'zeroed', 'the slash, not the link, is why it was posted');
});

test('a link that moves to another 8004 agent waits for the daily refresh', async () => {
  const { w, publisher, deps } = setup({ mode: 'live' });
  await publisher.runOnce();
  w.head = 140;
  w.links[did(1)] = '8';
  deps.scanner.scan = async ({ onClaim }) => { onClaim({ didHash: did(1), agentId: '8', block: 130, logIndex: 0 }); return 1; };
  await publisher.runOnce();
  assert.deepEqual(kinds(w), ['post'], 'not a first link: nothing is sent for it today');
  deps.scanner.scan = async () => 0;
  nextDay(w, 160);
  await publisher.runOnce();
  assert.deepEqual(w.sends.map((s) => `${s.kind} ${s.agentId}`), ['post 7', 'revoke 7', 'post 8']);
});

test('a link found is saved before the run reads anything else', async () => {
  const { w, publisher, deps } = setup({ mode: 'live' });
  // A store that keeps copies, as the state file does, so a run that fails keeps only what it saved.
  let saved = null;
  deps.state.get = () => (saved ? JSON.parse(saved) : null);
  deps.state.set = (s) => { saved = JSON.stringify(s); };
  const state = () => JSON.parse(saved);
  delete w.links[did(1)];
  await publisher.runOnce();
  w.head = 140;
  w.links[did(1)] = '7';
  deps.scanner.scan = async ({ onClaim }) => { onClaim({ didHash: did(1), agentId: '7', block: 130, logIndex: 0 }); return 1; };
  deps.reads.reputationEvents = async () => { throw new Error('the node did not answer'); };
  await assert.rejects(publisher.runOnce());
  assert.equal(state().pending[did(1)]?.kind, 'linked', 'kept for the next run, though this one failed');
});

test('a link scan short of the read block posts nothing, and keeps the agent for next run', async () => {
  const { w, publisher, state, logs } = setup({ mode: 'live' });
  w.covers = false;
  await publisher.runOnce();
  assert.deepEqual(w.sends, []);
  assert.ok(state().pending[did(1)]);
  assert.ok(logs.some((l) => /link scan has not reached block 120/.test(l)));
});

test('PUBLISH_ALLOW_AGENT_IDS limits a first cycle to the agents named', async () => {
  const { w, publisher, deps } = setup({ mode: 'live' });
  deps.cfg.allowAgentIds = new Set(['8']);
  const r = await publisher.runOnce();
  assert.deepEqual(w.sends, []);
  assert.equal(r.skipped[0].reason, 'not on PUBLISH_ALLOW_AGENT_IDS');
});

// Two more agents linked to 8004 agents 8 and 9, scored 30, with events at blocks 101 and 102.
function addAgents(w) {
  for (const [n, id] of [[2, '8'], [3, '9']]) {
    w.events.push({ kind: 'updated', didHash: did(n), block: 99 + n, logIndex: 0, txHash: null });
    w.operators[did(n)] = OPERATOR;
    w.links[did(n)] = id;
    w.spendable[did(n)] = 30;
    w.earned[did(n)] = 30;
  }
}

test('the transactions per run are capped, revokes included', async () => {
  const { w, publisher, deps, state } = setup({ mode: 'live' });
  w.feedback['7'] = [{ value: 40n, valueDecimals: 0n, tag1: 'sigvara', tag2: 'score', isRevoked: false }];
  deps.cfg.maxTxsPerRun = 2;
  addAgents(w);
  await publisher.runOnce();
  assert.deepEqual(w.sends.map((s) => `${s.kind} ${s.agentId}`), ['revoke 7', 'post 7'], 'a revoke counts as one');
  assert.ok(state().pending[did(2)], 'the rest wait for the next run');
});

test('a failed send stops the run, before the next agent\'s revoke goes out', async () => {
  const { w, publisher, state } = setup({ mode: 'live' });
  addAgents(w);
  w.failNext = 'post';
  await publisher.runOnce();
  assert.deepEqual(kinds(w), ['post']);
  assert.ok(state().pending[did(1)] && state().pending[did(2)] && state().pending[did(3)]);
});

test('a balance that falls below the floor mid-run stops it', async () => {
  const { w, publisher, deps, state } = setup({ mode: 'live' });
  addAgents(w);
  let reads = 0;
  deps.reads.balance = async () => (++reads > 2 ? 0n : 10n ** 18n); // the gate, the first post, then empty
  await publisher.runOnce();
  assert.deepEqual(w.sends.map((s) => s.agentId), ['7']);
  assert.ok(state().pending[did(2)]);
});

// ---- the remote signer and the settings ----------------------------------------

const http = require('http');
const { ethers } = require('ethers');
const { remoteSigner, readConfig } = require('./publisher');

const REGISTRY = '0x8004B663056A597Dffe9eCcC1965A193B7388713';
const SECRET = 'ab'.repeat(32);

/**
 * A JSON-RPC signer on a local port, signing with a throwaway key. `tamper` changes the transaction
 * before it is signed, as a compromised or misconfigured signer might.
 */
async function fakeSigner({ tamper = null } = {}) {
  const key = ethers.Wallet.createRandom();
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const { id, method, params } = JSON.parse(body);
    let result;
    if (method === 'eth_accounts') result = [key.address.toLowerCase()];
    if (method === 'eth_signTransaction') {
      const t = { ...params[0] };
      delete t.from;
      if (tamper) Object.assign(t, tamper);
      const tx = { to: t.to, data: t.data, nonce: Number(t.nonce), gasLimit: BigInt(t.gas), chainId: BigInt(t.chainId), value: BigInt(t.value ?? 0) };
      if (Number(t.type ?? 2) === 0) Object.assign(tx, { type: 0, gasPrice: BigInt(t.maxFeePerGas) });
      else Object.assign(tx, { type: 2, maxFeePerGas: BigInt(t.maxFeePerGas), maxPriorityFeePerGas: BigInt(t.maxPriorityFeePerGas) });
      result = await key.signTransaction(tx);
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, address: key.address, close: () => new Promise((r) => server.close(r)) };
}

function fakeProvider({ maxFeePerGas = 20n * 10n ** 9n } = {}) {
  const broadcast = [];
  return {
    broadcast,
    getFeeData: async () => ({ maxFeePerGas, maxPriorityFeePerGas: 10n ** 9n, gasPrice: maxFeePerGas }),
    estimateGas: async () => 150_000n,
    getTransactionCount: async () => 4,
    broadcastTransaction: async (raw) => { broadcast.push(raw); return { hash: ethers.Transaction.from(raw).hash }; },
    getTransactionReceipt: async () => ({ status: 1 }),
  };
}

// waitForTransaction counts a confirmation only once it has seen a block after the transaction's, so a post
// that had landed, read before the next block, timed out and was reported as not confirmed. The keeper polls
// for the receipt for that reason, and the publisher now does the same.
test('remoteSigner: a receipt is enough, without waiting for a block after it', async () => {
  const s = await fakeSigner();
  try {
    let reads = 0;
    const provider = {
      ...fakeProvider(),
      waitForTransaction: async () => { throw new Error('timeout'); },
      // Not there on the first read, and a read that fails says nothing either way.
      getTransactionReceipt: async () => {
        reads += 1;
        if (reads === 1) return null;
        if (reads === 2) throw new Error('rate limit exceeded');
        return { status: 1 };
      },
    };
    const signer = remoteSigner({ url: s.url, secret: SECRET, publisher: s.address, provider, chainId: 5042002, to: REGISTRY, maxFeeWei: 50n * 10n ** 9n, maxGas: 400_000n, pollMs: 1 });
    const hash = await signer.send('revoke', 7, [7, 1]);
    assert.equal(hash, ethers.Transaction.from(provider.broadcast[0]).hash);
    assert.equal(reads, 3);
  } finally {
    await s.close();
  }
});

test('remoteSigner: a reverted post, and one with no receipt in time, name the transaction', async () => {
  const s = await fakeSigner();
  try {
    for (const [receipt, words] of [[{ status: 0 }, /revoke 0x[0-9a-f]{64} reverted/], [null, /revoke 0x[0-9a-f]{64} was sent, with no receipt.*Check it before assuming it failed/]]) {
      const provider = { ...fakeProvider(), getTransactionReceipt: async () => receipt };
      const signer = remoteSigner({ url: s.url, secret: SECRET, publisher: s.address, provider, chainId: 5042002, to: REGISTRY, maxFeeWei: 50n * 10n ** 9n, maxGas: 400_000n, waitMs: 20, pollMs: 1 });
      await assert.rejects(signer.send('revoke', 7, [7, 1]), words);
    }
  } finally {
    await s.close();
  }
});

// fs.writeSync may write less than it is given, and the state file was written with one call.
test('fileState: a write the system takes in pieces still lands whole', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { fileState } = require('./publisher');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sigvara-filestate-'));
  const real = fs.writeSync;
  // At most 7 bytes a call.
  fs.writeSync = (fd, data, ...rest) => {
    if (typeof data === 'string') return real(fd, data.slice(0, 7));
    const [offset = 0, length = data.length - offset] = rest;
    return real(fd, data, offset, Math.min(length, 7));
  };
  try {
    const file = path.join(dir, 'state.json');
    const value = { scanBlock: 12_345, open: { [did(1)]: true }, note: 'é'.repeat(40) };
    const s = fileState(file);
    s.set(value);
    s.persist();
    fs.writeSync = real;
    assert.deepEqual(fileState(file).get(), value);
  } finally {
    fs.writeSync = real;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('remoteSigner: signs through the remote signer, checks what came back, and broadcasts it', async () => {
  const s = await fakeSigner();
  try {
    const provider = fakeProvider();
    const signer = remoteSigner({ url: s.url, secret: SECRET, publisher: s.address, provider, chainId: 5042002, to: REGISTRY, maxFeeWei: 50n * 10n ** 9n, maxGas: 400_000n });
    assert.equal(await signer.address(), s.address);
    const hash = await signer.send('revoke', 7, [7, 1]);
    assert.equal(provider.broadcast.length, 1);
    const sent = ethers.Transaction.from(provider.broadcast[0]);
    assert.equal(sent.from, s.address);
    assert.equal(sent.to, REGISTRY);
    assert.equal(sent.nonce, 4);
    assert.equal(sent.gasLimit, 180_000n, 'the estimate plus a fifth');
    assert.equal(hash, sent.hash);
  } finally {
    await s.close();
  }
});

test('remoteSigner: a fee above PUBLISH_MAX_FEE_GWEI is not sent', async () => {
  const s = await fakeSigner();
  try {
    const provider = fakeProvider({ maxFeePerGas: 80n * 10n ** 9n });
    const signer = remoteSigner({ url: s.url, secret: SECRET, publisher: s.address, provider, chainId: 5042002, to: REGISTRY, maxFeeWei: 50n * 10n ** 9n, maxGas: 400_000n });
    await assert.rejects(signer.send('revoke', 7, [7, 1]), /above PUBLISH_MAX_FEE_GWEI/);
    assert.equal(provider.broadcast.length, 0);
  } finally {
    await s.close();
  }
});

test('remoteSigner: a signed transaction other than the one asked for is not sent', async () => {
  // Another contract, value attached, more gas, a far higher fee, or a legacy transaction: each is
  // a signature the publisher did not ask for, and none of them is broadcast.
  for (const tamper of [
    { to: '0x0000000000000000000000000000000000000bad' },
    { value: '0xde0b6b3a7640000' },
    { gas: '0x1c9c380' },
    { maxFeePerGas: '0x5af3107a4000', maxPriorityFeePerGas: '0x5af3107a4000' },
    { type: '0x0' },
  ]) {
    const s = await fakeSigner({ tamper });
    try {
      const provider = fakeProvider();
      const signer = remoteSigner({ url: s.url, secret: SECRET, publisher: s.address, provider, chainId: 5042002, to: REGISTRY, maxFeeWei: 50n * 10n ** 9n, maxGas: 400_000n });
      await assert.rejects(signer.send('revoke', 7, [7, 1]), /other than the one asked for/, JSON.stringify(tamper));
      assert.equal(provider.broadcast.length, 0, JSON.stringify(tamper));
    } finally {
      await s.close();
    }
  }
});

test('remoteSigner: a signer that does not answer reads as no address', async () => {
  const signer = remoteSigner({ url: 'http://127.0.0.1:9', secret: SECRET, publisher: PUBLISHER, provider: fakeProvider(), chainId: 1, to: REGISTRY, maxFeeWei: 1n, maxGas: 1n });
  assert.equal(await signer.address(), null);
});

test('readConfig: shadow mode needs no key, signer or publisher address; live mode needs all three', () => {
  const base = {
    RPC_URL: 'https://rpc.example', IDENTITY_ADDRESS: '0x7e3aFC532eE5d922ab3cc3FFb510c7C8151477Dd',
    REPUTATION_ADDRESS: '0x6603C96275e85F724Cdf74666b399365e4cA29ed', EXTERNAL_IDENTITY_ADDRESS: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    EXTERNAL_REPUTATION_ADDRESS: REGISTRY, EXTERNAL_LINK_FROM_BLOCK: '70565000', PUBLISH_FROM_BLOCK: '70567000', SIGVARA_ERC8004_AGENT_ID: '897764',
  };
  const shadow = readConfig(base);
  assert.equal(shadow.mode, 'shadow');
  assert.equal(shadow.publisher, ethers.ZeroAddress);
  assert.equal(shadow.signerUrl, '');
  assert.throws(() => readConfig({ ...base, PUBLISH_MODE: 'live' }), /PUBLISHER_ADDRESS is required/);
  assert.throws(() => readConfig({ ...base, PUBLISH_MODE: 'live', PUBLISHER_ADDRESS: PUBLISHER }), /PUBLISH_SIGNER_URL is required/);
  assert.throws(() => readConfig({ ...base, PUBLISH_MODE: 'live', PUBLISHER_ADDRESS: PUBLISHER, PUBLISH_SIGNER_URL: 'https://signer.internal' }), /PUBLISH_SIGNER_SECRET is required/);
  const live = { ...base, PUBLISH_MODE: 'live', PUBLISHER_ADDRESS: PUBLISHER, PUBLISH_SIGNER_URL: 'https://signer.internal', PUBLISH_SIGNER_SECRET: SECRET };
  assert.throws(() => readConfig(live), /PUBLISH_MAX_FEE_GWEI is required/);
  const liveCfg = readConfig({ ...live, PUBLISH_MAX_FEE_GWEI: '50' });
  assert.equal(liveCfg.maxFeeWei, 50n * 10n ** 9n);
  assert.equal(liveCfg.signerSecret, SECRET);
  assert.throws(() => readConfig({ ...base, PUBLISH_MODE: 'loud' }), /shadow or live/);
  assert.throws(() => readConfig({ ...base, EXTERNAL_LINK_FROM_BLOCK: '' }), /EXTERNAL_LINK_FROM_BLOCK is required/);
});
