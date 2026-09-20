import { ethers } from 'ethers';
import { IDENTITY_ABI, REPUTATION_ABI, STAKING_ABI } from './abis';
import { parseDid, computeDidHash } from './did';
import { verifyChallenge, parseChallengePayload, isChallengeExpired } from './challenge';
import { bytes32ToPubKey, pubKeyToMultibase } from './keys';
import type {
  VerifierConfig,
  AgentIdentity,
  AgentStatus,
  ReputationData,
  DidDocument,
  ContractAddresses,
} from './types';

export class SigvaraVerifier {
  private readonly provider: ethers.JsonRpcProvider;
  private readonly addresses: ContractAddresses;
  private _chainId: number | undefined;

  // Cached lazily — avoids re-parsing the ABI on every call.
  private _identity?: ethers.Contract;
  private _reputation?: ethers.Contract;
  private _staking?: ethers.Contract;

  constructor(config: VerifierConfig) {
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
    this.addresses = config.addresses;
    this._chainId = config.chainId;
  }

  private identity() {
    return (this._identity ??= new ethers.Contract(this.addresses.identity, IDENTITY_ABI, this.provider));
  }

  private reputation() {
    return (this._reputation ??= new ethers.Contract(this.addresses.reputation, REPUTATION_ABI, this.provider));
  }

  private staking() {
    return (this._staking ??= new ethers.Contract(this.addresses.staking, STAKING_ABI, this.provider));
  }

  private async chainId(): Promise<number> {
    if (this._chainId !== undefined) return this._chainId;
    const network = await this.provider.getNetwork();
    this._chainId = Number(network.chainId);
    return this._chainId;
  }

  private async didHashFromDid(did: string): Promise<string> {
    const { chainId, agentAddress } = parseDid(did);
    return computeDidHash(agentAddress, chainId);
  }

  async getIdentity(did: string): Promise<AgentIdentity> {
    const didHash = await this.didHashFromDid(did);
    const raw = await this.identity().getIdentity(didHash);
    return {
      operator: raw.operator,
      agentAddress: raw.agentAddress,
      ed25519PubKey: raw.ed25519PubKey,
      status: Number(raw.status) as AgentStatus,
      registeredAt: BigInt(raw.registeredAt),
    };
  }

  async isActive(did: string): Promise<boolean> {
    const didHash = await this.didHashFromDid(did);
    return this.identity().isActive(didHash) as Promise<boolean>;
  }

  async getReputation(did: string): Promise<ReputationData> {
    const didHash = await this.didHashFromDid(did);
    const [raw, total] = await Promise.all([
      this.reputation().getReputation(didHash),
      this.reputation().getTotalScore(didHash),
    ]);
    return {
      feeScore: Number(raw.feeScore),
      successScore: Number(raw.successScore),
      ageScore: Number(raw.ageScore),
      externalScore: Number(raw.externalScore),
      communityScore: Number(raw.communityScore),
      propagationScore: Number(raw.propagationScore),
      lastUpdated: BigInt(raw.lastUpdated),
      total: Number(total),
    };
  }

  async meetsThreshold(did: string, threshold: number): Promise<boolean> {
    const didHash = await this.didHashFromDid(did);
    return this.reputation().meetsThreshold(didHash, threshold) as Promise<boolean>;
  }

  async getStake(did: string): Promise<bigint> {
    const didHash = await this.didHashFromDid(did);
    return this.staking().getStake(didHash) as Promise<bigint>;
  }

  async hasMinimumStake(did: string): Promise<boolean> {
    const didHash = await this.didHashFromDid(did);
    return this.staking().hasMinimumStake(didHash) as Promise<boolean>;
  }

  // Resolve the agent's Ed25519 public key from chain and verify the signature.
  //
  // Besides the cryptographic check, this binds the challenge to `did` and rejects
  // stale challenges so a captured (payload, signature) pair can't be replayed after
  // it expires. Nonce uniqueness within the freshness window is still the caller's
  // responsibility — track consumed nonces if you need strict single-use semantics.
  async verifySignature(
    did: string,
    challengePayload: string,
    signatureBase58: string,
    maxAgeSeconds = 300,
    expectedAudience?: string
  ): Promise<boolean> {
    // The payload must name this DID as the prover, otherwise a signature made for a
    // different challenge/DID could be presented against this one.
    let parsed;
    try {
      parsed = parseChallengePayload(challengePayload);
    } catch {
      return false;
    }
    if (parsed.did !== did) return false;

    // The payload must also name THIS verifier as the audience.
    //
    // Without it, a verifier holding a valid (payload, signature) pair can present that
    // same pair to another verifier and be accepted as the agent, because nothing in the
    // signed bytes says who the agent was talking to. Every verifier an agent
    // authenticates to could impersonate it everywhere else, for the life of the
    // challenge. v1 payloads carry no audience and cannot be checked, which is why they
    // are refused as soon as a caller states what it expects.
    if (expectedAudience !== undefined) {
      if (parsed.version !== 2) return false;
      if (parsed.audience !== expectedAudience) return false;
    }

    if (isChallengeExpired(challengePayload, maxAgeSeconds)) return false;

    const identity = await this.getIdentity(did);
    if (identity.registeredAt === 0n) return false;
    if (identity.ed25519PubKey === ethers.ZeroHash) return false;
    const pubKey = bytes32ToPubKey(identity.ed25519PubKey);
    try {
      return verifyChallenge(challengePayload, signatureBase58, pubKey);
    } catch {
      // base58Decode throws on an invalid alphabet character. A client sending a
      // malformed signature has failed to prove anything, which is a false, not an
      // exception: letting it escape turns a refusal into a 500 and lets any caller
      // crash a gate by sending punctuation.
      return false;
    }
  }

  async buildDidDocument(did: string): Promise<DidDocument> {
    const identity = await this.getIdentity(did);
    const { agentAddress } = parseDid(did);
    const pubKey = bytes32ToPubKey(identity.ed25519PubKey);
    const keyId = `${did}#key-1`;
    return {
      '@context': [
        'https://www.w3.org/ns/did/v1',
        'https://w3id.org/security/suites/ed25519-2020/v1',
      ],
      id: did,
      controller: `did:pkh:eip155:${(await this.chainId())}:${identity.operator}`,
      verificationMethod: [
        {
          id: keyId,
          type: 'Ed25519VerificationKey2020',
          controller: did,
          publicKeyMultibase: pubKeyToMultibase(pubKey),
        },
      ],
      authentication: [keyId],
      assertionMethod: [keyId],
    };
  }
}

/**
 * Registers an agent on-chain. The operator sends the transaction; the agent address
 * must sign for it.
 *
 * `agentSigner` proves control of `agentAddress`. Without it anyone could register an
 * address they do not own, choose the Ed25519 key verifiers check against it, and lock
 * the rightful owner out for good, since a didHash can never be reissued.
 *
 * The digest is read from the contract rather than rebuilt here, so a change to the
 * binding cannot leave the SDK signing a stale message. Pass `signature` directly
 * instead when the agent is a contract or its key lives in a signer you cannot hand
 * over, such as an HSM or a Safe.
 */
export async function registerAgent(
  signer: ethers.Signer,
  agentAddress: string,
  ed25519PubKeyBytes32: string,
  identityAddress: string,
  proof: { agentSigner: ethers.Signer } | { signature: string }
): Promise<{ didHash: string; txHash: string }> {
  const contract = new ethers.Contract(identityAddress, IDENTITY_ABI, signer);

  let signature: string;
  if ('signature' in proof) {
    signature = proof.signature;
  } else {
    const operator = await signer.getAddress();
    const digest: string = await contract.registrationDigest(
      agentAddress, operator, ed25519PubKeyBytes32
    );
    // The digest comes back UNPREFIXED; the contract applies the EIP-191 prefix
    // itself when it verifies. Passing the raw 32 bytes makes signMessage apply
    // exactly that prefix, once. Passing the hex STRING instead would prefix its 66
    // ASCII characters and produce a signature that never recovers to the agent.
    signature = await proof.agentSigner.signMessage(ethers.getBytes(digest));
  }

  const tx = await contract.registerAgent(agentAddress, ed25519PubKeyBytes32, signature);
  const receipt = await tx.wait();
  const iface = new ethers.Interface(IDENTITY_ABI);
  let didHash = '';
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog({ topics: log.topics, data: log.data });
      if (parsed && parsed.name === 'AgentRegistered') {
        didHash = parsed.args.didHash;
        break;
      }
    } catch {
      // not this event
    }
  }
  return { didHash, txHash: receipt.hash };
}
