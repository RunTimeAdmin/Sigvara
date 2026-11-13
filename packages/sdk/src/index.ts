export { SigvaraAgent } from './agent';
export { SigvaraVerifier, registerAgent } from './verifier';
export { depositStake } from './stake';
export { SigvaraGate, atomicNonceStore } from './gate';
export { SigvaraTrustCheck, standingDecision, SCORE_BANDS, scoreBand } from './standing';
export type { TrustCheckConfig, TrustVerdict, TrustReason, StandingReason } from './standing';
export { sigvaraX402Fetch, x402OffersFrom, X402SellerRefused, X402_MAX_BYTES, X402_MAX_OFFERS } from './x402';
export type { X402Offer } from './x402';
export { sigvaraTrustTool, requireTrustedAgent, UntrustedAgentError, TRUST_TOOL_SCHEMA } from './tools';
export {
  evidenceLeaf,
  evidenceLayers,
  evidenceRoot,
  evidenceProof,
  matchEvidenceRoot,
  outcomeCode,
} from './evidence';
export type { EvidenceRecord, RootMatch } from './evidence';
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
  PendingScore,
  PendingWithdrawal,
  SlashProposal,
} from './types';
export { AgentStatus, SlashState } from './types';
