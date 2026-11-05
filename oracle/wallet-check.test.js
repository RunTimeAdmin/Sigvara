'use strict';

// What scripts/check-live.mjs holds the operators' wallets to, and that what it reads names them properly.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');

const checkLive = () => import('../scripts/check-live.mjs');
const USDC = 10n ** 18n; // gas on Arc is USDC, in 18 decimals
const WALLETS = { oracle: { address: '0xa', minUsdc: 10 }, checker: { address: '0xb', minUsdc: 1 } };

test('a wallet is low under its floor, and not at it', async () => {
  const { lowWallets } = await checkLive();
  assert.deepEqual(lowWallets(WALLETS, { oracle: 10n * USDC, checker: USDC }), []);
  assert.deepEqual(lowWallets(WALLETS, { oracle: 10n * USDC - 1n, checker: USDC }).map((w) => w.name), ['oracle']);
  assert.deepEqual(lowWallets(WALLETS, { oracle: 10n * USDC, checker: USDC - 1n }).map((w) => w.name), ['checker']);
});

test('each wallet has its own floor', async () => {
  const { lowWallets } = await checkLive();
  // 5 USDC is low for one and plenty for the other.
  assert.deepEqual(lowWallets(WALLETS, { oracle: 5n * USDC, checker: 5n * USDC }).map((w) => w.name), ['oracle']);
});

test('says which wallet, where it is, what it holds and what it should', async () => {
  const { lowWallets } = await checkLive();
  const [low] = lowWallets(WALLETS, { oracle: 2_340_000_000_000_000_000n, checker: USDC });
  assert.deepEqual(low, { name: 'oracle', address: '0xa', minUsdc: 10, usdc: '2.34' });
});

test('the scheduled services check runs it', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'check-live.mjs'), 'utf8');
  const body = source.slice(source.indexOf('async function checkServices()'), source.indexOf('async function rpcCall('));
  assert.match(body, /await checkWallets\(\)/);
});

test('the deployment record names real addresses with whole floors, for both operators and the publisher', () => {
  const { wallets } = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'deployments', '5042002.json'), 'utf8'));
  assert.deepEqual(Object.keys(wallets).sort(), ['checker', 'primary oracle', 'publisher']);
  for (const [name, w] of Object.entries(wallets)) {
    assert.equal(ethers.getAddress(w.address), w.address, name);
    assert.ok(Number.isInteger(w.minUsdc) && w.minUsdc > 0, name);
  }
});
