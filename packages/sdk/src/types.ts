export interface ContractAddresses {
  identity: string;
  reputation: string;
  staking: string;
}

export enum AgentStatus {
  Active = 0,
  Suspended = 1,
  Slashed = 2,
  /**
   * Registered but never bonded. Not slashable and not scoreable, so it is not an
   * agent anyone should rely on yet. Becomes Active when a deposit first carries it
   * over minimumStake. Appended to match the on-chain enum.
   */
  PendingBond = 3,
}

export interface AgentIdentity {
  operator: string;
  agentAddress: string;
  ed25519PubKey: string;
  status: AgentStatus;
  registeredAt: bigint;
}

export interface ReputationData {
  feeScore: number;
  successScore: number;
  ageScore: number;
  externalScore: number;
  communityScore: number;
  propagationScore: number;
  lastUpdated: bigint;
  total: number;
}

/** A score proposed by an oracle and not yet finalized. `exists` is false when none is pending. */
export interface PendingScore {
  exists: boolean;
  /** The proposed factors. `lastUpdated` inside is not meaningful until the score is finalized. */
  data: Omit<ReputationData, 'total'>;
  proposedAt: bigint;
  /** First moment it can be finalized, and the last it can be rejected. Zero for a proposal older than the field. */
  finalizableAt: bigint;
  evidenceRoot: string;
  /** The oracle that proposed it. The zero address for a proposal older than the field. */
  proposer: string;
}

/** Matches SigvaraStaking.SlashState. */
export enum SlashState {
  None = 0,
  Pending = 1,
  Executed = 2,
  Cancelled = 3,
  Disputed = 4,
}

/** The agent's most recent slash proposal, as SigvaraStaking keeps it. State None means there has been none. */
export interface SlashProposal {
  state: SlashState;
  reporter: string;
  victim: string;
  initiatedAt: bigint;
  challengeDeadline: bigint;
  /** Zero if the operator never disputed. */
  disputedAt: bigint;
  evidenceHash: string;
}

/** Stake queued for withdrawal. Still slashable until it is claimed. */
export interface PendingWithdrawal {
  amount: bigint;
  /** Zero when nothing is queued. */
  claimableAt: bigint;
}

export interface Challenge {
  payload: string;
  nonce: string;
  timestamp: number;
  expiresAt: number;
  /** Who the challenge was issued by. Undefined only for legacy v1 challenges. */
  audience?: string;
}

export interface ParsedChallenge {
  did: string;
  nonce: string;
  timestamp: number;
  /** Undefined for a v1 payload, which did not carry one. */
  audience?: string;
  version: 1 | 2;
}

export interface VerifierConfig {
  rpcUrl: string;
  addresses: ContractAddresses;
  chainId?: number;
  /**
   * How long one read may take before it is abandoned, in milliseconds. Default 30000.
   * ethers' own default is five minutes, which holds a gate's request that long when the RPC is
   * down. A positive number.
   */
  timeoutMs?: number;
}

export interface DidDocument {
  '@context': string[];
  id: string;
  controller: string;
  verificationMethod: VerificationMethod[];
  authentication: string[];
  assertionMethod: string[];
}

export interface VerificationMethod {
  id: string;
  type: string;
  controller: string;
  publicKeyMultibase: string;
}
