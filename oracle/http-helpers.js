'use strict';

const crypto = require('crypto');

// Pure-ish HTTP helpers extracted from index.js so the auth gate, body-size
// limit, and route parsing can be unit tested without a live server.

const MAX_BODY_SIZE = 1024 * 1024; // 1 MB

const SCORE_PATH_RE = /^\/score\/(0x[0-9a-fA-F]{64})$/;

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// req only needs to be an EventEmitter emitting 'data' | 'end' | 'error' and
// exposing destroy() — a real http.IncomingMessage satisfies this, and so
// does a plain fake in tests.
async function readBody(req, maxBodySize = MAX_BODY_SIZE) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > maxBodySize) {
        req.destroy();
        return reject(new Error('Request body too large'));
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

/**
 * The service credentials the oracle will accept, as name → token.
 *
 * One shared token was fine while the operator was the only writer. It stops being a
 * secret the moment a second service holds it: revoking one integration means rotating
 * every integration, so in practice nobody revokes anything, and the write log cannot
 * say which service acted.
 *
 * Each `ORACLE_TOKEN_<NAME>` is an independent credential. Deleting one variable
 * revokes exactly that caller and leaves the others working.
 *
 * `ORACLE_ADMIN_TOKEN` is still honoured, as the credential named `admin`. Dropping it
 * would lock the operator out of a running oracle at the next restart, which is a poor
 * trade for tidiness.
 */
function readCredentials(env = process.env) {
  const creds = new Map();
  if (env.ORACLE_ADMIN_TOKEN) creds.set('admin', env.ORACLE_ADMIN_TOKEN);
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('ORACLE_TOKEN_') || !value) continue;
    const name = key.slice('ORACLE_TOKEN_'.length).toLowerCase();
    if (name) creds.set(name, value);
  }
  return creds;
}

/**
 * Which credential presented this request, or null.
 *
 * Returns the name rather than a boolean so a write can be attributed. "Someone with
 * the token flagged this agent" is not an answer once several services hold tokens.
 *
 * Every candidate is compared even after a match, so the time taken does not reveal
 * how far down the list a guess landed. Each comparison is constant-time, and a
 * length mismatch is rejected first because timingSafeEqual requires equal lengths.
 *
 * No credentials configured means auth is disabled, which is the old behaviour for
 * local runs and is why adminTokenPolicyError refuses a non-loopback bind in that
 * state. The caller is named `unauthenticated` so a log line cannot be mistaken for
 * an authorised one.
 */
function identifyCaller(headers, credentials) {
  if (!credentials || credentials.size === 0) return 'unauthenticated';
  const presented = Buffer.from((headers && headers['authorization']) || '');
  let matched = null;
  for (const [name, token] of credentials) {
    const expected = Buffer.from(`Bearer ${token}`);
    const ok = presented.length === expected.length
      && crypto.timingSafeEqual(presented, expected);
    if (ok && matched === null) matched = name;
  }
  return matched;
}

/**
 * Whether an /attest call may proceed without the admin token.
 *
 * A verified payment is a credential: the payer is read from the transfer log rather
 * than asserted, self-payment is refused, and one counterparty's evidence is capped.
 * That is enough to let a stranger say "this agent did work for me".
 *
 * It is not enough to let them say the opposite. successScore is
 * successful / (total + prior), so a negative attestation lowers the score directly,
 * and the payment proves only that money moved, never that the work failed. On a
 * testnet whose bond token comes from an open faucet, that would put every agent's
 * score at the mercy of anyone willing to spend a free token. Negatives therefore
 * still need the token, which is how CounterAudit reports outcomes it actually audited.
 *
 * Strictly `true`, not merely truthy: this decides an authorisation question, and
 * `success: "no"` must not read as a positive. The tally below keeps its original
 * truthiness for authorised callers, so nothing that works today breaks.
 */
function mayAttestUnauthenticated(success, paymentsRequired) {
  return success === true && paymentsRequired === true;
}

// Returns the didHash from a /score/:didHash path, or null if it doesn't match.
function parseScorePath(pathname) {
  const match = pathname.match(SCORE_PATH_RE);
  return match ? match[1] : null;
}

// Simple in-memory fixed-window rate limiter, keyed by an arbitrary string
// (caller passes the client IP). Testnet-grade: single-process and resets on
// restart, but it blunts bursts of writes to /attest, /flag, and /epoch on top
// of the bearer-token gate — a stolen token can no longer flood scores/gas.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 60; // requests per key per window
const _rateBuckets = new Map();
let _lastSweep = 0;

// Drop buckets whose window has closed.
//
// A bucket is replaced when its own key comes back, so a key that keeps requesting stays
// bounded on its own. A key that is seen once and never again was not: its bucket stayed
// resident for the life of the process. On the internet-facing routes that means the map
// held an entry for every client address ever observed, which is a slow leak an
// unauthenticated caller controls the rate of.
//
// Swept at most once per window rather than on every request. Map.set on an existing key
// keeps its original position, so insertion order is first-seen order and not reset
// order, and there is no ordered head to stop at the way there is for gate nonces. A
// full pass is the honest way to do it, so the fix is to do it rarely: O(N) once a
// minute instead of never. Steady-state size becomes the keys active in the last window
// plus at most one window of stragglers.
function sweepRateBuckets(now) {
  if (now - _lastSweep < RATE_WINDOW_MS) return;
  _lastSweep = now;
  for (const [key, bucket] of _rateBuckets) {
    if (now >= bucket.reset) _rateBuckets.delete(key);
  }
}

// How many buckets are resident. Observability for the sweep: without it, a swept map
// and an unswept one answer every rateLimited() call identically, so the leak this
// closes would be untestable and free to come back.
function rateBucketCount() {
  return _rateBuckets.size;
}

function rateLimited(key, now = Date.now(), max = RATE_MAX, windowMs = RATE_WINDOW_MS) {
  sweepRateBuckets(now);
  const bucket = _rateBuckets.get(key);
  if (!bucket || now >= bucket.reset) {
    _rateBuckets.set(key, { count: 1, reset: now + windowMs });
    return false;
  }
  bucket.count++;
  return bucket.count > max;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * The rate-limiter key for a request: the caller's address, as best it can be known.
 *
 * The socket address alone is wrong once a reverse proxy is in front. The oracle binds
 * loopback, so every proxied request reports 127.0.0.1 and the whole internet shares a
 * single bucket: one abuser locks out everybody, which is worse than no limit at all.
 *
 * X-Forwarded-For carries the real address, but only the hop that wrote it can vouch
 * for it, so it is read only when the connection itself arrived over loopback. A
 * request from anywhere else keeps its socket address and cannot win a fresh bucket by
 * sending the header itself.
 *
 * The LAST entry is the caller. A proxy appends to any header the client supplied, so
 * the leading entries are attacker-controlled; the final one was written by the nearest
 * hop. Reading the first entry instead would let anyone mint unlimited buckets.
 */
function clientKey(req) {
  const socketAddr = req?.socket?.remoteAddress || 'unknown';
  if (!LOOPBACK.has(socketAddr)) return socketAddr;
  const fwd = req?.headers?.['x-forwarded-for'];
  if (!fwd) return socketAddr;
  const parts = String(fwd).split(',');
  return parts[parts.length - 1].trim() || socketAddr;
}

// Loopback binds may run with no credentials at all (local testing). Anything else
// must have at least one, or /flag, /link and /epoch are open to the network. Returns
// null when the configuration is acceptable, otherwise the reason to refuse startup.
//
// Takes the credential map rather than one token, so an oracle configured purely with
// per-service tokens and no ORACLE_ADMIN_TOKEN still starts.
function adminTokenPolicyError(host, credentials) {
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  const count = typeof credentials === 'string'
    ? (credentials ? 1 : 0)            // legacy: a bare token
    : (credentials ? credentials.size : 0);
  if (count > 0 || loopback) return null;
  return `no write credentials are configured but HOST=${host} is not loopback; refusing to expose unauthenticated write endpoints. Set ORACLE_ADMIN_TOKEN or an ORACLE_TOKEN_<NAME> (openssl rand -hex 32), or bind to 127.0.0.1.`;
}

/**
 * The commit this process is running, or null when it was not told.
 *
 * Deployments clone `main` inside the container at start, so "which code is this
 * operator running" had no answer from outside. During the reweight skew it was a live
 * question and could only be settled by inference: the container restarted, main was at
 * such-and-such, therefore it must be running that. Sound reasoning, not verification,
 * and the first thing worth ruling out when two oracles disagree is that they are
 * running different scoring code.
 *
 * **This is not a trust anchor.** The value is whatever the operator's container put in
 * an environment variable, so a dishonest one can print anything. It catches accident,
 * which is the failure that actually happens: a box that missed a deploy, a container
 * pinned to a stale image, two operators a few commits apart. For anything adversarial
 * the evidence endpoints are the answer, because those can be recomputed against the
 * chain and this cannot.
 *
 * Shape-checked to 40 hex so a failed `git rev-parse` publishes null rather than its
 * own error text, and null is reported explicitly rather than omitted so "does not say"
 * stays distinguishable from "too old to have the field".
 */
function runningCommit(env = process.env) {
  const raw = String(env.SIGVARA_COMMIT ?? '').trim();
  return /^[0-9a-f]{40}$/.test(raw) ? raw : null;
}

module.exports = {
  adminTokenPolicyError,
  clientKey,
  MAX_BODY_SIZE,
  RATE_WINDOW_MS,
  RATE_MAX,
  json,
  readBody,
  readCredentials,
  identifyCaller,
  mayAttestUnauthenticated,
  parseScorePath,
  rateLimited,
  rateBucketCount,
  runningCommit,
};
