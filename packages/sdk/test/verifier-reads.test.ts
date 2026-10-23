import { describe, it, expect, vi } from 'vitest';
import { ethers } from 'ethers';
import { SigvaraVerifier } from '../src/verifier';
import { generateChallenge, signChallenge } from '../src/challenge';
import { computeDidHash } from '../src/did';
import { seedToKeyPair, pubKeyToBytes32, pubKeyToMultibase } from '../src/keys';
import { AgentStatus } from '../src/types';

/**
 * The contract handles are stubbed on the verifier rather than at the RPC layer. What is
 * under test is SigvaraVerifier's own work: which didHash it asks about, and how it turns
 * the contract's answers into SDK types. The ABI encoding is ethers' job.
 */
const CHAIN = 5042002;
const AGENT = '0x00000000000000000000000000000000000000aa';
const DID = `did:sigvara:${CHAIN}:${AGENT}`;
const DID_HASH = computeDidHash(AGENT, CHAIN);
const OPERATOR = '0x00000000000000000000000000000000000000cc';
const AUDIENCE = 'https://verifier.example';

const kp = seedToKeyPair(new Uint8Array(32).fill(7));
const other = seedToKeyPair(new Uint8Array(32).fill(8));

function verifierWith(
  identity: Partial<{ operator: string; ed25519PubKey: string; status: number; registeredAt: bigint }> = {},
  chainId: number | null = CHAIN,
) {
  const v = new SigvaraVerifier({
    rpcUrl: 'http://127.0.0.1:0',
    addresses: {
      identity: '0x0000000000000000000000000000000000000001',
      reputation: '0x0000000000000000000000000000000000000002',
      staking: '0x0000000000000000000000000000000000000003',
    },
    ...(chainId === null ? {} : { chainId }),
  });
  const raw = {
    operator: OPERATOR,
    agentAddress: AGENT,
    ed25519PubKey: pubKeyToBytes32(kp.publicKey),
    status: 0n,
    registeredAt: 1_700_000_000n,
    ...identity,
  };
  const idc = {
    getIdentity: vi.fn(async () => raw),
    isActive: vi.fn(async () => true),
  };
  const repc = {
    getReputation: vi.fn(async () => ({
      feeScore: 12n, successScore: 9n, ageScore: 22n, externalScore: 5n,
      communityScore: 5n, propagationScore: 2n, lastUpdated: 1_700_000_123n,
    })),
    getTotalScore: vi.fn(async () => 41n),
    meetsThreshold: vi.fn(async (_d: string, t: number) => 41 >= t),
  };
  const stc = {
    getStake: vi.fn(async () => 5_000n * 10n ** 18n),
    hasMinimumStake: vi.fn(async () => true),
  };
  const anyV = v as any;
  anyV._identity = idc;
  anyV._reputation = repc;
  anyV._staking = stc;
  return { v, idc, repc, stc };
}

describe('SigvaraVerifier reads', () => {
  it('getIdentity derives the didHash from the DID and converts the tuple', async () => {
    const { v, idc } = verifierWith({ status: 3n });
    const id = await v.getIdentity(DID);
    expect(idc.getIdentity).toHaveBeenCalledWith(DID_HASH);
    expect(id).toEqual({
      operator: OPERATOR,
      agentAddress: AGENT,
      ed25519PubKey: pubKeyToBytes32(kp.publicKey),
      status: AgentStatus.PendingBond,
      registeredAt: 1_700_000_000n,
    });
    expect(typeof id.status).toBe('number');
    expect(typeof id.registeredAt).toBe('bigint');
  });

  it('getIdentity rejects a malformed DID before reading the chain', async () => {
    const { v, idc } = verifierWith();
    await expect(v.getIdentity('did:sigvara:abc:0x1')).rejects.toThrow(/Invalid did:sigvara/);
    expect(idc.getIdentity).not.toHaveBeenCalled();
  });

  it('the chain id in the DID, not the configured one, picks the didHash', async () => {
    const { v, idc } = verifierWith();
    const elsewhere = `did:sigvara:1:${AGENT}`;
    await v.getIdentity(elsewhere);
    expect(idc.getIdentity).toHaveBeenCalledWith(computeDidHash(AGENT, 1));
  });

  it('getReputation returns numbers for factors, a bigint timestamp, and the matured total', async () => {
    const { v, repc } = verifierWith();
    const r = await v.getReputation(DID);
    expect(repc.getReputation).toHaveBeenCalledWith(DID_HASH);
    expect(repc.getTotalScore).toHaveBeenCalledWith(DID_HASH);
    expect(r).toEqual({
      feeScore: 12, successScore: 9, ageScore: 22, externalScore: 5,
      communityScore: 5, propagationScore: 2, lastUpdated: 1_700_000_123n, total: 41,
    });
  });

  it('getTotalScore reads only the total', async () => {
    const { v, repc } = verifierWith();
    expect(await v.getTotalScore(DID)).toBe(41);
    expect(repc.getReputation).not.toHaveBeenCalled();
  });

  it('meetsThreshold, isActive, getStake and hasMinimumStake pass the didHash through', async () => {
    const { v, idc, repc, stc } = verifierWith();
    expect(await v.meetsThreshold(DID, 40)).toBe(true);
    expect(repc.meetsThreshold).toHaveBeenCalledWith(DID_HASH, 40);
    expect(await v.meetsThreshold(DID, 42)).toBe(false);
    expect(await v.isActive(DID)).toBe(true);
    expect(idc.isActive).toHaveBeenCalledWith(DID_HASH);
    expect(await v.getStake(DID)).toBe(5_000n * 10n ** 18n);
    expect(stc.getStake).toHaveBeenCalledWith(DID_HASH);
    expect(await v.hasMinimumStake(DID)).toBe(true);
    expect(stc.hasMinimumStake).toHaveBeenCalledWith(DID_HASH);
  });
});

describe('SigvaraVerifier.verifySignature against the registered key', () => {
  const fresh = () => generateChallenge(DID, AUDIENCE).payload;

  it('accepts a signature by the registered key', async () => {
    const { v } = verifierWith();
    const p = fresh();
    expect(await v.verifySignature(DID, p, signChallenge(p, kp.secretKey))).toBe(true);
  });

  it('accepts when the expected audience matches', async () => {
    const { v } = verifierWith();
    const p = fresh();
    expect(await v.verifySignature(DID, p, signChallenge(p, kp.secretKey), 300, AUDIENCE)).toBe(true);
  });

  it('refuses a different audience without reading the chain', async () => {
    const { v, idc } = verifierWith();
    const p = fresh();
    expect(await v.verifySignature(DID, p, signChallenge(p, kp.secretKey), 300, 'https://elsewhere.example')).toBe(false);
    expect(idc.getIdentity).not.toHaveBeenCalled();
  });

  it('refuses a v1 payload once an audience is expected, but accepts it otherwise', async () => {
    const { v } = verifierWith();
    const p = `SIGVARA-VERIFY:${DID}:deadbeef:${Math.floor(Date.now() / 1000)}`;
    const sig = signChallenge(p, kp.secretKey);
    expect(await v.verifySignature(DID, p, sig, 300, AUDIENCE)).toBe(false);
    expect(await v.verifySignature(DID, p, sig)).toBe(true);
  });

  it('refuses a signature by any other key', async () => {
    const { v } = verifierWith();
    const p = fresh();
    expect(await v.verifySignature(DID, p, signChallenge(p, other.secretKey))).toBe(false);
  });

  it('refuses a signature over a different payload', async () => {
    const { v } = verifierWith();
    const p = fresh();
    const q = fresh();
    expect(await v.verifySignature(DID, p, signChallenge(q, kp.secretKey))).toBe(false);
  });

  it('refuses an unregistered agent', async () => {
    const { v } = verifierWith({ registeredAt: 0n });
    const p = fresh();
    expect(await v.verifySignature(DID, p, signChallenge(p, kp.secretKey))).toBe(false);
  });

  it('refuses an agent whose key is zero', async () => {
    const { v } = verifierWith({ ed25519PubKey: ethers.ZeroHash });
    const p = fresh();
    expect(await v.verifySignature(DID, p, signChallenge(p, kp.secretKey))).toBe(false);
  });

  it('returns false, not an exception, for a non-base58 signature of legal width', async () => {
    const { v } = verifierWith();
    const p = fresh();
    expect(await v.verifySignature(DID, p, '0'.repeat(88))).toBe(false);
  });

  it('refuses a payload dated in the future, however well it is signed', async () => {
    // The attack: a peer the agent authenticates to hands it a payload naming a victim
    // verifier as the audience and dated ten years ahead. Only the age used to be checked,
    // so the signature worked at the victim for as long as the date stayed in the future.
    const { v } = verifierWith();
    const later = Math.floor(Date.now() / 1000) + 10 * 365 * 86_400;
    const p = ['SIGVARA-VERIFY-V2', `did: ${DID}`, `aud: ${AUDIENCE}`, 'nonce: deadbeef', `ts: ${later}`].join('\n');
    expect(await v.verifySignature(DID, p, signChallenge(p, kp.secretKey), 300, AUDIENCE)).toBe(false);
  });

  it('accepts a payload a little ahead of this clock, as two hosts\' clocks may be', async () => {
    const { v } = verifierWith();
    const ahead = Math.floor(Date.now() / 1000) + 30;
    const p = ['SIGVARA-VERIFY-V2', `did: ${DID}`, `aud: ${AUDIENCE}`, 'nonce: deadbeef', `ts: ${ahead}`].join('\n');
    expect(await v.verifySignature(DID, p, signChallenge(p, kp.secretKey), 300, AUDIENCE)).toBe(true);
  });

  it('honours a custom maxAge', async () => {
    const { v } = verifierWith();
    const ts = Math.floor(Date.now() / 1000) - 120;
    const p = `SIGVARA-VERIFY:${DID}:deadbeef:${ts}`;
    const sig = signChallenge(p, kp.secretKey);
    expect(await v.verifySignature(DID, p, sig, 60)).toBe(false);
    expect(await v.verifySignature(DID, p, sig, 600)).toBe(true);
  });
});

describe('SigvaraVerifier.buildDidDocument', () => {
  it('builds a W3C document around the registered key and the operator', async () => {
    const { v } = verifierWith();
    const doc = await v.buildDidDocument(DID);
    const keyId = `${DID}#key-1`;
    expect(doc).toEqual({
      '@context': [
        'https://www.w3.org/ns/did/v1',
        'https://w3id.org/security/suites/ed25519-2020/v1',
      ],
      id: DID,
      controller: `did:pkh:eip155:${CHAIN}:${OPERATOR}`,
      verificationMethod: [{
        id: keyId,
        type: 'Ed25519VerificationKey2020',
        controller: DID,
        publicKeyMultibase: pubKeyToMultibase(kp.publicKey),
      }],
      authentication: [keyId],
      assertionMethod: [keyId],
    });
  });

  it('asks the provider for the chain id when none was configured, once', async () => {
    const { v } = verifierWith({}, null);
    const getNetwork = vi.fn(async () => ({ chainId: 42n }));
    (v as any).provider.getNetwork = getNetwork;
    const a = await v.buildDidDocument(DID);
    const b = await v.buildDidDocument(DID);
    expect(a.controller).toBe(`did:pkh:eip155:42:${OPERATOR}`);
    expect(b.controller).toBe(a.controller);
    expect(getNetwork).toHaveBeenCalledTimes(1);
  });
});
