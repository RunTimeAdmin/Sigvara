'use strict';

/**
 * Payment evidence by pull — ADR 0003.
 *
 * A payment settles on chain as an ERC-20 Transfer to the agent's address. Until now it
 * entered an operator's state only when somebody POSTed the settlement hash to *that*
 * operator. The verification was always chain-based; only the notification was not, and
 * with two operators that difference stopped being invisible: six payers paid the demo
 * agent, every settlement was attested to the primary, and the checker — same chain,
 * same code, same rules — scored 23 SVR against the primary's 3,023. Nobody misbehaved.
 * The evidence simply never arrived, because arrival was per-operator and by HTTP.
 *
 * So each operator finds payments itself, by scanning the same Transfer logs it could
 * already verify. Two operators with the same chain view then converge by construction,
 * and a divergence afterwards means a real disagreement rather than a delivery failure.
 * It also closes whitepaper §5.4.6 from the other side: work an agent was paid for is no
 * longer invisible because nobody filled in a form.
 *
 * ## What a pulled payment is, and is not
 *
 * It is evidence that money moved: fee volume and tenure. It is evidence of nothing at
 * all about how the work went, so it is credited with `success: null` and payments.js
 * keeps it out of both sides of the success ratio. Outcomes stay push, because "the job
 * was good" is not on chain and never will be.
 *
 * Recording it as `false` would damage an agent nobody complained about. Recording it as
 * `true` would invent evidence. Both are worse than the payment remaining invisible,
 * which is the defect being fixed.
 *
 * ## What it does not weaken
 *
 * Every existing defence survives unchanged, because none of them depended on the
 * attestation being the entry point. The payer is read from the transfer log rather than
 * asserted — that was already true. Self-payments are refused here too. `maxPerPayer`
 * still caps what one counterparty contributes, and volume still decays.
 *
 * The honest way to put it: this changes who notices a payment, not what a payment has
 * to survive to count.
 */

const { ethers } = require('ethers');

/** Transfer(address indexed from, address indexed to, uint256 value). */
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

/**
 * Recipients per getLogs call.
 *
 * A topic filter is an OR-list and nodes cap how long it may be, so the agent set is
 * queried in batches rather than in one filter that silently fails once the registry
 * grows. Conservative on purpose: the cost of another round trip is a round trip, and
 * the cost of an over-long filter is a scan that returns nothing and looks like an
 * agent with no income.
 */
const MAX_RECIPIENTS_PER_CALL = 50;

/** Floor for how far behind the head an unattended scan credits. */
const MIN_SCAN_CONFIRMATIONS = 6;

function readConfig(env = process.env) {
  return {
    // Off by default. Turning it on is ADR 0003 landing, and it changes scores: an
    // operator that has been missing payments starts counting them. That is the point,
    // and it is not something to have happen by surprise during a slash drill.
    enabled: env.PAYMENT_SCAN_ENABLED === '1',
    // Where to begin when there is no checkpoint. Scanning from genesis on a busy chain
    // is the fastest way to be rate-limited into never finishing.
    fromBlock: Number(env.PAYMENT_SCAN_FROM_BLOCK || env.FROM_BLOCK || 0),
    chunkSize: Math.max(1, Number(env.PAYMENT_SCAN_CHUNK || env.LOG_CHUNK_SIZE || 2000)),
    // Blocks to stay behind the head. A log in the most recent block can still be
    // reorganised away, and a credit is not something this system takes back: the tx
    // hash is recorded as used, so a reorg leaves a credit for a transaction that no
    // longer exists.
    //
    // Deeper than the attested path's default of 1, and deliberately so. An attestation
    // is a deliberate act by someone who saw the transaction settle; a scan credits
    // unattended, every epoch, with nobody looking. The floor is 6 and an explicit
    // setting may raise it but not lower it below what the attested path requires.
    confirmations: Math.max(
      MIN_SCAN_CONFIRMATIONS,
      Number(env.PAYMENT_SCAN_CONFIRMATIONS || env.PAYMENT_MIN_CONFIRMATIONS || 0),
    ),
  };
}

const pad = (address) => ethers.zeroPadValue(ethers.getAddress(address), 32);
const lower = (a) => String(a || '').toLowerCase();

/** Split the agent set into filter-sized batches. */
function recipientBatches(addresses, max = MAX_RECIPIENTS_PER_CALL) {
  const out = [];
  for (let i = 0; i < addresses.length; i += max) out.push(addresses.slice(i, i + max));
  return out;
}

/** Inclusive [from, to] ranges of at most `chunkSize` blocks. */
function blockRanges(fromBlock, toBlock, chunkSize) {
  const out = [];
  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    out.push([start, Math.min(start + chunkSize - 1, toBlock)]);
  }
  return out;
}

/**
 * Decode one Transfer log, or null when it is not one.
 *
 * `from` and `to` come out of the topics, which is the whole reason this is trustworthy:
 * the payer is read off the chain, never taken from a caller.
 */
function decodeTransfer(log) {
  if (!log || !Array.isArray(log.topics) || log.topics[0] !== TRANSFER_TOPIC) return null;
  if (log.topics.length < 3) return null; // a non-standard Transfer without indexed parties
  return {
    txHash: log.transactionHash,
    blockNumber: log.blockNumber,
    logIndex: log.logIndex,
    from: ethers.getAddress('0x' + log.topics[1].slice(26)),
    to: ethers.getAddress('0x' + log.topics[2].slice(26)),
    amount: BigInt(log.data).toString(),
  };
}

/**
 * Decide what to credit, and say what was skipped and why.
 *
 * Pure. No provider, no state mutation. Everything it refuses is named rather than
 * dropped, because a silent filter here is indistinguishable from an agent that was
 * never paid, and that ambiguity is what this whole change exists to remove.
 *
 * Transfers are summed per (transaction, recipient) to match what `verifyPayment`
 * already does with a receipt: one settlement transaction is one payment, whatever
 * number of Transfer events it contains.
 *
 * @param {Array} decoded from decodeTransfer
 * @param {object} opts
 *   @param {(address:string) => string|null} opts.didHashOf recipient address -> didHash
 *   @param {(address:string) => string|null} opts.operatorOf didHash -> operator address
 *   @param {(txHash:string, didHash:string) => boolean} opts.isUsed already credited
 *          for THAT agent. One transaction can pay several, so the hash alone is not
 *          the question being asked.
 *   @param {bigint} opts.minAmount
 */
function planCredits(decoded, opts) {
  const { didHashOf, operatorOf = () => null, isUsed = () => false, minAmount = 0n } = opts;

  // (txHash, recipient, sender) -> accumulated
  //
  // The sender is part of the key, not something chosen afterwards. Two payers can credit
  // one agent in a single transaction, and picking one of them to represent both lost who
  // actually paid, which the per-payer cap, distinct counterparty count, propagation and
  // the self-payment check all depend on. It also made this path disagree with the
  // attested one, which chose the largest contributor where this chose the earliest log:
  // same transaction, same agent, different payer, and a divergence between two honest
  // operators is evidence for the slashing committee.
  const grouped = new Map();
  const skipped = [];

  for (const t of decoded) {
    if (!t) continue;
    const didHash = didHashOf(t.to);
    if (!didHash) {
      // A transfer to somebody who is not a registered agent. Not a problem, just not
      // ours; recorded at debug volume only, so it is not reported as a skip.
      continue;
    }
    const key = `${lower(t.txHash)}|${lower(t.to)}|${lower(t.from)}`;
    const cur = grouped.get(key) ?? {
      didHash, txHash: t.txHash, to: t.to, from: t.from,
      amount: 0n, blockNumber: t.blockNumber,
    };
    cur.amount += BigInt(t.amount);
    grouped.set(key, cur);
  }

  const credits = [];
  for (const g of grouped.values()) {
    const reject = (reason) => skipped.push({
      txHash: g.txHash, didHash: g.didHash, payer: g.from, amount: g.amount.toString(), reason,
    });

    // Per agent, not per transaction: a batch payout credits each recipient it paid.
    if (isUsed(g.txHash, g.didHash, g.from)) { reject('already_credited'); continue; }
    if (g.amount < minAmount) { reject('below_minimum'); continue; }
    // Same rule as the attested path: an operator paying its own agent costs only gas,
    // and the money comes straight back.
    if (lower(g.from) === lower(g.to)) { reject('self_payment'); continue; }
    const operator = operatorOf(g.didHash);
    if (operator && lower(g.from) === lower(operator)) { reject('self_payment'); continue; }

    credits.push({
      didHash: g.didHash,
      txHash: g.txHash,
      payer: g.from,
      amount: g.amount.toString(),
      blockNumber: g.blockNumber,
      // The point of ADR 0003. Money moving is on chain; how the work went is not.
      success: null,
    });
  }

  return { credits, skipped };
}

// ---------------------------------------------------------------------------
// Canary
// ---------------------------------------------------------------------------

/**
 * Why an empty scan needs proving rather than believing.
 *
 * A getLogs call that matches nothing returns the same empty array whether nothing
 * happened or the query was wrong. Wrong asset, wrong chain, a topic filter grown long
 * enough that the node quietly stops matching: each of those reads as a set of agents
 * who were never paid, which is exactly the conclusion this scanner exists to stop
 * anyone drawing by accident.
 *
 * A probe with no recipient filter is not enough. It proves the asset and chain are
 * right, and then leaves the normal case ("this asset moved, but not to any of our
 * agents") indistinguishable from a broken recipient filter.
 *
 * So the canary re-runs the same filter shape against a payment already known to exist:
 * one recipient, one block, one expected transaction. If that comes back empty, the
 * mechanism is broken and an empty scan means nothing. It costs one getLogs, and only
 * when a scan credited nothing, which is the only time the answer matters.
 *
 * With no prior payment to point at there is no canary, and the verdict is `unavailable`
 * rather than `passed`. A check that reports success when it did not run is the failure
 * it was written to prevent.
 */

/**
 * Choose a known payment to re-find. Pure.
 *
 * @param {Map<string, Array<{txHash:string}>>} eventsByDid
 * @param {(didHash:string) => string|null} addressOf recipient address for an agent
 */
function pickCanary(eventsByDid, addressOf) {
  for (const [didHash, events] of eventsByDid) {
    const recipient = addressOf(didHash);
    if (!recipient) continue;
    // The newest, because an old settlement may sit outside whatever block range a
    // pruned node still serves.
    for (let i = events.length - 1; i >= 0; i--) {
      const txHash = events[i] && events[i].txHash;
      if (txHash) return { didHash, recipient, txHash };
    }
  }
  return null;
}

/** The same filter shape the scan uses, narrowed to one recipient and one block. */
function canaryFilter(asset, recipient, blockNumber) {
  return {
    address: asset,
    topics: [TRANSFER_TOPIC, null, [pad(recipient)]],
    fromBlock: blockNumber,
    toBlock: blockNumber,
  };
}

/**
 * Did the filter find the transaction it was pointed at?
 *
 * `failed` is the loud one: the query mechanism does not work, so an empty scan carries
 * no information and must not be reported as a quiet range.
 */
function canaryVerdict(logs, expectedTxHash) {
  if (!Array.isArray(logs)) return 'failed';
  const want = lower(expectedTxHash);
  return logs.some((l) => lower(l && l.transactionHash) === want) ? 'passed' : 'failed';
}

/**
 * The highest block safe to credit from.
 *
 * Staying behind the head by `confirmations` because a log in the most recent block can
 * still be reorganised away, and a credited payment is not something this system takes
 * back: the tx hash is recorded as used, so a reorg would leave a credit for a
 * transaction that no longer exists.
 */
function safeHead(head, confirmations) {
  return Math.max(0, head - confirmations);
}

/**
 * How far the checkpoint may advance after processing a range.
 *
 * Not simply `to`. A credit whose block timestamp could not be read is left uncredited,
 * and if the checkpoint moved past it anyway that payment would never be looked at
 * again: the scan only ever moves forward. The first version of this carried a comment
 * saying such a credit was "left for next time" while advancing the checkpoint past it,
 * which is the worst kind of wrong — an asserted safety property that is not there.
 *
 * So the checkpoint stops one block short of the earliest block still unresolved, and
 * the next scan retries from there. Returns null when nothing may be committed at all,
 * which is the case where the very first block of the range is the unresolved one.
 *
 * @param {Array<{blockNumber:number}>} unresolved credits with no usable timestamp
 */
function checkpointAfter(unresolved, from, to) {
  if (!unresolved.length) return to;
  const earliest = unresolved.reduce((m, c) => Math.min(m, c.blockNumber), Infinity);
  const candidate = earliest - 1;
  return candidate >= from ? candidate : null;
}

/**
 * Fetch Transfer logs to a set of recipients over a block range.
 *
 * `readLogs` is injected so the caller supplies its own backoff; this module does not
 * own retry policy and should not grow a second one beside chain.js's.
 */
async function scanRange({ readLogs, asset }, recipients, fromBlock, toBlock, chunkSize) {
  const out = [];
  for (const batch of recipientBatches(recipients)) {
    const topics = [TRANSFER_TOPIC, null, batch.map(pad)];
    for (const [start, end] of blockRanges(fromBlock, toBlock, chunkSize)) {
      const logs = await readLogs({ address: asset, topics, fromBlock: start, toBlock: end });
      out.push(...logs);
    }
  }
  return out;
}

module.exports = {
  TRANSFER_TOPIC,
  MAX_RECIPIENTS_PER_CALL,
  readConfig,
  recipientBatches,
  blockRanges,
  decodeTransfer,
  planCredits,
  safeHead,
  checkpointAfter,
  pickCanary,
  canaryFilter,
  canaryVerdict,
  MIN_SCAN_CONFIRMATIONS,
  scanRange,
};
