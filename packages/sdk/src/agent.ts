import nacl from 'tweetnacl';
import { seedToKeyPair, pubKeyToBytes32, bytesToHex } from './keys';
import { formatDid, computeDidHash } from './did';
import { generateChallenge, parseChallengePayload, signChallenge } from './challenge';
import type { Challenge } from './types';

export class SigvaraAgent {
  // A true private field, not TypeScript's `private`. The keyword is erased at compile time, so the key was an
  // ordinary property: JSON.stringify(agent), a logged agent and an error reporter's snapshot all carried it.
  readonly #keyPair: { publicKey: Uint8Array; secretKey: Uint8Array };
  private readonly _agentAddress: string;
  private readonly _chainId: number;
  private readonly _challengeTtl: number;

  constructor(options: {
    privateKey: string | Uint8Array;
    agentAddress: string;
    chainId: number;
    challengeTtlSeconds?: number;
  }) {
    this.#keyPair = seedToKeyPair(options.privateKey);
    this._agentAddress = options.agentAddress.toLowerCase();
    this._chainId = options.chainId;
    this._challengeTtl = options.challengeTtlSeconds ?? 300;
  }

  /**
   * Generate a new Ed25519 keypair and return a ready-to-use agent alongside
   * the raw private key (seed) for secure storage by the caller.
   *
   * This is the recommended entry point for new agent creation. It keeps
   * tweetnacl as an internal implementation detail — callers never need to
   * import or interact with it directly.
   *
   * @example
   * const { agent, privateKey } = SigvaraAgent.generate({
   *   agentAddress: '0xYourAgentAddress',
   *   chainId: 5042002,
   * });
   * // Store privateKey (hex) securely — it cannot be recovered from the agent.
   * await registerAgent(operatorWallet, agent.agentAddress, agent.publicKeyBytes32, IDENTITY_ADDRESS);
   */
  static generate(options: {
    agentAddress: string;
    chainId: number;
    challengeTtlSeconds?: number;
  }): { agent: SigvaraAgent; privateKey: string } {
    const seed = nacl.randomBytes(32);
    const agent = new SigvaraAgent({ ...options, privateKey: seed });
    return { agent, privateKey: '0x' + bytesToHex(seed) };
  }

  get agentAddress(): string {
    return this._agentAddress;
  }

  get did(): string {
    return formatDid(this._agentAddress, this._chainId);
  }

  get didHash(): string {
    return computeDidHash(this._agentAddress, this._chainId);
  }

  // Returns the bytes32 hex public key for on-chain registration.
  get publicKeyBytes32(): string {
    return pubKeyToBytes32(this.#keyPair.publicKey);
  }

  // Generate a challenge to send to a peer agent. The payload names the peer as the
  // prover, so signing it proves the peer holds the corresponding private key, and names
  // THIS agent as the audience, so the peer's response cannot be relayed onward and used
  // to impersonate it to a third party. Without that second binding, every agent a peer
  // authenticates to can turn round and impersonate it everywhere else.
  issueChallenge(peerDid: string, ttlSeconds?: number): Challenge {
    return generateChallenge(peerDid, this.did, ttlSeconds ?? this._challengeTtl);
  }

  // Sign a challenge payload received from a peer, but only if it is addressed to the verifier the
  // caller means to prove itself to. Returns a base58-encoded signature.
  //
  // `audience` is what the caller knows about who it is talking to: the origin it connected to, or
  // the other agent's DID. The payload must be a v2 challenge (v1 names no audience), must name this
  // agent as the prover, and must name exactly that audience. Anything else throws and nothing is
  // signed.
  //
  // This is the half of the audience binding that only the signer can enforce. The audience in a
  // challenge protects an agent from relay only if the agent checks it before signing; otherwise a
  // verifier can hand it a payload naming a different verifier, collect the signature, and present
  // it there as this agent. The verifier's own check (verifySignature's expectedAudience) catches
  // a relayed response after the fact, and cannot catch a signature the agent was talked into.
  signChallengeFor(payload: string, audience: string): string {
    let parsed;
    try {
      parsed = parseChallengePayload(payload);
    } catch {
      throw new Error('signChallengeFor: not a Sigvara challenge, nothing signed');
    }
    if (parsed.version !== 2) {
      throw new Error('signChallengeFor: a v1 challenge names no audience, so it cannot be checked, nothing signed');
    }
    if (parsed.did.toLowerCase() !== this.did) {
      throw new Error('signChallengeFor: the challenge names a different prover, nothing signed');
    }
    if (parsed.audience !== audience) {
      throw new Error('signChallengeFor: the challenge is addressed to a different audience, nothing signed');
    }
    return signChallenge(payload, this.#keyPair.secretKey);
  }

  // Removed. This signed whatever it was handed, with no check on who the challenge was addressed to,
  // so a verifier could pass an agent a payload naming a different verifier, collect the signature and
  // present it there as the agent. signChallengeFor is the same signature with that check.
  //
  // What is left is a stub, so that a caller is told at the call and not by a missing method. The
  // parameter is `never`, so a call does not compile, and the body throws, so a call from JavaScript
  // says what to use instead.
  /** @deprecated Removed. Use signChallengeFor(payload, audience). */
  signChallenge(_removed: never): never {
    throw new Error(
      'signChallenge was removed: it signed whatever it was handed, which let a verifier collect a signature meant ' +
      'for another. Use signChallengeFor(payload, audience), which signs only a challenge addressed to the audience you name.',
    );
  }
}
