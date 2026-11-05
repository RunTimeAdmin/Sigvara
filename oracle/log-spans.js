'use strict';

// What a log scan does when a node refuses a read for how much it asked. Asking for the same span
// again gets the same answer, so one span holding too many logs stopped a scan until someone changed
// its settings, and anyone can put logs in a span. Halving always gets there: a single block holds far
// fewer logs than any of these limits.
//
// No dependencies: the indexer runs with no node_modules, from the files
// docker-compose.indexer.vps.yml names.

// The node's own words. ethers nests them under `error`, or under `info.error` for a call it turned into
// "missing revert data", in a message that also holds the request, and the request can say anything:
// ethers numbers its requests, so one has the id 429.
const wordsOf = (err) => String(err?.error?.message ?? err?.info?.error?.message ?? err?.shortMessage ?? err?.message ?? err);

// Asked again in place, not halved: a smaller span would be throttled the same way. \b because a
// refusal can name blocks ("retry with the range 70742912-70750000").
const THROTTLED = /rate limit|\b429\b|too many requests/i;

// Measured on 4 Nov 2026, and they differ enough that a list is the honest way to say it. Arc: "requested
// range too large", "request exceeded max allowed range: query exceeds max results 20000". Elysium: "logs
// count limit exceeded (10000)". Base Sepolia: "server response 413 Payload Too Large". The rest, not
// measured here, is what this check already took: "query returned more than 10000 results" and the like.
// -32005 will not do: it is Arc's rate limit and Elysium's log limit.
const REFUSED = /more than \d+|too many (results|logs)|too large|\b413\b|response size|block range|allowed range|max(imum)? results|logs? (count )?limit/i;

/** Whether a node refused a log read for its size. rpcError (payment-chains.js) keeps the answer without the words. */
function spanRefused(err) {
  if (err?.spanRefused === true) return true;
  const words = wordsOf(err);
  return !THROTTLED.test(words) && REFUSED.test(words);
}

/**
 * spanRefused, or no answer in time, which a smaller span may also cure. Only for a read with a short
 * limit of its own: halving costs a timeout at every level, and inside an epoch a dead endpoint would
 * hold the epoch for all of them.
 */
function spanTooBig(err) {
  const words = wordsOf(err);
  return spanRefused(err) || (!THROTTLED.test(words) && /timeout/i.test(words));
}

/**
 * The logs of blocks [from, to] from `read(a, b)`, in block order, halving any span it refuses. A
 * single block it still refuses is thrown, and so is any other failure: there is nothing smaller to
 * ask for. `pause` runs before each smaller read, so a run of refusals keeps to the caller's pace.
 * `join` is for a read that answers with something other than an array.
 */
async function readSplitting(read, from, to, { tooBig = spanRefused, pause = async () => {}, join = (l, r) => l.concat(r) } = {}) {
  try {
    return await read(from, to);
  } catch (err) {
    if (from >= to || !tooBig(err)) throw err;
    const mid = from + Math.floor((to - from) / 2);
    await pause();
    const left = await readSplitting(read, from, mid, { tooBig, pause, join });
    await pause();
    const right = await readSplitting(read, mid + 1, to, { tooBig, pause, join });
    return join(left, right);
  }
}

module.exports = { spanRefused, spanTooBig, readSplitting, wordsOf };
