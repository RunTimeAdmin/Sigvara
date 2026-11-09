'use strict';
/**
 * A payer's signed "not delivered" under ADR 0011: held, then counted unless the agent refunded the payer.
 *
 * A negative is held for PAYER_NEGATIVE_HOLD_DAYS (7) from the time of the block its signature was checked at,
 * `payerOutcome.checkedAtMs`. That block is recorded with the outcome and an importing operator checks at the same
 * one, so every operator starts the hold at the same moment. A transfer from the agent to that payer, in the
 * payment's asset and on the payment's chain, of at least the payment's amount, after the payment and by the end
 * of the hold, cures it for good. A partial refund does not.
 *
 * Until a negative counts it reads as not reported, in the evidence and so in the score, the evidence root and
 * the checker's audit alike: they all take their evidence through `present`. It counts from MARGIN_MS after the
 * hold ends, once this operator has read the agent's transfers past the hold's end and found no refund. The
 * margin gives every operator time to finish that read. One that has not by then holds the agent's proposal and
 * its audit for the epoch (`unresolvedAt`), as a scan that is behind does, rather than read the negative
 * differently from the others.
 *
 * Negatives exist only under PAYER_OUTCOMES=both, so with the default `positive` none of this changes anything.
 */
const { ethers } = require('ethers');
const { TRANSFER_TOPIC } = require('./payments');

const NOT_DELIVERED = 2;
const DAY_MS = 86_400_000;
const DEFAULT_HOLD_DAYS = 7;
/** From the hold's end to when a negative counts: time for every operator to have read the refunds. */
const MARGIN_MS = 3_600_000;
/** At most this many reads per negative per epoch, so a long history is read over several epochs. */
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

/** When the hold ends: never, for an outcome recorded without its block's time. */
function holdEndMs(e, cfg) {
  const start = Number(e?.payerOutcome?.checkedAtMs);
  return Number.isSafeInteger(start) && start > 0 ? start + cfg.holdMs : Infinity;
}

const countsFromMs = (e, cfg) => holdEndMs(e, cfg) + MARGIN_MS;

/** Whether the negative counts in evidence chosen at `atMs`: held long enough, and read as not refunded. */
function counts(e, atMs, cfg) {
  return atMs >= countsFromMs(e, cfg) && e.refundCheck?.final === true && e.refundCheck.refunded === false;
}

/**
 * The events as a score made at `atMs` reads them: a payer negative that does not count yet, or was refunded,
 * reads as not reported (`success: null`). The same array when nothing changes.
 */
function present(events, atMs, cfg) {
  let changed = false;
  const out = events.map((e) => {
    if (!isPayerNegative(e) || counts(e, atMs, cfg)) return e;
    changed = true;
    return Object.freeze({ ...e, success: null });
  });
  return changed ? out : events;
}

/** Payer negatives that should count at `atMs` but whose refund read this operator has not finished. */
function unresolvedAt(events, atMs, cfg) {
  return events.filter((e) => isPayerNegative(e) && atMs >= countsFromMs(e, cfg) && e.refundCheck?.final !== true);
}

/** Payer negatives whose refund read is not finished. */
const toRead = (events) => events.filter((e) => isPayerNegative(e) && e.refundCheck?.final !== true);

const pad = (address) => ethers.zeroPadValue(ethers.getAddress(address), 32);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Reads the agent's transfers to the payer, continuing from where the last read stopped, and says whether the
 * negative is settled. It is settled as refunded as soon as a curing transfer is found, and as not refunded once
 * the read has passed a block at or after the hold's end without finding one.
 *
 * @param {object} e  the payment event, with its payerOutcome and any earlier refundCheck
 * @param {object} io
 * @param {(filter: object) => Promise<object[]>} io.getLogs
 * @param {(blockNumber: number) => Promise<number>} io.blockMs  a block's timestamp in ms
 * @param {string} io.asset  the payment's asset on its chain
 * @param {string} io.agent  the agent's address, which was paid
 * @param {number} io.headBlock  the newest block this operator treats as settled on that chain
 * @param {number} io.chunk  blocks per getLogs
 * @param {number} [io.paceMs]
 * @param {number} [io.maxReads]
 * @returns {Promise<{ final: boolean, refunded: boolean|null, readThroughBlock: number, txHash?: string, blockNumber?: number }>}
 */
async function readRefund(e, cfg, { getLogs, blockMs, asset, agent, headBlock, chunk, paceMs = 0, maxReads = MAX_READS_PER_EPOCH }) {
  const end = holdEndMs(e, cfg);
  const amount = BigInt(e.amount);
  const settledMs = Number(e.ts);
  const earlier = e.refundCheck;
  let from = Number.isSafeInteger(earlier?.readThroughBlock) ? earlier.readThroughBlock + 1 : Number(e.blockNumber);
  const topics = [TRANSFER_TOPIC, pad(agent), pad(e.payer)];
  let reads = 0;
  let through = from - 1;
  while (from <= headBlock && reads < maxReads) {
    const to = Math.min(headBlock, from + chunk - 1);
    const logs = await getLogs({ address: asset, topics, fromBlock: from, toBlock: to });
    reads += 1;
    const ordered = [...logs].sort((a, b) => (a.blockNumber - b.blockNumber) || ((a.index ?? a.logIndex ?? 0) - (b.index ?? b.logIndex ?? 0)));
    for (const log of ordered) {
      if (String(log.address).toLowerCase() !== String(asset).toLowerCase()) continue;
      if (BigInt(log.data) < amount) continue;
      const ms = await blockMs(log.blockNumber);
      if (ms <= settledMs || ms > end) continue;
      return { final: true, refunded: true, readThroughBlock: log.blockNumber, txHash: log.transactionHash, blockNumber: log.blockNumber };
    }
    through = to;
    from = to + 1;
    if (paceMs && from <= headBlock && reads < maxReads) await sleep(paceMs);
  }
  // Settled as not refunded only once the read has reached a block at or past the hold's end.
  const passedEnd = through >= Number(e.blockNumber) && (await blockMs(through)) >= end;
  return { final: passedEnd, refunded: passedEnd ? false : null, readThroughBlock: through };
}

module.exports = {
  readConfig,
  isPayerNegative,
  holdEndMs,
  countsFromMs,
  counts,
  present,
  unresolvedAt,
  toRead,
  readRefund,
  NOT_DELIVERED,
  MARGIN_MS,
  DEFAULT_HOLD_DAYS,
  MAX_READS_PER_EPOCH,
};
