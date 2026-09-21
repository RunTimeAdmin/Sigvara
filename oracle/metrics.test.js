'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const metrics = require('./metrics');
const fs = require('node:fs');
const path = require('node:path');

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

// -------------------------------------------------------------------------
// Exposition completeness
//
// These are the tests that matter here. Every bug this file just fixed was silent:
// inc() drops unknown names, and a declared counter missing from toPrometheusText
// reads as a metric that is always zero. Both look exactly like "nothing is
// happening", which is the single most misleading thing a monitoring surface can do.
// checkerDivergences was incremented on every disagreement this operator found and
// declared nowhere, so the checker's disagreement count sat at zero while it was
// disagreeing.
// -------------------------------------------------------------------------

test('every metric name used in the source is declared', () => {
  // The bug class: metrics.inc('typo') is a silent no-op. Nothing warns, and the
  // counter reads zero forever. Scanning the source is the only way to catch it,
  // because the call sites are spread across the epoch and the request handlers.
  const dir = __dirname;
  const sources = fs.readdirSync(dir)
    .filter(f => f.endsWith('.js') && !f.endsWith('.test.js'));

  const declared = new Set([
    ...Object.keys(metrics.counters),
    ...Object.keys(metrics.gauges),
  ]);

  const undeclared = [];
  for (const file of sources) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const match of text.matchAll(/metrics\.(inc|set)\('([A-Za-z0-9_]+)'/g)) {
      const [, fn, name] = match;
      if (!declared.has(name)) undeclared.push(`${file}: metrics.${fn}('${name}')`);
    }
  }

  assert.deepEqual(undeclared, [], 'these names are incremented into nothing');
});

test('every declared counter and gauge reaches the exposition', () => {
  // A counter can be declared, incremented correctly, and still never rendered.
  // Probing by value rather than by name, because the names do not appear literally:
  // most are emitted with labels, e.g. sigvara_oracle_propose_total{result="success"}.
  metrics.reset();
  const counterKeys = Object.keys(metrics.counters);
  const gaugeKeys = Object.keys(metrics.gauges);

  counterKeys.forEach((k, i) => { metrics.counters[k] = 700000 + i; });
  gaugeKeys.forEach((k, i) => { metrics.gauges[k] = 800000 + i; });

  const text = metrics.toPrometheusText();

  const missingCounters = counterKeys.filter((k, i) => !text.includes(String(700000 + i)));
  assert.deepEqual(missingCounters, [], 'declared but never rendered');

  // lastSuccessfulEpochMs is rendered as seconds, so it is checked separately.
  const missingGauges = gaugeKeys.filter((k, i) =>
    k !== 'lastSuccessfulEpochMs' && !text.includes(String(800000 + i)));
  assert.deepEqual(missingGauges, [], 'declared but never rendered');
  metrics.reset();
});

test('no metric family is split across the exposition', () => {
  // The other bug fixed here: an attest_total sample sat several families below its
  // own HELP/TYPE header, among the payment counters. Strict parsers reject a family
  // that reopens after another has started, and a reader trying to find it has no
  // chance.
  metrics.reset();
  const lines = metrics.toPrometheusText().split('\n').filter(Boolean);

  const seen = new Set();
  let current = null;
  for (const line of lines) {
    if (line.startsWith('#')) continue;
    const name = line.split(/[\s{]/)[0];
    if (name !== current) {
      assert.equal(seen.has(name), false, `metric family ${name} reopens after another`);
      seen.add(name);
      current = name;
    }
  }
});

test('every sample is preceded by a TYPE declaration for its family', () => {
  metrics.reset();
  const lines = metrics.toPrometheusText().split('\n').filter(Boolean);
  const typed = new Set();

  for (const line of lines) {
    if (line.startsWith('# TYPE ')) { typed.add(line.split(' ')[2]); continue; }
    if (line.startsWith('#')) continue;
    const name = line.split(/[\s{]/)[0];
    assert.equal(typed.has(name), true, `${name} has no # TYPE`);
  }
});

test('evidence cache stats are reported when supplied, absent when not', () => {
  metrics.reset();
  const without = metrics.toPrometheusText();
  assert.equal(without.includes('evidence_cache'), false);

  const withCache = metrics.toPrometheusText({
    evidenceCache: { hits: 41, misses: 3, evictions: 2, entries: 9, bytes: 12345 },
  });
  assert.match(withCache, /sigvara_oracle_evidence_cache_total\{result="hit"\} 41/);
  assert.match(withCache, /sigvara_oracle_evidence_cache_total\{result="miss"\} 3/);
  assert.match(withCache, /sigvara_oracle_evidence_cache_evictions_total 2/);
  assert.match(withCache, /sigvara_oracle_evidence_cache_entries 9/);
  assert.match(withCache, /sigvara_oracle_evidence_cache_bytes 12345/);
});
