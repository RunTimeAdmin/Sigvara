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
// How far signedAt may be after the time of the block it is checked at. A confirmed block is a
// little behind the head, and the head a little behind real time; an hour is far more than either.
const MAX_CHECK_LAG_SECONDS = 3_600;
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
 *   publish: whether the signed payloads are served (in /evidence and GET /outcomes). Off on
 *     mainnet until the retention policy covers copies held elsewhere (ADR 0006, Rollout 5).
 *   peers: the other operators to import payer-signed outcomes from (ADR 0006, section 6), as
 *     base URLs. Empty means no import; also off on mainnet until that review.
 *   importGraceMs: how long after an outcome's deadline an import may still reach this operator.
 *     A peer names the block it checked at and nothing proves it did, so past this an import is
 *     refused rather than judged at that block (PAYER_OUTCOMES_IMPORT_GRACE_HOURS, default 6).
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
  const graceHours = env.PAYER_OUTCOMES_IMPORT_GRACE_HOURS === undefined || env.PAYER_OUTCOMES_IMPORT_GRACE_HOURS === ''
    ? 6
    : Number(env.PAYER_OUTCOMES_IMPORT_GRACE_HOURS);
  if (!Number.isFinite(graceHours) || graceHours < 0) {
    throw new Error(`PAYER_OUTCOMES_IMPORT_GRACE_HOURS must be a number of hours, 0 or more, got "${env.PAYER_OUTCOMES_IMPORT_GRACE_HOURS}"`);
  }
  const peers = String(env.PAYER_OUTCOMES_PEERS || '').split(',').map((s) => s.trim()).filter(Boolean).map(peerUrl);
  if (peers.length && mode === 'off') {
    throw new Error('PAYER_OUTCOMES_PEERS needs PAYER_OUTCOMES: an oracle that takes no payer outcomes imports none');
  }
  return {
    mode,
    windowMs: windowDays * 86_400_000,
    negativeMinAmount: negative ? BigInt(negative) : paymentCfg.minAmount,
    publish: publish === 'on',
    peers,
    importGraceMs: graceHours * 3_600_000,
  };
}

/** A peer's base URL, without a trailing slash. Plain http is allowed: every import is checked. */
function peerUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`PAYER_OUTCOMES_PEERS: "${raw}" is not a URL`);
  }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username || url.password || url.search || url.hash) {
    throw new Error(`PAYER_OUTCOMES_PEERS: "${raw}" must be an http(s) base URL with no credentials, query or fragment`);
  }
  return url.href.replace(/\/+$/, '');
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
 * The CounterAudit packet that sealed a payer-signed outcome, as whoever carried the outcome named
 * it, or null. Checked for shape only, as the credentialed path checks its packetId: this oracle
 * never fetches the packet. It is served beside the outcome as counterauditPacketId, a pointer
 * anyone can check: CounterAudit's public proof for it names the EIP-712 hash of the outcome it
 * sealed, which a verifier recomputes from the payload served here.
 */
function packetIdOf(value) {
  return typeof value === 'string' && /^[0-9a-fA-F-]{36}$/.test(value) ? value : null;
}

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
 * The EIP-712 hash of a leg's outcome: what its payer signed, and the `signed_outcome_hash` a
 * CounterAudit packet seals for it.
 */
function outcomeHash(dom, didHash, txHash, value) {
  return ethers.TypedDataEncoder.hash(dom, TYPES, message(didHash, txHash, value));
}

/**
 * Whether signedAt and deadline allow this outcome, before any chain read (ADR 0006, section 3).
 * Whether the deadline has passed is checkedBlockProblem's question.
 *
 * Only "not in the future" reads this host's clock, and an answer that held when one operator
 * took the outcome still holds when another imports it later.
 *
 * @param {number} settledAtMs  the payment's block time
 * @returns {string|null} why not, or null
 */
function timingProblem(value, settledAtMs, nowMs = Date.now()) {
  if (value.signedAt * 1000 < settledAtMs) return 'signed before the payment settled';
  if (value.signedAt > Math.floor(nowMs / 1000) + MAX_FUTURE_SKEW_SECONDS) return 'signedAt is in the future';
  if (value.deadline > value.signedAt + MAX_DEADLINE_SECONDS) return 'the deadline is more than 30 days after signedAt';
  return null;
}

/**
 * Whether the block the signature is checked at allows this outcome: its deadline not passed at
 * that block's time, and the block not from well before the signature.
 *
 * Judged at the block, not by this host's clock, so an operator importing the outcome later,
 * checking at the block the first one recorded, reaches the same answer. The second rule stops a
 * peer naming a block from long before the outcome was signed. A peer can still name one up to
 * MAX_CHECK_LAG_SECONDS before, and a payer can date its signature back; ADR 0006 says what that
 * leaves.
 *
 * @param {number} checkedAtMs  the time of the block the signature is checked at
 * @returns {string|null} why not, or null
 */
function checkedBlockProblem(value, checkedAtMs) {
  const checkedSec = Math.floor(checkedAtMs / 1000);
  if (value.signedAt > checkedSec + MAX_CHECK_LAG_SECONDS) return 'checked at a block from before it was signed';
  if (value.deadline <= checkedSec) return 'the deadline has passed';
  return null;
}

/**
 * Why an imported outcome arrived too late to judge at the block its peer names, or null.
 *
 * The deadline is judged at the block the accepting operator says it checked at, and the payer's
 * signature does not cover that block. A peer could hold a signature past its deadline and pass
 * it on naming an earlier block. Nothing proves when the peer took it, so this bounds how late
 * that can be: the import must reach this operator, at its own confirmed head, within the grace
 * after the deadline (review M-02, 1 November 2026).
 */
function importLateProblem(value, arrivedAtMs, graceMs) {
  if (arrivedAtMs > value.deadline * 1000 + graceMs) {
    return `it reached this operator more than ${graceMs / 3_600_000} hours after its deadline`;
  }
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

/** A signature by the payer's own key, checked as OpenZeppelin's ECDSA would. Reads no state. */
function recover(dom, msg, signature) {
  if (!canonicalEcdsa(signature)) return { valid: false, signer: 'eoa' };
  let recovered;
  try {
    recovered = ethers.verifyTypedData(dom, TYPES, msg, signature);
  } catch {
    return { valid: false, signer: 'eoa' };
  }
  return { valid: recovered === msg.payer, signer: 'eoa' };
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
  if (!code || code === '0x') return recover(dom, msg, signature);
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
  // OpenZeppelin's rule: at least one word, and the first word is the magic value then zeros.
  // Anything after it is ignored (the vectors' contract_longer_answer); four bytes alone are not
  // a word (contract_short_answer).
  const valid =
    typeof answer === 'string' &&
    answer.length >= 66 &&
    answer.slice(0, 66).toLowerCase() === `${ERC1271_MAGIC}${'0'.repeat(56)}`;
  return { valid, signer: 'contract' };
}

/**
 * verifySignature for an outcome another operator checked at `blockNumber`, reading as little old
 * state as it can. A node that is not an archive node keeps state for only the last blocks, and an
 * import runs an epoch or more after the outcome was taken.
 *
 * An address with no code at this node's `headBlock` is checked by recovery, which reads no state.
 * Only one with code now is checked as of the recorded block: by ERC-1271 if it had code then, by
 * recovery if it gained code later (EIP-7702). That needs an archive node, and on one without, the
 * read fails as an RpcError and the import tries again later. An address that had code when the
 * outcome was taken and has none now is checked by recovery, so a signature only its old code
 * would accept is refused here.
 */
async function verifyImported({ provider, dom, msg, signature, blockNumber, headBlock }) {
  let code;
  try {
    code = await provider.getCode(msg.payer, headBlock);
  } catch (err) {
    throw new RpcError(`could not read the payer's code: ${err.message}`);
  }
  if (!code || code === '0x') return recover(dom, msg, signature);
  return verifySignature({ provider, dom, msg, signature, blockNumber });
}

// ---- Peer import (ADR 0006, section 6) ------------------------------------------------------

// GET /outcomes serves at most this many per page.
const OUTCOMES_PAGE = 500;
// A full page is a few hundred kilobytes. A peer that sends more is not answering the question.
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const isMs = (n) => Number.isSafeInteger(n) && n >= 0;

/**
 * One page of a peer's GET /outcomes after `since`. Throws on anything but a well-formed answer;
 * the items themselves are checked one by one (parseServed), so one bad item costs only itself.
 *
 * redirect: 'error', as the watcher does: the peer is somebody else's server, and following a
 * redirect it chooses would let it point this oracle at an address it could not reach itself.
 *
 * @returns {Promise<{ outcomes: unknown[], more: boolean }>}
 */
async function fetchOutcomesPage(peer, since, { timeoutMs = 20_000, maxBytes = MAX_PAGE_BYTES } = {}) {
  const res = await fetch(`${peer}/outcomes?since=${since}`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`GET /outcomes returned ${res.status}`);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error(`GET /outcomes sent more than ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!body || !Array.isArray(body.outcomes)) throw new Error('GET /outcomes sent no outcomes list');
  // A page is at most OUTCOMES_PAGE long. Anything past that is a peer padding it.
  return { outcomes: body.outcomes.slice(0, OUTCOMES_PAGE), more: body.more === true };
}

/**
 * An item a peer served, checked for shape only: everything that matters is checked again
 * against this oracle's own chain view, as if it had been posted here.
 *
 * @returns {{ ok: true, value: { didHash: string, txHash: string, checkedAtBlock: number,
 *   acceptedAt: number, signed: object, packetId: string|null } } | { ok: false, error: string }}
 */
function parseServed(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false, error: 'not an object' };
  const { didHash, txHash, checkedAtBlock, acceptedAt } = item;
  if (typeof didHash !== 'string' || !BYTES32.test(didHash)) return { ok: false, error: 'didHash is not 32 bytes' };
  if (typeof txHash !== 'string' || !BYTES32.test(txHash)) return { ok: false, error: 'txHash is not 32 bytes' };
  if (!Number.isSafeInteger(checkedAtBlock) || checkedAtBlock < 0) return { ok: false, error: 'checkedAtBlock is not a block number' };
  if (!isMs(acceptedAt)) return { ok: false, error: 'acceptedAt is not a time' };
  const signed = parse(item);
  if (!signed.ok) return signed;
  return {
    ok: true,
    value: {
      didHash: didHash.toLowerCase(),
      txHash: txHash.toLowerCase(),
      checkedAtBlock,
      acceptedAt,
      signed: signed.value,
      packetId: packetIdOf(item.counterauditPacketId),
    },
  };
}

module.exports = {
  TYPES,
  DELIVERED,
  NOT_DELIVERED,
  MAX_DEADLINE_SECONDS,
  MAX_FUTURE_SKEW_SECONDS,
  MAX_CHECK_LAG_SECONDS,
  ERC1271_MAGIC,
  readConfig,
  domain,
  parse,
  packetIdOf,
  message,
  outcomeHash,
  timingProblem,
  checkedBlockProblem,
  importLateProblem,
  verifySignature,
  verifyImported,
  RpcError,
  OUTCOMES_PAGE,
  fetchOutcomesPage,
  parseServed,
};
