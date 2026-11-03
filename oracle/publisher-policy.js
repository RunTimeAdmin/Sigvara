'use strict';

// What the ERC-8004 publisher posts, and when (docs/adr/0008-sigvara-as-erc8004-signal-provider.md).
// Pure: publisher.js does the reading and the sending.
//
// One live Sigvara feedback per linked agent, tagged `sigvara` / `score`, whose value is the
// spendable score. Before posting a new value the publisher revokes its previous one, so
// getSummary(agentId, [publisher], "sigvara", "score") returns the current score with a count of 1.

const { ethers } = require('ethers');

const TAG1 = 'sigvara';
const TAG2 = 'score';
const DAY_SECONDS = 86_400;

const utcDay = (seconds) => Math.floor(seconds / DAY_SECONDS);

/**
 * The spec's off-chain feedback file (EIP-8004, "Off-Chain Feedback File Structure"): its required
 * fields, the tags, and a `sigvara` object saying what the value was read from, so anyone can
 * check it against SigvaraReputation at that block. `event` is the ReputationUpdated or
 * ReputationZeroed that prompted the post, or null for a daily refresh.
 */
function feedbackFile({
  chainId, identityRegistry, agentId, publisher, readAt, spendable, earned, didHash, reputation, event = null,
}) {
  return {
    agentRegistry: `eip155:${chainId}:${identityRegistry}`,
    agentId: Number(agentId),
    clientAddress: `eip155:${chainId}:${publisher}`,
    createdAt: new Date(readAt.time * 1000).toISOString(),
    value: spendable,
    valueDecimals: 0,
    tag1: TAG1,
    tag2: TAG2,
    sigvara: {
      didHash,
      reputation,
      readAtBlock: readAt.block,
      readAtTime: new Date(readAt.time * 1000).toISOString(),
      spendable,
      earned,
      event: event && {
        kind: event.kind, transactionHash: event.txHash, block: event.block, evidenceRoot: event.evidenceRoot ?? null,
      },
    },
  };
}

/** The file as a data: URI, and the keccak256 of the JSON in it, for giveFeedback. */
function encodeFeedback(file) {
  const json = JSON.stringify(file);
  return {
    uri: `data:application/json;base64,${Buffer.from(json, 'utf8').toString('base64')}`,
    hash: ethers.keccak256(ethers.toUtf8Bytes(json)),
  };
}

// How far back the publisher looks among its own feedback on an agent for any still live.
const LOOKBACK = 8;

const valueOf = (f) => Number(f.value) / 10 ** Number(f.valueDecimals ?? 0);

/**
 * What to do for one agent, given the score it should show (`spendable`, or null for none, when
 * the agent is no longer linked to it) and the publisher's live sigvara/score feedback on it,
 * newest first ([{ index, value, valueDecimals }], from the last LOOKBACK it posted there).
 *
 * Returns { revoke: [indexes], post: bool }. Every live feedback but one that already holds the
 * score is revoked, so exactly one stays live. Normally there is at most one. There can be two
 * when a post lands after the publisher gave up waiting for it and posted again; the next update
 * then revokes the stale one too, instead of leaving it for getSummary to average in for ever.
 *
 * A revoke that landed without its post leaves nothing live: the retry posts without revoking.
 */
function planUpdate(spendable, live) {
  const keep = spendable === null ? null : live.find((f) => valueOf(f) === spendable) ?? null;
  return {
    revoke: live.filter((f) => f !== keep).map((f) => f.index),
    post: spendable !== null && keep === null,
  };
}

/**
 * Whether an agent may be posted to now: at most once per UTC day, except for a zero after a
 * slash, which goes out at once. `lastDay` is the UTC day of its last post, or undefined.
 */
function mayPostNow(lastDay, nowSeconds, zeroed) {
  return zeroed || lastDay !== utcDay(nowSeconds);
}

/**
 * Why posting is not allowed yet, as one line each; empty when it is (ADR 0008, Rollout). The
 * registration must be on chain, its agentWallet must be the publisher, the signer must sign as
 * the publisher, and the publisher must hold enough to pay for a run.
 *
 * No transaction of the publisher's may still be pending either. One that the publisher gave up
 * waiting for can land later; sending again before it settles is how one update becomes two.
 */
function liveGateProblems({ publisher, agentWallet, signerAddress, balance, minBalance, pendingTxs = 0 }) {
  const out = [];
  const same = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
  if (!agentWallet || /^0x0{40}$/i.test(agentWallet)) out.push("Sigvara's ERC-8004 registration has no agentWallet");
  else if (!same(agentWallet, publisher)) out.push(`the registration's agentWallet is ${agentWallet}, not the publisher ${publisher}`);
  if (signerAddress === null) out.push('the remote signer did not answer');
  else if (!same(signerAddress, publisher)) out.push(`the remote signer signs as ${signerAddress}, not the publisher ${publisher}`);
  if (balance < minBalance) out.push(`the publisher holds ${ethers.formatEther(balance)}, below the floor of ${ethers.formatEther(minBalance)}`);
  if (pendingTxs > 0) out.push(`${pendingTxs} transaction(s) from the publisher are still pending`);
  return out;
}

/** An ERC-8004 agent id in one spelling: "0897764" and 897764n are the same agent. */
const agentKey = (id) => BigInt(id).toString();

module.exports = {
  TAG1, TAG2, LOOKBACK, utcDay, feedbackFile, encodeFeedback, planUpdate, mayPostNow, liveGateProblems, agentKey,
};
