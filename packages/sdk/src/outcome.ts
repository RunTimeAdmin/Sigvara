import { ethers } from 'ethers';

// Outcomes signed by the payer (docs/adr/0006-payer-signed-outcomes.md).
//
// After paying an agent, the payer signs whether the work was delivered, over EIP-712 typed data
// that binds the outcome to that payment. Any Sigvara oracle takes it at POST /attest without a
// token, because the signature is the credential, and other operators import it from there.
// signPaymentOutcome makes the `payerOutcome` that request carries. verifyPaymentOutcome checks
// one the way the oracle does, which is the rule OpenZeppelin's SignatureChecker applies on chain.
// test/vectors/payment-outcome.json holds the cases both are tested against.

const TYPES: Record<string, ethers.TypedDataField[]> = {
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
for (const fields of Object.values(TYPES)) {
  for (const f of fields) Object.freeze(f);
  Object.freeze(fields);
}
Object.freeze(TYPES);

/**
 * The EIP-712 types, for a wallet that signs typed data itself. Frozen at run time, since signing and
 * verifying use the same object; typed as ethers takes it, so it can be passed to signTypedData.
 */
export const PAYMENT_OUTCOME_TYPES: Record<string, ethers.TypedDataField[]> = TYPES;

/** The work was delivered. */
export const OUTCOME_DELIVERED = 1;
/** The work was not delivered. Oracles take it only where negatives are switched on. */
export const OUTCOME_NOT_DELIVERED = 2;
export type PaymentOutcomeCode = typeof OUTCOME_DELIVERED | typeof OUTCOME_NOT_DELIVERED;

/** The furthest a deadline may be from signedAt. Oracles refuse anything later. */
export const MAX_OUTCOME_DEADLINE_SECONDS = 30 * 86_400;
const DEFAULT_TTL_SECONDS = 86_400;
// Gas for one isValidSignature call, as the oracle allows.
const ERC1271_GAS = 2_000_000n;
const ERC1271_MAGIC_WORD = `0x1626ba7e${'0'.repeat(56)}`;
const ERC1271 = new ethers.Interface(['function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)']);
// secp256k1n / 2: OpenZeppelin refuses a signature with a higher s.
const HALF_ORDER = BigInt('0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0');
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
// The longest signature an oracle takes. An ERC-1271 one can be longer than 65 bytes (a multisig's), not unboundedly.
const MAX_SIGNATURE_BYTES = 4096;

/** Which deployment an outcome is signed for: the chain the payment settled on, and its SigvaraReputation proxy. */
export interface PaymentOutcomeDeployment {
  chainId: number | bigint;
  reputationAddress: string;
}

/** What POST /attest takes as `payerOutcome`. */
export interface SignedPaymentOutcome {
  payer: string;
  outcome: PaymentOutcomeCode;
  evidence: string;
  signedAt: number;
  deadline: number;
  signature: string;
}

export interface SignPaymentOutcomeOptions extends PaymentOutcomeDeployment {
  /** The agent the payment went to. */
  didHash: string;
  /** The settlement transaction. */
  txHash: string;
  outcome: PaymentOutcomeCode;
  /** Optional 32-byte reference: the hash of what was received, say. Zero by default. */
  evidence?: string;
  /** The sender of the payment. Defaults to the signer's address; set it to a smart account's address when its owner signs. */
  payer?: string;
  /** Seconds. Defaults to now. */
  signedAt?: number;
  /** Seconds, at most 30 days after signedAt. Defaults to a day after it. */
  deadline?: number;
}

export interface VerifyPaymentOutcomeOptions extends PaymentOutcomeDeployment {
  didHash: string;
  txHash: string;
  /** As POST /attest takes it. A missing `evidence` is zero, as the oracle reads it. */
  payerOutcome: SignedPaymentOutcome;
  /**
   * A node on the payment's chain. Required: whether the payer has code decides how its signature
   * is checked, and an address can gain code (a smart account, or EIP-7702).
   */
  provider: Pick<ethers.Provider, 'getCode' | 'call'>;
  /**
   * The block to check at, read for both the payer's code and its account's answer. Pass a block
   * number to have both read at one block: the oracle records the one it used as checkedAtBlock.
   * By default each read is at the latest block.
   */
  blockTag?: ethers.BlockTag;
}

/** The EIP-712 domain: Sigvara, version 1, on the payment's chain, for its SigvaraReputation proxy. */
export function paymentOutcomeDomain({ chainId, reputationAddress }: PaymentOutcomeDeployment): ethers.TypedDataDomain {
  return {
    name: 'Sigvara',
    version: '1',
    chainId: BigInt(chainId),
    verifyingContract: ethers.getAddress(reputationAddress),
  };
}

function checkShape(fn: string, v: {
  didHash: string; txHash: string; payer: string; outcome: number; evidence: string; signedAt: number; deadline: number;
}): void {
  if (!v.payer || typeof v.payer !== 'string') throw new TypeError(`${fn}: payer must be an address`);
  if (!BYTES32.test(v.didHash)) throw new TypeError(`${fn}: didHash must be 32 bytes of hex`);
  if (!BYTES32.test(v.txHash)) throw new TypeError(`${fn}: txHash must be 32 bytes of hex`);
  if (!ethers.isAddress(v.payer)) throw new TypeError(`${fn}: payer must be an address`);
  if (v.outcome !== OUTCOME_DELIVERED && v.outcome !== OUTCOME_NOT_DELIVERED) {
    throw new TypeError(`${fn}: outcome must be 1 (delivered) or 2 (not delivered)`);
  }
  if (!BYTES32.test(v.evidence)) throw new TypeError(`${fn}: evidence must be 32 bytes of hex`);
  for (const [name, n] of [['signedAt', v.signedAt], ['deadline', v.deadline]] as const) {
    if (!Number.isSafeInteger(n) || n < 0) throw new TypeError(`${fn}: ${name} must be a whole number of seconds`);
  }
}

/**
 * Signs the outcome of one payment leg, as its payer.
 *
 * The signer is the payer's own key, or the owner key of a smart account that answers ERC-1271
 * for its owner's EIP-712 signatures (pass the account as `payer`). An account that wraps or
 * re-hashes what its owner signs needs its own wallet SDK to sign the same typed data; build the
 * SignedPaymentOutcome from that signature.
 *
 * A signature with v 0 or 1, as some wallets give, is rewritten with v 27 or 28, which is what
 * OpenZeppelin and the oracle take. When the signer is the payer, the signature is recovered before
 * it is returned, so one the oracle would refuse is an error here.
 *
 * @returns the `payerOutcome` for POST /attest, beside `didHash` and `payment.txHash`
 */
export async function signPaymentOutcome(
  signer: Pick<ethers.Signer, 'getAddress' | 'signTypedData'>,
  opts: SignPaymentOutcomeOptions,
): Promise<SignedPaymentOutcome> {
  const payer = ethers.getAddress(opts.payer ?? (await signer.getAddress()));
  const signedAt = opts.signedAt ?? Math.floor(Date.now() / 1000);
  const value = {
    didHash: opts.didHash,
    txHash: opts.txHash,
    payer,
    outcome: opts.outcome,
    evidence: opts.evidence ?? ethers.ZeroHash,
    signedAt,
    deadline: opts.deadline ?? signedAt + DEFAULT_TTL_SECONDS,
  };
  checkShape('signPaymentOutcome', value);
  if (value.deadline <= value.signedAt || value.deadline > value.signedAt + MAX_OUTCOME_DEADLINE_SECONDS) {
    throw new RangeError('signPaymentOutcome: deadline must be after signedAt and at most 30 days after it');
  }
  const domain = paymentOutcomeDomain(opts);
  const raw = ethers.getBytes(await signer.signTypedData(domain, TYPES, value));
  if (raw.length === 65 && (raw[64] === 0 || raw[64] === 1)) raw[64] += 27;
  const signature = ethers.hexlify(raw);
  if (payer === ethers.getAddress(await signer.getAddress()) && !recoversToPayer(domain, value, payer, signature)) {
    throw new Error('signPaymentOutcome: the signer\'s signature does not recover to the payer, so no oracle would take it');
  }
  return {
    payer,
    outcome: value.outcome,
    evidence: value.evidence.toLowerCase(),
    signedAt: value.signedAt,
    deadline: value.deadline,
    signature,
  };
}

/** A signature by the payer's own key, checked as OpenZeppelin's ECDSA would: 65 bytes, v 27 or 28, low s. */
function recoversToPayer(domain: ethers.TypedDataDomain, value: Record<string, unknown>, payer: string, signature: string): boolean {
  let bytes: Uint8Array;
  try {
    bytes = ethers.getBytes(signature);
  } catch {
    return false;
  }
  if (bytes.length !== 65) return false;
  const s = BigInt(ethers.hexlify(bytes.slice(32, 64)));
  if (s > HALF_ORDER || (bytes[64] !== 27 && bytes[64] !== 28)) return false;
  try {
    return ethers.verifyTypedData(domain, TYPES, value, signature) === payer;
  } catch {
    return false;
  }
}

// What a node says when the account's code itself refused: a revert, or running out of gas or into
// an invalid instruction. ethers reports every eth_call error as CALL_EXCEPTION, so the node's own
// message is what tells the account's "no" from the node failing to answer.
const ACCOUNT_REFUSED = /revert|out of gas|invalid opcode|invalid jump|stack (under|over)flow/i;

function accountRefused(err: unknown): boolean {
  const e = err as { code?: string; data?: unknown; info?: { error?: { message?: unknown } }; shortMessage?: unknown; message?: unknown };
  if (!e || e.code !== 'CALL_EXCEPTION') return false;
  if (typeof e.data === 'string' && e.data.length > 2) return true;
  const nodeSaid = e.info?.error?.message;
  if (typeof nodeSaid === 'string') return ACCOUNT_REFUSED.test(nodeSaid);
  return [e.shortMessage, e.message]
    .filter((m): m is string => typeof m === 'string')
    .some((m) => ACCOUNT_REFUSED.test(m.replace(/missing revert data/gi, '')));
}

/**
 * Whether a payer-signed outcome carries its payer's signature for this payment leg, the way a
 * Sigvara oracle decides it: an address without code by recovery, one with code by ERC-1271 at
 * `blockTag`, as OpenZeppelin's SignatureChecker does. This is the signature only, not whether an
 * oracle will take the outcome: the oracle also checks the payment, the payer's leg in it, the
 * timing and its own records.
 *
 * It differs from the on-chain rule in ways that matter only to accounts that break ERC-1271 or
 * lean on its edges, and the oracle differs the same way: an eth_call is not a static call, so an
 * account that writes storage while answering is accepted here and refused on chain; the call is
 * capped at 2,000,000 gas; its `bytes` argument is padded to a whole word, where OpenZeppelin sends
 * it unpadded; and an empty signature, or one over 4096 bytes, is refused before the account is
 * asked (a Safe can approve a message on chain and take an empty signature for it).
 *
 * @throws TypeError when the outcome is not shaped as one or no provider is given, and Error when
 *   the provider cannot answer
 */
export async function verifyPaymentOutcome(opts: VerifyPaymentOutcomeOptions): Promise<{ valid: boolean; signer: 'eoa' | 'contract' }> {
  const p = opts.payerOutcome;
  if (!opts.provider) {
    throw new TypeError('verifyPaymentOutcome: a provider is required, to read whether the payer has code');
  }
  const value = {
    didHash: opts.didHash,
    txHash: opts.txHash,
    payer: p?.payer,
    outcome: p?.outcome,
    evidence: p?.evidence ?? ethers.ZeroHash,
    signedAt: p?.signedAt,
    deadline: p?.deadline,
  };
  checkShape('verifyPaymentOutcome', value);
  if (
    typeof p.signature !== 'string'
    || !/^0x([0-9a-fA-F]{2})+$/.test(p.signature)
    || (p.signature.length - 2) / 2 > MAX_SIGNATURE_BYTES
  ) {
    throw new TypeError(`verifyPaymentOutcome: signature must be hex bytes, at most ${MAX_SIGNATURE_BYTES} of them`);
  }
  const payer = ethers.getAddress(value.payer);
  const typed = { ...value, payer };
  const domain = paymentOutcomeDomain(opts);
  const code = await opts.provider.getCode(payer, opts.blockTag);
  if (!code || code === '0x') {
    return { valid: recoversToPayer(domain, typed, payer, p.signature), signer: 'eoa' };
  }
  const hash = ethers.TypedDataEncoder.hash(domain, TYPES, typed);
  let answer: string;
  try {
    answer = await opts.provider.call({
      to: payer,
      data: ERC1271.encodeFunctionData('isValidSignature', [hash, p.signature]),
      blockTag: opts.blockTag,
      gasLimit: ERC1271_GAS,
    });
  } catch (err) {
    if (accountRefused(err)) return { valid: false, signer: 'contract' };
    throw new Error(`verifyPaymentOutcome: could not ask the payer's account: ${(err as Error).message}`);
  }
  // At least one word, and the first word is the magic value then zeros; the rest is ignored.
  const valid = typeof answer === 'string' && answer.length >= 66 && answer.slice(0, 66).toLowerCase() === ERC1271_MAGIC_WORD;
  return { valid, signer: 'contract' };
}
