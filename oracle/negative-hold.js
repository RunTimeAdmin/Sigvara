'use strict';
/**
 * A payer's signed "not delivered" under ADR 0011: held, then counted unless the agent refunded the payer.
 *
 * A negative is held for PAYER_NEGATIVE_HOLD_DAYS (7) from the time of the block its signature was checked at,
 * `payerOutcome.checkedAtMs`, and never from before the payer signed it. That block is recorded with the outcome and
 * an importing operator checks at the same one, so every operator starts the hold at the same moment; one that took
 * the same outcome later moves to the earlier block when it imports it (index.js). A transfer from the agent to that
 * payer, in the payment's asset and on the payment's chain, of at least the payment's amount, in a block after the
 * payment's and by the end of the hold, cures it for good. A partial refund does not. A refund is not used up: one
 * that meets the terms of several negatives cures each of them.
 *
 * Until a negative counts it reads as not reported, in the evidence and so in the score, the evidence root and
 * the checker's audit alike: they all take their evidence through `present`. It counts from MARGIN_MS after the
 * hold ends, once this operator has read the agent's transfers past the hold's end and found no refund. The
 * margin gives every operator time to finish that read. One that has not by then holds the agent's proposal and
 * its audit for the epoch (`unresolvedAt`), as a scan that is behind does, rather than read the negative
 * differently from the others.
 *
 * Negatives are taken only under PAYER_OUTCOMES=both. Those already taken are still held, read and counted after a
 * switch back to `positive` or `off` (ADR 0011, section 4); an operator that never ran `both` holds none.
 */
const { ethers } = require('ethers');
const { TRANSFER_TOPIC } = require('./payments');

const NOT_DELIVERED = 2;
const DAY_MS = 86_400_000;
const DEFAULT_HOLD_DAYS = 7;
/** From the hold's end to when a negative counts: time for every operator to have read the refunds. */
const MARGIN_MS = 3_600_000;
/** At least this many reads per negative per epoch; more when that would not reach the hold's end in time (readBudget). */
const MAX_READS_PER_EPOCH = 50;

/** @returns {{ holdMs: number }} */
function readConfig(env = process.env) {
  const raw = env.PAYER_NEGATIVE_HOLD_DAYS;
  const days = raw === undefined || String(raw).trim() === '' ? DEFAULT_HOLD_DAYS : Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > 30) {
    throw new Error(`PAYER_NEGATIVE_HOLD_DAYS must be a whole number from 1 to 30, got "${raw}"`);
  }
  return Object.freeze({ holdMs: days * DAY_MS });
}

/** A payment whose payer signed "not delivered". */
const isPayerNegative = (e) => e?.payerOutcome?.outcome === NOT_DELIVERED && e.success === false;

/**
 * When the hold starts: the time of the block the signature was checked at, or the time the payer signed when that
 * is later, since nobody can have taken it before then. NaN for an outcome recorded without its block's time.
 */
function holdStartMs(e) {
  const checked = Number(e?.payerOutcome?.checkedAtMs);
  if (!Number.isSafeInteger(checked) || checked <= 0) return NaN;
  const signed = Number(e.payerOutcome.signedAt) * 1000;
  return Number.isSafeInteger(signed) ? Math.max(checked, signed) : checked;
}

/**
 * When the hold ends: never, for an outcome recorded without its block's time. Once its refund read is final, the
 * end it was read against, so a later change of PAYER_NEGATIVE_HOLD_DAYS cannot move a settled negative.
 */
function holdEndMs(e, cfg) {
  const rc = e?.refundCheck;
  if (rc?.final === true && Number.isSafeInteger(rc.holdEndMs)) return rc.holdEndMs;
  const start = holdStartMs(e);
  return Number.isFinite(start) ? start + cfg.holdMs : Infinity;
}

const countsFromMs = (e, cfg) => holdEndMs(e, cfg) + MARGIN_MS;

/** Whether the negative counts in evidence chosen at `atMs`: held long enough, and read as not refunded. */
function counts(e, atMs, cfg) {
  return atMs >= countsFromMs(e, cfg) && e.refundCheck?.final === true && e.refundCheck.refunded === false;
}

// The last answer for each stored array, per config. For one array the negatives that count only grow with the time
// asked about, so an answer counting as many is the same answer, and handing back the same frozen array lets the
// evidence cache and the Merkle root cache hit, as payment-chains.eventsAt does.
const presented = new WeakMap();

/**
 * The events as a score made at `atMs` reads them: a payer negative that does not count yet, or was refunded,
 * reads as not reported (`success: null`). The same array when nothing changes, and for a frozen array the same
 * answer each time the same negatives count.
 */
function present(events, atMs, cfg) {
  let negatives = 0;
  let counting = 0;
  for (const e of events) {
    if (!isPayerNegative(e)) continue;
    negatives += 1;
    if (counts(e, atMs, cfg)) counting += 1;
  }
  if (counting === negatives) return events;
  const frozen = Object.isFrozen(events);
  let byArray = presented.get(cfg);
  if (!byArray) { byArray = new WeakMap(); presented.set(cfg, byArray); }
  const hit = frozen ? byArray.get(events) : undefined;
  if (hit && hit.counting === counting) return hit.out;
  const out = Object.freeze(events.map((e) => (!isPayerNegative(e) || counts(e, atMs, cfg) ? e : Object.freeze({ ...e, success: null }))));
  if (frozen) byArray.set(events, { counting, out });
  return out;
}

/** Payer negatives that should count at `atMs` but whose refund read this operator has not finished. */
function unresolvedAt(events, atMs, cfg) {
  return events.filter((e) => isPayerNegative(e) && atMs >= countsFromMs(e, cfg) && e.refundCheck?.final !== true);
}

/** Payer negatives that start to count after `fromMs` and by `toMs`. One found refunded never counts, so it is left out. */
function startingBetween(events, fromMs, toMs, cfg) {
  return events.filter((e) => isPayerNegative(e) && !(e.refundCheck?.final === true && e.refundCheck.refunded === true)
    && countsFromMs(e, cfg) > fromMs && countsFromMs(e, cfg) <= toMs);
}

/** Payer negatives whose refund read is not finished. */
const toRead = (events) => events.filter((e) => isPayerNegative(e) && e.refundCheck?.final !== true);

const pad = (address) => ethers.zeroPadValue(ethers.getAddress(address), 32);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How many reads one negative gets this epoch: enough to reach the hold's end by the time it counts, spread over the
 * epochs left until then, and never fewer than MAX_READS_PER_EPOCH. The blocks still to come are estimated from the
 * chain's own rate since the payment. A fast chain needs far more than the floor: Base Sepolia makes a block every
 * 0.2 s, about 3,000,000 in a 7-day hold, at 200 a read.
 */
function readBudget(e, cfg, { from, headBlock, headMs, chunk, epochMs }) {
  const end = holdEndMs(e, cfg);
  if (!Number.isFinite(end)) return MAX_READS_PER_EPOCH;
  const paidBlock = Number(e.blockNumber);
  const paidMs = Number(e.ts);
  const perMs = headMs > paidMs && headBlock > paidBlock ? (headBlock - paidBlock) / (headMs - paidMs) : 0;
  const endBlock = headBlock + Math.max(0, Math.ceil((end - headMs) * perMs));
  const epochsLeft = Math.max(1, Math.floor((countsFromMs(e, cfg) - headMs) / epochMs));
  return Math.max(MAX_READS_PER_EPOCH, Math.ceil(Math.max(0, endBlock - from + 1) / chunk / epochsLeft) + 1);
}

/**
 * Reads the agent's transfers to the payer, continuing from where the last read stopped, and says whether the
 * negative is settled. It is settled as refunded as soon as a curing transfer is found, and as not refunded once
 * the read has passed a block at or after the hold's end without finding one, and the same filter turned round
 * finds the payment itself. That is the payment scan's canary (index.js runScanCanary): an empty answer is believed
 * only from a node that answers this filter.
 *
 * A read that fails returns what it read before the failure, with the error, so the next one goes on from there.
 *
 * @param {object} e  the payment event, with its payerOutcome and any earlier refundCheck
 * @param {object} io
 * @param {(filter: object) => Promise<object[]>} io.getLogs
 * @param {(blockNumber: number) => Promise<number>} io.blockMs  a block's timestamp in ms
 * @param {string} io.asset  the payment's asset on its chain
 * @param {string} io.agent  the agent's address, which was paid
 * @param {number} io.headBlock  the newest block this operator treats as settled on that chain
 * @param {number} [io.headMs]  that block's time in ms, when the caller has read it already
 * @param {number} io.chunk  blocks per getLogs
 * @param {number} [io.paceMs]
 * @param {number} [io.maxReads]  by default MAX_READS_PER_EPOCH, or readBudget's when `epochMs` is given
 * @param {number} [io.epochMs]  how often the oracle reads, for readBudget
 * @param {number} [io.deadline]  this host's time to stop reading by
 * @returns {Promise<{ final: boolean, refunded: boolean|null, readThroughBlock: number, txHash?: string, blockNumber?: number, error?: Error }>}
 */
async function readRefund(e, cfg, { getLogs, blockMs, asset, agent, headBlock, headMs: knownHeadMs, chunk, paceMs = 0, maxReads, epochMs, deadline = Infinity }) {
  const end = holdEndMs(e, cfg);
  const amount = BigInt(e.amount);
  const paidBlock = Number(e.blockNumber);
  const earlier = e.refundCheck;
  let from = Number.isSafeInteger(earlier?.readThroughBlock) ? earlier.readThroughBlock + 1 : paidBlock;
  const before = from - 1;
  const topics = [TRANSFER_TOPIC, pad(agent), pad(e.payer)];
  let reads = 0;
  let through = before;
  let passedEnd = false;
  try {
    const headMs = Number.isFinite(knownHeadMs) ? knownHeadMs : await blockMs(headBlock);
    const budget = maxReads ?? (epochMs ? readBudget(e, cfg, { from, headBlock, headMs, chunk, epochMs }) : MAX_READS_PER_EPOCH);
    while (from <= headBlock && reads < budget && Date.now() < deadline) {
      const to = Math.min(headBlock, from + chunk - 1);
      const logs = await getLogs({ address: asset, topics, fromBlock: from, toBlock: to });
      reads += 1;
      const ordered = [...logs].sort((a, b) => (a.blockNumber - b.blockNumber) || ((a.index ?? a.logIndex ?? 0) - (b.index ?? b.logIndex ?? 0)));
      for (const log of ordered) {
        if (String(log.address).toLowerCase() !== String(asset).toLowerCase()) continue;
        if (BigInt(log.data) < amount) continue;
        // After the payment means in a later block: blocks share whole-second times, so the time cannot tell.
        if (!(log.blockNumber > paidBlock)) continue;
        if ((await blockMs(log.blockNumber)) > end) continue;
        return { final: true, refunded: true, readThroughBlock: log.blockNumber, txHash: log.transactionHash, blockNumber: log.blockNumber };
      }
      through = to;
      from = to + 1;
      // Nothing after the hold's end can cure it, so the read stops once past it. Asked only once the head is.
      if (headMs >= end && (await blockMs(through)) >= end) { passedEnd = true; break; }
      if (paceMs && from <= headBlock && reads < budget) await sleep(paceMs);
    }
    if (passedEnd) {
      const own = await getLogs({ address: asset, topics: [TRANSFER_TOPIC, pad(e.payer), pad(agent)], fromBlock: paidBlock, toBlock: paidBlock });
      if (!own.some((l) => String(l.transactionHash).toLowerCase() === String(e.txHash).toLowerCase())) {
        // The node did not find the payment with the same filter, so what it found above proves nothing.
        return { final: false, refunded: null, readThroughBlock: before, error: new Error(`the same filter did not find the payment itself in block ${paidBlock}`) };
      }
    }
  } catch (error) {
    return { final: false, refunded: null, readThroughBlock: through, error };
  }
  // Settled as not refunded only once the read has reached a block at or past the hold's end.
  return { final: passedEnd, refunded: passedEnd ? false : null, readThroughBlock: through };
}

/**
 * The order the negatives still to read are read in, the most urgent first: one whose hold start is not dated yet
 * (one read dates it), then by when each counts, then by agent and payment, so that every operator reads them alike.
 *
 * @param {Array<{ didHash: string, e: object }>} items
 */
function readOrder(items, cfg) {
  const at = (x) => countsFromMs(x.e, cfg);
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return [...items].sort((x, y) => {
    const dx = Number.isFinite(at(x));
    const dy = Number.isFinite(at(y));
    return (Number(dx) - Number(dy)) || (dx && dy ? at(x) - at(y) : 0)
      || cmp(String(x.didHash), String(y.didHash)) || cmp(String(x.e.txHash), String(y.e.txHash));
  });
}

/**
 * Reads each of `items` with `read`, in readOrder, and checks `deadline` before each one, so that an epoch's time for
 * reading refunds bounds every read it makes for them, not only the getLogs inside readRefund. Returns how many it
 * did not reach.
 */
async function readInTurn(items, cfg, { deadline, read, now = Date.now }) {
  const queue = readOrder(items, cfg);
  for (let i = 0; i < queue.length; i += 1) {
    if (now() >= deadline) return queue.length - i;
    await read(queue[i]);
  }
  return 0;
}

module.exports = {
  readConfig,
  isPayerNegative,
  holdStartMs,
  holdEndMs,
  countsFromMs,
  counts,
  present,
  unresolvedAt,
  startingBetween,
  toRead,
  readBudget,
  readRefund,
  readOrder,
  readInTurn,
  NOT_DELIVERED,
  MARGIN_MS,
  DEFAULT_HOLD_DAYS,
  MAX_READS_PER_EPOCH,
};
