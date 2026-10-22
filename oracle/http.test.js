'use strict';

// End-to-end tests for the HTTP layer: what the listener refuses, how it meters callers, what
// a bad request costs, and what the watcher does when it cannot read the checker. The real
// index.js and watcher.js run as child processes with the chain stubbed (test-support/).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const {
  World, startOracle, runToExit, startWatcher, webhookSink,
} = require('./test-support/oracle-harness');

const ADMIN = 'a'.repeat(64);
const AUDITOR = 'c'.repeat(64);
const DID = `0x${'ab'.repeat(32)}`;
const BACKSLASH = String.fromCharCode(92);

const FLAGGER = 'f'.repeat(64);

const ENV = {
  ORACLE_ADMIN_TOKEN: ADMIN,
  ORACLE_TOKEN_COUNTERAUDIT: AUDITOR,
  ORACLE_SCOPES_COUNTERAUDIT: 'attest',
  ORACLE_TOKEN_FLAGGER: FLAGGER,
  ORACLE_SCOPES_FLAGGER: 'flag',
};

let world;
let oracle;

before(async () => {
  world = new World();
  oracle = await startOracle({ world, env: ENV });
});

after(async () => {
  await oracle.stop();
});

const metricsText = async () => (await oracle.call('GET', '/metrics')).text;
const counter = (text, name) => Number((text.match(new RegExp(`^${name.replace(/[{}"=]/g, '\\$&')} (\\d+)`, 'm')) || [])[1]);

// ---- request targets -------------------------------------------------------------------

test('a request target that is not a canonical path is refused, and the process survives', async () => {
  const targets = [
    'GET http://[ HTTP/1.1',                 // new URL() threw on this and the process exited
    `GET //evidence/metrics HTTP/1.1`,       // read as host "evidence", path "/metrics"
    `GET //metrics HTTP/1.1`,
    `GET /evidence/../metrics HTTP/1.1`,     // collapsed by the URL parser, not by a proxy
    `GET /%2e%2e/metrics HTTP/1.1`,
    `GET /health/. HTTP/1.1`,
    'GET * HTTP/1.1',
  ];
  for (const line of targets) {
    const status = await oracle.raw(line);
    assert.match(status, / 400 /, `${line} => ${status}`);
  }
  assert.ok(oracle.alive(), 'the oracle is still running');
  const health = await oracle.call('GET', '/health');
  assert.equal(health.status, 200);
  const text = await metricsText();
  assert.ok(counter(text, 'sigvara_oracle_http_refused_total{reason="bad_target"}') >= 3, text);
});

test('an ordinary request is still answered', async () => {
  assert.match(await oracle.raw('GET /health HTTP/1.1'), / 200 /);
  assert.match(await oracle.raw(`GET /evidence/${DID} HTTP/1.1`), / 200 /);
  assert.match(await oracle.raw(`GET /score/${DID} HTTP/1.1`), / 200 /);
});

test('a handler that throws costs one request, not the process', async () => {
  world.set('explodeHealth', true);
  const r = await oracle.call('GET', '/health');
  assert.equal(r.status, 500);
  assert.deepEqual(r.body, { error: 'internal error' }, 'the error text is not sent to the caller');
  assert.ok(!/stub/.test(r.text));
  assert.ok(oracle.alive(), 'the process is still running');
  assert.match(oracle.logs(), /request failed: GET "\/health"/, 'it is logged, with the target quoted');

  world.set('explodeHealth', false);
  assert.equal((await oracle.call('GET', '/health')).status, 200);
  assert.ok(counter(await metricsText(), 'sigvara_oracle_http_refused_total{reason="handler_error"}') >= 1);
});

// ---- rate limiting ---------------------------------------------------------------------

test('a flood on one kind of read does not use up the allowance of another', async () => {
  const client = '198.51.100.20';
  let last;
  for (let i = 0; i < 61; i++) last = await oracle.call('GET', `/evidence/${DID}`, undefined, undefined, { client });
  assert.equal(last.status, 429, 'the 61st evidence read is refused');

  // The same client, now asking for the divergence list the watcher polls: not refused.
  // (A primary answers 404 not_a_checker; what matters is that it is not a 429.)
  const divergence = await oracle.call('GET', '/divergence', undefined, undefined, { client });
  assert.equal(divergence.status, 404);
  assert.equal(divergence.body.error, 'not_a_checker');
  assert.equal((await oracle.call('GET', `/score/${DID}`, undefined, undefined, { client })).status, 200);
});

test('writes are metered before they are authorised, so guessing a token is throttled too', async () => {
  const client = '198.51.100.21';
  const statuses = [];
  for (let i = 0; i < 62; i++) {
    statuses.push((await oracle.call('POST', '/flag', { didHash: DID }, undefined, { client })).status);
  }
  assert.equal(statuses[0], 401);
  assert.equal(statuses[59], 401);
  assert.equal(statuses[60], 429, 'the 61st attempt is refused, not answered 401 again');
});

// The proxy case itself. Every other request in this file reaches the oracle from loopback, which
// is always trusted, so none of them can tell whether TRUSTED_PROXIES is wired up. This one
// connects from the machine's own network address, as a proxy on another interface would.
function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address;
    }
  }
  return null;
}

function getFrom(lan, port, forwardedFor) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      host: lan,
      port,
      path: `/score/${DID}`,
      localAddress: lan,
      agent: false,
      headers: { 'x-forwarded-for': forwardedFor },
    }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
}

test('behind a listed proxy each visitor has a bucket of their own; behind an unlisted one they share', async (t) => {
  const lan = lanAddress();
  if (!lan) return t.skip('this machine has no non-loopback network interface');
  const listed = await startOracle({
    world: new World(),
    env: { HOST: '0.0.0.0', ORACLE_ADMIN_TOKEN: ADMIN, TRUSTED_PROXIES: `${lan}/32` },
  });
  const unlisted = await startOracle({
    world: new World(),
    env: { HOST: '0.0.0.0', ORACLE_ADMIN_TOKEN: ADMIN },
  });
  try {
    const a = [];
    const b = [];
    for (let i = 1; i <= 62; i++) {
      a.push(await getFrom(lan, listed.port, `198.51.100.${i}`));
      b.push(await getFrom(lan, unlisted.port, `198.51.100.${i}`));
    }
    assert.ok(a.every((s) => s === 200), `62 different visitors, none refused: ${[...new Set(a)]}`);
    // Without the setting the proxy is the only address the oracle sees, so the 61st request
    // is refused no matter who sent it. That is the outage this setting exists to prevent.
    assert.equal(b[59], 200);
    assert.equal(b[60], 429);
  } finally {
    await listed.stop();
    await unlisted.stop();
  }
});

// ---- writes validate what they store -----------------------------------------------------

test('/flag refuses a didHash that is not a 32-byte hash, and one bad body does not break saving', async () => {
  for (const didHash of [{ toString: 1 }, 'x'.repeat(5000), `0x${'z'.repeat(64)}`, 7, null, undefined]) {
    const r = await oracle.call('POST', '/flag', { didHash }, ADMIN);
    assert.equal(r.status, 400, JSON.stringify(didHash)?.slice(0, 40));
  }
  // The state file must still be writable: this is what the object key used to break.
  const ok = await oracle.call('POST', '/flag', { didHash: DID }, ADMIN);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.flags, 1);
  const health = (await oracle.call('GET', '/health')).body;
  assert.equal(health.statePersisted, true, 'the last save of the state file worked');
});

test('/flag files the flag under the one stored spelling of the hash', async () => {
  const mixed = `0x${'Cd'.repeat(32)}`;
  const r = await oracle.call('POST', '/flag', { didHash: mixed }, ADMIN);
  assert.equal(r.status, 200, r.text);
  const s = await oracle.call('GET', `/score/0x${'cd'.repeat(32)}`);
  assert.equal(s.body.flags, 1, 'a score reads the flag, which a mixed-case key would hide');
});

test('/flag/resolve and /link refuse a didHash that is not a 32-byte hash', async () => {
  for (const [path, body] of [
    ['/flag/resolve', { didHash: 'nope' }],
    ['/flag/resolve', { didHash: { a: 1 } }],
    ['/link', { didHash: 'nope', agentId: 1 }],
    ['/link', { didHash: { a: 1 }, agentId: 1 }],
  ]) {
    const r = await oracle.call('POST', path, body, ADMIN);
    assert.equal(r.status, 400, `${path} ${JSON.stringify(body)}`);
    assert.match(r.body.error, /32-byte/);
  }
});

// ---- the evidence cache ----------------------------------------------------------------

test('the evidence cache is keyed on the stored spelling, not the caller\'s', async () => {
  const lower = `0x${'ef'.repeat(32)}`;
  const upper = `0x${'EF'.repeat(32)}`;
  const mixed = `0x${'Ef'.repeat(32)}`;
  const entriesBefore = counter(await metricsText(), 'sigvara_oracle_evidence_cache_entries');

  for (const spelling of [lower, upper, mixed]) {
    assert.equal((await oracle.call('GET', `/evidence/${spelling}`)).status, 200);
  }

  // Entries, not hits: an agent with no payments gets a fresh empty array on every read, and
  // the cache treats the array's identity as the revision, so it never hits for such an agent.
  assert.equal(counter(await metricsText(), 'sigvara_oracle_evidence_cache_entries'), entriesBefore + 1,
    'three spellings of one agent are one cache entry');
});

// ---- credential scopes -----------------------------------------------------------------

test('a credential restricted to attest cannot run an epoch, flag, resolve or link', async () => {
  const forbidden = [
    ['/epoch', {}],
    ['/flag', { didHash: DID }],
    ['/flag/resolve', { didHash: DID }],
    ['/link', { didHash: DID, agentId: 1 }],
  ];
  for (const [path, body] of forbidden) {
    const restricted = await oracle.call('POST', path, body, AUDITOR);
    assert.equal(restricted.status, 403, `${path} with the restricted token`);
    const stranger = await oracle.call('POST', path, body);
    assert.equal(stranger.status, 401, `${path} with no token`);
  }
  // The admin credential is never restricted.
  assert.equal((await oracle.call('POST', '/flag', { didHash: DID }, ADMIN)).status, 200);
});

test('a credential restricted to attest can still attest', async () => {
  const r = await oracle.call('POST', '/attest', { didHash: DID, success: true, attester: 'counteraudit' }, AUDITOR);
  assert.equal(r.status, 200, r.text);
});

test('a credential restricted to other scopes is refused at /attest, not treated as a stranger', async () => {
  const r = await oracle.call('POST', '/attest', { didHash: DID, success: true, attester: 'x' }, FLAGGER);
  assert.equal(r.status, 403);
  assert.equal((await oracle.call('POST', '/flag', { didHash: DID }, FLAGGER)).status, 200, 'its own scope works');
});

test('an unrestricted credential keeps every scope', async () => {
  const open = new World();
  const free = await startOracle({ world: open, env: { ORACLE_ADMIN_TOKEN: ADMIN, ORACLE_TOKEN_COUNTERAUDIT: AUDITOR } });
  try {
    assert.equal((await free.call('POST', '/flag', { didHash: DID }, AUDITOR)).status, 200);
  } finally {
    await free.stop();
  }
});

test('the oracle refuses to start on a scope or proxy setting it cannot read', async () => {
  const base = { ORACLE_ADMIN_TOKEN: ADMIN, ORACLE_TOKEN_COUNTERAUDIT: AUDITOR };
  const cases = [
    [{ ORACLE_SCOPES_COUNTERAUDIT: 'atest' }, /unknown scope atest/],
    [{ ORACLE_SCOPES_COUNTERAUDT: 'attest' }, /does not exist/],
    [{ TRUSTED_PROXIES: 'banana' }, /TRUSTED_PROXIES/],
    [{ TRUSTED_PROXIES: '172.16.0.0/40' }, /prefix/],
  ];
  for (const [extra, pattern] of cases) {
    const { code, log } = await runToExit({ world: new World(), env: { ...base, ...extra } });
    assert.equal(code, 1, JSON.stringify(extra));
    assert.match(log, pattern, JSON.stringify(extra));
  }
});

test('the oracle says so at startup when it has been given no proxy network or a short token', async () => {
  const loud = await startOracle({
    world: new World(),
    env: { HOST: '0.0.0.0', ORACLE_ADMIN_TOKEN: 'short' },
  });
  try {
    assert.match(loud.logs(), /TRUSTED_PROXIES is unset/);
    assert.match(loud.logs(), /credential\(s\) admin shorter than 32/);
    assert.ok(!loud.logs().includes('short\n'), 'the token itself is never printed');
  } finally {
    await loud.stop();
  }
  const quiet = await startOracle({
    world: new World(),
    env: { HOST: '0.0.0.0', ORACLE_ADMIN_TOKEN: ADMIN, TRUSTED_PROXIES: '172.16.0.0/12' },
  });
  try {
    assert.ok(!/TRUSTED_PROXIES is unset/.test(quiet.logs()));
    assert.ok(!/shorter than/.test(quiet.logs()));
  } finally {
    await quiet.stop();
  }
});

// ---- the watcher -----------------------------------------------------------------------

const CHECKER_ENV = {
  ORACLE_MODE: 'checker',
  DIVERGENCE_TOLERANCE: '3',
  EPOCH_HOURS: '1',
  ORACLE_ADMIN_TOKEN: ADMIN,
};

async function waitFor(predicate, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return predicate();
}

test('the watcher raises an alert when the checker answers /health but refuses /divergence', async () => {
  const checker = await startOracle({ world: new World(), env: CHECKER_ENV });
  const sink = await webhookSink();
  let watcher;
  try {
    // Use up the allowance of the key the watcher will be seen as: loopback, no forwarded
    // address. This is what any client sharing the watcher's bucket could do to it.
    let last;
    for (let i = 0; i < 61; i++) last = await checker.call('GET', '/divergence', undefined, undefined, { client: '127.0.0.1' });
    assert.equal(last.status, 429, 'the bucket is spent');
    assert.equal((await checker.call('GET', '/health')).status, 200, '/health is not metered');

    watcher = startWatcher({ env: { CHECKER_URL: `http://127.0.0.1:${checker.port}`, WEBHOOK_URL: sink.url } });
    assert.ok(await waitFor(() => sink.received.length > 0, 15_000), `no alert was sent:\n${watcher.logs()}`);

    const alert = JSON.parse(sink.received[0].body);
    assert.equal(alert.title, 'the checker is not checking');
    assert.match(alert.lines[0], /divergence list could not be read/);
    assert.match(alert.lines[0], /429/);
  } finally {
    if (watcher) await watcher.stop();
    await sink.close();
    await checker.stop();
  }
});

test('the watcher stays quiet when the checker is healthy and has nothing to report', async () => {
  const checker = await startOracle({ world: new World(), env: CHECKER_ENV });
  const sink = await webhookSink();
  let watcher;
  try {
    watcher = startWatcher({ env: { CHECKER_URL: `http://127.0.0.1:${checker.port}`, WEBHOOK_URL: sink.url } });
    assert.ok(await waitFor(() => /watching /.test(watcher.logs()), 10_000), watcher.logs());
    await new Promise((r) => setTimeout(r, 2_500)); // long enough for the first poll to finish
    assert.equal(sink.received.length, 0, `unexpected alert: ${sink.received[0]?.body}`);
    assert.ok(!/fetch failed|poll error/.test(watcher.logs()), watcher.logs());
  } finally {
    if (watcher) await watcher.stop();
    await sink.close();
    await checker.stop();
  }
});

test('the watcher does not follow a redirect from the checker', async () => {
  const hits = [];
  const target = http.createServer((req, res) => { hits.push(req.url); res.writeHead(200); res.end('{}'); });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  const redirector = http.createServer((req, res) => {
    res.writeHead(302, { Location: `http://127.0.0.1:${target.address().port}/internal` });
    res.end();
  });
  await new Promise((r) => redirector.listen(0, '127.0.0.1', r));
  const sink = await webhookSink();
  let watcher;
  try {
    watcher = startWatcher({
      env: { CHECKER_URL: `http://127.0.0.1:${redirector.address().port}`, WEBHOOK_URL: sink.url },
    });
    assert.ok(await waitFor(() => sink.received.length > 0, 15_000), watcher.logs());
    assert.equal(hits.length, 0, 'the redirect target was never fetched');
    assert.match(JSON.parse(sink.received[0].body).lines[0], /unreachable/);
  } finally {
    if (watcher) await watcher.stop();
    await sink.close();
    redirector.close();
    target.close();
  }
});
