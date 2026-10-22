'use strict';

// A JSON-RPC endpoint that answers what ethers asks when it sends a transaction, and lets a
// test decide what the chain does: what fees it reports, and whether a sent transaction is
// ever mined. Real ethers objects talk to it, so what is under test is the oracle's code and
// not a stand-in for ethers.
//
//   const rpc = await startFakeRpc({ priorityFee: 5_000_000n * 10n ** 9n });
//   ... chain.init({ rpcUrl: rpc.url, ... }) ...
//   options: priorityFee, gas, autoMine, throttleReceipts, revertCall (eth_call reverts with this
//            data), revertEstimate (eth_estimateGas reverts with this data)
//   rpc.sent        every raw transaction received, decoded
//   rpc.calls       every method called, in order
//   rpc.mine(hash)  give a received transaction a receipt
//   await rpc.stop()
//
// Not shipped: .dockerignore excludes this directory.

const http = require('node:http');
const { ethers } = require('ethers');

const hex = (n) => `0x${BigInt(n).toString(16)}`;

async function startFakeRpc(options = {}) {
  const state = {
    chainId: options.chainId ?? 5042,
    baseFee: options.baseFee ?? 20n * 10n ** 9n,
    priorityFee: options.priorityFee ?? 1n * 10n ** 9n,
    gasPrice: options.gasPrice ?? 21n * 10n ** 9n,
    gas: options.gas ?? 200_000n,
    head: 1_000,
    nonce: options.nonce ?? 0,
    // (decoded tx) => whether it is mined the moment it arrives
    autoMine: options.autoMine ?? (() => true),
    // The next this many receipt lookups fail with a rate-limit error.
    throttleReceipts: options.throttleReceipts ?? 0,
    // When set (revert data as hex), every eth_call reverts with it.
    revertCall: options.revertCall ?? null,
    // Likewise for eth_estimateGas, which is where a send that the contract would refuse fails.
    revertEstimate: options.revertEstimate ?? null,
    sent: [],
    calls: [],
    receipts: new Map(),
  };

  const block = () => ({
    number: hex(state.head),
    hash: ethers.id(`block-${state.head}`),
    parentHash: ethers.id(`block-${state.head - 1}`),
    timestamp: hex(Math.floor(Date.now() / 1000)),
    nonce: '0x0000000000000000',
    difficulty: '0x0',
    gasLimit: hex(30_000_000),
    gasUsed: '0x0',
    miner: ethers.ZeroAddress,
    extraData: '0x',
    baseFeePerGas: hex(state.baseFee),
    transactions: [],
  });

  const receiptFor = (entry) => ({
    transactionHash: entry.hash,
    transactionIndex: '0x0',
    blockHash: ethers.id(`block-${state.head}`),
    blockNumber: hex(state.head),
    from: entry.tx.from,
    to: entry.tx.to,
    cumulativeGasUsed: '0x5208',
    gasUsed: '0x5208',
    contractAddress: null,
    logs: [],
    logsBloom: `0x${'00'.repeat(256)}`,
    status: '0x1',
    effectiveGasPrice: hex(state.gasPrice),
    type: '0x2',
  });

  function mine(hash) {
    const entry = state.sent.find((s) => s.hash === hash);
    if (!entry) throw new Error(`fake rpc: no such transaction ${hash}`);
    state.head += 1;
    state.receipts.set(hash, receiptFor(entry));
  }

  // The account's transaction count: what is mined, and with 'pending' what is waiting too.
  // A replacement shares its original's nonce, so nonces are counted once.
  function transactionCount(tag) {
    const nonces = new Set(state.sent.map((s) => s.tx.nonce));
    const minedNonces = new Set(state.sent.filter((s) => state.receipts.has(s.hash)).map((s) => s.tx.nonce));
    return state.nonce + (tag === 'pending' ? nonces.size : minedNonces.size);
  }

  function answer(method, params) {
    state.calls.push(method);
    switch (method) {
      case 'eth_chainId': return hex(state.chainId);
      case 'net_version': return String(state.chainId);
      case 'eth_blockNumber': return hex(state.head);
      case 'eth_getBlockByNumber': return block();
      case 'eth_gasPrice': return hex(state.gasPrice);
      case 'eth_maxPriorityFeePerGas': return hex(state.priorityFee);
      case 'eth_getTransactionCount': return hex(transactionCount(params[1]));
      case 'eth_estimateGas': {
        if (state.revertEstimate) {
          const err = new Error('execution reverted');
          err.rpcCode = 3;
          err.rpcData = state.revertEstimate;
          throw err;
        }
        return hex(state.gas);
      }
      case 'eth_call': {
        // A contract call that simply succeeds, or reverts with the data a test supplies.
        if (state.revertCall) {
          const err = new Error('execution reverted');
          err.rpcCode = 3;
          err.rpcData = state.revertCall;
          throw err;
        }
        return '0x';
      }
      case 'eth_sendRawTransaction': {
        const tx = ethers.Transaction.from(params[0]);
        const entry = { hash: tx.hash, tx, raw: params[0] };
        state.sent.push(entry);
        if (state.autoMine(tx)) mine(entry.hash);
        return entry.hash;
      }
      case 'eth_getTransactionReceipt': {
        if (state.throttleReceipts > 0) {
          state.throttleReceipts -= 1;
          const err = new Error('rate limit exceeded');
          err.rpcCode = -32005;
          throw err;
        }
        return state.receipts.get(params[0]) ?? null;
      }
      default: {
        const err = new Error(`fake rpc: ${method} is not implemented`);
        err.rpcCode = -32601;
        throw err;
      }
    }
  }

  function respond(request) {
    try {
      return { jsonrpc: '2.0', id: request.id, result: answer(request.method, request.params ?? []) };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: { code: err.rpcCode ?? -32000, message: err.message, ...(err.rpcData ? { data: err.rpcData } : {}) },
      };
    }
  }

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const parsed = JSON.parse(body);
      const out = Array.isArray(parsed) ? parsed.map(respond) : respond(parsed);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    get sent() { return state.sent; },
    get calls() { return state.calls; },
    mine,
    async stop() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

module.exports = { startFakeRpc };
