'use strict';

/**
 * Demo: verify a real USDC payment on Arc with the oracle's own code.
 *
 * Written to be recorded in one take. Everything here is live: the USDC metadata is
 * read from the chain, the transaction is a real transfer anyone can look up, and the
 * verification is `payments.verifyPayment`, the same function that runs when an
 * attestation arrives at the production oracle. There is no fixture and no mock.
 *
 *   node oracle/demo-usdc.js              # paced for recording
 *   DEMO_PACE=0 node oracle/demo-usdc.js  # no pauses, for checking it still passes
 *   DEMO_DISCOVER=1 node oracle/demo-usdc.js   # find a fresh transfer instead of the pinned one
 *
 * The transaction is pinned by default so a take cannot be spoiled by whatever happened
 * to settle in the last minute. DEMO_DISCOVER proves the pinned one is not special.
 */

const { ethers } = require('ethers');
const fs = require('node:fs');
const path = require('node:path');
const payments = require('./payments');

const RPC = process.env.RPC_URL || 'https://rpc.testnet.arc.io';
const EXPLORER = 'https://testnet.arcscan.app';

/** Arc's native USDC, exposed as a standard ERC-20. Verified on testnet 21 Sep 2026. */
const USDC = '0x3600000000000000000000000000000000000000';
const SVR = '0x41De2D6D55318e197a00E8f5B496eA2790e23E6c';

/** A real USDC transfer on Arc. Replace with any other; nothing depends on this one. */
const PINNED_TX = '0xb43d22aec369233bc5bcac07a839093d0f4f138f47be1d3a8d388a633a35c3ae';

const PACE = process.env.DEMO_PACE === undefined ? 1500 : Number(process.env.DEMO_PACE);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const pause = (mult = 1) => (PACE > 0 ? sleep(PACE * mult) : Promise.resolve());

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  cyan: '\x1b[36m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
};
const say = (s = '') => console.log(s);
const head = async (n, t) => {
  say();
  say(`${C.cyan}${C.bold}  ${n}. ${t}${C.reset}`);
  say(`${C.dim}  ${'─'.repeat(64)}${C.reset}`);
  await pause(0.5);
};
const kv = (k, v, colour = '') => say(`     ${k.padEnd(22)} ${colour}${v}${C.reset}`);

/**
 * Print a named function from a source file.
 *
 * Found by name, not by line number. It was by line number until editing a comment
 * fifteen lines higher pushed the function down and the demo started displaying the
 * config block instead, which would have gone out on camera as "the code that reads a
 * payment". A demo that cites source has to find that source the way a reader would.
 */
function showFunction(file, fnName, note) {
  const abs = path.join(__dirname, file);
  const all = fs.readFileSync(abs, 'utf8').split('\n');
  const start = all.findIndex(l => l.startsWith(`function ${fnName}(`));
  if (start === -1) throw new Error(`${fnName} not found in ${file} — has it been renamed?`);
  // Closing brace of a top-level function: the next line that is exactly "}".
  let end = start;
  while (end < all.length && all[end] !== '}') end++;
  const from = start + 1;
  const to = end + 1;
  const lines = all.slice(start, end + 1);
  say(`     ${C.dim}${file}:${from}-${to}${C.reset}`);
  say();
  lines.forEach((l, i) => say(`     ${C.dim}${String(from + i).padStart(3)}${C.reset}  ${l}`));
  if (note) { say(); say(`     ${C.dim}${note}${C.reset}`); }
}

async function findRecentTransfer(provider) {
  const headBlock = await provider.getBlockNumber();
  const logs = await provider.getLogs({
    address: USDC,
    topics: [ethers.id('Transfer(address,address,uint256)')],
    // Small window on purpose: USDC is busy enough on Arc that a wide range trips the
    // node's 20,000-result cap.
    fromBlock: headBlock - 250,
    toBlock: headBlock,
  });
  const perTx = new Map();
  for (const l of logs) perTx.set(l.transactionHash, (perTx.get(l.transactionHash) || 0) + 1);
  const single = logs
    .filter(l => perTx.get(l.transactionHash) === 1)
    .map(l => ({ l, v: BigInt(l.data) }))
    .filter(x => x.v >= 1_000000n)
    .sort((a, b) => (b.v > a.v ? 1 : -1))[0];
  if (!single) throw new Error('no suitable USDC transfer in the last 250 blocks');
  return single.l.transactionHash;
}

(async () => {
  const provider = new ethers.JsonRpcProvider(RPC);

  say();
  say(`${C.bold}  Sigvara — verifying a real USDC payment on Arc${C.reset}`);
  say(`${C.dim}  Agent reputation computed from settled USDC, checked against the chain.${C.reset}`);
  await pause();

  // ---------------------------------------------------------------- 1
  await head(1, 'USDC on Arc, read from the chain');
  const erc20 = new ethers.Contract(
    USDC,
    ['function name() view returns (string)',
     'function symbol() view returns (string)',
     'function decimals() view returns (uint8)'],
    provider,
  );
  const [name, symbol, decimals, chain] = await Promise.all([
    erc20.name(), erc20.symbol(), erc20.decimals(), provider.getNetwork(),
  ]);
  kv('chain id', chain.chainId.toString(), C.green);
  kv('address', USDC, C.green);
  kv('name / symbol', `${name} / ${symbol}`, C.green);
  kv('decimals', decimals.toString(), C.green);
  say();
  say(`     ${C.dim}Arc's gas token is USDC. This is its ERC-20 interface, and the${C.reset}`);
  say(`     ${C.dim}native balance and this view are the same balance, not two.${C.reset}`);
  await pause(2);

  // ---------------------------------------------------------------- 2
  await head(2, 'The code that reads a payment');
  showFunction(
    'payments.js', 'transfersTo',
    'Nothing here is USDC-specific. It matches the configured asset and reads the\n     standard Transfer topics, which is why settling in USDC is configuration.',
  );
  await pause(3);

  // ---------------------------------------------------------------- 3
  await head(3, 'A real payment on Arc');
  const txHash = process.env.DEMO_DISCOVER ? await findRecentTransfer(provider) : PINNED_TX;
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error(`transaction ${txHash} not found — is RPC_URL an archive node?`);
  const transferLog = receipt.logs.find(
    l => l.address.toLowerCase() === USDC.toLowerCase()
      && l.topics[0] === ethers.id('Transfer(address,address,uint256)'),
  );
  const recipient = ethers.getAddress('0x' + transferLog.topics[2].slice(26));
  kv('tx', txHash, C.yellow);
  kv('block', receipt.blockNumber.toString());
  kv('paid to', recipient);
  kv('amount', `${ethers.formatUnits(BigInt(transferLog.data), 6)} USDC`, C.yellow);
  say();
  say(`     ${C.dim}${EXPLORER}/tx/${txHash}${C.reset}`);
  await pause(2.5);

  // ---------------------------------------------------------------- 4
  await head(4, 'Verify it with the oracle');
  const cfg = payments.readConfig({
    PAYMENT_VERIFICATION: 'required',
    PAYMENT_ASSET: USDC,
    PAYMENT_MIN_AMOUNT: '1000000',   // 1 USDC, in 6-decimal base units
    PAYMENT_FEE_UNIT: '100000000',   // 100 USDC per point of feeScore
    PAYMENT_MIN_CONFIRMATIONS: '1',
  });
  say(`     ${C.dim}payments.verifyPayment({ provider, cfg }, txHash, payTo)${C.reset}`);
  say();
  const t0 = Date.now();
  const result = await payments.verifyPayment({ provider, cfg }, txHash, recipient);
  kv('payer', result.payer, C.green);
  kv('amount', `${ethers.formatUnits(result.amount, 6)} USDC`, C.green);
  kv('settled at', new Date(result.settledAt).toISOString(), C.green);
  kv('verified in', `${Date.now() - t0} ms`);
  say();
  say(`     ${C.dim}The payer is taken from the transfer log, never from the caller.${C.reset}`);
  say(`     ${C.dim}Settlement time comes from the block, so an old receipt arrives${C.reset}`);
  say(`     ${C.dim}already decayed and cannot be hoarded to keep a score alive.${C.reset}`);
  await pause(3);

  // ---------------------------------------------------------------- 5
  await head(5, 'What it is worth to a score');
  const pts = payments.feeScoreFromVolume(result.amount, cfg.feeUnit);
  kv('fee unit', `${ethers.formatUnits(cfg.feeUnit, 6)} USDC per point`);
  kv('feeScore', `${pts} / 20`, C.green);
  say();
  say(`     ${C.dim}One of six factors. The score is proposed on chain with a Merkle root${C.reset}`);
  say(`     ${C.dim}over exactly this evidence, so anyone can recompute it.${C.reset}`);
  await pause(2.5);

  // ---------------------------------------------------------------- 6
  await head(6, 'And it refuses what it should');
  const wrong = payments.readConfig({
    PAYMENT_VERIFICATION: 'required',
    PAYMENT_ASSET: SVR,
  });
  say(`     ${C.dim}same transaction, oracle configured for a different asset${C.reset}`);
  say();
  try {
    await payments.verifyPayment({ provider, cfg: wrong }, txHash, recipient);
    kv('result', 'ACCEPTED — this is a bug', C.red);
    process.exitCode = 1;
  } catch (err) {
    kv('result', `refused: ${err.code}`, C.green);
    say();
    say(`     ${C.dim}A payment in the wrong currency is not evidence. Without this the${C.reset}`);
    say(`     ${C.dim}verification would only be checking that money moved somewhere.${C.reset}`);
  }
  await pause(2);

  say();
  say(`${C.dim}  ${'─'.repeat(64)}${C.reset}`);
  say(`  ${C.bold}Real USDC, on Arc, verified by the code that runs in production.${C.reset}`);
  say(`${C.dim}  github.com/RunTimeAdmin/Sigvara · oracle/payments.js${C.reset}`);
  say();
})().catch(err => {
  console.error(`\n  ${C.red}demo failed:${C.reset} ${err.message}\n`);
  process.exit(1);
});
