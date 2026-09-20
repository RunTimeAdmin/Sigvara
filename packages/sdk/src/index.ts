export { SigvaraAgent } from './agent';
export { SigvaraVerifier, registerAgent } from './verifier';
export { depositStake } from './stake';
export { SigvaraGate } from './gate';
export type { GateConfig, AdmitResult, AdmitReason, NonceStore } from './gate';
export type { DepositStakeResult } from './stake';
export {
  generateChallenge,
  signChallenge,
  verifyChallenge,
  parseChallengePayload,
  isChallengeExpired,
} from './challenge';
export {
  computeDidHash,
  formatDid,
  parseDid,
} from './did';
export {
  base58Encode,
  base58Decode,
  hexToBytes,
  bytesToHex,
  seedToKeyPair,
  pubKeyToBytes32,
  bytes32ToPubKey,
  pubKeyToMultibase,
} from './keys';
export type {
  ContractAddresses,
  AgentIdentity,
  ReputationData,
  Challenge,
  ParsedChallenge,
  VerifierConfig,
  DidDocument,
  VerificationMethod,
} from './types';
export { AgentStatus } from './types';
