'use strict';

// What a divergence watcher should do about what it sees. Pure functions, no I/O.
//
// The watcher exists because a checking operator can only record that it disagrees.
// It cannot reject a proposal; only SLASHING_COMMITTEE_ROLE can, and only inside the
// challenge window. A divergence nobody reads before that window closes is a
// post-mortem. So the watcher's whole job is to turn a recorded disagreement into a
// human being told, while the rejection is still possible.
//
// Two rules shape everything here.
//
// It re-reads the chain rather than trusting the checker's record. The checker stores
// what it saw at the time; by the time the watcher polls, the disputed proposal may
// have been finalized, rejected, or replaced by a newer one the checker has not
// examined yet. Alerting on a proposal that no longer exists trains the committee to
// ignore alerts, which is the failure this whole path exists to prevent.
//
// And it treats the checker's silence as a finding, not as quiet. A watcher that only
// reports what the checker says will report a dead checker as "no divergences", which
// is the same mistake as reading an empty /divergence as "checked, found nothing".

/**
 * Whether a recorded divergence is still something the committee can act on.
 *
 * `pending` is what the chain returns for this agent NOW, not what the checker recorded.
 *
 *   actionable  - same proposal, window still open. The committee can still reject.
 *   expired     - same proposal, window closed. Anyone can finalize it; too late to stop.
 *   superseded  - a different proposal occupies the slot. The dispute was about an older
 *                 one, and the checker will re-examine the new one on its next epoch.
 *   closed      - nothing pending. Already finalized or rejected.
 */
function classifyDivergence(divergence, pending, challengeWindowSec, nowSec) {
  if (!pending || !pending.exists) return { state: 'closed', secondsLeft: 0 };
  if (Number(pending.proposedAt) !== Number(divergence.proposedAt)) {
    return { state: 'superseded', secondsLeft: 0 };
  }
  const endsAt = Number(divergence.proposedAt) + Number(challengeWindowSec);
  const secondsLeft = endsAt - nowSec;
  return secondsLeft > 0
    ? { state: 'actionable', secondsLeft }
    : { state: 'expired', secondsLeft: 0 };
}

/**
 * Identity of an alert, for not sending the same one every poll.
 *
 * Keyed on the proposal rather than the agent: a second, separate divergence about the
 * same agent is a new event and must alert again. Keying on didHash alone would
 * suppress exactly the case where an operator is repeatedly wrong about one agent.
 */
function alertKey(divergence) {
  return `${divergence.didHash}:${divergence.proposedAt}`;
}

/**
 * Whether the checker itself is in a state where its silence means anything.
 *
 * Returns { ok, reason }. `ok: false` is itself an alert: the committee is relying on
 * this checker, and a checker that is down, stalled, or running on a cadence too slow
 * to see proposals before they expire is providing false assurance rather than none.
 */
function checkerStatus(health, divergencePayload, nowMs, maxSilenceMs) {
  if (!health) {
    return { ok: false, reason: 'checker unreachable' };
  }
  if (health.ok !== true) {
    return { ok: false, reason: 'checker reports not ok' };
  }
  // An epoch that has not completed in a long time means the checker is running but not
  // checking, which looks identical to "nothing to report" from outside.
  const since = Number(health.timeSinceLastEpochMs);
  if (Number.isFinite(since) && since > maxSilenceMs) {
    return { ok: false, reason: `checker has not completed an epoch in ${Math.round(since / 60000)} minutes` };
  }
  if (divergencePayload) {
    if (divergencePayload.mode !== 'checker') {
      return { ok: false, reason: 'endpoint is not a checker' };
    }
    // The checker publishes whether its own cadence is short enough to see proposals
    // before their window closes. false means an empty divergence list proves nothing.
    if (divergencePayload.seesProposals === false) {
      return { ok: false, reason: 'checker epoch is too long to see proposals before they expire' };
    }
  }
  return { ok: true, reason: null };
}

/**
 * Everything worth telling a human about this poll.
 *
 * `seen` is the set of alert keys already sent; it is read here and updated by the
 * caller so this stays pure and testable.
 */
function triage({ divergences, pendingByDid, challengeWindowSec, nowSec, seen }) {
  const alerts = [];
  const counts = { actionable: 0, expired: 0, superseded: 0, closed: 0, suppressed: 0 };

  for (const d of divergences ?? []) {
    const { state, secondsLeft } = classifyDivergence(
      d, pendingByDid[d.didHash], challengeWindowSec, nowSec,
    );
    counts[state] += 1;
    if (state !== 'actionable') continue;

    const key = alertKey(d);
    if (seen && seen.has(key)) { counts.suppressed += 1; counts.actionable -= 1; continue; }
    alerts.push({ key, didHash: d.didHash, secondsLeft, divergence: d });
  }
  return { alerts, counts };
}

module.exports = { classifyDivergence, alertKey, checkerStatus, triage };

/**
 * Shape an alert for whatever is on the other end of WEBHOOK_URL.
 *
 * The watcher used to POST {level, title, lines, at, checker} to every destination,
 * which is a sensible shape that almost nothing accepts. Discord wants `content`, Slack
 * wants `text`, Telegram wants `chat_id` and `text` on a bot URL. So "just set
 * WEBHOOK_URL" quietly delivered nothing to the three places anyone would actually point
 * it, and the failure was a 400 in a log nobody reads — on the component whose entire
 * job is reaching someone when nobody is reading logs.
 *
 * Detection is by hostname rather than a WEBHOOK_FORMAT setting, because the URL already
 * says which service it is and a second setting is a second thing to get wrong.
 * Anything unrecognised keeps the original payload, so an existing custom receiver is
 * unaffected.
 *
 * @param {string} url        the webhook URL, used only to identify the service
 * @param {{level,title,lines,at,checker}} alert
 * @param {string} [chatId]   Telegram only; ignored elsewhere
 */
function webhookPayload(url, alert, chatId = '') {
  const text = [
    `[sigvara-watcher] ${String(alert.level).toUpperCase()}: ${alert.title}`,
    ...(alert.lines || []).map(l => `  ${l}`),
    `  checker: ${alert.checker}`,
  ].join('\n');

  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return { ...alert }; }

  // Telegram rejects the whole message over 4096; Discord over 2000. Truncating beats a
  // 400, because a truncated alert still tells you to go and look.
  const clip = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 3)}...`);

  if (host === 'api.telegram.org') {
    return { chat_id: chatId, text: clip(text, 4096), disable_web_page_preview: true };
  }
  if (host === 'discord.com' || host === 'discordapp.com' || host.endsWith('.discord.com')) {
    return { content: clip(text, 2000) };
  }
  if (host === 'hooks.slack.com') {
    return { text: clip(text, 3000) };
  }
  return { ...alert };
}

module.exports.webhookPayload = webhookPayload;
