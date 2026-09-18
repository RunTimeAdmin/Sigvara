'use strict';

// Payment-backed attestations.
//
// Attestations used to be an unauthenticated HTTP post carrying a self-declared
// `attester` string. The only control was a cooldown keyed on that string, so the
// caller chose their own identity and could mint as many as they liked. Since
// feeScore was derived from attestation count, the largest factor in the score was
// whatever the loudest caller typed.
//
// This module makes an attestation cost something real. The caller supplies the
// settlement transaction from an x402 payment (the `transaction` field of the
// X-PAYMENT-RESPONSE header, which is what a client holds after a paid call). The
// oracle verifies on chain that the transaction moved at least the minimum amount
// of the accepted asset to the agent's own address, and takes the payer from the
// transfer itself. So:
//
//   - the attester identity is the paying address, not a string the caller picked
//   - an attestation cannot exist without a payment that actually settled
//   - each settlement counts once, so a receipt cannot be replayed
//   - feeScore becomes measured volume rather than a proxy for it
//
// This verifies a settled transfer rather than re-running x402's facilitator
// protocol. Whether the payment was made through x402's EIP-3009 scheme, a plain
// ERC-20 transfer, or anything else, what lands on chain is the same Transfer log,
// and that log is what can be checked after the fact by anyone.

const { ethers } = require('ethers');

// keccak256("Transfer(address,address,uint256)")
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');

class PaymentError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * @param {object} env
 * @returns {{mode: 'off'|'required', asset: string|null, minAmount: bigint, minConfirmations: number, feeUnit: bigint}}
 */
function readConfig(env = process.env) {
  const mode = (env.PAYMENT_VERIFICATION || 'off').toLowerCase();
  if (mode !== 'off' && mode !== 'required') {
    throw new Error(`PAYMENT_VERIFICATION must be "off" or "required", got "${mode}"`);
  }
  const asset = env.PAYMENT_ASSET ? ethers.getAddress(env.PAYMENT_ASSET) : null;
  if (mode === 'required' && !asset) {
    throw new Error('PAYMENT_VERIFICATION=required needs PAYMENT_ASSET (the ERC-20 payments are settled in)');
  }
  return {
    mode,
    asset,
    // Amounts are in the asset's own base units: 6 decimals for USDC, so
    // 10000 is one cent. Kept as BigInt throughout; a float would lose precision
    // on an 18-decimal token.
    minAmount: BigInt(env.PAYMENT_MIN_AMOUNT || '0'),
    minConfirmations: Number(env.PAYMENT_MIN_CONFIRMATIONS || 1),
    // Base units of volume per point of feeScore. The default is 100 USDC per
    // point, so the 30-point cap lands at 3,000 USDC of settled volume, which is
    // the figure docs/reputation-model.md has always quoted for this factor.
    feeUnit: BigInt(env.PAYMENT_FEE_UNIT || '100000000'),
    // Days after which a payment counts half. 0 disables decay, which makes a
    // score answer "was this agent ever busy" rather than "is it busy now".
    halfLifeMs: Number(env.PAYMENT_HALF_LIFE_DAYS ?? 90) * 86_400_000,
  };
}

function required(cfg) {
  return cfg.mode === 'required';
}

/**
 * Pull the ERC-20 Transfer logs out of a receipt that credit `payTo` in `asset`.
 *
 * A single transaction can carry several transfers (a router, a batch, a fee
 * split), so every matching log is considered rather than just the first.
 */
function transfersTo(receipt, asset, payTo) {
  const assetLc = asset.toLowerCase();
  const payToTopic = ethers.zeroPadValue(ethers.getAddress(payTo), 32).toLowerCase();

  const out = [];
  for (const log of receipt.logs || []) {
    if ((log.address || '').toLowerCase() !== assetLc) continue;
    const topics = log.topics || [];
    if (topics.length !== 3) continue; // Transfer has exactly two indexed args
    if (topics[0].toLowerCase() !== TRANSFER_TOPIC.toLowerCase()) continue;
    if (topics[2].toLowerCase() !== payToTopic) continue;
    out.push({
      from: ethers.getAddress('0x' + topics[1].slice(26)),
      value: BigInt(log.data),
    });
  }
  return out;
}

/**
 * Verify that `txHash` settled a payment to `payTo`.
 *
 * @param {object}   deps
 * @param {object}   deps.provider          ethers provider
 * @param {object}   deps.cfg               from readConfig()
 * @param {string}   txHash
 * @param {string}   payTo                  the agent's own address, from the identity registry
 * @returns {Promise<{payer: string, amount: bigint, blockNumber: number, txHash: string}>}
 * @throws {PaymentError}
 */
async function verifyPayment({ provider, cfg }, txHash, payTo) {
  if (typeof txHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
    throw new PaymentError('bad_tx_hash', 'payment.txHash must be a 32-byte hex string');
  }
  if (!cfg.asset) {
    throw new PaymentError('not_configured', 'no PAYMENT_ASSET configured');
  }

  let receipt;
  try {
    receipt = await provider.getTransactionReceipt(txHash);
  } catch (err) {
    // A provider that is down must not look like a rejected payment, or an RPC
    // blip would silently discard attestations that were actually paid for.
    throw new PaymentError('rpc_error', `could not read receipt: ${err.message}`);
  }
  if (!receipt) throw new PaymentError('not_found', 'transaction not found or not yet mined');
  if (receipt.status !== 1) throw new PaymentError('reverted', 'transaction reverted');

  let head;
  try {
    head = await provider.getBlockNumber();
  } catch (err) {
    throw new PaymentError('rpc_error', `could not read head: ${err.message}`);
  }
  const confirmations = head - receipt.blockNumber + 1;
  if (confirmations < cfg.minConfirmations) {
    throw new PaymentError(
      'unconfirmed',
      `${confirmations} confirmation(s), need ${cfg.minConfirmations}`
    );
  }

  const credits = transfersTo(receipt, cfg.asset, payTo);
  if (credits.length === 0) {
    throw new PaymentError('no_transfer', `no ${cfg.asset} transfer to ${payTo} in this transaction`);
  }

  // Sum the credits rather than taking the largest: a payment split across two
  // logs is still one payment. The payer is whoever contributed the most, which
  // is the meaningful counterparty when a router sits in the middle.
  const amount = credits.reduce((sum, c) => sum + c.value, 0n);
  if (amount < cfg.minAmount) {
    throw new PaymentError('below_minimum', `paid ${amount}, minimum is ${cfg.minAmount}`);
  }
  const payer = credits.reduce((a, b) => (b.value > a.value ? b : a)).from;

  return { payer, amount, blockNumber: receipt.blockNumber, txHash: txHash.toLowerCase() };
}

// Decay weight, as an integer scaled by WEIGHT_SCALE.
//
// Deliberately not a float multiply. Amounts are BigInt because an 18-decimal
// token overflows a JSON number, and converting to Number to apply a fractional
// weight would throw away the precision that BigInt exists to keep. Scaling the
// weight to an integer and dividing afterwards stays exact.
const WEIGHT_SCALE = 1_000_000n;

function decayWeight(ageMs, halfLifeMs) {
  if (!halfLifeMs || halfLifeMs <= 0) return WEIGHT_SCALE; // decay off
  if (ageMs <= 0) return WEIGHT_SCALE;                     // clock skew, treat as now
  const w = Math.pow(0.5, ageMs / halfLifeMs);
  return BigInt(Math.round(w * Number(WEIGHT_SCALE)));
}

/**
 * Age-weighted payment volume.
 *
 * Without this, volume accumulates forever: an agent that did three thousand
 * dollars of business last year still scores full marks today having done nothing
 * since. Decay is also what makes a Sybil farm an ongoing cost rather than a
 * one-off, because farmed volume evaporates unless it is renewed.
 */
function decayedVolume(events, halfLifeMs, now = Date.now()) {
  let total = 0n;
  for (const e of events) {
    total += (BigInt(e.amount) * decayWeight(now - e.ts, halfLifeMs)) / WEIGHT_SCALE;
  }
  return total;
}

/**
 * Age-weighted success ratio, as {successful, total} in scaled units.
 *
 * successScore is a ratio, so both halves decay together and a stale run of
 * successes stops masking recent failures. Returned in the same shape the
 * undecayed path uses so computeScore does not need to care which it got.
 */
function decayedAttestations(events, halfLifeMs, now = Date.now()) {
  let successful = 0n, total = 0n;
  for (const e of events) {
    const w = decayWeight(now - e.ts, halfLifeMs);
    total += w;
    if (e.success) successful += w;
  }
  // Scale down to ordinary numbers; the ratio is all successScore uses.
  return {
    successful: Number(successful / 1000n) / 1000,
    total: Number(total / 1000n) / 1000,
  };
}

/**
 * feeScore from measured payment volume.
 *
 * The old proxy was attestation count divided by ten, which meant the factor
 * documented as on-chain fee volume was really a count of HTTP requests.
 */
function feeScoreFromVolume(volume, feeUnit, max = 30) {
  if (feeUnit <= 0n) return 0;
  const points = BigInt(volume) / BigInt(feeUnit);
  return points > BigInt(max) ? max : Number(points);
}

module.exports = {
  PaymentError,
  readConfig,
  required,
  verifyPayment,
  transfersTo,
  feeScoreFromVolume,
  decayWeight,
  decayedVolume,
  decayedAttestations,
  WEIGHT_SCALE,
  TRANSFER_TOPIC,
};
