import { describe, it, expect } from 'vitest';
import { computeDidHash, formatDid, parseDid } from '../src/did';

const AGENT = '0x0000000000000000000000000000000000000001';
const ARC_TESTNET = 5042002;
const MAINNET = 1;

describe('formatDid', () => {
  it('formats lowercase address', () => {
    const did = formatDid(AGENT, ARC_TESTNET);
    expect(did).toBe(`did:sigvara:${ARC_TESTNET}:${AGENT}`);
  });

  it('lowercases mixed-case address', () => {
    const did = formatDid('0x0000000000000000000000000000000000000001', MAINNET);
    expect(did).toBe(`did:sigvara:${MAINNET}:${AGENT}`);
  });
});

describe('parseDid', () => {
  it('parses a valid DID', () => {
    const { chainId, agentAddress } = parseDid(`did:sigvara:${ARC_TESTNET}:${AGENT}`);
    expect(chainId).toBe(ARC_TESTNET);
    expect(agentAddress.toLowerCase()).toBe(AGENT);
  });

  it('throws on invalid format', () => {
    expect(() => parseDid('did:example:1:0xabc')).toThrow('Invalid did:sigvara');
    expect(() => parseDid('not-a-did')).toThrow();
    expect(() => parseDid(`did:sigvara:abc:${AGENT}`)).toThrow();
  });
});

describe('computeDidHash', () => {
  it('produces a 32-byte hex string', () => {
    const hash = computeDidHash(AGENT, ARC_TESTNET);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    expect(computeDidHash(AGENT, ARC_TESTNET)).toBe(computeDidHash(AGENT, ARC_TESTNET));
  });

  it('differs by chain', () => {
    expect(computeDidHash(AGENT, ARC_TESTNET)).not.toBe(computeDidHash(AGENT, MAINNET));
  });

  it('differs by address', () => {
    const a = '0x0000000000000000000000000000000000000001';
    const b = '0x0000000000000000000000000000000000000002';
    expect(computeDidHash(a, ARC_TESTNET)).not.toBe(computeDidHash(b, ARC_TESTNET));
  });

  it('formatDid + computeDidHash is self-consistent', () => {
    const did = formatDid(AGENT, ARC_TESTNET);
    const { chainId, agentAddress } = parseDid(did);
    const hash = computeDidHash(agentAddress, chainId);
    expect(hash).toBe(computeDidHash(AGENT, ARC_TESTNET));
  });
});
