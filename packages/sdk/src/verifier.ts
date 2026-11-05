import { ethers, FetchRequest } from 'ethers';
import { IDENTITY_ABI, REPUTATION_ABI, STAKING_ABI, ERC20_ABI } from './abis';
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
  PendingScore,
  PendingWithdrawal,
  SlashProposal,
  SlashState,
} from './types';

/**
 * How long one read may take before it is abandoned. ethers waits five minutes by default, so a
 * gate whose RPC had gone quiet held every admit that long. The reads here are single view calls;
 * one that takes half a minute is not going to answer.
 */
export const DEFAULT_RPC_TIMEOUT_MS = 30_000;

export class SigvaraVerifier {
  private readonly provider: ethers.JsonRpcProvider;
  private readonly addresses: ContractAddresses;
  private _chainId: number | undefined;

  // Cached lazily — avoids re-parsing the ABI on every call.
  private _identity?: ethers.Contract;
  private _reputation?: ethers.Contract;
  private _staking?: ethers.Contract;
  private _stakeTokenDecimals?: Promise<number>;

  constructor(config: VerifierConfig) {
    const timeoutMs = config.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
    if (!(timeoutMs > 0) || !Number.isFinite(timeoutMs)) {
      throw new Error(`SigvaraVerifier: timeoutMs must be a positive number of milliseconds, got ${timeoutMs}`);
    }
    const connection = new FetchRequest(config.rpcUrl);
    connection.timeout = timeoutMs;
    // ethers folds what is asked in one tick into one batch, of up to 100 calls by default. Arc's public
    // RPC answers 20 and refuses the rest with a rate limit, so a busy gate would refuse agents over it.
    this.provider = new ethers.JsonRpcProvider(connection, undefined, { batchMaxCount: 20 });
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

  /**
   * The matured score alone, without the factor breakdown.
   *
   * `getReputation` reads the raw tuple and `getTotalScore` together, because callers
   * that want the factors almost always want the total beside them. A gate wants only the
   * total: it compares one number against a threshold and discards the rest, so the tuple
   * read is a second contract execution and decode bought for nothing.
   */
  async getTotalScore(did: string): Promise<number> {
    const didHash = await this.didHashFromDid(did);
    return Number(await this.reputation().getTotalScore(didHash));
  }

  /**
   * When the agent's score was last written, in unix seconds, or 0 if it never was.
   *
   * Nothing on chain ages a score, so one left over from an oracle outage keeps satisfying a threshold. A
   * gate that wants to refuse a score nobody has refreshed reads this and applies its own limit. Read on its
   * own, like getTotalScore, because the breakdown is a second contract read the decision never looks at.
   */
  async getScoreUpdatedAt(did: string): Promise<number> {
    const didHash = await this.didHashFromDid(did);
    const raw = await this.reputation().getReputation(didHash);
    return Number(raw.lastUpdated);
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

  /**
   * The score the agent has earned: its factors summed and capped, before maturity releases it.
   * getTotalScore is the matured part, which is what a threshold is checked against, so the two differ
   * while a rise is still maturing or after a handover restarted maturity.
   */
  async getEarnedScore(did: string): Promise<number> {
    const didHash = await this.didHashFromDid(did);
    return Number(await this.reputation().getEarnedScore(didHash));
  }

  /** The proposal waiting out its challenge window for this agent. `exists` is false when there is none. */
  async getPendingScore(did: string): Promise<PendingScore> {
    const didHash = await this.didHashFromDid(did);
    const raw = await this.reputation().getPendingScore(didHash);
    return {
      exists: Boolean(raw.exists),
      data: {
        feeScore: Number(raw.data.feeScore),
        successScore: Number(raw.data.successScore),
        ageScore: Number(raw.data.ageScore),
        externalScore: Number(raw.data.externalScore),
        communityScore: Number(raw.data.communityScore),
        propagationScore: Number(raw.data.propagationScore),
        lastUpdated: BigInt(raw.data.lastUpdated),
      },
      proposedAt: BigInt(raw.proposedAt),
      finalizableAt: BigInt(raw.finalizableAt),
      evidenceRoot: raw.evidenceRoot,
      proposer: raw.proposer,
    };
  }

  /** The evidence root of the agent's finalized score. The zero hash when none has been finalized with one. */
  async getEvidenceRoot(did: string): Promise<string> {
    const didHash = await this.didHashFromDid(did);
    return this.reputation().evidenceRoots(didHash) as Promise<string>;
  }

  /** Whether `leaf` is in the agent's finalized evidence root, by the contract's own MerkleProof check. */
  async verifyEvidence(did: string, leaf: string, proof: string[]): Promise<boolean> {
    const didHash = await this.didHashFromDid(did);
    return this.reputation().verifyEvidence(didHash, leaf, proof) as Promise<boolean>;
  }

  /** The stake an agent must hold to be Active, as the staking contract asks it now. */
  async getMinimumStake(): Promise<bigint> {
    return BigInt(await this.staking().minimumStake());
  }

  /** Stake queued for withdrawal. It stays slashable until claimed; `claimableAt` is fixed when it is queued. */
  async getPendingWithdrawal(did: string): Promise<PendingWithdrawal> {
    const didHash = await this.didHashFromDid(did);
    const [amount, claimableAt] = await this.staking().getPendingWithdrawal(didHash);
    return { amount: BigInt(amount), claimableAt: BigInt(claimableAt) };
  }

  /** The agent's most recent slash proposal. State None means it has never had one. */
  async getSlashProposal(did: string): Promise<SlashProposal> {
    const didHash = await this.didHashFromDid(did);
    const raw = await this.staking().getSlashProposal(didHash);
    return {
      state: Number(raw.state) as SlashState,
      reporter: raw.reporter,
      victim: raw.victim,
      initiatedAt: BigInt(raw.initiatedAt),
      challengeDeadline: BigInt(raw.challengeDeadline),
      disputedAt: BigInt(raw.disputedAt),
      evidenceHash: raw.evidenceHash,
    };
  }

  /** Decimals of the token stakes are held in. Read once: the staking contract's token is set at initialize. */
  getStakeTokenDecimals(): Promise<number> {
    return (this._stakeTokenDecimals ??= (async () => {
      const token = new ethers.Contract(await this.staking().svrToken(), ERC20_ABI, this.provider);
      return Number(await token.decimals());
    })().catch((err) => {
      // A failed read is not cached, so the next call asks again.
      this._stakeTokenDecimals = undefined;
      throw err;
    }));
  }

  // Resolve the agent's Ed25519 public key from chain and verify the signature.
  //
  // Besides the cryptographic check, this binds the challenge to `did` and to
  // `expectedAudience`, and rejects stale challenges so a captured (payload, signature)
  // pair can't be replayed after it expires. Nonce uniqueness within the freshness
  // window is still the caller's responsibility: track consumed nonces if you need
  // strict single-use semantics.
  //
  // `expectedAudience` is who THIS verifier is: the same string passed to generateChallenge.
  // It is required.
  async verifySignature(
    did: string,
    challengePayload: string,
    signatureBase58: string,
    maxAgeSeconds = 300,
    expectedAudience: string
  ): Promise<boolean> {
    // Left out, this used to skip the audience check below, and a call that did so compiled
    // and accepted a response the agent had given to some other verifier. It throws rather
    // than returning false: a missing audience is a bug in the caller, and a false reads as
    // an ordinary refusal and hides it. TypeScript callers cannot get here without the
    // argument; JavaScript callers, and anything that went through `any`, get this error.
    if (typeof expectedAudience !== 'string' || expectedAudience === '') {
      throw new Error(
        'verifySignature: expectedAudience is required, as the fifth argument. It names this ' +
        'verifier, so a signature the agent gave to another verifier cannot be replayed here. ' +
        'Pass the same value you gave generateChallenge: your origin, or your own DID when ' +
        'one agent verifies another.',
      );
    }

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
    // challenge. v1 payloads carry no audience and cannot be checked, so they are refused.
    if (parsed.version !== 2) return false;
    if (parsed.audience !== expectedAudience) return false;

    if (isChallengeExpired(challengePayload, maxAgeSeconds)) return false;

    // Width check before the chain read.
    //
    // A protocol signature is always 64 bytes, and base58 of 64 bytes is 64 to 88
    // characters: 88 in the general case, shorter only when leading zero bytes encode as
    // '1', down to 64 for the all-zero degenerate. Measured across the all-zero and
    // all-0xff vectors, every leading-zero prefix length, and 20,000 random 64-byte
    // values; real Ed25519 signatures came out 87 or 88.
    //
    // Anything outside that cannot verify, so checking here costs an unauthenticated
    // caller its identity RPC and spares base58Decode an unbounded BigInt. The decoded
    // length is still checked downstream, and verifyChallenge keeps its own behaviour for
    // callers using it directly.
    if (signatureBase58.length < 64 || signatureBase58.length > 88) return false;

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
