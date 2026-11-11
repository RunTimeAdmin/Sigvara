// Base Sepolia USDC payments as x402's exact scheme makes them: the payer signs an EIP-3009
// transferWithAuthorization, and a facilitator submits it and pays the gas. The batch uses the public
// testnet facilitator, so nothing in it needs Base Sepolia ETH. The transfer is still the payer's own,
// so the oracle reads the payer from it as it would from a plain transfer.
//
// Pure: the runner (run.mjs) signs and sends.

import { ethers } from 'ethers';

export const BASE_CHAIN_ID = 84532;
export const BASE_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
// x402's name for the network in its first protocol version, which the public facilitator still serves.
export const NETWORK = 'base-sepolia';
// How long a signed authorization stays usable, and how far back it is dated, to allow for clock skew.
const VALID_FOR_S = 3600;
const BACKDATE_S = 600;

export const AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' }, { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' }, { name: 'validBefore', type: 'uint256' }, { name: 'nonce', type: 'bytes32' },
  ],
};

// The token's own EIP-712 domain (its name() and version() on Base Sepolia).
export const USDC_DOMAIN = { name: 'USDC', version: '2', chainId: BASE_CHAIN_ID, verifyingContract: BASE_USDC };

/**
 * The authorization for one transfer. The nonce comes from `key`, an action id, so the same action can
 * never move money twice: USDC refuses a nonce it has seen.
 */
export function authorization({ from, to, value, key, seed, nowS }) {
  return {
    from: ethers.getAddress(from),
    to: ethers.getAddress(to),
    value: BigInt(value),
    validAfter: BigInt(nowS - BACKDATE_S),
    validBefore: BigInt(nowS + VALID_FOR_S),
    nonce: nonceFor(seed, key),
  };
}

export const nonceFor = (seed, key) => ethers.keccak256(ethers.toUtf8Bytes(`${seed}:${key}`));

/** The body of a facilitator's POST /settle (and /verify), x402 version 1, exact scheme. */
export function settleRequest(auth, signature, resource) {
  const authorization = {
    from: auth.from, to: auth.to, value: auth.value.toString(),
    validAfter: auth.validAfter.toString(), validBefore: auth.validBefore.toString(), nonce: auth.nonce,
  };
  return {
    x402Version: 1,
    paymentPayload: { x402Version: 1, scheme: 'exact', network: NETWORK, payload: { signature, authorization } },
    paymentRequirements: {
      scheme: 'exact',
      network: NETWORK,
      maxAmountRequired: authorization.value,
      resource,
      description: 'A job in Sigvara\'s testnet simulation',
      mimeType: 'application/json',
      payTo: auth.to,
      maxTimeoutSeconds: VALID_FOR_S,
      asset: BASE_USDC,
      extra: { name: USDC_DOMAIN.name, version: USDC_DOMAIN.version },
    },
  };
}
