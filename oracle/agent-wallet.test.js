'use strict';

// The publisher's agentWallet signature (agent-wallet.js). The whole ceremony, against a fork of
// Arc testnet, is rehearsed by hand: see the pull request that added this file.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { ethers } = require('ethers');
const { agentWalletTypedData, signedBy, requestSignature } = require('./agent-wallet');

const REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const OWNER = '0x18CBcE50390f5f6ebe4E20Fc17833F25c8D94811';
const coder = ethers.AbiCoder.defaultAbiCoder();

test('agentWalletTypedData: the digest is the one IdentityRegistryUpgradeable.setAgentWallet checks', () => {
  const publisher = ethers.Wallet.createRandom().address;
  const typed = agentWalletTypedData({ chainId: 5042002, registry: REGISTRY, agentId: 897764, newWallet: publisher, owner: OWNER, deadline: 1_793_740_000 });
  // As the contract builds it: _hashTypedDataV4(keccak256(abi.encode(AGENT_WALLET_SET_TYPEHASH,
  // agentId, newWallet, owner, deadline))), under EIP712("ERC8004IdentityRegistry", "1").
  const domainSeparator = ethers.keccak256(coder.encode(
    ['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
    [ethers.id('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'),
      ethers.id('ERC8004IdentityRegistry'), ethers.id('1'), 5042002, REGISTRY],
  ));
  const structHash = ethers.keccak256(coder.encode(
    ['bytes32', 'uint256', 'address', 'address', 'uint256'],
    [ethers.id('AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)'), 897764, publisher, OWNER, 1_793_740_000],
  ));
  const digest = ethers.keccak256(ethers.concat(['0x1901', domainSeparator, structHash]));
  assert.equal(ethers.TypedDataEncoder.hash(typed.domain, typed.types, typed.message), digest);
});

test('signedBy: only the new wallet\'s own signature counts', async () => {
  const publisher = ethers.Wallet.createRandom();
  const other = ethers.Wallet.createRandom();
  const typed = agentWalletTypedData({ chainId: 5042002, registry: REGISTRY, agentId: 897764, newWallet: publisher.address, owner: OWNER, deadline: 1 });
  assert.equal(signedBy(typed, await publisher.signTypedData(typed.domain, typed.types, typed.message)), true);
  assert.equal(signedBy(typed, await other.signTypedData(typed.domain, typed.types, typed.message)), false);
});

/** A JSON-RPC signer on a local port that signs typed data with `key`. */
async function fakeSigner(key, { method = 'eth_signTypedData_v4' } = {}) {
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const { id, method: asked, params } = JSON.parse(body);
    res.setHeader('content-type', 'application/json');
    if (asked !== method) return res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } }));
    const typed = JSON.parse(params[1]);
    delete typed.types.EIP712Domain;
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result: await key.signTypedData(typed.domain, typed.types, typed.message) }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test('requestSignature: asks the remote signer, and checks the answer is the publisher\'s', async () => {
  const publisher = ethers.Wallet.createRandom();
  const typed = agentWalletTypedData({ chainId: 5042002, registry: REGISTRY, agentId: 897764, newWallet: publisher.address, owner: OWNER, deadline: 1 });
  for (const method of ['eth_signTypedData_v4', 'eth_signTypedData']) {
    const s = await fakeSigner(publisher, { method });
    try {
      assert.ok(signedBy(typed, await requestSignature(s.url, typed, 'ab'.repeat(32))), method);
    } finally {
      await s.close();
    }
  }
});

test('requestSignature: a signature from another key is refused', async () => {
  const publisher = ethers.Wallet.createRandom();
  const typed = agentWalletTypedData({ chainId: 5042002, registry: REGISTRY, agentId: 897764, newWallet: publisher.address, owner: OWNER, deadline: 1 });
  const s = await fakeSigner(ethers.Wallet.createRandom());
  try {
    await assert.rejects(requestSignature(s.url, typed, 'ab'.repeat(32)), /not the publisher's/);
  } finally {
    await s.close();
  }
});
