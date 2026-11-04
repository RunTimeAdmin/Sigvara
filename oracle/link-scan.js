'use strict';

// The scan for links made on chain, and the test of whether a claim holds, shared by the oracle
// (index.js) and the ERC-8004 publisher (publisher.js). Both must find the same links by the same
// rules, so the rules live here once. link-claims.js is the arithmetic; this is the reading.

const linkClaims = require('./link-claims');

// A span the node refuses for its size or does not answer in time is halved. A rate limit is
// not: a smaller span would only be throttled the same way.
const spanTooBig = (err) => {
  const msg = String((err && err.message) || err);
  return !/rate limit|429|too many requests/i.test(msg) && /more than \d+|too many results|response size|block range|timeout/i.test(msg);
};

/**
 * A scanner over one state slot. `chain` and `external` are the modules of the same names (or
 * their fakes); `getState`, `setState` and `persist` hold { cursor, claims } wherever the caller
 * keeps it. `fromBlock` is EXTERNAL_LINK_FROM_BLOCK and `chunkSize` the most blocks one read spans.
 */
function createLinkScanner({ chain, external, fromBlock, chunkSize, getState, setState, persist }) {
  // Retried in place, like any read, except a timeout, which halving the span answers better.
  const retryLinkRead = (err) => chain.isTransientReadError(err) && !/timeout/i.test(String((err && err.message) || err));
  const startCursor = () => getState()?.cursor ?? { block: fromBlock, logIndex: 0 };

  /**
   * Whether a claim was made by the operator of the Sigvara agent it names: as of the log's block,
   * the 8004 agent still names the didHash and is owned by that operator, and it was owned by the
   * same operator in the block before. Without the second test, a contract could mint an 8004 agent,
   * set the key to someone else's didHash and give the NFT to that agent's operator, all in one
   * transaction, and the claim would hold.
   *
   * The reads stop at the first one that fails, and `cache` keeps them for one scan, so a burst of
   * claims from one 8004 agent in one block costs one ownership read, not one each.
   */
  async function claimMadeByOperator({ didHash, agentId, block }, cache) {
    const once = (key, fn) => {
      if (!cache.has(key)) cache.set(key, fn());
      return cache.get(key);
    };
    try {
      const { operator } = await once(`operator ${didHash} ${block}`, () => chain.getAgentInfo(didHash, block));
      if (/^0x0{40}$/i.test(String(operator))) return false;
      const before = await once(`owner ${agentId} ${block - 1}`,
        () => chain.readWithBackoff('link owner', () => external.ownerAt(agentId, block - 1)));
      if (before.toLowerCase() !== String(operator).toLowerCase()) return false;
      return await chain.readWithBackoff('link claim', () => external.claimHolds(agentId, linkClaims.LINK_KEY, didHash, operator, block));
    } catch (err) {
      // A node that could not answer stops the scan, which resumes at this log next time. Anything
      // else, such as an 8004 agent that did not exist in the block before, is not the operator's claim.
      if (chain.isTransientReadError(err)) throw err;
      return false;
    }
  }

  /**
   * Reads the `sigvara` MetadataSet logs in blocks [from, to] a span at a time, oldest first, and
   * hands each span's logs to `onLogs(logs, end)`. Paced like the registry scan, so a long catch-up
   * is not a burst.
   */
  async function eachLinkSpan(from, to, onLogs) {
    let start = from;
    let span = chunkSize;
    while (start <= to) {
      const end = Math.min(start + span - 1, to);
      let logs;
      try {
        logs = await chain.readWithBackoff('link logs', () => external.readLinkLogs(linkClaims.LINK_KEY, start, end), 4, retryLinkRead);
      } catch (err) {
        if (end > start && spanTooBig(err)) { span = Math.ceil((end - start + 1) / 2); continue; }
        throw err;
      }
      await onLogs(logs, end);
      start = end + 1;
      span = chunkSize;
      if (start <= to) await new Promise((r) => setTimeout(r, 400));
    }
  }

  /**
   * Reads the MetadataSet logs for the `sigvara` key since the last scan, up to the head or `upTo`,
   * and keeps the claims made by the operator of the Sigvara agent they name (claimMadeByOperator).
   * Returns how many it kept, and hands each one to `onClaim` when given.
   *
   * The operator test is made here, as of the log's block, and not only when a link is used: anyone
   * can set `sigvara` on an 8004 agent of their own, and enough such claims on one didHash would
   * push its operator's out of the list. Read as of the log's block, every reader decides the same.
   *
   * Anyone can also post such logs in bulk to slow the scan. With `known`, the set of registered
   * didHashes, one naming any other agent costs no read; and the checkpoint moves after every log,
   * so a scan cut short resumes where it stopped.
   */
  async function scan({ known = null, upTo = Infinity, onClaim = null } = {}) {
    const state = getState() ?? { cursor: null, claims: {} };
    if (!state.cursor) state.cursor = startCursor();
    const head = await chain.readWithBackoff('head', () => external.latestBlock());
    const to = Math.min(head, upTo);
    const cache = new Map();
    let found = 0;
    try {
      await eachLinkSpan(state.cursor.block, to, async (logs, end) => {
        for (const log of logs) {
          if (linkClaims.isBefore(log, state.cursor)) continue;
          const claim = linkClaims.claimFromLog(log);
          if (claim && (!known || known.has(claim.didHash)) && await claimMadeByOperator(claim, cache)) {
            linkClaims.addClaim(state.claims, claim);
            found++;
            if (onClaim) onClaim(claim);
          }
          state.cursor = { block: log.blockNumber, logIndex: log.logIndex + 1 };
        }
        state.cursor = { block: end + 1, logIndex: 0 };
      });
    } finally {
      setState(state);
      persist();
    }
    return found;
  }

  /**
   * The didHashes named by `sigvara` logs that the scan has not checked yet, up to `block`. Listing
   * them takes the logs alone and no read per log, so it answers when the checks cannot keep up.
   * Only these agents can hold a link this reader has not found and another has; every other
   * agent's links up to `block` are all known. Throws when the logs cannot be read.
   */
  async function uncheckedAgents(block) {
    const cursor = startCursor();
    const named = new Set();
    await eachLinkSpan(cursor.block, block, async (logs) => {
      for (const log of logs) {
        if (linkClaims.isBefore(log, cursor)) continue;
        const claim = linkClaims.claimFromLog(log);
        if (claim) named.add(claim.didHash);
      }
    });
    return named;
  }

  /** Whether the scan has seen every claim made at or before `block`. */
  function covers(block) {
    return linkClaims.scanCovers(getState()?.cursor ?? null, fromBlock, block);
  }

  function hasClaims(didHash) {
    return linkClaims.candidatesAt(getState()?.claims, didHash).length > 0;
  }

  /**
   * The 8004 agent `didHash` is linked to on chain as of `blockTag` when given: the newest claim
   * made by then that still holds there, or undefined. A claim holds while the 8004 agent still
   * names this didHash and is owned by `operator`, so clearing the key or moving the NFT undoes
   * the link, with nothing to tell the reader. Throws when the node could not answer.
   */
  async function claimedAgentAt(didHash, operator, blockTag) {
    for (const agentId of linkClaims.candidatesAt(getState()?.claims, didHash, blockTag)) {
      try {
        const holds = await chain.readWithBackoff('link claim', () => external.claimHolds(agentId, linkClaims.LINK_KEY, didHash, operator, blockTag));
        if (holds) return agentId;
      } catch (err) {
        // A node that could not answer: the caller skips the agent this time. Anything else, such
        // as an agent id the registry does not have, is a claim that does not hold.
        if (chain.isTransientReadError(err)) throw err;
      }
    }
    return undefined;
  }

  return { scan, uncheckedAgents, covers, hasClaims, claimedAgentAt };
}

module.exports = { createLinkScanner };
