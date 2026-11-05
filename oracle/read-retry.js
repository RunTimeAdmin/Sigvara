'use strict';

// Whether a read failed because of the node, and trying it again. On its own because external.js needs
// it, and external.js cannot load chain.js: chain.js loads reviewers.js, which loads external.js.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The most calls to put in one JSON-RPC batch. Arc's public RPC answers 20 and refuses the 21st on
// with a per-item rate limit (measured 4 November 2026), which ethers reports as CALL_EXCEPTION,
// missing revert data, so it reads like a failed call and gets retried. ethers would otherwise
// send up to 100.
const MAX_BATCH_CALLS = 20;

/**
 * A contract read, retried on the failures that are the node's fault rather than the
 * contract's.
 *
 * chain.js's queryWithBackoff does this for the log scan and nothing did it for the reads,
 * and the gap cost a real epoch. A scan burst exhausted a free-tier RPC's request
 * budget, the per-agent reads that followed inherited the throttling with no retry, and
 * every agent failed with CALL_EXCEPTION. The epoch then reported "0 proposed, 0
 * finalized, 0 diverged" and exited cleanly, which reads exactly like agreement. A
 * checker that silently audits nothing is worse than one that is visibly down.
 *
 * Retrying CALL_EXCEPTION needs justifying, because that is normally how a revert
 * arrives. The distinction is `err.data`: a genuine revert carries its payload there and
 * is rethrown on the first attempt. `data: null` means the node declined to execute at
 * all. Every call wrapped here is a view over plain storage that cannot revert for a
 * well-formed didHash, so no-data is a transport failure wearing a contract error's
 * clothes.
 *
 * Deliberately not applied to writes. proposeScore and finalizeScore race other parties
 * for one slot, and retrying a submission that may already be in the mempool is how you
 * pay twice for one epoch.
 */
/**
 * Whether a read failed because of the node and not because of what was asked of it: a throttle, a
 * timeout, a dropped connection, a call that came back empty with no revert data. readWithBackoff
 * retries these. A caller that is about to read a failed answer as "none" has to refuse to for these,
 * because the failure says nothing about the thing it was asking about.
 */
function isTransientReadError(err) {
  const msg = String((err && err.message) || err);
  const code = err && err.code;
  return /rate limit|429|too many requests|timeout|etimedout|econnreset|socket hang up/i.test(msg) ||
    code === 'SERVER_ERROR' || code === 'NETWORK_ERROR' || code === 'TIMEOUT' ||
    (code === 'CALL_EXCEPTION' && (err.data === null || err.data === undefined));
}

async function readWithBackoff(label, fn, attempts = 4, retryable = isTransientReadError) {
  let delay = 500;
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const code = err && err.code;
      if (!retryable(err) || i >= attempts - 1) throw err;
      console.log(`[oracle] ${label} failed (${code || 'error'}), retrying in ${delay}ms`);
      await sleep(delay);
      delay *= 2;
    }
  }
}

module.exports = { isTransientReadError, readWithBackoff, MAX_BATCH_CALLS };
