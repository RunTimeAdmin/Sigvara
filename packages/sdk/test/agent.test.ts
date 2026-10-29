import { describe, it, expect } from 'vitest';
import { inspect } from 'node:util';
import nacl from 'tweetnacl';
import { SigvaraAgent } from '../src/agent';
import {
  generateChallenge,
  parseChallengePayload,
  verifyChallenge,
  isChallengeExpired,
} from '../src/challenge';
import { base58Decode, bytes32ToPubKey } from '../src/keys';
import { computeDidHash, formatDid } from '../src/did';

const CHAIN_ID = 5042002;
const AGENT_ADDR = '0x0000000000000000000000000000000000001234';
const PEER_ADDR  = '0x0000000000000000000000000000000000005678';

// Internal helper — uses nacl directly because it is testing the constructor path.
// Public API tests should use SigvaraAgent.generate() instead.
function makeAgent(address: string = AGENT_ADDR) {
  return new SigvaraAgent({
    privateKey: nacl.randomBytes(32),
    agentAddress: address,
    chainId: CHAIN_ID,
  });
}

describe('SigvaraAgent — identity', () => {
  it('exposes the correct DID', () => {
    const agent = makeAgent();
    expect(agent.did).toBe(formatDid(AGENT_ADDR, CHAIN_ID));
  });

  it('exposes the correct didHash', () => {
    const agent = makeAgent();
    expect(agent.didHash).toBe(computeDidHash(AGENT_ADDR, CHAIN_ID));
  });

  it('publicKeyBytes32 is 32 bytes (0x + 64 hex chars)', () => {
    const agent = makeAgent();
    expect(agent.publicKeyBytes32).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

describe('SigvaraAgent — issueChallenge', () => {
  it('challenge payload contains the peer DID', () => {
    const agentB = makeAgent();
    const peerDid = formatDid(PEER_ADDR, CHAIN_ID);
    const challenge = agentB.issueChallenge(peerDid);
    expect(challenge.payload).toContain(peerDid);
  });

  it('each issued challenge has a unique nonce', () => {
    const agentB = makeAgent();
    const peerDid = formatDid(PEER_ADDR, CHAIN_ID);
    const c1 = agentB.issueChallenge(peerDid);
    const c2 = agentB.issueChallenge(peerDid);
    expect(c1.nonce).not.toBe(c2.nonce);
  });
});

describe('SigvaraAgent — signChallengeFor', () => {
  const VERIFIER = 'https://verifier.example';
  const OTHER = 'https://elsewhere.example';

  it('signs a v2 challenge addressed to the audience it expects, and the signature verifies', () => {
    const agent = makeAgent();
    const challenge = generateChallenge(agent.did, VERIFIER);

    const signature = agent.signChallengeFor(challenge.payload, VERIFIER);

    const pubKey = bytes32ToPubKey(agent.publicKeyBytes32);
    expect(verifyChallenge(challenge.payload, signature, pubKey)).toBe(true);
  });

  it('refuses a challenge addressed to a different audience, and signs nothing', () => {
    // The relay: verifier B gets a challenge from verifier C and asks the agent to sign it as though it
    // were B's. The agent knows it is talking to B.
    const agent = makeAgent();
    const forC = generateChallenge(agent.did, OTHER);
    expect(() => agent.signChallengeFor(forC.payload, VERIFIER)).toThrow(/different audience/);
  });

  it('an audience that differs only by case or a trailing slash is a different audience', () => {
    const agent = makeAgent();
    const challenge = generateChallenge(agent.did, VERIFIER);
    expect(() => agent.signChallengeFor(challenge.payload, VERIFIER.toUpperCase())).toThrow(/different audience/);
    expect(() => agent.signChallengeFor(challenge.payload, `${VERIFIER}/`)).toThrow(/different audience/);
  });

  it('refuses a challenge that names a different prover', () => {
    const agent = makeAgent();
    const forSomeoneElse = generateChallenge(formatDid(PEER_ADDR, CHAIN_ID), VERIFIER);
    expect(() => agent.signChallengeFor(forSomeoneElse.payload, VERIFIER)).toThrow(/different prover/);
  });

  it('accepts the prover DID however its address is cased', () => {
    const agent = makeAgent();
    const upper = agent.did.replace(/0x([0-9a-f]+)$/, (_m, hex: string) => `0x${hex.toUpperCase()}`);
    const challenge = generateChallenge(upper, VERIFIER);
    expect(() => agent.signChallengeFor(challenge.payload, VERIFIER)).not.toThrow();
  });

  it('refuses a v1 challenge, which names no audience to check', () => {
    const agent = makeAgent();
    const v1 = `SIGVARA-VERIFY:${agent.did}:abc123:${Math.floor(Date.now() / 1000)}`;
    expect(() => agent.signChallengeFor(v1, VERIFIER)).toThrow(/v1 challenge/);
  });

  it('refuses something that is not a challenge at all', () => {
    const agent = makeAgent();
    expect(() => agent.signChallengeFor('transfer all funds', VERIFIER)).toThrow(/not a Sigvara challenge/);
    expect(() => agent.signChallengeFor('', VERIFIER)).toThrow(/not a Sigvara challenge/);
  });
});

describe('SigvaraAgent: no blind signing', () => {
  // signChallenge signed whatever it was handed, so a verifier could pass an agent a payload naming a different
  // verifier, collect the signature and present it there as the agent. It is removed. The compiler refuses a
  // call, because the parameter is `never`, and what a JavaScript caller meets is an error that names the method
  // to use. The @ts-expect-error below fails the typecheck if a call ever compiles again.
  it('signChallenge refuses to sign, and says to use signChallengeFor', () => {
    const agent = makeAgent();
    const challenge = generateChallenge(agent.did, 'https://elsewhere.example');
    // @ts-expect-error a call does not compile: the parameter is `never`
    expect(() => agent.signChallenge(challenge.payload)).toThrow(/signChallengeFor/);
  });

  it('what it refused is what signChallengeFor signs, once it is told the audience', () => {
    const agent = makeAgent();
    const challenge = generateChallenge(agent.did, 'https://elsewhere.example');
    expect(() => agent.signChallengeFor(challenge.payload, 'https://elsewhere.example')).not.toThrow();
  });
});

describe('SigvaraAgent — A2A sign/verify flow', () => {
  it('Agent A signs a challenge issued by Agent B and signature verifies', () => {
    const agentA = makeAgent(AGENT_ADDR);
    const agentB = makeAgent(PEER_ADDR);

    // B issues a challenge to A
    const challenge = agentB.issueChallenge(agentA.did);

    // A signs the challenge payload
    const signature = agentA.signChallengeFor(challenge.payload, agentB.did);

    // Signature is base58 encoded, 64 bytes
    expect(base58Decode(signature).length).toBe(64);

    // Parse the payload — the DID should be Agent A's DID
    const parsed = parseChallengePayload(challenge.payload);
    expect(parsed.did).toBe(agentA.did);

    // Reconstruct Agent A's public key from its on-chain bytes32 representation
    // (this is what the verifier would fetch from chain)
    const pubKey = bytes32ToPubKey(agentA.publicKeyBytes32);
    expect(verifyChallenge(challenge.payload, signature, pubKey)).toBe(true);
  });

  it('signature does not verify against the wrong public key', () => {
    const agentA = makeAgent(AGENT_ADDR);
    const agentB = makeAgent(PEER_ADDR);
    const agentC = makeAgent('0x0000000000000000000000000000000000009999');

    const challenge = agentB.issueChallenge(agentA.did);
    const signature = agentA.signChallengeFor(challenge.payload, agentB.did);

    const wrongPubKey = bytes32ToPubKey(agentC.publicKeyBytes32);
    expect(verifyChallenge(challenge.payload, signature, wrongPubKey)).toBe(false);
  });

  it('issued challenge is not yet expired', () => {
    const agentB = makeAgent();
    const challenge = agentB.issueChallenge(formatDid(PEER_ADDR, CHAIN_ID));
    expect(isChallengeExpired(challenge.payload)).toBe(false);
  });

  it('deterministic keypair produces the same public key each time', () => {
    const seed = nacl.randomBytes(32);
    const a1 = new SigvaraAgent({ privateKey: seed, agentAddress: AGENT_ADDR, chainId: CHAIN_ID });
    const a2 = new SigvaraAgent({ privateKey: seed, agentAddress: AGENT_ADDR, chainId: CHAIN_ID });
    expect(a1.publicKeyBytes32).toBe(a2.publicKeyBytes32);
  });
});

describe('SigvaraAgent.generate() — static factory', () => {
  it('returns an agent and a hex private key without requiring a nacl import', () => {
    const { agent, privateKey } = SigvaraAgent.generate({
      agentAddress: AGENT_ADDR,
      chainId: CHAIN_ID,
    });
    expect(agent).toBeInstanceOf(SigvaraAgent);
    expect(privateKey).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('agent DID is correct', () => {
    const { agent } = SigvaraAgent.generate({ agentAddress: AGENT_ADDR, chainId: CHAIN_ID });
    expect(agent.did).toBe(formatDid(AGENT_ADDR, CHAIN_ID));
  });

  it('agent publicKeyBytes32 is a valid 32-byte hex string', () => {
    const { agent } = SigvaraAgent.generate({ agentAddress: AGENT_ADDR, chainId: CHAIN_ID });
    expect(agent.publicKeyBytes32).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('privateKey can reconstruct the same agent (round-trip)', () => {
    const { agent: a1, privateKey } = SigvaraAgent.generate({
      agentAddress: AGENT_ADDR,
      chainId: CHAIN_ID,
    });
    const a2 = new SigvaraAgent({ privateKey, agentAddress: AGENT_ADDR, chainId: CHAIN_ID });
    expect(a1.publicKeyBytes32).toBe(a2.publicKeyBytes32);
  });

  it('each call generates a unique keypair', () => {
    const { privateKey: k1 } = SigvaraAgent.generate({ agentAddress: AGENT_ADDR, chainId: CHAIN_ID });
    const { privateKey: k2 } = SigvaraAgent.generate({ agentAddress: AGENT_ADDR, chainId: CHAIN_ID });
    expect(k1).not.toBe(k2);
  });

  it('generated agent can sign a challenge that verifies against its public key', () => {
    const { agent } = SigvaraAgent.generate({ agentAddress: AGENT_ADDR, chainId: CHAIN_ID });
    const peerDid = formatDid(PEER_ADDR, CHAIN_ID);
    // Simulate: peer issues challenge to this agent, agent signs it.
    const challenge = agent.issueChallenge(peerDid);
    const selfPayload = challenge.payload.replace(peerDid, agent.did);
    const signature = agent.signChallengeFor(selfPayload, agent.did);
    const pubKey = bytes32ToPubKey(agent.publicKeyBytes32);
    expect(verifyChallenge(selfPayload, signature, pubKey)).toBe(true);
  });
});

describe('SigvaraAgent: accessors and generate()', () => {
  it('agentAddress returns the address it was built with', () => {
    expect(makeAgent().agentAddress).toBe(AGENT_ADDR);
  });

  it('generate() returns a 32-byte hex seed that rebuilds the same agent', () => {
    const { agent, privateKey } = SigvaraAgent.generate({ agentAddress: AGENT_ADDR, chainId: CHAIN_ID });
    expect(privateKey).toMatch(/^0x[0-9a-f]{64}$/);
    const again = new SigvaraAgent({ privateKey, agentAddress: AGENT_ADDR, chainId: CHAIN_ID });
    expect(again.publicKeyBytes32).toBe(agent.publicKeyBytes32);
    expect(again.did).toBe(formatDid(AGENT_ADDR, CHAIN_ID));
  });

  it('issueChallenge names the peer as prover and this agent as audience', () => {
    const me = makeAgent();
    const peerDid = formatDid(PEER_ADDR, CHAIN_ID);
    const c = me.issueChallenge(peerDid, 30);
    const p = parseChallengePayload(c.payload);
    expect(p.did).toBe(peerDid);
    expect(p.audience).toBe(me.did);
    expect(c.expiresAt - c.timestamp).toBe(30);
  });
});

describe('SigvaraAgent keeps its secret key out of sight', () => {
  it('is not in the JSON, the console output or the enumerable properties', () => {
    const { agent, privateKey } = SigvaraAgent.generate({ agentAddress: AGENT_ADDR, chainId: CHAIN_ID });
    const seedHex = privateKey.replace(/^0x/, '');
    const json = JSON.stringify(agent);
    expect(json).not.toMatch(/secretKey|keyPair/);
    expect(inspect(agent, { depth: 6 })).not.toMatch(/secretKey|keyPair/);
    expect(Object.keys(agent)).not.toContain('keyPair');
    expect(json).not.toContain(seedHex);
  });

  it('still signs: the private field is what signChallengeFor uses', () => {
    const a = SigvaraAgent.generate({ agentAddress: AGENT_ADDR, chainId: CHAIN_ID }).agent;
    const b = SigvaraAgent.generate({ agentAddress: PEER_ADDR, chainId: CHAIN_ID }).agent;
    const c = a.issueChallenge(b.did);
    const pub = bytes32ToPubKey(b.publicKeyBytes32);
    expect(verifyChallenge(c.payload, b.signChallengeFor(c.payload, a.did), pub)).toBe(true);
  });
});
