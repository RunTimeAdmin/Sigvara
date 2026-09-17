'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const metrics = require('./metrics');

test('metrics.inc: increments counter by 1 by default', () => {
  metrics.reset();
  assert.equal(metrics.get('epochsStarted'), 0);
  metrics.inc('epochsStarted');
  assert.equal(metrics.get('epochsStarted'), 1);
  metrics.inc('epochsStarted');
  assert.equal(metrics.get('epochsStarted'), 2);
});

test('metrics.inc: increments counter by specified amount', () => {
  metrics.reset();
  metrics.inc('proposeSuccesses', 5);
  assert.equal(metrics.get('proposeSuccesses'), 5);
  metrics.inc('proposeSuccesses', 3);
  assert.equal(metrics.get('proposeSuccesses'), 8);
});

test('metrics.inc: ignores unknown counter names', () => {
  metrics.reset();
  metrics.inc('unknownCounter');
  assert.equal(metrics.get('unknownCounter'), undefined);
});

test('metrics.set: sets gauge value', () => {
  metrics.reset();
  metrics.set('lastSuccessfulEpochMs', 1234567890);
  assert.equal(metrics.get('lastSuccessfulEpochMs'), 1234567890);
});

test('metrics.set: ignores unknown gauge names', () => {
  metrics.reset();
  metrics.set('unknownGauge', 123);
  assert.equal(metrics.get('unknownGauge'), undefined);
});

test('metrics.get: returns counter values', () => {
  metrics.reset();
  metrics.inc('attestAccepted', 10);
  assert.equal(metrics.get('attestAccepted'), 10);
});

test('metrics.get: returns gauge values', () => {
  metrics.reset();
  metrics.set('activeAgents', 42);
  assert.equal(metrics.get('activeAgents'), 42);
});

test('metrics.uptimeSeconds: returns non-negative number', () => {
  const uptime = metrics.uptimeSeconds();
  assert.ok(uptime >= 0);
  assert.ok(Number.isInteger(uptime));
});

test('metrics.reset: clears all counters and gauges', () => {
  metrics.inc('epochsStarted', 5);
  metrics.inc('proposeSuccesses', 10);
  metrics.set('lastSuccessfulEpochMs', 999);
  metrics.set('activeAgents', 3);
  metrics.reset();
  assert.equal(metrics.get('epochsStarted'), 0);
  assert.equal(metrics.get('proposeSuccesses'), 0);
  assert.equal(metrics.get('lastSuccessfulEpochMs'), 0);
  assert.equal(metrics.get('activeAgents'), 0);
});

test('metrics.toPrometheusText: returns valid Prometheus format', () => {
  metrics.reset();
  metrics.inc('epochsStarted', 5);
  metrics.inc('epochsSucceeded', 4);
  metrics.inc('epochsFailed', 1);
  metrics.inc('proposeSuccesses', 20);
  metrics.inc('attestAccepted', 15);
  metrics.inc('attestRejectedCooldown', 3);
  metrics.set('lastSuccessfulEpochMs', 1234567890000);
  metrics.set('activeAgents', 10);

  const text = metrics.toPrometheusText();

  assert.ok(text.includes('# HELP'), 'should include HELP comments');
  assert.ok(text.includes('# TYPE'), 'should include TYPE comments');
  assert.ok(text.includes('sigvara_oracle_uptime_seconds'), 'should include uptime metric');
  assert.ok(text.includes('sigvara_oracle_epochs_total{status="started"} 5'), 'should include epochs started');
  assert.ok(text.includes('sigvara_oracle_epochs_total{status="succeeded"} 4'), 'should include epochs succeeded');
  assert.ok(text.includes('sigvara_oracle_epochs_total{status="failed"} 1'), 'should include epochs failed');
  assert.ok(text.includes('sigvara_oracle_propose_total{result="success"} 20'), 'should include propose successes');
  assert.ok(text.includes('sigvara_oracle_attest_total{result="accepted"} 15'), 'should include attest accepted');
  assert.ok(text.includes('sigvara_oracle_attest_total{result="rejected_cooldown"} 3'), 'should include attest rejected');
  assert.ok(text.includes('sigvara_oracle_last_successful_epoch_timestamp_seconds 1234567890'), 'should include last epoch timestamp');
  assert.ok(text.includes('sigvara_oracle_active_agents 10'), 'should include active agents');
  assert.ok(text.endsWith('\n'), 'should end with newline');
});

test('metrics.toPrometheusText: each line is valid', () => {
  metrics.reset();
  const text = metrics.toPrometheusText();
  const lines = text.split('\n').filter(line => line.length > 0);

  for (const line of lines) {
    const isComment = line.startsWith('#');
    const isMetric = /^[a-z_]+(\{[^}]*\})?\s+-?\d+(\.\d+)?$/.test(line);
    assert.ok(isComment || isMetric, `Invalid line: ${line}`);
  }
});

test('all expected counters exist', () => {
  const expectedCounters = [
    'epochsStarted',
    'epochsSucceeded',
    'epochsFailed',
    'proposeAttempts',
    'proposeSuccesses',
    'proposeErrors',
    'finalizeAttempts',
    'finalizeSuccesses',
    'finalizeErrors',
    'attestAccepted',
    'attestRejectedCooldown',
    'attestRejectedOther',
    'flagsReceived',
    'linksCreated',
    'rateLimitHits',
    'httpRequests',
  ];

  for (const counter of expectedCounters) {
    assert.ok(counter in metrics.counters, `Counter ${counter} should exist`);
  }
});

test('all expected gauges exist', () => {
  const expectedGauges = [
    'lastSuccessfulEpochMs',
    'activeAgents',
  ];

  for (const gauge of expectedGauges) {
    assert.ok(gauge in metrics.gauges, `Gauge ${gauge} should exist`);
  }
});
