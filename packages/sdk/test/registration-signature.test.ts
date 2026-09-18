import { describe, it, expect } from 'vitest';
import { ethers } from 'ethers';

/**
 * The registration digest is returned unprefixed and signed with personal_sign, so the
 * EIP-191 prefix is applied exactly once. Getting this wrong produces a signature that
 * compiles, transmits and is rejected on chain, so the convention is pinned here.
 */
describe('registration signature convention', () => {
  const TYPEHASH = ethers.keccak256(
    ethers.toUtf8Bytes(
      'SigvaraRegistration(uint256 chainId,address registry,address agentAddress,address operator,bytes32 ed25519PubKey)'
    )
  );

  const digestFor = (chainId: bigint, registry: string, agent: string, operator: string, pub: string) =>
    ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['bytes32', 'uint256', 'address', 'address', 'address', 'bytes32'],
        [TYPEHASH, chainId, registry, agent, operator, pub]
      )
    );

  const registry = '0x7e3aFC532eE5d922ab3cc3FFb510c7C8151477Dd';
  const operator = '0x18CBcE50390f5f6ebe4E20Fc17833F25c8D94811';
  const pub = ethers.hexlify(ethers.randomBytes(32));

  it('signs the digest once, so it recovers to the agent address', async () => {
    const agent = ethers.Wallet.createRandom();
    const digest = digestFor(5042002n, registry, agent.address, operator, pub);

    // What the SDK does: sign the raw 32 bytes, letting the signer add the prefix.
    const sig = await agent.signMessage(ethers.getBytes(digest));

    // What the contract does: prefix, then recover.
    expect(ethers.verifyMessage(ethers.getBytes(digest), sig)).toBe(agent.address);
  });

  it('a double-prefixed signature does not recover, which is the trap', async () => {
    const agent = ethers.Wallet.createRandom();
    const digest = digestFor(5042002n, registry, agent.address, operator, pub);

    // Signing the already-prefixed hash, as you would if the contract returned it
    // pre-prefixed for "convenience".
    const prefixed = ethers.hashMessage(ethers.getBytes(digest));
    const wrong = await agent.signMessage(ethers.getBytes(prefixed));

    expect(ethers.verifyMessage(ethers.getBytes(digest), wrong)).not.toBe(agent.address);
  });

  it('the digest binds the agent, the operator and the key', () => {
    const a = ethers.Wallet.createRandom().address;
    const base = digestFor(5042002n, registry, a, operator, pub);
    expect(digestFor(5042002n, registry, a, operator, pub)).toBe(base);
    expect(digestFor(5042002n, registry, a, registry, pub)).not.toBe(base);
    expect(digestFor(5042002n, registry, a, operator, ethers.ZeroHash)).not.toBe(base);
    expect(digestFor(1n, registry, a, operator, pub)).not.toBe(base);
    expect(digestFor(5042002n, operator, a, operator, pub)).not.toBe(base);
  });
});
