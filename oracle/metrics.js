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
  // An agent not charged because the contract would have refused the proposal, or because
  // the dry run could not be made. Each one is a fee that was not taken for nothing.
  feeChargesSkipped: 0,
  feeChargesAlreadyPaid: 0,
  proposalsStranded: 0,
  // Transactions the oracle declined to sign (a fee or cost above its cap), and ones it
  // sent and never saw mined. Neither is the contract refusing or the provider throttling,
  // and both are worth a look at the RPC.
  txCapped: 0,
  txUnconfirmed: 0,
  attestAccepted: 0,
  // Accepted and held in memory, but the state file could not be written, so a restart before the next
  // good save loses it. The reply says so (202, durable: false). Worth alerting on beside /health.
  attestAcceptedNotDurable: 0,
  attestRejectedCooldown: 0,
  attestRejectedOther: 0,
  attestRejectedPayment: 0,
  paymentsVerified: 0,
  paymentRpcErrors: 0,
  skippedUnbonded: 0,
  flagsReceived: 0,
  flagsResolved: 0,
  linksCreated: 0,
  // A flag, a resolve or a link that was taken and held in memory, but the state file could not be written. The
  // reply says so (202, durable: false). Worth alerting on beside /health, like attestAcceptedNotDurable.
  writesNotDurable: 0,
  scoreRpcErrors: 0,
  scoreErrors: 0,
  // Badges are embedded on pages this oracle does not control, so request volume is
  // set by an agent's audience. The hit ratio is the thing to watch: a falling one
  // means the cache is being missed and every reader is costing two RPC calls.
  badgeRequests: 0,
  badgeCacheHits: 0,
  badgeRpcErrors: 0,
  // ERC-8183 reader. Observation only today, but a reader that starts failing should
  // be visible before anyone decides to score from it.
  jobsReads: 0,
  jobsErrors: 0,
  // ADR 0003 pull scanner. paymentsPulled is the one to watch: it is how much evidence
  // this operator found for itself rather than being told about, and a checker whose
  // figure stays at zero while the primary's climbs is not converging.
  paymentScans: 0,
  paymentsPulled: 0,
  paymentScanErrors: 0,
  // A failure here means an empty scan told us nothing. Worth alerting on: it is the
  // difference between "no agent was paid" and "the query stopped working".
  paymentScanCanaryFailures: 0,
  // A credit the scan planned and the store then refused. Should be zero: the two
  // consult the same predicate, so anything here means they disagree, or a
  // pre-migration bare-hash entry is blocking a settlement.
  paymentScanRefused: 0,
  // ADR 0006 peer import. Imported is outcomes another operator took that this one now holds
  // too. Refused is ones it served that fail this oracle's own checks: a few are expected (a
  // payment this node cannot find), many mean a peer serving what it should not. Errors are
  // runs that stopped early, usually a peer or this node not answering. Conflicts are outcomes a
  // peer served that differ from the one held for the same payment, unchecked: a payer who signed
  // two, or a peer serving something it should not.
  payerOutcomesImported: 0,
  payerOutcomeImportRefused: 0,
  payerOutcomeImportErrors: 0,
  payerOutcomeConflicts: 0,
  // The provider throttled a write. Separate from proposeErrors and finalizeErrors,
  // which should mean this operator could not do its job: throttling is the provider's
  // limit, with a different fix, and burying it in the same number hides both.
  proposeThrottled: 0,
  finalizeThrottled: 0,
  rateLimitHits: 0,
  httpRequests: 0,
  // Requests refused before routing because the target was not a canonical path, and
  // requests whose handler threw. The second should be zero; either one climbing means
  // someone is probing the listener or a route has a bug.
  httpBadTargets: 0,
  httpHandlerErrors: 0,

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
  lines.push(`sigvara_oracle_fee_charges_total{result="skipped"} ${counters.feeChargesSkipped}`);
  lines.push(`sigvara_oracle_fee_charges_total{result="already_paid"} ${counters.feeChargesAlreadyPaid}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_tx_refused_total Transactions not signed because of a fee cap, or sent and never seen mined');
  lines.push('# TYPE sigvara_oracle_tx_refused_total counter');
  lines.push(`sigvara_oracle_tx_refused_total{reason="fee_cap"} ${counters.txCapped}`);
  lines.push(`sigvara_oracle_tx_refused_total{reason="unconfirmed"} ${counters.txUnconfirmed}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_attest_total Attestation requests');
  lines.push('# TYPE sigvara_oracle_attest_total counter');
  lines.push(`sigvara_oracle_attest_total{result="accepted"} ${counters.attestAccepted}`);
  lines.push(`sigvara_oracle_attest_total{result="accepted_not_durable"} ${counters.attestAcceptedNotDurable}`);
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
  lines.push('# HELP sigvara_oracle_proposals_stranded_total Pending proposals whose proposer lost its authority, replaced rather than finalized');
  lines.push('# TYPE sigvara_oracle_proposals_stranded_total counter');
  lines.push(`sigvara_oracle_proposals_stranded_total ${counters.proposalsStranded}`);

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
  lines.push('# HELP sigvara_oracle_writes_not_durable_total Flags, resolves and links accepted while the state file could not be written, answered 202');
  lines.push('# TYPE sigvara_oracle_writes_not_durable_total counter');
  lines.push(`sigvara_oracle_writes_not_durable_total ${counters.writesNotDurable}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_score_rpc_errors_total /score reads that failed upstream, answered 502');
  lines.push('# TYPE sigvara_oracle_score_rpc_errors_total counter');
  lines.push(`sigvara_oracle_score_rpc_errors_total ${counters.scoreRpcErrors}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_score_errors_total /score failures that were not upstream, answered 500');
  lines.push('# TYPE sigvara_oracle_score_errors_total counter');
  lines.push(`sigvara_oracle_score_errors_total ${counters.scoreErrors}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_badge_requests_total Badge SVG requests');
  lines.push('# TYPE sigvara_oracle_badge_requests_total counter');
  lines.push(`sigvara_oracle_badge_requests_total ${counters.badgeRequests}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_badge_cache_hits_total Badge requests served without touching the chain');
  lines.push('# TYPE sigvara_oracle_badge_cache_hits_total counter');
  lines.push(`sigvara_oracle_badge_cache_hits_total ${counters.badgeCacheHits}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_badge_rpc_errors_total Badge reads that could not reach the chain');
  lines.push('# TYPE sigvara_oracle_badge_rpc_errors_total counter');
  lines.push(`sigvara_oracle_badge_rpc_errors_total ${counters.badgeRpcErrors}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_jobs_reads_total ERC-8183 job registry reads served');
  lines.push('# TYPE sigvara_oracle_jobs_reads_total counter');
  lines.push(`sigvara_oracle_jobs_reads_total ${counters.jobsReads}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_jobs_errors_total ERC-8183 reads that could not reach the registry');
  lines.push('# TYPE sigvara_oracle_jobs_errors_total counter');
  lines.push(`sigvara_oracle_jobs_errors_total ${counters.jobsErrors}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_payment_scans_total Payment scans completed');
  lines.push('# TYPE sigvara_oracle_payment_scans_total counter');
  lines.push(`sigvara_oracle_payment_scans_total ${counters.paymentScans}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_payments_pulled_total Payments credited from the chain rather than reported');
  lines.push('# TYPE sigvara_oracle_payments_pulled_total counter');
  lines.push(`sigvara_oracle_payments_pulled_total ${counters.paymentsPulled}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_payment_scan_errors_total Payment scans that could not complete');
  lines.push('# TYPE sigvara_oracle_payment_scan_errors_total counter');
  lines.push(`sigvara_oracle_payment_scan_errors_total ${counters.paymentScanErrors}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_payer_outcomes_imported_total Payer-signed outcomes imported from other operators');
  lines.push('# TYPE sigvara_oracle_payer_outcomes_imported_total counter');
  lines.push(`sigvara_oracle_payer_outcomes_imported_total ${counters.payerOutcomesImported}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_payer_outcome_import_refused_total Outcomes a peer served that failed the checks here');
  lines.push('# TYPE sigvara_oracle_payer_outcome_import_refused_total counter');
  lines.push(`sigvara_oracle_payer_outcome_import_refused_total ${counters.payerOutcomeImportRefused}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_payer_outcome_import_errors_total Imports from a peer that stopped early');
  lines.push('# TYPE sigvara_oracle_payer_outcome_import_errors_total counter');
  lines.push(`sigvara_oracle_payer_outcome_import_errors_total ${counters.payerOutcomeImportErrors}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_payer_outcome_conflicts_total Outcomes a peer served that differ from the one held, unchecked');
  lines.push('# TYPE sigvara_oracle_payer_outcome_conflicts_total counter');
  lines.push(`sigvara_oracle_payer_outcome_conflicts_total ${counters.payerOutcomeConflicts}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_payment_scan_canary_failures_total Empty scans whose query could not be proved to work');
  lines.push('# TYPE sigvara_oracle_payment_scan_canary_failures_total counter');
  lines.push(`sigvara_oracle_payment_scan_canary_failures_total ${counters.paymentScanCanaryFailures}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_payment_scan_refused_total Planned credits the store refused');
  lines.push('# TYPE sigvara_oracle_payment_scan_refused_total counter');
  lines.push(`sigvara_oracle_payment_scan_refused_total ${counters.paymentScanRefused}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_propose_throttled_total Proposals the RPC provider throttled');
  lines.push('# TYPE sigvara_oracle_propose_throttled_total counter');
  lines.push(`sigvara_oracle_propose_throttled_total ${counters.proposeThrottled}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_finalize_throttled_total Finalizations the RPC provider throttled');
  lines.push('# TYPE sigvara_oracle_finalize_throttled_total counter');
  lines.push(`sigvara_oracle_finalize_throttled_total ${counters.finalizeThrottled}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_rate_limit_hits_total Rate limit rejections');
  lines.push('# TYPE sigvara_oracle_rate_limit_hits_total counter');
  lines.push(`sigvara_oracle_rate_limit_hits_total ${counters.rateLimitHits}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_http_requests_total Total HTTP requests');
  lines.push('# TYPE sigvara_oracle_http_requests_total counter');
  lines.push(`sigvara_oracle_http_requests_total ${counters.httpRequests}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_http_refused_total Requests refused before routing, or ended by an unexpected error');
  lines.push('# TYPE sigvara_oracle_http_refused_total counter');
  lines.push(`sigvara_oracle_http_refused_total{reason="bad_target"} ${counters.httpBadTargets}`);
  lines.push(`sigvara_oracle_http_refused_total{reason="handler_error"} ${counters.httpHandlerErrors}`);

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
