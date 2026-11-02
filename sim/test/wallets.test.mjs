import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ethers } from 'ethers';
import { loadMnemonic, walletAt, agentEd25519 } from '../src/wallets.mjs';

// The well-known test mnemonic, never used for anything real.
const PHRASE = 'test test test test test test test test test test test junk';

test('wallets are derived by index, the same each time', () => {
  assert.equal(walletAt(PHRASE, 0).address, '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
  assert.equal(walletAt(PHRASE, 101).address, walletAt(PHRASE, 101).address);
  assert.notEqual(walletAt(PHRASE, 100).address, walletAt(PHRASE, 101).address);
});

test('an agent Ed25519 key is 32 bytes, stable, and differs per agent', () => {
  const a = agentEd25519(walletAt(PHRASE, 100));
  assert.match(a, /^0x[0-9a-f]{64}$/);
  assert.equal(a, agentEd25519(walletAt(PHRASE, 100)));
  assert.notEqual(a, agentEd25519(walletAt(PHRASE, 101)));
});

test('a file that does not hold a mnemonic is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sim-'));
  writeFileSync(join(dir, 'good'), PHRASE + '\n');
  writeFileSync(join(dir, 'bad'), ethers.hexlify(ethers.randomBytes(32)));
  assert.equal(loadMnemonic(join(dir, 'good')), PHRASE);
  assert.throws(() => loadMnemonic(join(dir, 'bad')), /not hold a valid mnemonic/);
});
