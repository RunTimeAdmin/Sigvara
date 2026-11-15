'use strict';

/**
 * Reading a credit again once its block is final (docs/adr/0012-a-credit-a-reorganization-removed.md).
 *
 * A payment on the scored chain is credited once its block is final, and its hash stays used for good. If the chain
 * then replaced that block anyway, the credit would count for a transaction that is no longer there. So each credit is
 * read once more, in the first epoch after its block is at or below the finalized block, and one the chain no longer
 * holds is given `removedAt`: the time of the finalized block it was read against. Evidence leaves it out from then on
 * (payment-chains.eventsAt, and auditOptions in index.js), every root made before still reproduces, and the hash stays
 * used, so a transaction put back in a later block is not credited again.
 *
 * Nothing is removed on an answer that could be a node's rather than the chain's. A receipt is the first read. When
 * there is none, which is also how a node that prunes its receipt index answers for an old payment, the block's own list
 * of transactions decides whether the transaction is still in it, and its logs whether the transfer is. Anything else
 * leaves the credit to be read again next epoch.
 */

const { ethers } = require('ethers');
const { decodeTransfer, TRANSFER_TOPIC } = require('./payment-scan');

const lower = (a) => String(a || '').toLowerCase();

/**
 * The scored chain's credits to read again, oldest block first: each with a block, at or below `finalizedBlock`, not
 * read again yet, for an agent whose address is known. A credit stored before blocks were kept has none to read at.
 *
 * @param {Map<string, object[]>|Iterable<[string, object[]]>} eventsByDid
 * @param {number} finalizedBlock
 * @param {(didHash: string) => string|null} addressOf
 */
function toReread(eventsByDid, finalizedBlock, addressOf) {
  const out = [];
  for (const [didHash, events] of eventsByDid) {
    const agent = addressOf(didHash);
    if (!agent) continue;
    for (const e of events) {
      if (e.chainId != null || !Number.isInteger(e.blockNumber) || e.blockNumber > finalizedBlock) continue;
      if (e.rereadBlock !== undefined || e.removedAt !== undefined) continue;
      out.push({ didHash, agent, e });
    }
  }
  return out.sort((a, b) => a.e.blockNumber - b.e.blockNumber);
}

/** What `payer` moved to `agent` in `asset` in these logs of transaction `txHash`, in base units. */
function paidIn(logs, { txHash, payer, agent, asset }) {
  let sum = 0n;
  for (const log of logs || []) {
    if (log.transactionHash != null && lower(log.transactionHash) !== lower(txHash)) continue;
    const t = decodeTransfer(log, asset);
    if (t && lower(t.from) === lower(payer) && lower(t.to) === lower(agent)) sum += BigInt(t.amount);
  }
  return sum;
}

/**
 * Read one credit again. Returns `{ kept: true }`, `{ removed: reason }`, or `{ unsure: why }` when the reads do not
 * settle it, in which case it is read again next epoch.
 *
 * Reasons: `other_block` (the receipt is in another block now), `transfer_changed` (the receipt no longer holds the
 * credited transfer, or reverted), `not_in_block` (no receipt, and the block no longer holds the transaction).
 *
 * @param {{ txHash: string, payer: string, amount: string, blockNumber: number }} e  the credit
 * @param {object} ctx
 * @param {string} ctx.agent   the agent's address, the transfer's recipient
 * @param {string} ctx.asset   the payment asset
 * @param {(txHash: string) => Promise<object|null>} ctx.getReceipt
 * @param {(n: number) => Promise<object|null>} ctx.getBlock  a block with its transaction hashes
 * @param {(filter: object) => Promise<object[]>} ctx.getLogs
 */
async function reread(e, { agent, asset, getReceipt, getBlock, getLogs }) {
  const want = { txHash: e.txHash, payer: e.payer, agent, asset };
  const amount = BigInt(e.amount);
  const receipt = await getReceipt(e.txHash);
  if (receipt) {
    if (receipt.blockNumber !== e.blockNumber) return { removed: 'other_block' };
    if (receipt.status !== 1 || paidIn(receipt.logs, want) !== amount) return { removed: 'transfer_changed' };
    return { kept: true };
  }
  const block = await getBlock(e.blockNumber);
  if (!block || !Array.isArray(block.transactions)) return { unsure: `block ${e.blockNumber} came back without its transactions` };
  if (!block.transactions.some((h) => lower(typeof h === 'string' ? h : h?.hash) === lower(e.txHash))) {
    return { removed: 'not_in_block' };
  }
  const pad = (address) => ethers.zeroPadValue(ethers.getAddress(address), 32);
  const logs = await getLogs({
    address: asset, topics: [TRANSFER_TOPIC, pad(e.payer), pad(agent)], fromBlock: e.blockNumber, toBlock: e.blockNumber,
  });
  if (paidIn(logs, want) === amount) return { kept: true };
  return { unsure: `no receipt, and block ${e.blockNumber}'s logs do not show the credited transfer` };
}

module.exports = { toReread, paidIn, reread };
