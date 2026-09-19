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
    // How much evidence one counterparty can contribute: at most this many points
    // of feeScore, and this many attestations of weight. Volume from a single
    // payer is otherwise indistinguishable from volume from a hundred, which is
    // what makes a small ring of wallets as good as a real customer base. At the
    // default of 5, reaching the 30-point cap needs at least six distinct payers.
    // 0 disables the cap.
    maxPerPayer: Number(env.PAYMENT_MAX_PER_PAYER ?? 5),
    // Web of trust. A counterparty that is itself a scored Sigvara agent is better
    // evidence than an anonymous wallet, so its cap is raised in proportion to its
    // own score: at the default of 1.0 a perfectly scored counterparty counts double.
    // 0 disables the weighting and every payer is treated alike.
    trustWeight: Number(env.PAYMENT_TRUST_WEIGHT ?? 1),
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
 * @returns {Promise<{payer: string, amount: bigint, blockNumber: number, settledAt: number, txHash: string}>}
 *          settledAt is the block's timestamp in ms, not the time this ran.
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

  // When the payment settled, not when the receipt was handed in. Decay, tenure and
  // recency all key off this. Using the submission time made a year-old payment count
  // as fresh, so receipts could be hoarded and released to keep a score alive without
  // new work, and an agent's operating span collapsed to however fast its receipts
  // were posted. With the settlement time, an old receipt arrives already decayed and
  // hoarding buys nothing.
  let block;
  try {
    block = await provider.getBlock(receipt.blockNumber);
  } catch (err) {
    throw new PaymentError('rpc_error', `could not read block: ${err.message}`);
  }
  if (!block || typeof block.timestamp !== 'number') {
    // Never fall back to the current time: that silently reintroduces the bug this
    // exists to fix, and a retry costs nothing.
    throw new PaymentError('rpc_error', 'block timestamp unavailable');
  }

  return {
    payer,
    amount,
    blockNumber: receipt.blockNumber,
    settledAt: block.timestamp * 1000,
    txHash: txHash.toLowerCase(),
  };
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
 * Whether a payment is the agent's own side of the table paying itself.
 *
 * An operator can pay its own agent for the price of gas, since the money comes
 * straight back, and the resulting attestation is indistinguishable from a real
 * customer's. Catching the operator and the agent address does not stop someone
 * funding a second wallet, but it raises the floor from free to deliberate.
 */
function isSelfPayment(payer, identity) {
  const p = String(payer || '').toLowerCase();
  if (!p) return false;
  return p === String(identity.operator || '').toLowerCase()
      || p === String(identity.agentAddress || '').toLowerCase();
}

/**
 * Group decayed evidence by counterparty.
 *
 * Returns payer -> { volume, weight, successWeight }, all age-weighted. Kept
 * separate from the summing so the caps below operate per payer rather than on a
 * total that has already lost the distinction.
 */
function byPayer(events, halfLifeMs, now = Date.now()) {
  const out = new Map();
  for (const e of events) {
    const w = decayWeight(now - e.ts, halfLifeMs);
    const key = String(e.payer || '').toLowerCase();
    const cur = out.get(key) ?? { volume: 0n, weight: 0n, successWeight: 0n };
    cur.volume += (BigInt(e.amount) * w) / WEIGHT_SCALE;
    cur.weight += w;
    if (e.success) cur.successWeight += w;
    out.set(key, cur);
  }
  return out;
}

/**
 * How far a counterparty's cap is raised by its own standing.
 *
 * Returns a multiplier in [1, 1 + trustWeight]. An unknown wallet gets 1, which is
 * the behaviour before any of this existed. A ring of fresh agents all score 0 and so
 * grant each other nothing, which is the property that matters: a web of trust that
 * could be bootstrapped from nothing would be worse than no web at all.
 */
function trustMultiplier(payer, payerScores, trustWeight) {
  if (!trustWeight || trustWeight <= 0 || !payerScores) return 1;
  const score = payerScores[String(payer || '').toLowerCase()] || 0;
  return 1 + (Math.max(0, Math.min(100, score)) / 100) * trustWeight;
}

/**
 * Inherited trust, 0 to 5.
 *
 * One point per counterparty that is itself fully trusted, pro-rated by its score, so
 * five perfectly scored counterparties reach the cap and ten half-scored ones do the
 * same. Each counterparty contributes at most once however much it pays, because this
 * factor is about the breadth of who vouches for an agent, not the size of the
 * cheques. Scores are the matured ones, which lag, so a reciprocal pair cannot lift
 * each other in a single epoch.
 */
function propagationScore(events, payerScores, max = 5) {
  if (!payerScores) return 0;
  const seen = new Set();
  let trust = 0;
  for (const e of events) {
    const key = String(e.payer || '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    trust += Math.max(0, Math.min(100, payerScores[key] || 0)) / 100;
  }
  return Math.min(max, Math.floor(trust));
}

/// Scale for the fractional trust multiplier: a float cannot survive BigInt arithmetic,
/// so it is scaled up, applied, and divided back.
const TRUST_SCALE = 1000n;

/// `base` raised by the payer's own standing. Extracted because the identical scaled
/// integer idiom sat in both diversified* functions, and two copies of fiddly BigInt
/// arithmetic is how the two quietly stop agreeing.
function cappedAt(base, payer, payerScores, trustWeight) {
  const mult = BigInt(Math.round(
    trustMultiplier(payer, payerScores, trustWeight) * Number(TRUST_SCALE)
  ));
  return (base * mult) / TRUST_SCALE;
}

/**
 * Age-weighted volume with each counterparty's contribution capped.
 *
 * Without the cap, one wallet paying ten times is worth exactly as much as ten
 * wallets paying once, so a ring is as good as a customer base. `feeUnit` and
 * `maxPerPayer` together set the cap: no payer contributes more than
 * `maxPerPayer` points of feeScore however much it sends.
 */
// `grouped` is an optional pre-computed byPayer() map, last so every existing caller is
// unaffected. measuredFactorsFor now groups once and hands the same map to all three
// consumers instead of each rebuilding it. Deliberately an extra argument rather than a
// second "fast path" implementation: one body means the capping rules cannot diverge.
function diversifiedVolume(events, cfg, now = Date.now(), payerScores = null, grouped = null) {
  const { halfLifeMs, feeUnit, maxPerPayer, trustWeight } = cfg;
  if (!maxPerPayer || maxPerPayer <= 0) return decayedVolume(events, halfLifeMs, now);
  let total = 0n;
  for (const [payer, { volume }] of (grouped ?? byPayer(events, halfLifeMs, now))) {
    const cap = cappedAt(BigInt(feeUnit) * BigInt(maxPerPayer), payer, payerScores, trustWeight);
    total += volume > cap ? cap : volume;
  }
  return total;
}

/**
 * Age-weighted success ratio with each counterparty's evidence capped.
 *
 * The same reasoning as volume: a single payer filing a hundred attestations
 * should not buy the confidence that a hundred payers would. When a payer is
 * capped its successes are scaled by the same factor, so the cap changes how much
 * its opinion counts without changing what its opinion was.
 */
function diversifiedAttestations(events, cfg, now = Date.now(), payerScores = null, grouped = null) {
  const { halfLifeMs, maxPerPayer, trustWeight } = cfg;
  if (!maxPerPayer || maxPerPayer <= 0) return decayedAttestations(events, halfLifeMs, now);
  let successful = 0n, total = 0n;
  for (const [payer, { weight, successWeight }] of (grouped ?? byPayer(events, halfLifeMs, now))) {
    const cap = cappedAt(BigInt(maxPerPayer) * WEIGHT_SCALE, payer, payerScores, trustWeight);
    if (weight <= cap) { total += weight; successful += successWeight; }
    else { total += cap; successful += (successWeight * cap) / weight; }
  }
  return {
    successful: Number(successful / 1000n) / 1000,
    total: Number(total / 1000n) / 1000,
  };
}

/**
 * The agent's operating window, for the tenure factor.
 *
 * `recency` is the decay weight of the most recent payment, so a tenure that was
 * earned and then abandoned fades at the same rate as everything else. Self-payments
 * never reach the log, so this window is made of arm's-length trade only.
 */
function activityWindow(events, halfLifeMs, now = Date.now()) {
  if (!events || events.length === 0) return null;
  let first = Infinity, last = -Infinity;
  for (const e of events) {
    if (e.ts < first) first = e.ts;
    if (e.ts > last) last = e.ts;
  }
  return {
    firstActivitySec: Math.floor(first / 1000),
    lastActivitySec: Math.floor(last / 1000),
    recency: Number(decayWeight(now - last, halfLifeMs)) / Number(WEIGHT_SCALE),
  };
}

/// Distinct counterparties with any surviving weight. Reported, not scored.
function distinctPayers(events, halfLifeMs, now = Date.now()) {
  return byPayer(events, halfLifeMs, now).size;
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
  byPayer,
  isSelfPayment,
  trustMultiplier,
  propagationScore,
  diversifiedVolume,
  diversifiedAttestations,
  distinctPayers,
  activityWindow,
  WEIGHT_SCALE,
  TRANSFER_TOPIC,
};
