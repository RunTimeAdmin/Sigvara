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
  flagsReceived: 0,
  linksCreated: 0,
  rateLimitHits: 0,
  httpRequests: 0,
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

function toPrometheusText() {
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

  lines.push('');
  lines.push('# HELP sigvara_oracle_finalize_total Score finalization attempts');
  lines.push('# TYPE sigvara_oracle_finalize_total counter');
  lines.push(`sigvara_oracle_finalize_total{result="success"} ${counters.finalizeSuccesses}`);
  lines.push(`sigvara_oracle_finalize_total{result="error"} ${counters.finalizeErrors}`);

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
  lines.push('');
  lines.push('# HELP sigvara_oracle_payments_verified_total Attestations backed by a verified settlement');
  lines.push('# TYPE sigvara_oracle_payments_verified_total counter');
  lines.push(`sigvara_oracle_payments_verified_total ${counters.paymentsVerified}`);
  lines.push('# HELP sigvara_oracle_payment_rpc_errors_total Receipt lookups that failed on the RPC, not on the payment');
  lines.push('# TYPE sigvara_oracle_payment_rpc_errors_total counter');
  lines.push(`sigvara_oracle_payment_rpc_errors_total ${counters.paymentRpcErrors}`);
  lines.push(`sigvara_oracle_attest_total{result="rejected_other"} ${counters.attestRejectedOther}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_flags_total Flags received');
  lines.push('# TYPE sigvara_oracle_flags_total counter');
  lines.push(`sigvara_oracle_flags_total ${counters.flagsReceived}`);

  lines.push('');
  lines.push('# HELP sigvara_oracle_links_total Links created');
  lines.push('# TYPE sigvara_oracle_links_total counter');
  lines.push(`sigvara_oracle_links_total ${counters.linksCreated}`);

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
