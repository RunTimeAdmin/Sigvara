'use strict';

// Outcomes signed by the payer (docs/adr/0006-payer-signed-outcomes.md).
//
// A payment's outcome has been a credentialed service's word. Here the party that paid signs
// it, over EIP-712 typed data that binds the outcome to that payment, so any operator can check
// it without trusting whoever carried it. This module holds what that check needs and nothing
// that touches state: the type and domain, parsing a request, the signature, and the timing.
// Precedence lives with the payment log in store.js.

const { ethers } = require('ethers');

const TYPES = {
  PaymentOutcome: [
    { name: 'didHash', type: 'bytes32' },
    { name: 'txHash', type: 'bytes32' },
    { name: 'payer', type: 'address' },
    { name: 'outcome', type: 'uint8' },
    { name: 'evidence', type: 'bytes32' },
    { name: 'signedAt', type: 'uint64' },
    { name: 'deadline', type: 'uint64' },
  ],
};

const DELIVERED = 1;
const NOT_DELIVERED = 2;
// A deadline further out than this is refused, so a signature cannot sit in reserve for long.
const MAX_DEADLINE_SECONDS = 30 * 86_400;
// How far ahead of this host's clock signedAt may be.
const MAX_FUTURE_SKEW_SECONDS = 300;
// An ERC-1271 signature can be longer than 65 bytes (a multisig's, say), but not unboundedly.
const MAX_SIGNATURE_BYTES = 4096;
const ERC1271_MAGIC = '0x1626ba7e';
const ERC1271 = new ethers.Interface(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)']);
// Gas for one isValidSignature call. Enough for a passkey (P-256) account without a precompile,
// which needs a few hundred thousand; the node's own cap is far higher, and anyone with a funded
// leg can make this oracle run their account's code.
const ERC1271_GAS = 2_000_000n;
// What a node says when the account's code itself refused: a revert, or running out of gas or
// into an invalid instruction. ethers reports every eth_call error as CALL_EXCEPTION, so the
// node's message is what tells the account's "no" from the node failing to answer.
const ACCOUNT_REFUSED = /revert|out of gas|invalid opcode|invalid jump|stack (under|over)flow/i;

function accountRefused(err) {
  if (!err || err.code !== 'CALL_EXCEPTION') return false;
  if (typeof err.data === 'string' && err.data.length > 2) return true;
  const said = [err.info?.error?.message, err.shortMessage, err.message].filter((m) => typeof m === 'string');
  // ethers words a call error that carried no revert data as "missing revert data", which is
  // not the account reverting; only the node's own message counts.
  const nodeSaid = typeof err.info?.error?.message === 'string' ? err.info.error.message : null;
  if (nodeSaid !== null) return ACCOUNT_REFUSED.test(nodeSaid);
  return said.some((m) => ACCOUNT_REFUSED.test(m.replace(/missing revert data/gi, '')));
}
// secp256k1n / 2. OpenZeppelin's ECDSA refuses a signature with a higher s, the malleable twin
// of a valid one, and this oracle must accept exactly what the contracts would.
const HALF_ORDER = BigInt('0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0');

const MODES = ['off', 'positive', 'both'];

/**
 * @param {Record<string, string|undefined>} env
 * @param {{ minAmount: bigint }} paymentCfg
 * @returns {{ mode: 'off'|'positive'|'both', windowMs: number, negativeMinAmount: bigint, publish: boolean }}
 *   mode: which payer-signed outcomes are taken. `positive` takes only "delivered"; negatives
 *     wait for a challenge process (ADR 0006, section 5).
 *   windowMs: how long after the payment's block time a payer-signed outcome may replace a
 *     credentialed one.
 *   negativeMinAmount: the least a payment leg must carry for its payer's "not delivered" to
 *     count, in the payment asset's base units. Starts at PAYMENT_MIN_AMOUNT.
 *   publish: whether the signed payloads are served (in /evidence). Off on mainnet until the
 *     retention policy covers copies held elsewhere (ADR 0006, Rollout 5).
 */
function readConfig(env = process.env, paymentCfg) {
  const mode = String(env.PAYER_OUTCOMES || 'off').toLowerCase();
  if (!MODES.includes(mode)) {
    throw new Error(`PAYER_OUTCOMES must be one of ${MODES.join(', ')}, got "${env.PAYER_OUTCOMES}"`);
  }
  const publish = String(env.PAYER_OUTCOMES_PUBLISH || 'off').toLowerCase();
  if (publish !== 'on' && publish !== 'off') {
    throw new Error(`PAYER_OUTCOMES_PUBLISH must be "on" or "off", got "${env.PAYER_OUTCOMES_PUBLISH}"`);
  }
  const negative = env.PAYER_NEGATIVE_MIN_AMOUNT;
  if (negative !== undefined && negative !== '' && !/^\d+$/.test(negative)) {
    throw new Error('PAYER_NEGATIVE_MIN_AMOUNT must be a whole number of the payment asset\'s base units');
  }
  // A window that is not a finite, non-negative number would let a credentialed outcome be
  // replaced forever (NaN compares false) or never, so it stops the process instead.
  const windowDays = env.PAYER_OUTCOME_WINDOW_DAYS === undefined || env.PAYER_OUTCOME_WINDOW_DAYS === ''
    ? 14
    : Number(env.PAYER_OUTCOME_WINDOW_DAYS);
  if (!Number.isFinite(windowDays) || windowDays < 0) {
    throw new Error(`PAYER_OUTCOME_WINDOW_DAYS must be a number of days, 0 or more, got "${env.PAYER_OUTCOME_WINDOW_DAYS}"`);
  }
  return {
    mode,
    windowMs: windowDays * 86_400_000,
    negativeMinAmount: negative ? BigInt(negative) : paymentCfg.minAmount,
    publish: publish === 'on',
  };
}

/** The domain: Sigvara, version 1, on the chain the payment settled on, for its SigvaraReputation proxy. */
function domain(chainId, reputationAddress) {
  return {
    name: 'Sigvara',
    version: '1',
    chainId: BigInt(chainId),
    verifyingContract: ethers.getAddress(reputationAddress),
  };
}

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const isUint64 = (n) => Number.isSafeInteger(n) && n >= 0;

/**
 * The `payerOutcome` of a request, checked for shape only.
 * @returns {{ ok: true, value: { payer: string, outcome: 1|2, evidence: string, signedAt: number,
 *   deadline: number, signature: string } } | { ok: false, error: string }}
 */
function parse(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'payerOutcome must be an object' };
  }
  const { payer, outcome, signedAt, deadline, signature } = raw;
  const evidence = raw.evidence ?? ethers.ZeroHash;
  if (typeof payer !== 'string' || !ethers.isAddress(payer)) {
    return { ok: false, error: 'payerOutcome.payer must be an address' };
  }
  if (outcome !== DELIVERED && outcome !== NOT_DELIVERED) {
    return { ok: false, error: 'payerOutcome.outcome must be 1 (delivered) or 2 (not delivered)' };
  }
  if (typeof evidence !== 'string' || !BYTES32.test(evidence)) {
    return { ok: false, error: 'payerOutcome.evidence must be a 32-byte hex string' };
  }
  if (!isUint64(signedAt) || !isUint64(deadline)) {
    return { ok: false, error: 'payerOutcome.signedAt and deadline must be whole numbers of seconds' };
  }
  if (
    typeof signature !== 'string' ||
    !/^0x([0-9a-fA-F]{2})+$/.test(signature) ||
    (signature.length - 2) / 2 > MAX_SIGNATURE_BYTES
  ) {
    return { ok: false, error: 'payerOutcome.signature must be hex bytes' };
  }
  return {
    ok: true,
    value: {
      payer: ethers.getAddress(payer),
      outcome,
      evidence: evidence.toLowerCase(),
      signedAt,
      deadline,
      signature: signature.toLowerCase(),
    },
  };
}

/** The typed-data message for a payment leg. */
function message(didHash, txHash, value) {
  return {
    didHash,
    txHash,
    payer: value.payer,
    outcome: value.outcome,
    evidence: value.evidence,
    signedAt: value.signedAt,
    deadline: value.deadline,
  };
}

/**
 * Whether signedAt and deadline allow this outcome now (ADR 0006, section 3).
 * @param {number} settledAtMs  the payment's block time
 * @returns {string|null} why not, or null
 */
function timingProblem(value, settledAtMs, nowMs = Date.now()) {
  const nowSec = Math.floor(nowMs / 1000);
  if (value.signedAt * 1000 < settledAtMs) return 'signed before the payment settled';
  if (value.signedAt > nowSec + MAX_FUTURE_SKEW_SECONDS) return 'signedAt is in the future';
  if (value.deadline <= nowSec) return 'the deadline has passed';
  if (value.deadline > value.signedAt + MAX_DEADLINE_SECONDS) return 'the deadline is more than 30 days after signedAt';
  return null;
}

/** A 65-byte secp256k1 signature OpenZeppelin's ECDSA would accept: v 27 or 28, low s. */
function canonicalEcdsa(signature) {
  const bytes = ethers.getBytes(signature);
  if (bytes.length !== 65) return false;
  const s = BigInt(ethers.hexlify(bytes.slice(32, 64)));
  const v = bytes[64];
  return s <= HALF_ORDER && (v === 27 || v === 28);
}

class RpcError extends Error {
  constructor(message) {
    super(message);
    this.code = 'rpc_error';
  }
}

/**
 * Checks the payer's signature the way OpenZeppelin's SignatureChecker does, which is what
 * SigvaraIdentity applies to agent wallets: an address without code signs by recovery, one with
 * code answers ERC-1271's isValidSignature. Both are read at `blockNumber`, so a contract
 * account's answer is pinned to the block it was checked at (ADR 0006, section 6).
 *
 * @param {{ getCode: Function, call: Function }} provider
 * @returns {Promise<{ valid: boolean, signer: 'eoa'|'contract' }>}
 * @throws {RpcError} when the node cannot answer, which is not the signer's fault
 */
async function verifySignature({ provider, dom, msg, signature, blockNumber }) {
  let code;
  try {
    code = await provider.getCode(msg.payer, blockNumber);
  } catch (err) {
    throw new RpcError(`could not read the payer's code: ${err.message}`);
  }
  if (!code || code === '0x') {
    if (!canonicalEcdsa(signature)) return { valid: false, signer: 'eoa' };
    let recovered;
    try {
      recovered = ethers.verifyTypedData(dom, TYPES, msg, signature);
    } catch {
      return { valid: false, signer: 'eoa' };
    }
    return { valid: recovered === msg.payer, signer: 'eoa' };
  }
  const hash = ethers.TypedDataEncoder.hash(dom, TYPES, msg);
  let answer;
  try {
    answer = await provider.call({
      to: msg.payer,
      data: ERC1271.encodeFunctionData('isValidSignature', [hash, signature]),
      blockTag: blockNumber,
      gasLimit: ERC1271_GAS,
    });
  } catch (err) {
    // The account's own refusal is a no. A node that cannot answer (no state at that block, a
    // rate limit, a timeout) is not the signer's fault, and must not read as a bad signature.
    if (accountRefused(err)) return { valid: false, signer: 'contract' };
    throw new RpcError(`could not ask the payer's account: ${err.message}`);
  }
  // A bytes4 return is one word: the magic value, then zeros. Anything else is not a yes.
  const valid =
    typeof answer === 'string' &&
    answer.length === 66 &&
    answer.toLowerCase() === `${ERC1271_MAGIC}${'0'.repeat(56)}`;
  return { valid, signer: 'contract' };
}

module.exports = {
  TYPES,
  DELIVERED,
  NOT_DELIVERED,
  MAX_DEADLINE_SECONDS,
  MAX_FUTURE_SKEW_SECONDS,
  ERC1271_MAGIC,
  readConfig,
  domain,
  parse,
  message,
  timingProblem,
  verifySignature,
  RpcError,
};
