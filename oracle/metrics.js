'use strict';

// Prometheus-style metrics for the Sigvara oracle.
// Lightweight: no external deps, just in-memory counters with text exposition.

const processStartTime = Date.now();

const counters = {
  epochsStarted: 0,
  epochsSucceeded: 0,
  epochsFailed: 0,
  proposeAttempts: 0,
  proposeSuccesses: 0,
  proposeErrors: 0,
  finalizeAttempts: 0,
  finalizeSuccesses: 0,
  finalizeErrors: 0,
  feeCharges: 0,
  feeChargeErrors: 0,
  attestAccepted: 0,
  attestRejectedCooldown: 0,
  attestRejectedOther: 0,
  attestRejectedPayment: 0,
  paymentsVerified: 0,
  paymentRpcErrors: 0,
  skippedUnbonded: 0,
  flagsReceived: 0,
  flagsResolved: 0,
  linksCreated: 0,
  scoreRpcErrors: 0,
  scoreErrors: 0,
  rateLimitHits: 0,
  httpRequests: 0,

  // Checker mode. These were incremented by index.js for a week without being declared
  // here, and inc() drops unknown names silently, so every divergence this operator
  // found was counted into nothing. The checker's whole job is noticing disagreement
  // and its disagreement counter read zero.
  checkerDivergences: 0,
  checkerAgreed: 0,

  // Write outcomes that are neither success nor error and were likewise undeclared.
  // proposeSlotTaken is the ordinary result of proposeIfEmpty losing a race, and
  // proposalsRejected is the committee rejecting a score: both are things you want a
  // rate for, and both read zero.
  proposeSlotTaken: 0,
  proposalsRejected: 0,
};

const gauges = {
  lastSuccessfulEpochMs: 0,
  activeAgents: 0,
};

function inc(name, amount = 1) {
  if (name in counters) counters[name] += amount;
}

function set(name, value) {
  if (name in gauges) gauges[name] = value;
}

function get(name) {
  if (name in counters) return counters[name];
  if (name in gauges) return gauges[name];
  return undefined;
}

function uptimeSeconds() {
  return Math.floor((Date.now() - processStartTime) / 1000);
}

/**
 * Render the exposition.
 *
 * `extra.evidenceCache` takes a stats object straight from the response cache. It is
 * passed in rather than imported so this module keeps no second copy of numbers the
 * cache already owns: a mirrored counter is a counter that can disagree with its
 * source, and the point of reporting the hit rate is to find out whether the cache is
 * working, not to read back what we assumed.
 */
function toPrometheusText(extra = {}) {
  const lines = [];
  lines.push('# HELP sigvara_oracle_uptime_seconds Process uptime in seconds');
  lines.push('# TYPE sigvara_oracle_uptime_seconds gauge');
  lines.push(`sigvara_oracle_uptime_seconds ${uptimeSeconds()}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_epochs_total Total epochs started');
  lines.push('# TYPE sigvara_oracle_epochs_total counter');
  lines.push(`sigvara_oracle_epochs_total{status="started"} ${counters.epochsStarted}`);
  lines.push(`sigvara_oracle_epochs_total{status="succeeded"} ${counters.epochsSucceeded}`);
  lines.push(`sigvara_oracle_epochs_total{status="failed"} ${counters.epochsFailed}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_propose_total Score proposal attempts');
  lines.push('# TYPE sigvara_oracle_propose_total counter');
  lines.push(`sigvara_oracle_propose_total{result="success"} ${counters.proposeSuccesses}`);
  lines.push(`sigvara_oracle_propose_total{result="error"} ${counters.proposeErrors}`);
  // slot_taken is proposeIfEmpty declining to overwrite a pending score, which is a
  // normal race outcome rather than a failure. Attempts are exposed so success + error
  // + slot_taken can be checked to account for all of them.
  lines.push(`sigvara_oracle_propose_total{result="slot_taken"} ${counters.proposeSlotTaken}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_propose_attempts_total Proposals attempted, before their outcome');
  lines.push('# TYPE sigvara_oracle_propose_attempts_total counter');
  lines.push(`sigvara_oracle_propose_attempts_total ${counters.proposeAttempts}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_finalize_total Score finalization attempts');
  lines.push('# TYPE sigvara_oracle_finalize_total counter');
  lines.push(`sigvara_oracle_finalize_total{result="success"} ${counters.finalizeSuccesses}`);
  lines.push(`sigvara_oracle_finalize_total{result="error"} ${counters.finalizeErrors}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_finalize_attempts_total Finalizations attempted, before their outcome');
  lines.push('# TYPE sigvara_oracle_finalize_attempts_total counter');
  lines.push(`sigvara_oracle_finalize_attempts_total ${counters.finalizeAttempts}`);

  lines.push('# HELP sigvara_oracle_fee_charges_total Epoch-fee charges attempted by the oracle');
  lines.push('# TYPE sigvara_oracle_fee_charges_total counter');
  lines.push(`sigvara_oracle_fee_charges_total{result="ok"} ${counters.feeCharges}`);
  lines.push(`sigvara_oracle_fee_charges_total{result="error"} ${counters.feeChargeErrors}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_attest_total Attestation requests');
  lines.push('# TYPE sigvara_oracle_attest_total counter');
  lines.push(`sigvara_oracle_attest_total{result="accepted"} ${counters.attestAccepted}`);
  lines.push(`sigvara_oracle_attest_total{result="rejected_cooldown"} ${counters.attestRejectedCooldown}`);
  lines.push(`sigvara_oracle_attest_total{result="rejected_payment"} ${counters.attestRejectedPayment}`);
  // Kept with the rest of its family. This line used to sit after the payment counters,
  // which splits one metric family across the exposition; strict parsers object and
  // readers more so.
  lines.push(`sigvara_oracle_attest_total{result="rejected_other"} ${counters.attestRejectedOther}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_skipped_unbonded_total Agents skipped for holding less than minimumStake');
  lines.push('# TYPE sigvara_oracle_skipped_unbonded_total counter');
  lines.push(`sigvara_oracle_skipped_unbonded_total ${counters.skippedUnbonded}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_payments_verified_total Attestations backed by a verified settlement');
  lines.push('# TYPE sigvara_oracle_payments_verified_total counter');
  lines.push(`sigvara_oracle_payments_verified_total ${counters.paymentsVerified}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_payment_rpc_errors_total Receipt lookups that failed on the RPC, not on the payment');
  lines.push('# TYPE sigvara_oracle_payment_rpc_errors_total counter');
  lines.push(`sigvara_oracle_payment_rpc_errors_total ${counters.paymentRpcErrors}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_checker_comparisons_total Pending scores this checker re-measured');
  lines.push('# TYPE sigvara_oracle_checker_comparisons_total counter');
  lines.push(`sigvara_oracle_checker_comparisons_total{verdict="diverged"} ${counters.checkerDivergences}`);
  lines.push(`sigvara_oracle_checker_comparisons_total{verdict="agreed"} ${counters.checkerAgreed}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_proposals_rejected_total Proposals rejected by the slashing committee');
  lines.push('# TYPE sigvara_oracle_proposals_rejected_total counter');
  lines.push(`sigvara_oracle_proposals_rejected_total ${counters.proposalsRejected}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_flags_total Flags received');
  lines.push('# TYPE sigvara_oracle_flags_total counter');
  lines.push(`sigvara_oracle_flags_total ${counters.flagsReceived}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_flags_resolved_total Flags cleared by an operator');
  lines.push('# TYPE sigvara_oracle_flags_resolved_total counter');
  lines.push(`sigvara_oracle_flags_resolved_total ${counters.flagsResolved}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_links_total Links created');
  lines.push('# TYPE sigvara_oracle_links_total counter');
  lines.push(`sigvara_oracle_links_total ${counters.linksCreated}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_score_rpc_errors_total /score reads that failed upstream, answered 502');
  lines.push('# TYPE sigvara_oracle_score_rpc_errors_total counter');
  lines.push(`sigvara_oracle_score_rpc_errors_total ${counters.scoreRpcErrors}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_score_errors_total /score failures that were not upstream, answered 500');
  lines.push('# TYPE sigvara_oracle_score_errors_total counter');
  lines.push(`sigvara_oracle_score_errors_total ${counters.scoreErrors}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_rate_limit_hits_total Rate limit rejections');
  lines.push('# TYPE sigvara_oracle_rate_limit_hits_total counter');
  lines.push(`sigvara_oracle_rate_limit_hits_total ${counters.rateLimitHits}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_http_requests_total Total HTTP requests');
  lines.push('# TYPE sigvara_oracle_http_requests_total counter');
  lines.push(`sigvara_oracle_http_requests_total ${counters.httpRequests}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_last_successful_epoch_timestamp_seconds Unix timestamp of last successful epoch');
  lines.push('# TYPE sigvara_oracle_last_successful_epoch_timestamp_seconds gauge');
  lines.push(`sigvara_oracle_last_successful_epoch_timestamp_seconds ${Math.floor(gauges.lastSuccessfulEpochMs / 1000)}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_active_agents Number of agents scored in last epoch');
  lines.push('# TYPE sigvara_oracle_active_agents gauge');
  lines.push(`sigvara_oracle_active_agents ${gauges.activeAgents}`);

  if (extra.evidenceCache) {
    const c = extra.evidenceCache;
    lines.push('');
    lines.push('# HELP sigvara_oracle_evidence_cache_total Evidence responses served from cache or rebuilt');
    lines.push('# TYPE sigvara_oracle_evidence_cache_total counter');
    lines.push(`sigvara_oracle_evidence_cache_total{result="hit"} ${c.hits}`);
    lines.push(`sigvara_oracle_evidence_cache_total{result="miss"} ${c.misses}`);
    lines.push(`sigvara_oracle_evidence_cache_evictions_total ${c.evictions}`);
    lines.push('');
    lines.push('# HELP sigvara_oracle_evidence_cache_entries Cached evidence responses held');
    lines.push('# TYPE sigvara_oracle_evidence_cache_entries gauge');
    lines.push(`sigvara_oracle_evidence_cache_entries ${c.entries}`);
    lines.push('# HELP sigvara_oracle_evidence_cache_bytes Serialized bytes held by the evidence cache');
    lines.push('# TYPE sigvara_oracle_evidence_cache_bytes gauge');
    lines.push(`sigvara_oracle_evidence_cache_bytes ${c.bytes}`);
  }

  return lines.join('\n') + '\n';
}

function reset() {
  for (const key of Object.keys(counters)) counters[key] = 0;
  for (const key of Object.keys(gauges)) gauges[key] = 0;
}

module.exports = {
  inc,
  set,
  get,
  uptimeSeconds,
  toPrometheusText,
  reset,
  counters,
  gauges,
};
