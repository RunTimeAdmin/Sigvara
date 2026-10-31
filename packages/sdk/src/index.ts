export { SigvaraAgent } from './agent';
export { SigvaraVerifier, registerAgent } from './verifier';
export { depositStake } from './stake';
export { SigvaraGate, atomicNonceStore } from './gate';
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
  signPaymentOutcome,
  verifyPaymentOutcome,
  paymentOutcomeDomain,
  PAYMENT_OUTCOME_TYPES,
  OUTCOME_DELIVERED,
  OUTCOME_NOT_DELIVERED,
  MAX_OUTCOME_DEADLINE_SECONDS,
} from './outcome';
export type {
  PaymentOutcomeCode,
  PaymentOutcomeDeployment,
  SignedPaymentOutcome,
  SignPaymentOutcomeOptions,
  VerifyPaymentOutcomeOptions,
} from './outcome';
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
