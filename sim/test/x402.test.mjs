import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { authorization, settleRequest, nonceFor, AUTH_TYPES, USDC_DOMAIN, BASE_USDC } from '../src/batch2/x402.mjs';

const payer = new ethers.Wallet('0x' + '11'.repeat(32));
const to = '0x' + '22'.repeat(20);
const NOW = 1_800_000_000;

test('an authorization is valid now, for an hour, with a nonce fixed by its action', () => {
  const a = authorization({ from: payer.address, to, value: 50_000n, key: 'pay:5:1210:base', seed: 's', nowS: NOW });
  assert.ok(a.validAfter < BigInt(NOW) && a.validBefore === BigInt(NOW + 3600));
  assert.equal(a.nonce, nonceFor('s', 'pay:5:1210:base'));
  assert.equal(authorization({ from: payer.address, to, value: 1n, key: 'pay:5:1210:base', seed: 's', nowS: NOW + 99 }).nonce, a.nonce,
    'a retry of the same action reuses its nonce, so USDC refuses a second transfer');
  assert.notEqual(nonceFor('s', 'pay:6:1210:base'), a.nonce);
});

test('the settle request is x402 version 1, exact scheme on base-sepolia, paying the signed amount to the signed address', async () => {
  const a = authorization({ from: payer.address, to, value: 70_000n, key: 'k', seed: 's', nowS: NOW });
  const signature = await payer.signTypedData(USDC_DOMAIN, AUTH_TYPES, a);
  const body = settleRequest(a, signature, 'https://sigvara.xyz/simulation?batch=2');
  assert.equal(body.x402Version, 1);
  const { paymentPayload: p, paymentRequirements: r } = body;
  assert.equal(p.scheme, 'exact');
  assert.equal(p.network, 'base-sepolia');
  assert.equal(r.network, 'base-sepolia');
  assert.equal(r.asset, BASE_USDC);
  assert.equal(r.payTo, ethers.getAddress(to));
  assert.equal(r.maxAmountRequired, '70000');
  assert.deepEqual(r.extra, { name: 'USDC', version: '2' });
  const auth = p.payload.authorization;
  assert.equal(auth.value, '70000');
  assert.equal(auth.from, payer.address);
  const signed = { ...auth, value: BigInt(auth.value), validAfter: BigInt(auth.validAfter), validBefore: BigInt(auth.validBefore) };
  assert.equal(ethers.verifyTypedData(USDC_DOMAIN, AUTH_TYPES, signed, p.payload.signature), payer.address,
    'the signature in the body is the payer\'s over exactly the authorization in it');
});
