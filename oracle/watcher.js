'use strict';

/**
 * Divergence watcher.
 *
 * Polls a checking operator's /divergence, verifies each disagreement against the chain,
 * and alerts a human while the slashing committee can still act on it.
 *
 * A checker can only record that it disagrees. It cannot reject a proposal; only
 * SLASHING_COMMITTEE_ROLE can, and only inside the challenge window. Six hours on Arc.
 * Nobody watches an HTTP endpoint for six hours, so without this the divergence signal
 * is a log nobody reads and the committee's power stays theoretical.
 *
 * Two things it deliberately does NOT do.
 *
 * It holds no private key and signs nothing. Every action it takes is a read or a
 * notification. A watcher that could write would be another privileged component to
 * secure, for no gain: the committee has to make the judgement anyway.
 *
 * It does not trust the checker's record. The checker stores what it saw when it saw
 * it; the disputed proposal may since have been finalized, rejected, or replaced. The
 * watcher re-reads the slot before alerting, because an alert about a proposal that no
 * longer exists trains the committee to ignore alerts.
 *
 * Run it somewhere other than the checker. A watcher sharing a host with the thing it
 * watches goes down with it, silently.
 *
 *   CHECKER_URL=https://checker.example node watcher.js
 */

// A watcher that fails open is worse than none: MAX_SILENCE_MINUTES=2h parsed to NaN, and a
// comparison against NaN is never true, so no checker was ever judged silent. See config.js.
require('./config').requireValidNumericConfig('watcher');

const { ethers } = require('ethers');
const {
  checkerStatus, classifyDivergence, triage, nextAlert, webhookPayload, describeDivergence, trackPollOutcome,
} = require('./watcher-policy');
const { redact } = require('./event-index');
const { wordsOf } = require('./log-spans');
const { readWithBackoff } = require('./read-retry');

const cfg = {
  checkerUrl: (process.env.CHECKER_URL || '').replace(/\/+$/, ''),
  rpcUrl: process.env.RPC_URL || '',
  reputationAddress: process.env.REPUTATION_ADDRESS || '',
  pollSeconds: Number(process.env.POLL_SECONDS || 300),
  // How long a checker may go without completing an epoch before its silence is itself
  // the alert. Default is generous: two hours against a one-hour checker cadence.
  maxSilenceMs: Number(process.env.MAX_SILENCE_MINUTES || 120) * 60_000,
  // Second alert when a window is closing and nothing has happened. The first alert
  // says "look"; this one says "you are about to lose the ability to act".
  finalWarningSeconds: Number(process.env.FINAL_WARNING_MINUTES || 60) * 60,
  webhookUrl: process.env.WEBHOOK_URL || '',
  // Telegram only. Every other destination identifies its target in the URL itself.
  webhookChatId: process.env.WEBHOOK_CHAT_ID || '',
};

if (!cfg.checkerUrl || !cfg.rpcUrl || !cfg.reputationAddress) {
  console.error('[watcher] need CHECKER_URL, RPC_URL and REPUTATION_ADDRESS');
  process.exit(1);
}
if (!Number.isFinite(cfg.pollSeconds) || cfg.pollSeconds < 30) {
  console.error(`[watcher] POLL_SECONDS is ${process.env.POLL_SECONDS}; must be a number of at least 30`);
  process.exit(1);
}

const ABI = [
  'function getPendingScore(bytes32 didHash) view returns (tuple(tuple(uint8 feeScore, uint8 successScore, uint8 ageScore, uint8 externalScore, uint8 communityScore, uint8 propagationScore, uint256 lastUpdated) data, uint256 proposedAt, bool exists, bytes32 evidenceRoot, address proposer, uint256 finalizableAt))',
  'function challengeWindow() view returns (uint256)',
];

const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
const reputation = new ethers.Contract(cfg.reputationAddress, ABI, provider);

// An error as words that can leave this machine. An ethers error's message holds the whole RPC URL
// when a node answers 429 or 500, and a provider's URL can carry its key. These reach the webhook,
// which is somebody else's channel. The node's own words say what happened.
const said = (err) => redact(wordsOf(err), [cfg.rpcUrl, cfg.webhookUrl]);

// key -> { level, divergence }: the highest escalation already sent (0 first sighting, 1 final
// warning), and the record it was about, so the final warning can go out from here whatever the
// checker answers by then. In memory on purpose: a restart re-surfaces anything still open, which
// is the safe direction. Losing the record of an alert nobody acted on is not a loss.
const sent = new Map();
let checkerWasOk = true;
// Whether the checker's list was last seen cut short, so that is paged once a spell.
let truncatedRaised = false;
// Which of checkerStatus's kinds was last paged, so a new cause while not ok is paged too.
let checkerKind = null;

// redirect: 'error'. The checker is somebody else's server, and following a redirect it
// chooses would let it point this watcher at an address it could not reach itself, such as
// the cloud metadata service on this host.
async function getJson(path, { acceptStatus = [] } = {}) {
  const res = await fetch(`${cfg.checkerUrl}${path}`, { signal: AbortSignal.timeout(20_000), redirect: 'error' });
  if (!res.ok && !acceptStatus.includes(res.status)) throw new Error(`${path} returned ${res.status}`);
  const body = await res.text();
  // Not the parser's message, which quotes the body: what this server sends is not ours to repeat.
  try { return JSON.parse(body); } catch { throw new Error(`${path} did not return JSON`); }
}

async function notify(level, title, lines) {
  const stamp = new Date().toISOString();
  const text = [`[watcher] ${level.toUpperCase()}: ${title}`, ...lines.map(l => `  ${l}`)].join('\n');
  (level === 'ok' ? console.log : console.error)(text);
  if (!cfg.webhookUrl) return;
  try {
    const payload = webhookPayload(
      cfg.webhookUrl,
      { level, title, lines, at: stamp, checker: cfg.checkerUrl },
      cfg.webhookChatId,
    );
    const res = await fetch(cfg.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
      redirect: 'error',
    });
    // fetch only rejects on transport failure, so without this a 400 from a malformed
    // payload or a revoked webhook counts as delivered. That is the exact failure this
    // component cannot afford: believing it raised an alarm that nobody heard.
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      console.error(`[watcher] webhook rejected the alert: ${res.status} ${detail.slice(0, 200)}`);
    }
  } catch (err) {
    // A webhook that is down must not stop the loop, and must not be silent either.
    console.error(`[watcher] webhook delivery failed: ${said(err)}`);
  }
}

function hhmm(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

async function poll() {
  // Two fetches that can fail separately, and the second one is the one that is metered.
  // They used to share a try block that logged only when /health failed, so a /divergence
  // that was refused left no trace anywhere and the poll carried on as if all were well.
  let health = null, payload = null, payloadError = null;
  try {
    // A 503 is the checker saying it is not ok, with a body that says so: a save failed, or its
    // scoring is stale. It may still be auditing, so it is read like a 200 and not as unreachable.
    health = await getJson('/health', { acceptStatus: [503] });
  } catch (err) {
    console.error(`[watcher] checker fetch failed: ${said(err)}`);
  }
  if (health) {
    try {
      payload = await getJson('/divergence');
    } catch (err) {
      payloadError = said(err);
      console.error(`[watcher] divergence fetch failed: ${payloadError}`);
    }
  }

  const status = checkerStatus(health, payload, Date.now(), cfg.maxSilenceMs, payloadError);
  if (!status.ok) {
    // On the transition, and when the cause changes, so an outage is one page per cause rather
    // than one per poll.
    if (checkerWasOk || status.kind !== checkerKind) {
      await notify('alert', 'the checker is not checking', [
        status.reason,
        `checker: ${cfg.checkerUrl}`,
        'Until this clears, an empty divergence list means nothing was looked at.',
      ]);
    }
    checkerWasOk = false;
    checkerKind = status.kind;
  } else if (!checkerWasOk) {
    await notify('ok', 'checker is back', [`checker: ${cfg.checkerUrl}`]);
    checkerWasOk = true;
    checkerKind = null;
  }

  // What a checker that is not ok still found is relayed all the same: its disputes are the
  // committee's only signal, and triage re-reads the chain, so a degraded checker cannot raise a
  // false one. Only a list that is missing, or not a checker's, has nothing to relay.
  const listed = payload?.mode === 'checker';
  const divergences = listed ? (payload.divergences ?? []) : [];

  // /divergence serves the newest 100 records. With more, a dispute among the older ones is never
  // seen here, so that is paged, once a spell like an outage. The count is rendered from a number:
  // nothing the checker writes is quoted.
  if (listed) {
    if (payload.truncated === true && !truncatedRaised) {
      const total = Number.isFinite(Number(payload.total)) ? Number(payload.total) : '?';
      await notify('alert', 'the checker has more disputes than its list shows', [
        `it recorded ${total}, and its list holds the newest ${divergences.length}`,
        'A dispute among the others is not checked here. Ask the checker for one agent at /divergence/<didHash>.',
      ]);
    }
    truncatedRaised = payload.truncated === true;
  }

  // Re-read every disputed slot, one agent at a time. Read together they go out as one JSON-RPC
  // batch, and dRPC answers 400 to a whole batch over 10 calls (measured 6 November 2026), so every
  // read failed once enough agents were on the list, however few were still open. 100 agents take
  // about 8 seconds this way, against a poll of minutes. Every agent already raised is read too: its
  // final warning is owed whatever the checker lists now, or whether it answers at all.
  const dids = [...new Set([...divergences, ...[...sent.values()].map(e => e.divergence)].map(d => d.didHash))];
  if (dids.length === 0) return;
  const challengeWindowSec = Number(await reputation.challengeWindow());
  const pendingByDid = {};
  for (const did of dids) {
    try {
      const p = await readWithBackoff('pending score', () => reputation.getPendingScore(did));
      pendingByDid[did] = { exists: p.exists, proposedAt: Number(p.proposedAt), finalizableAt: Number(p.finalizableAt) };
    } catch (err) {
      // An unreadable slot must not be treated as "nothing pending", which would
      // silently downgrade a live dispute to 'closed'. Leaving it undefined does the
      // same, so say so and skip the agent this round.
      console.error(`[watcher] could not read pending score for ${did}: ${said(err)}`);
    }
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const readable = divergences.filter(d => pendingByDid[d.didHash] !== undefined);
  const { alerts, counts } = triage({
    divergences: readable, pendingByDid, challengeWindowSec, nowSec, seen: new Set(sent.keys()),
  });

  for (const a of alerts) {
    sent.set(a.key, { level: nextAlert(undefined, 'actionable', a.secondsLeft, cfg.finalWarningSeconds).level, divergence: a.divergence });
    await notify('alert', `checker disputes a score, ${hhmm(a.secondsLeft)} left to reject it`, [
      describeDivergence(a.divergence),
      `rejectReputation(${a.didHash}) from the committee wallet, before the window closes.`,
    ]);
  }

  // Escalate anything raised and still unresolved as its window runs out, and forget what is over.
  for (const [key, { level, divergence }] of sent) {
    const p = pendingByDid[divergence.didHash];
    if (p === undefined) continue; // not read this poll, which fails it below
    const { state, secondsLeft } = classifyDivergence(divergence, p, challengeWindowSec, nowSec);
    const next = nextAlert(level, state, secondsLeft, cfg.finalWarningSeconds);
    if (next.action === 'forget') sent.delete(key);
    if (next.action !== 'last') continue;
    sent.set(key, { level: next.level, divergence });
    await notify('alert', `LAST CALL: ${hhmm(secondsLeft)} to reject a disputed score`, [
      describeDivergence(divergence),
      'After this window closes anyone can finalize it and the committee cannot stop it.',
    ]);
  }

  if (divergences.length) {
    console.log(
      `[watcher] ${divergences.length} recorded: ${counts.actionable} new actionable, ` +
      `${counts.suppressed} already raised, ${counts.expired} expired, ` +
      `${counts.superseded} superseded, ${counts.closed} closed`,
    );
  }

  // An agent it could not read has not been checked, so this poll did not do its job, and three in a
  // row raise the alert in runPoll. Last, so the agents it could read have already alerted.
  const unread = dids.length - Object.keys(pendingByDid).length;
  if (unread) throw new Error(`could not read ${unread} of ${dids.length} disputed agents`);
}

console.log(
  `[watcher] watching ${cfg.checkerUrl} every ${cfg.pollSeconds}s, ` +
  `webhook ${cfg.webhookUrl ? 'on' : 'off'}, read-only (no key)`,
);
// A poll that throws was logged and forgotten, so a watcher that could no longer do its job,
// its own RPC down for one, looked from outside like a watcher with nothing to report. Three
// failures in a row raise an alert, and recovery says so. See trackPollOutcome.
let pollHealth = { failures: 0, alerted: false };

async function runPoll() {
  let ok = true;
  let failure = '';
  try {
    await poll();
  } catch (err) {
    ok = false;
    failure = said(err);
    console.error(`[watcher] poll error: ${failure}`);
  }
  const { state, action } = trackPollOutcome(pollHealth, ok);
  pollHealth = state;
  if (action === 'alert') {
    await notify('alert', 'the watcher cannot complete its checks', [
      `${state.failures} polls in a row failed; the last error: ${String(failure).slice(0, 200)}`,
      `checker: ${cfg.checkerUrl}`,
      'Until this clears, nothing is being checked and silence means nothing.',
    ]);
  } else if (action === 'recovered') {
    await notify('ok', 'the watcher is checking again', [`checker: ${cfg.checkerUrl}`]);
  }
}

// runPoll handles its own failures; this is for the one it cannot, so a bug here costs a poll
// and not the process. One poll at a time: a poll can outlast the interval (a node backing off, a
// webhook slow to answer), and two at once each took a dispute the other was paging for unseen.
let polling = false;
const tick = () => {
  if (polling) return;
  polling = true;
  runPoll()
    .catch((err) => console.error(`[watcher] unexpected error: ${said(err)}`))
    .finally(() => { polling = false; });
};
tick();
setInterval(tick, cfg.pollSeconds * 1000);
