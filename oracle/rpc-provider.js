'use strict';

// How the oracle and its services reach a node. On its own, beside read-retry.js, so read-retry.js keeps no
// dependencies.

const { ethers } = require('ethers');
const { MAX_BATCH_CALLS } = require('./read-retry');

// How long one request may take. The payment chains' figure (payment-chains.RPC_TIMEOUT_MS), which a wide log read
// on Arc and Base answers well inside. ethers' own default is 300 s.
const RPC_TIMEOUT_MS = 30_000;

/**
 * A provider for `url`, built the same way everywhere:
 *   - each request has a deadline, where ethers' default let a stalled node hold /score, /attest and /link for
 *     five minutes a read;
 *   - ethers tries nothing again itself. It tried an HTTP 429 up to 12 times inside each of readWithBackoff's
 *     attempts, so a throttling node was still being asked after 100 s (performance review, 15 November).
 *     A throttle is retried by readWithBackoff, and only there;
 *   - the chain is fixed: `chainId` when it is known, the node's first answer otherwise. Without that ethers asks
 *     eth_chainId before every wave of reads. Whatever has to know the chain the node serves now asks it directly
 *     (chain.getChainId, external.refreshChainId), as before.
 */
function rpcProvider(url, chainId = null, { timeoutMs = RPC_TIMEOUT_MS, batchMaxCount = MAX_BATCH_CALLS } = {}) {
  const request = new ethers.FetchRequest(url);
  request.timeout = timeoutMs;
  request.setThrottleParams({ maxAttempts: 1 });
  return new ethers.JsonRpcProvider(request, chainId == null ? undefined : Number(chainId), { staticNetwork: true, batchMaxCount });
}

module.exports = { rpcProvider, RPC_TIMEOUT_MS };
