'use strict';

// What the oracle does about an RPC endpoint that is wrong, slow or hostile: a transaction
// that never lands, a fee that is absurd, a chain that is not the one expected, a proposal
// that would be refused. The first group uses hand-rolled fakes because each case is one
// decision; the second runs real ethers objects against a fake JSON-RPC endpoint
// (test-support/fake-rpc.js), because the fee and nonce behaviour is ethers' and a fake of
// ethers would only prove the fake.

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const chain = require('./chain');
const { startFakeRpc } = require('./test-support/fake-rpc');

const GWEI = 10n ** 9n;
const DID = ethers.id('agent');
const SCORES = {
  feeScore: 1, successScore: 2, ageScore: 3, externalScore: 0, communityScore: 5, propagationScore: 0, total: 11,
};

// ---- settle, with fakes -----------------------------------------------------------------

const FAST = {
  rpcUrl: 'http://fake',
  privateKey: `0x${'1'.repeat(64)}`,
  identityAddress: '0xIdentity',
  reputationAddress: '0xReputation',
  txWaitMs: 80,
  txPollMs: 5,
};

/** A provider whose receipt lookups follow a script per hash. The last entry repeats. */
function scripted(byHash) {
  const calls = {};
  return {
    calls,
    getTransactionReceipt: async (hash) => {
      const script = byHash[hash] ?? [null];
      const i = calls[hash] = (calls[hash] ?? 0) + 1;
      const step = script[Math.min(i - 1, script.length - 1)];
      if (step instanceof Error) throw step;
      return step;
    },
  };
}

const rateLimit = () => Object.assign(new Error('rate limit exceeded'), { code: -32005 });

const ORIGINAL = {
  hash: '0xoriginal',
  nonce: 7,
  to: '0xabc',
  data: '0xdead',
  value: 0n,
  gasLimit: 100_000n,
  maxFeePerGas: 30n * GWEI,
  maxPriorityFeePerGas: 2n * GWEI,
  chainId: 5042n,
};

function recordingWallet({ refuse = false } = {}) {
  const sent = [];
  const wallet = {
    sent,
    attempted: false,
    address: '0xWallet',
    sendTransaction: async (req) => {
      wallet.attempted = true;
      if (refuse) throw Object.assign(new Error('nonce has already been used'), { code: 'NONCE_EXPIRED' });
      sent.push(req);
      return { hash: '0xreplacement', ...req };
    },
  };
  return wallet;
}

function initWith(provider, wallet = recordingWallet()) {
  chain.init(FAST, { provider, wallet, identityContract: {}, reputationContract: {} });
  return wallet;
}

test('settle: a transaction that is mined resolves with its receipt and hash', async () => {
  initWith(scripted({ '0xoriginal': [{ status: 1 }] }));
  const { receipt, hash } = await chain.settle(ORIGINAL);
  assert.equal(receipt.status, 1);
  assert.equal(hash, '0xoriginal');
});

test('settle: waits through a few empty lookups', async () => {
  initWith(scripted({ '0xoriginal': [null, null, null, { status: 1 }] }));
  assert.equal((await chain.settle(ORIGINAL)).hash, '0xoriginal');
});

test('settle: a rate-limited receipt lookup does not make a mined transaction a failure', async () => {
  // ethers' own wait() rejected on this, so an epoch fee that had landed was reported as
  // failed and charged again the next epoch.
  const provider = scripted({ '0xoriginal': [rateLimit(), rateLimit(), { status: 1 }] });
  initWith(provider);
  assert.equal((await chain.settle(ORIGINAL)).hash, '0xoriginal');
  assert.equal(provider.calls['0xoriginal'], 3);
});

test('settle: an error that is not the node\'s own trouble is not swallowed', async () => {
  initWith(scripted({ '0xoriginal': [new Error('malformed response')] }));
  await assert.rejects(() => chain.settle(ORIGINAL), /malformed response/);
});

test('settle: a transaction that was mined and reverted throws as ethers would', async () => {
  initWith(scripted({ '0xoriginal': [{ status: 0 }] }));
  await assert.rejects(
    () => chain.settle(ORIGINAL),
    (err) => err.code === 'CALL_EXCEPTION' && err.receipt.status === 0 && err.transaction.hash === '0xoriginal',
  );
});

test('settle: a transaction that is never mined is replaced once, at twice the fee and the same nonce', async () => {
  const wallet = initWith(scripted({
    '0xoriginal': [null],
    '0xreplacement': [null, null, { status: 1 }],
  }));
  const { hash } = await chain.settle(ORIGINAL);
  assert.equal(hash, '0xreplacement', 'the replacement is the transaction that was mined');
  assert.equal(wallet.sent.length, 1);
  const [replacement] = wallet.sent;
  assert.equal(replacement.nonce, ORIGINAL.nonce, 'the same nonce, so only one of the two can ever be mined');
  assert.equal(replacement.data, ORIGINAL.data);
  assert.equal(replacement.to, ORIGINAL.to);
  assert.equal(replacement.gasLimit, ORIGINAL.gasLimit);
  assert.equal(replacement.maxFeePerGas, 60n * GWEI);
  assert.equal(replacement.maxPriorityFeePerGas, 4n * GWEI);
});

test('settle: nothing is resent beyond the one replacement', async () => {
  const wallet = initWith(scripted({ '0xoriginal': [null], '0xreplacement': [null] }));
  await assert.rejects(
    () => chain.settle(ORIGINAL),
    (err) => err.code === 'TX_UNCONFIRMED' && err.txHash === '0xoriginal' && err.replacementHash === '0xreplacement',
  );
  assert.equal(wallet.sent.length, 1, 'never pay twice for one epoch');
});

test('settle: the original landing while its replacement is pending is a success, not an error', async () => {
  // Same nonce: whichever is mined first wins, and the other can never be. Driven by what
  // happened and not by how many lookups it took: the original appears once the
  // replacement has been sent.
  const wallet = recordingWallet();
  initWith({
    getTransactionReceipt: async (hash) => (hash === '0xoriginal' && wallet.sent.length > 0 ? { status: 1 } : null),
  }, wallet);
  const { hash } = await chain.settle(ORIGINAL);
  assert.equal(hash, '0xoriginal');
  assert.equal(wallet.sent.length, 1);
});

test('settle: a transaction that cannot be replaced is given a last look and then reported', async () => {
  const wallet = initWith(scripted({ '0xoriginal': [null] }));
  // A fake that carries none of the fields a replacement is built from.
  await assert.rejects(
    () => chain.settle({ hash: '0xoriginal' }),
    (err) => err.code === 'TX_UNCONFIRMED' && err.replacementHash === null,
  );
  assert.equal(wallet.sent.length, 0);
});

test('settle: a refused replacement is not an error of its own, only the original is waited on', async () => {
  // The node says the nonce is used because the original landed in the meantime.
  const wallet = recordingWallet({ refuse: true });
  initWith({
    getTransactionReceipt: async (hash) => (hash === '0xoriginal' && wallet.attempted ? { status: 1 } : null),
  }, wallet);
  assert.equal((await chain.settle(ORIGINAL)).hash, '0xoriginal');
});

test('settle: a transaction object whose own wait() never returns cannot hang it', async () => {
  // The old code awaited tx.wait(1). This one never calls it.
  initWith(scripted({ '0xhung': [null] }));
  const hung = { ...ORIGINAL, hash: '0xhung', wait: () => new Promise(() => {}) };
  await assert.rejects(() => chain.settle(hung), (err) => err.code === 'TX_UNCONFIRMED');
});

// ---- the caps, as a function --------------------------------------------------------------

const CAPS = { maxFeePerGas: 1000n * GWEI, maxTxCost: ethers.parseEther('1') };

test('assertWithinCaps: an ordinary transaction passes', () => {
  chain.assertWithinCaps({ maxFeePerGas: 41n * GWEI, gasLimit: 250_000n }, CAPS);
});

test('assertWithinCaps: a fee above the ceiling is refused, and says which cap', () => {
  assert.throws(
    () => chain.assertWithinCaps({ maxFeePerGas: 5_000_000n * GWEI, gasLimit: 100_000n }, CAPS),
    (err) => err.code === 'FEE_CAP' && /MAX_FEE_GWEI/.test(err.message),
  );
});

test('assertWithinCaps: a total cost above the ceiling is refused even at an ordinary fee', () => {
  // 50 million gas at 41 gwei is 2.05 tokens: an inflated estimate, not an inflated price.
  assert.throws(
    () => chain.assertWithinCaps({ maxFeePerGas: 41n * GWEI, gasLimit: 50_000_000n }, CAPS),
    (err) => err.code === 'FEE_CAP' && /MAX_TX_COST/.test(err.message),
  );
});

test('assertWithinCaps: a legacy gasPrice is held to the same ceiling', () => {
  assert.throws(
    () => chain.assertWithinCaps({ gasPrice: 2000n * GWEI, gasLimit: 21_000n }, CAPS),
    (err) => err.code === 'FEE_CAP',
  );
});

test('assertWithinCaps: exactly the cap is allowed', () => {
  chain.assertWithinCaps({ maxFeePerGas: 1000n * GWEI, gasLimit: 1_000_000n }, CAPS); // 1 token
});

// ---- real ethers against a fake endpoint ----------------------------------------------------

const ADDR = (n) => ethers.getAddress(`0x${String(n).repeat(40)}`);
let rpc;

afterEach(async () => {
  try { chain.getProvider()?.destroy(); } catch { /* none */ }
  if (rpc) await rpc.stop();
  rpc = null;
});

// ethers keeps every answer, a failed one included, for 250 ms, keyed by the request. The
// oracle polls every 1.5 s, so that never shows in production, but a test polling every few
// milliseconds would be handed the same stale answer for a quarter of a second.
async function startChain(options = {}, cfg = {}) {
  rpc = await startFakeRpc(options);
  chain.init({
    rpcUrl: rpc.url,
    privateKey: `0x${'11'.repeat(32)}`,
    identityAddress: ADDR(2),
    reputationAddress: ADDR(3),
    feeRegistryAddress: ADDR(4),
    txWaitMs: 200,
    txPollMs: 10,
    ...cfg,
  }, { provider: new ethers.JsonRpcProvider(rpc.url, undefined, { cacheTimeout: -1 }) });
  return rpc;
}

test('a transaction at ordinary fees is signed, sent and settled', async () => {
  await startChain();
  const hash = await chain.proposeScore(DID, SCORES);
  assert.equal(rpc.sent.length, 1);
  assert.equal(hash, rpc.sent[0].hash);
});

test('a fee above the cap is refused before anything is signed or sent', async () => {
  // The case that spent nearly a whole float: the node reports a priority fee of millions
  // of gwei and ethers dutifully offers it.
  await startChain({ priorityFee: 5_000_000n * GWEI });
  await assert.rejects(() => chain.proposeScore(DID, SCORES), (err) => chain.isFeeCap(err));
  assert.equal(rpc.sent.length, 0);
  assert.ok(!rpc.calls.includes('eth_sendRawTransaction'));
});

test('the total cost cap catches an inflated gas estimate', async () => {
  await startChain({ gas: 50_000_000n });
  await assert.rejects(() => chain.proposeScore(DID, SCORES), (err) => chain.isFeeCap(err) && /MAX_TX_COST/.test(err.message));
  assert.equal(rpc.sent.length, 0);
});

test('the caps come from configuration', async () => {
  await startChain({}, { maxFeeGwei: 30 }); // the endpoint reports 41
  await assert.rejects(() => chain.proposeScore(DID, SCORES), (err) => chain.isFeeCap(err) && /MAX_FEE_GWEI/.test(err.message));
  chain.getProvider().destroy();
  await rpc.stop();
  await startChain({}, { maxFeeGwei: 50 });
  await chain.proposeScore(DID, SCORES);
  assert.equal(rpc.sent.length, 1);
});

test('with nothing configured the fee ceiling is 1,000 gwei', async () => {
  // 2,041 gwei in all, at a total cost well under the 1 token cost ceiling, so only the fee
  // ceiling can be what refuses it.
  await startChain({ priorityFee: 2_000n * GWEI });
  await assert.rejects(() => chain.proposeScore(DID, SCORES), (err) => chain.isFeeCap(err) && /MAX_FEE_GWEI/.test(err.message));
  assert.equal(rpc.sent.length, 0);
});

test('a transaction the endpoint never mines is replaced once, and the replacement settles', async () => {
  await startChain({ autoMine: (tx) => tx.maxPriorityFeePerGas >= 2n * GWEI });
  const hash = await chain.proposeScore(DID, SCORES);
  assert.equal(rpc.sent.length, 2);
  const [first, second] = rpc.sent;
  assert.equal(second.tx.nonce, first.tx.nonce);
  assert.equal(second.tx.maxFeePerGas, first.tx.maxFeePerGas * 2n);
  assert.equal(second.tx.data, first.tx.data);
  assert.equal(hash, second.hash);
});

test('a transaction the endpoint never mines ends the wait instead of hanging, with exactly two sends', async () => {
  await startChain({ autoMine: () => false });
  const started = Date.now();
  await assert.rejects(() => chain.proposeScore(DID, SCORES), (err) => chain.isTxUnconfirmed(err));
  assert.ok(Date.now() - started < 5_000, 'it gave up instead of waiting for ever');
  assert.equal(rpc.sent.length, 2, 'the original and one replacement, never more');
  assert.equal(rpc.sent[0].tx.nonce, rpc.sent[1].tx.nonce);
});

test('a rate-limited receipt lookup does not undo a transaction that was mined', async () => {
  await startChain({ throttleReceipts: 4 });
  const hash = await chain.proposeScore(DID, SCORES);
  assert.equal(hash, rpc.sent[0].hash);
  assert.equal(rpc.sent.length, 1, 'and it was not sent again');
});

test('the epoch fee uses the same bounded wait', async () => {
  await startChain({ autoMine: () => false });
  await assert.rejects(() => chain.chargeEpoch(DID), (err) => chain.isTxUnconfirmed(err));
  assert.equal(rpc.sent.length, 2);
});

test('finalizing uses the same bounded wait', async () => {
  await startChain({ autoMine: () => false });
  await assert.rejects(() => chain.finalizeScore(DID), (err) => chain.isTxUnconfirmed(err));
  assert.equal(rpc.sent.length, 2);
});

test('a transaction the endpoint never mines shows as a pending nonce until it lands', async () => {
  await startChain({ autoMine: () => false });
  assert.equal(await chain.getNonceGap(), 0);
  await assert.rejects(() => chain.proposeScore(DID, SCORES), (err) => chain.isTxUnconfirmed(err));
  assert.equal(await chain.getNonceGap(), 1, 'the original and its replacement share one nonce');
  rpc.mine(rpc.sent[1].hash);
  assert.equal(await chain.getNonceGap(), 0);
});

// ---- which chain ---------------------------------------------------------------------------

test('assertChainId: returns the chain the node reports when it matches or none is expected', async () => {
  await startChain({ chainId: 5042 });
  assert.equal(await chain.assertChainId(5042), 5042);
  assert.equal(await chain.assertChainId('5042'), 5042, 'an environment string is fine');
  assert.equal(await chain.assertChainId(null), 5042);
  assert.equal(await chain.getChainId(), 5042);
});

test('assertChainId: a node on another chain is refused, naming both', async () => {
  await startChain({ chainId: 5042002 });
  await assert.rejects(
    () => chain.assertChainId(5042),
    (err) => err instanceof chain.ChainMismatchError && err.expected === 5042 && err.actual === 5042002
      && /5042002/.test(err.message) && /Nothing will be signed/.test(err.message),
  );
});

test('assertChainId: asks the node each time, because ethers remembers the first answer', async () => {
  await startChain({ chainId: 5042 });
  await chain.assertChainId(5042);
  rpc.state.chainId = 1; // a failover lands on a different chain
  await assert.rejects(() => chain.assertChainId(5042), (err) => err instanceof chain.ChainMismatchError && err.actual === 1);
});

// ---- would the proposal be accepted -----------------------------------------------------------

function fakeReputation(staticCall) {
  const method = async () => { throw new Error('canPropose must not send'); };
  method.staticCall = staticCall;
  return { proposeReputation: method, proposeIfEmpty: method };
}

function initWithContract(reputationContract) {
  chain.init(FAST, {
    provider: scripted({}),
    wallet: recordingWallet(),
    identityContract: {},
    reputationContract,
  });
}

test('canPropose: a proposal the contract would accept is ok, and nothing is sent', async () => {
  initWithContract(fakeReputation(async () => undefined));
  assert.deepEqual(await chain.canPropose(DID, SCORES), { ok: true });
});

test('canPropose: a proposal the contract refuses is reported with the reason, not thrown', async () => {
  // The case behind the fee charged for nothing: the bond had lapsed, every proposal
  // reverted, and the epoch fee was taken first all the same.
  initWithContract(fakeReputation(async () => {
    throw Object.assign(new Error('execution reverted'), {
      code: 'CALL_EXCEPTION', data: '0xdeadbeef', revert: { name: 'OperatorNotBonded' },
    });
  }));
  assert.deepEqual(await chain.canPropose(DID, SCORES), { ok: false, reason: 'OperatorNotBonded' });
});

test('canPropose: a node that cannot answer is thrown, so it reads as neither yes nor no', async () => {
  initWithContract(fakeReputation(async () => { throw new Error('connection closed'); }));
  await assert.rejects(() => chain.canPropose(DID, SCORES), /connection closed/);
});

test('canPropose: picks the entry point the caller would use', async () => {
  const used = [];
  const method = (name) => Object.assign(async () => {}, { staticCall: async () => { used.push(name); } });
  initWithContract({ proposeReputation: method('proposeReputation'), proposeIfEmpty: method('proposeIfEmpty') });
  await chain.canPropose(DID, SCORES, ethers.ZeroHash, false);
  await chain.canPropose(DID, SCORES, ethers.ZeroHash, true);
  assert.deepEqual(used, ['proposeReputation', 'proposeIfEmpty']);
});

test('canPropose: against a real endpoint, a revert with data is the contract saying no', async () => {
  await startChain({ revertCall: '0xdeadbeef' });
  const result = await chain.canPropose(DID, SCORES);
  assert.equal(result.ok, false);
  assert.match(result.reason, /revert/i);
  assert.equal(rpc.sent.length, 0);
});

test('canPropose: against a real endpoint that accepts, the answer is yes', async () => {
  await startChain();
  assert.deepEqual(await chain.canPropose(DID, SCORES), { ok: true });
});
