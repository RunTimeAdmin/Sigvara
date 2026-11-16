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

/**
 * True when the node refused the request because we are being throttled, rather than
 * because anything is wrong with the transaction.
 *
 * Reads already treat throttling as transient and retry, in readWithBackoff. Writes
 * deliberately do not, and that is unchanged here: proposeScore and finalizeScore race
 * other parties for one slot, and resending something that may already be in the mempool
 * is how you pay twice for one epoch. This only names the cause.
 *
 * Naming it matters because the alternative was counting it as a propose failure.
 * `proposeErrors` should mean this operator could not do its job; on the live checker it
 * also meant the provider said slow down, which is a different problem with a different
 * fix, and the log line was a wall of JSON-RPC payload rather than a sentence.
 *
 * -32005 is the JSON-RPC code providers use for this. ethers wraps it in "could not
 * coalesce error" with the original nested inside, so the string match is doing real work
 * and is not just belt and braces.
 *
 * An HTTP 429 arrives in other words. ethers retries one itself until its attempts run out,
 * and rpc-provider.js allows one, so the error says "exceeded maximum retry limit", and the
 * 429 survives only in the status of the response ethers escalated ("CLIENT ESCALATED SERVER
 * ERROR (429 Too Many Requests; ...)"). Read only the short message, it looked like any
 * other server error, and the checker's node, which answers a burst with a 429, kept the
 * short schedule (16 November 2026).
 */
function isRateLimited(err) {
  if (!err) return false;
  const nested = err.error || err.info?.error || {};
  if (nested.code === -32005 || err.code === -32005) return true;
  if (/\b429\b|too many requests/i.test(String(err.response?.statusMessage ?? ''))) return true;
  return /rate limit|429|too many requests|exceeded maximum retry limit/i.test(
    String(err.shortMessage || err.message || '')
  );
}

// A refusal for the node's rate limit is tried again on a longer schedule than other failures: up to
// RATE_LIMIT_ATTEMPTS tries, the wait doubling to at most RATE_LIMIT_MAX_WAIT_MS, about 24 s at most in all. Each wait is
// between half and all of its step, so reads refused together do not all come back together. ethers used to retry an
// HTTP 429 inside each try, for minutes (rpc-provider.js stopped that), and the checker's node answers a burst with one:
// four tries over 3.5 s left 2 to 4 agents an hourly epoch unread (16 November 2026).
const RATE_LIMIT_ATTEMPTS = 7;
const RATE_LIMIT_MAX_WAIT_MS = 8_000;

async function readWithBackoff(label, fn, attempts = 4, retryable = isTransientReadError, { pause = sleep, random = Math.random } = {}) {
  let delay = 500;
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const code = err && err.code;
      if (!retryable(err)) throw err;
      const limited = isRateLimited(err);
      if (i >= (limited ? Math.max(attempts, RATE_LIMIT_ATTEMPTS) : attempts) - 1) throw err;
      const wait = limited ? Math.round(delay / 2 + random() * (delay / 2)) : delay;
      console.log(`[oracle] ${label} failed (${code || 'error'}), retrying in ${wait}ms`);
      await pause(wait);
      delay = Math.min(delay * 2, RATE_LIMIT_MAX_WAIT_MS);
    }
  }
}

module.exports = { isTransientReadError, isRateLimited, readWithBackoff, MAX_BATCH_CALLS, RATE_LIMIT_ATTEMPTS };
