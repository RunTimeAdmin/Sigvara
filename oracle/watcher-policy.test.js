'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { classifyDivergence, alertKey, checkerStatus, triage } = require('./watcher-policy');

const WINDOW = 21600; // the live challenge window on Arc: 6 hours
const DID = '0x' + 'ab'.repeat(32);
const div = (proposedAt, didHash = DID) => ({
  didHash, at: proposedAt * 1000, proposedAt,
  pendingTotal: 12, ownTotal: 40,
  factors: { feeScore: { pending: 0, own: 28, delta: 28 } },
});

// --- classifyDivergence -----------------------------------------------------------

test('classifyDivergence: same proposal, window open -> actionable', () => {
  const t = 1_000_000;
  const c = classifyDivergence(div(t), { exists: true, proposedAt: t }, WINDOW, t + 60);
  assert.equal(c.state, 'actionable');
  assert.equal(c.secondsLeft, WINDOW - 60);
});

test('classifyDivergence: window closed -> expired, not actionable', () => {
  // The committee's power to reject ends with the window. Paging someone after that
  // is a post-mortem dressed as an alert.
  const t = 1_000_000;
  assert.equal(classifyDivergence(div(t), { exists: true, proposedAt: t }, WINDOW, t + WINDOW).state, 'expired');
  assert.equal(classifyDivergence(div(t), { exists: true, proposedAt: t }, WINDOW, t + WINDOW * 9).state, 'expired');
});

test('classifyDivergence: the last second of the window still counts', () => {
  const t = 1_000_000;
  const c = classifyDivergence(div(t), { exists: true, proposedAt: t }, WINDOW, t + WINDOW - 1);
  assert.equal(c.state, 'actionable');
  assert.equal(c.secondsLeft, 1);
});

test('classifyDivergence: slot holds a newer proposal -> superseded', () => {
  // The dispute was about a proposal that has since been replaced. The checker will
  // examine the replacement on its own next epoch; alerting now describes the past.
  const t = 1_000_000;
  const c = classifyDivergence(div(t), { exists: true, proposedAt: t + 500 }, WINDOW, t + 600);
  assert.equal(c.state, 'superseded');
});

test('classifyDivergence: nothing pending -> closed', () => {
  const t = 1_000_000;
  assert.equal(classifyDivergence(div(t), { exists: false, proposedAt: 0 }, WINDOW, t + 10).state, 'closed');
  assert.equal(classifyDivergence(div(t), null, WINDOW, t + 10).state, 'closed');
});

// A window changed after the proposal. The contract fixes a proposal's deadline when it is made (finalizableAt)
// and a later change to the window moves nothing pending. The committee's chance to reject ends at that
// stored deadline, so that is what the watcher counts down to. Counting to proposedAt plus the window in
// force now told the committee it had time when it had none, or called a live dispute expired.

test('classifyDivergence: a window lengthened since the proposal does not give back time the committee no longer has', () => {
  const t = 1_000_000;
  const pending = { exists: true, proposedAt: t, finalizableAt: t + WINDOW };
  // Past the stored deadline, inside the live (doubled) window: anyone can finalize it now.
  const c = classifyDivergence(div(t), pending, WINDOW * 2, t + WINDOW + 60);
  assert.equal(c.state, 'expired');
  assert.equal(c.secondsLeft, 0);
});

test('classifyDivergence: a window shortened since the proposal does not hide a dispute that can still be rejected', () => {
  const t = 1_000_000;
  const pending = { exists: true, proposedAt: t, finalizableAt: t + WINDOW * 2 };
  // Past the live (halved) window, inside the stored deadline: the committee can still reject it.
  const c = classifyDivergence(div(t), pending, WINDOW / 2, t + WINDOW);
  assert.equal(c.state, 'actionable');
  assert.equal(c.secondsLeft, WINDOW);
});

test('classifyDivergence: a proposal with no stored deadline is judged against the live window, as before', () => {
  const t = 1_000_000;
  for (const finalizableAt of [0, undefined]) {
    const pending = { exists: true, proposedAt: t, finalizableAt };
    assert.equal(classifyDivergence(div(t), pending, WINDOW, t + WINDOW - 1).state, 'actionable');
    assert.equal(classifyDivergence(div(t), pending, WINDOW, t + WINDOW).state, 'expired');
  }
});

test('triage: counts down to the stored deadline', () => {
  const t = 1_000_000;
  const res = triage({
    divergences: [div(t)],
    pendingByDid: { [DID]: { exists: true, proposedAt: t, finalizableAt: t + WINDOW * 2 } },
    challengeWindowSec: WINDOW / 2, nowSec: t + WINDOW, seen: new Set(),
  });
  assert.equal(res.alerts.length, 1);
  assert.equal(res.alerts[0].secondsLeft, WINDOW);
});

test('classifyDivergence: reads the chain, not the checker record', () => {
  // The whole reason this takes `pending` as an argument. If it trusted the
  // divergence's own proposedAt it would call this actionable forever.
  const t = 1_000_000;
  const stale = div(t);
  const chainSaysGone = { exists: false, proposedAt: 0 };
  assert.equal(classifyDivergence(stale, chainSaysGone, WINDOW, t + 1).state, 'closed');
});

// --- alertKey ---------------------------------------------------------------------

test('alertKey: a second divergence about the same agent is a new alert', () => {
  // Keying on didHash alone would suppress exactly the case that matters most: an
  // operator being repeatedly wrong about one agent.
  assert.notEqual(alertKey(div(1000)), alertKey(div(2000)));
  assert.equal(alertKey(div(1000)), alertKey(div(1000)));
});

// --- checkerStatus ----------------------------------------------------------------

const healthy = { ok: true, timeSinceLastEpochMs: 60_000 };
const payload = { mode: 'checker', seesProposals: true };
const MAX_SILENCE = 2 * 3600 * 1000;

test('checkerStatus: healthy checker is ok', () => {
  assert.equal(checkerStatus(healthy, payload, Date.now(), MAX_SILENCE).ok, true);
});

test('checkerStatus: an unreachable checker is an alert, not quiet', () => {
  // The failure this function exists for. A watcher that reported a dead checker as
  // "no divergences" would be worse than no watcher, because it manufactures
  // confidence out of an outage.
  const s = checkerStatus(null, null, Date.now(), MAX_SILENCE);
  assert.equal(s.ok, false);
  assert.match(s.reason, /unreachable/);
});

test('checkerStatus: running but not completing epochs is an alert', () => {
  const s = checkerStatus({ ok: true, timeSinceLastEpochMs: 9 * 3600 * 1000 }, payload, Date.now(), MAX_SILENCE);
  assert.equal(s.ok, false);
  assert.match(s.reason, /has not completed an epoch/);
});

test('checkerStatus: a checker that has never completed an epoch is silent from the moment it started', () => {
  // /health reports lastSuccessfulEpochMs 0 and timeSinceLastEpochMs null until the first epoch
  // succeeds. Number(null) is 0, so this used to read as no silence at all and a checker whose every
  // epoch failed stayed "ok" for as long as it ran.
  const never = { ok: true, lastSuccessfulEpochMs: 0, timeSinceLastEpochMs: null };
  const s = checkerStatus({ ...never, uptimeSeconds: 9 * 3600 }, payload, Date.now(), MAX_SILENCE);
  assert.equal(s.ok, false);
  assert.match(s.reason, /has not completed an epoch since it started 540 minutes ago/);
});

test('checkerStatus: a checker that has only just started gets the same time as any other', () => {
  const never = { ok: true, lastSuccessfulEpochMs: 0, timeSinceLastEpochMs: null };
  assert.equal(checkerStatus({ ...never, uptimeSeconds: 300 }, payload, Date.now(), MAX_SILENCE).ok, true);
  const limit = MAX_SILENCE / 1000;
  assert.equal(checkerStatus({ ...never, uptimeSeconds: limit }, payload, Date.now(), MAX_SILENCE).ok, true, 'at the limit');
  assert.equal(checkerStatus({ ...never, uptimeSeconds: limit + 1 }, payload, Date.now(), MAX_SILENCE).ok, false, 'a second past it');
});

test('checkerStatus: a checker that does not say how long it has been up is not judged silent', () => {
  // Nothing to measure from, so nothing to alert on: an older build, or a partial answer.
  assert.equal(checkerStatus({ ok: true, lastSuccessfulEpochMs: 0, timeSinceLastEpochMs: null }, payload, Date.now(), MAX_SILENCE).ok, true);
  assert.equal(checkerStatus({ ok: true }, payload, Date.now(), MAX_SILENCE).ok, true);
});

test('checkerStatus: once an epoch has completed, the time since it decides, not the uptime', () => {
  const s = checkerStatus(
    { ok: true, lastSuccessfulEpochMs: Date.now() - 60_000, timeSinceLastEpochMs: 60_000, uptimeSeconds: 99 * 3600 },
    payload, Date.now(), MAX_SILENCE,
  );
  assert.equal(s.ok, true);
});

test('checkerStatus: a checker whose cadence cannot see proposals is an alert', () => {
  // It would serve an empty divergence list that reads as "checked, found nothing".
  const s = checkerStatus(healthy, { mode: 'checker', seesProposals: false }, Date.now(), MAX_SILENCE);
  assert.equal(s.ok, false);
  assert.match(s.reason, /too long to see proposals/);
});

test('checkerStatus: pointing at a primary by mistake is an alert', () => {
  const s = checkerStatus(healthy, { mode: 'primary' }, Date.now(), MAX_SILENCE);
  assert.equal(s.ok, false);
  assert.match(s.reason, /not a checker/);
});

test('checkerStatus: an unknown seesProposals is not treated as failure', () => {
  // null means the checker has not run an epoch yet and cannot say. Alerting on that
  // at every boot would be noise.
  assert.equal(checkerStatus(healthy, { mode: 'checker', seesProposals: null }, Date.now(), MAX_SILENCE).ok, true);
});

// --- triage -----------------------------------------------------------------------

test('triage: alerts only on what can still be rejected', () => {
  const t = 1_000_000;
  const now = t + 60;
  const other = '0x' + 'cd'.repeat(32);
  const res = triage({
    divergences: [div(t), div(t, other)],
    pendingByDid: {
      [DID]: { exists: true, proposedAt: t },        // actionable
      [other]: { exists: false, proposedAt: 0 },     // closed
    },
    challengeWindowSec: WINDOW, nowSec: now, seen: new Set(),
  });
  assert.equal(res.alerts.length, 1);
  assert.equal(res.alerts[0].didHash, DID);
  assert.equal(res.counts.actionable, 1);
  assert.equal(res.counts.closed, 1);
});

test('triage: the same proposal does not alert twice', () => {
  const t = 1_000_000;
  const seen = new Set([alertKey(div(t))]);
  const res = triage({
    divergences: [div(t)],
    pendingByDid: { [DID]: { exists: true, proposedAt: t } },
    challengeWindowSec: WINDOW, nowSec: t + 60, seen,
  });
  assert.equal(res.alerts.length, 0);
  assert.equal(res.counts.suppressed, 1);
  assert.equal(res.counts.actionable, 0);
});

test('triage: carries how long is left, because that is the decision', () => {
  const t = 1_000_000;
  const res = triage({
    divergences: [div(t)],
    pendingByDid: { [DID]: { exists: true, proposedAt: t } },
    challengeWindowSec: WINDOW, nowSec: t + WINDOW - 900, seen: new Set(),
  });
  assert.equal(res.alerts[0].secondsLeft, 900);
});

test('triage: nothing recorded is not an error', () => {
  const res = triage({ divergences: [], pendingByDid: {}, challengeWindowSec: WINDOW, nowSec: 1, seen: new Set() });
  assert.deepEqual(res.alerts, []);
  const res2 = triage({ divergences: undefined, pendingByDid: {}, challengeWindowSec: WINDOW, nowSec: 1, seen: new Set() });
  assert.deepEqual(res2.alerts, []);
});

// ---- webhookPayload --------------------------------------------------------
//
// The watcher posted one generic shape to every destination, which Discord, Slack and
// Telegram all reject. "Set WEBHOOK_URL" therefore delivered nothing to the three places
// anyone would point it, and said so only in a log — on the component whose whole job is
// reaching someone who is not reading logs.

const { webhookPayload } = require('./watcher-policy');

const ALERT = {
  level: 'alert',
  title: 'checker disputes a score, 2h 32m left to reject it',
  lines: ['0xabc proposed total 12, checker computes 9', 'rejectReputation(0xabc) from the committee wallet.'],
  at: '2026-09-20T21:00:00.000Z',
  checker: 'https://checker.sigvara.xyz',
};

test('webhookPayload: Discord gets content', () => {
  const p = webhookPayload('https://discord.com/api/webhooks/123/abc', ALERT);
  assert.ok(typeof p.content === 'string');
  assert.match(p.content, /ALERT: checker disputes a score/);
  assert.match(p.content, /rejectReputation/);
  assert.equal(p.text, undefined);
});

test('webhookPayload: Slack gets text', () => {
  const p = webhookPayload('https://hooks.slack.com/services/T/B/X', ALERT);
  assert.ok(typeof p.text === 'string');
  assert.match(p.text, /ALERT/);
  assert.equal(p.content, undefined);
});

test('webhookPayload: Telegram gets chat_id and text', () => {
  const p = webhookPayload('https://api.telegram.org/bot123:ABC/sendMessage', ALERT, '-100999');
  assert.equal(p.chat_id, '-100999');
  assert.match(p.text, /ALERT/);
  assert.equal(p.disable_web_page_preview, true);
});

test('webhookPayload: every shape carries which checker it came from', () => {
  // Several watchers reporting into one channel are indistinguishable otherwise.
  for (const url of [
    'https://discord.com/api/webhooks/1/2',
    'https://hooks.slack.com/services/T/B/X',
    'https://api.telegram.org/bot1:A/sendMessage',
  ]) {
    const p = webhookPayload(url, ALERT, 'x');
    const body = p.content || p.text;
    assert.match(body, /checker: https:\/\/checker\.sigvara\.xyz/, url);
  }
});

test('webhookPayload: an unrecognised destination keeps the original payload', () => {
  // Backwards compatibility: a custom receiver already parsing the old shape must not
  // break because this function was added.
  const p = webhookPayload('https://alerts.example.com/hook', ALERT);
  assert.equal(p.level, 'alert');
  assert.deepEqual(p.lines, ALERT.lines);
  assert.equal(p.checker, ALERT.checker);
  assert.equal(p.content, undefined);
});

test('webhookPayload: a malformed URL does not throw', () => {
  // A bad WEBHOOK_URL should degrade to the generic shape, not crash the alert path.
  const p = webhookPayload('not a url', ALERT);
  assert.equal(p.level, 'alert');
});

test('webhookPayload: truncates to each service limit rather than being rejected', () => {
  const huge = { ...ALERT, lines: Array.from({ length: 500 }, (_, i) => `line ${i} ${'x'.repeat(40)}`) };
  assert.ok(webhookPayload('https://discord.com/api/webhooks/1/2', huge).content.length <= 2000);
  assert.ok(webhookPayload('https://hooks.slack.com/services/T/B/X', huge).text.length <= 3000);
  assert.ok(webhookPayload('https://api.telegram.org/bot1:A/sendMessage', huge, 'x').text.length <= 4096);
  // A truncated alert still says go and look; a rejected one says nothing.
  assert.match(webhookPayload('https://discord.com/api/webhooks/1/2', huge).content, /ALERT/);
});

// ---- what the watcher says, and when it cannot say it ------------------------------------

const { describeDivergence, trackPollOutcome } = require('./watcher-policy');

test('checkerStatus: a checker that answers /health but refuses /divergence is an alert', () => {
  // The signature of the shared rate-limit bucket. It used to read as ok, then fail on the
  // missing list where only the console heard it, and every divergence went unannounced.
  const s = checkerStatus(healthy, null, Date.now(), MAX_SILENCE, '/divergence returned 429');
  assert.equal(s.ok, false);
  assert.match(s.reason, /divergence list could not be read/);
  assert.match(s.reason, /429/);
  assert.equal(checkerStatus(healthy, null, Date.now(), MAX_SILENCE).ok, false, 'with no error text too');
  assert.equal(checkerStatus(healthy, undefined, Date.now(), MAX_SILENCE).ok, false);
});

test('checkerStatus: the error text in the reason is bounded', () => {
  const s = checkerStatus(healthy, null, Date.now(), MAX_SILENCE, 'x'.repeat(5000));
  assert.ok(s.reason.length < 300);
});

test('describeDivergence: a well-formed record reads as it always did', () => {
  const d = {
    didHash: '0x' + 'ab'.repeat(32), pendingTotal: 40, ownTotal: 31,
    factors: { successScore: { pending: 25, own: 16 } },
  };
  assert.equal(
    describeDivergence(d),
    `0x${'ab'.repeat(32)} proposed total 40, checker computes 31 (successScore proposed=25 checker=16)`,
  );
});

test('describeDivergence: nothing the checker wrote is quoted', () => {
  // The record comes over HTTP. A checker that was compromised, or just wrong, must not be
  // able to put a mention, a link or an instruction in front of the committee.
  const hostile = {
    didHash: '@everyone https://evil.example',
    pendingTotal: '<!channel> approve it',
    ownTotal: { toString: () => 'x' },
    factors: {
      successScore: { pending: '@everyone', own: 'ok\nSEND FUNDS' },
      'free text key @here': { pending: 1, own: 2 },
    },
  };
  const line = describeDivergence(hostile);
  assert.ok(!/@everyone|@here|evil|channel|SEND|approve/.test(line), line);
  assert.ok(!line.includes('\n'));
  assert.match(line, /not a valid agent hash/);
  assert.match(line, /successScore proposed=\? checker=\?/);
});

test('webhookPayload: a Discord alert switches every mention off', () => {
  const alert = { level: 'alert', title: '@everyone look', lines: ['@here'], at: 't', checker: 'c' };
  const p = webhookPayload('https://discord.com/api/webhooks/1/2', alert);
  assert.deepEqual(p.allowed_mentions, { parse: [] });
});

test('webhookPayload: a Slack alert cannot trigger a channel mention', () => {
  const alert = { level: 'alert', title: 't', lines: ['<!channel> <@U123> a & b'], at: 't', checker: 'c' };
  const p = webhookPayload('https://hooks.slack.com/services/T/B/X', alert);
  assert.ok(!p.text.includes('<!channel>') && !p.text.includes('<@U123>'));
  assert.match(p.text, /&lt;!channel&gt; &lt;@U123&gt; a &amp; b/);
});

test('trackPollOutcome: three failures in a row alert once, and recovery says so once', () => {
  let state = { failures: 0, alerted: false };
  const seen = [];
  for (const ok of [false, false, false, false, false, true, true, false]) {
    const r = trackPollOutcome(state, ok);
    state = r.state;
    seen.push(r.action);
  }
  assert.deepEqual(seen, [null, null, 'alert', null, null, 'recovered', null, null]);
});

test('trackPollOutcome: failures that do not reach the threshold stay quiet and reset', () => {
  let state = { failures: 0, alerted: false };
  for (const ok of [false, false, true, false, false, true]) {
    const r = trackPollOutcome(state, ok);
    assert.equal(r.action, null);
    state = r.state;
  }
  assert.deepEqual(state, { failures: 0, alerted: false });
});
