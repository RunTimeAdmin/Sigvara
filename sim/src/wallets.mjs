// Every simulation wallet comes from one mnemonic, by role index (cast.mjs INDEX), so the whole
// cast is recoverable from a single secret and its addresses can be published without it.
// The mnemonic is read from a file and never printed.

import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { seedToKeyPair, pubKeyToBytes32 } from '@sigvara/protocol-sdk';

export function loadMnemonic(file) {
  const phrase = readFileSync(file, 'utf8').trim();
  if (!ethers.Mnemonic.isValidMnemonic(phrase)) throw new Error(`${file} does not hold a valid mnemonic`);
  return phrase;
}

/** The wallet at `index`, connected to `provider` when one is given. */
export function walletAt(phrase, index, provider) {
  const w = ethers.HDNodeWallet.fromPhrase(phrase, undefined, `m/44'/60'/0'/0/${index}`);
  return provider ? w.connect(provider) : w;
}

/** An agent's Ed25519 key, derived from its wallet so it never needs storing on its own. */
export function agentEd25519(wallet) {
  const seed = ethers.keccak256(ethers.concat([wallet.privateKey, ethers.toUtf8Bytes('sigvara-sim:ed25519')]));
  return pubKeyToBytes32(seedToKeyPair(seed).publicKey);
}
