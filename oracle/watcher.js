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

const { ethers } = require('ethers');
const { checkerStatus, triage, alertKey, webhookPayload } = require('./watcher-policy');

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
  'function getPendingScore(bytes32 didHash) view returns (tuple(tuple(uint8 feeScore, uint8 successScore, uint8 ageScore, uint8 externalScore, uint8 communityScore, uint8 propagationScore, uint256 lastUpdated) data, uint256 proposedAt, bool exists))',
  'function challengeWindow() view returns (uint256)',
];

const provider = new ethers.JsonRpcProvider(cfg.rpcUrl);
const reputation = new ethers.Contract(cfg.reputationAddress, ABI, provider);

// key -> highest escalation already sent (0 first sighting, 1 final warning).
// In memory on purpose: a restart re-surfaces anything still open, which is the safe
// direction. Losing the record of an alert nobody acted on is not a loss.
const sent = new Map();
let checkerWasOk = true;

async function getJson(path) {
  const res = await fetch(`${cfg.checkerUrl}${path}`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return res.json();
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
    console.error(`[watcher] webhook delivery failed: ${err.message}`);
  }
}

function describe(d) {
  const factors = Object.entries(d.factors ?? {})
    .map(([f, v]) => `${f} proposed=${v.pending} checker=${v.own}`)
    .join(', ');
  return `${d.didHash} proposed total ${d.pendingTotal}, checker computes ${d.ownTotal}${factors ? ` (${factors})` : ''}`;
}

function hhmm(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

async function poll() {
  let health = null, payload = null;
  try {
    health = await getJson('/health');
    payload = await getJson('/divergence');
  } catch (err) {
    // Leave health/payload as whatever was fetched; checkerStatus decides what that means.
    if (!health) console.error(`[watcher] checker fetch failed: ${err.message}`);
  }

  const status = checkerStatus(health, payload, Date.now(), cfg.maxSilenceMs);
  if (!status.ok) {
    // Only on the transition, so an outage is one page rather than one per poll.
    if (checkerWasOk) {
      await notify('alert', 'the checker is not checking', [
        status.reason,
        `checker: ${cfg.checkerUrl}`,
        'Until this clears, an empty divergence list means nothing was looked at.',
      ]);
    }
    checkerWasOk = false;
    return;
  }
  if (!checkerWasOk) {
    await notify('ok', 'checker is back', [`checker: ${cfg.checkerUrl}`]);
    checkerWasOk = true;
  }

  const divergences = payload.divergences ?? [];
  if (divergences.length === 0) return;

  // Re-read every disputed slot. One call per distinct agent, in parallel.
  const dids = [...new Set(divergences.map(d => d.didHash))];
  const challengeWindowSec = Number(await reputation.challengeWindow());
  const pendingByDid = {};
  await Promise.all(dids.map(async (did) => {
    try {
      const p = await reputation.getPendingScore(did);
      pendingByDid[did] = { exists: p.exists, proposedAt: Number(p.proposedAt) };
    } catch (err) {
      // An unreadable slot must not be treated as "nothing pending", which would
      // silently downgrade a live dispute to 'closed'. Leaving it undefined does the
      // same, so say so and skip the agent this round.
      console.error(`[watcher] could not read pending score for ${did}: ${err.message}`);
    }
  }));

  const nowSec = Math.floor(Date.now() / 1000);
  const readable = divergences.filter(d => pendingByDid[d.didHash] !== undefined);
  const { alerts, counts } = triage({
    divergences: readable, pendingByDid, challengeWindowSec, nowSec, seen: new Set(sent.keys()),
  });

  for (const a of alerts) {
    sent.set(a.key, 0);
    await notify('alert', `checker disputes a score, ${hhmm(a.secondsLeft)} left to reject it`, [
      describe(a.divergence),
      `rejectReputation(${a.didHash}) from the committee wallet, before the window closes.`,
    ]);
  }

  // Escalate anything still unresolved as its window runs out.
  for (const d of readable) {
    const key = alertKey(d);
    if (sent.get(key) !== 0) continue;
    const p = pendingByDid[d.didHash];
    if (!p.exists || Number(p.proposedAt) !== Number(d.proposedAt)) { sent.delete(key); continue; }
    const left = Number(d.proposedAt) + challengeWindowSec - nowSec;
    if (left > 0 && left <= cfg.finalWarningSeconds) {
      sent.set(key, 1);
      await notify('alert', `LAST CALL: ${hhmm(left)} to reject a disputed score`, [
        describe(d),
        'After this window closes anyone can finalize it and the committee cannot stop it.',
      ]);
    }
  }

  console.log(
    `[watcher] ${divergences.length} recorded — ${counts.actionable} new actionable, ` +
    `${counts.suppressed} already raised, ${counts.expired} expired, ` +
    `${counts.superseded} superseded, ${counts.closed} closed`,
  );
}

console.log(
  `[watcher] watching ${cfg.checkerUrl} every ${cfg.pollSeconds}s, ` +
  `webhook ${cfg.webhookUrl ? 'on' : 'off'}, read-only (no key)`,
);
poll().catch(err => console.error(`[watcher] poll error: ${err.message}`));
setInterval(() => poll().catch(err => console.error(`[watcher] poll error: ${err.message}`)), cfg.pollSeconds * 1000);
