'use strict';

// Log reads refused, as each node really refused them on 4 November 2026 and in the shape ethers 6
// gives them: the node's words nested, in a message that also holds the request. This request's
// id is 429 on purpose: ethers numbers its requests, so one in each process has it.
//
// Not shipped: .dockerignore excludes this directory.

const fromEthers = (code, message) => Object.assign(
  new Error(`could not coalesce error (error={ "code": ${code}, "message": "${message}" }, payload={ "id": 429, "jsonrpc": "2.0", "method": "eth_getLogs", "params": [ { "fromBlock": "0x4290000" } ] }, code=UNKNOWN_ERROR, version=6.16.0)`),
  { code: 'UNKNOWN_ERROR', shortMessage: 'could not coalesce error', error: { code, message } },
);
const httpStatus = (status, text) => Object.assign(
  new Error(`server response ${status} ${text} (request={ }, response={ }, error=null, code=SERVER_ERROR, version=6.16.0)`),
  { code: 'SERVER_ERROR', shortMessage: `server response ${status} ${text}` },
);

module.exports = {
  fromEthers,
  arcTooMany: () => fromEthers(-32012, 'request exceeded max allowed range: query exceeds max results 20000, retry with the range 70780526-70785795'),
  arcTooWide: () => fromEthers(-32012, 'requested range too large'),
  elysium: () => fromEthers(-32005, 'logs count limit exceeded (10000) consider refine/narrow down your query'),
  baseSepolia: () => httpStatus(413, 'Payload Too Large'),
  rateLimited: () => fromEthers(-32005, 'rate limit exceeded'),
  http429: () => httpStatus(429, 'Too Many Requests'),
};
