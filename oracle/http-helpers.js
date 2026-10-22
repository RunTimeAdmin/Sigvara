'use strict';

const crypto = require('crypto');
const net = require('net');

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

/** An address in one spelling: an IPv4-mapped IPv6 address is the IPv4 address. */
function normalizeAddress(address) {
  const a = String(address || '');
  return a.toLowerCase().startsWith('::ffff:') && net.isIPv4(a.slice(7)) ? a.slice(7) : a;
}

function isLoopback(address) {
  return LOOPBACK.has(String(address || '')) || LOOPBACK.has(normalizeAddress(address));
}

/**
 * The peers whose X-Forwarded-For may be believed: loopback always, plus whatever the
 * operator lists in TRUSTED_PROXIES (comma-separated addresses or CIDR ranges, for
 * example "172.16.0.0/12"). Returns a function from an address to a boolean.
 *
 * Loopback alone was right for a proxy on the same host reaching a loopback bind, and
 * wrong for both deployments that exist. Caddy runs in a container and reaches the
 * oracle over a Docker network, so its address is a bridge address. nginx on the host
 * reaches the published port through Docker's proxy, so it arrives from the bridge
 * gateway. In both, the header was ignored and every visitor shared one bucket, so a
 * single client sending a few dozen requests a minute refused everyone else, including
 * the watcher that polls /divergence.
 *
 * Throws on an entry it cannot read, so a typo stops the process instead of quietly
 * trusting nothing. Do not list a range that includes untrusted clients: whoever is in it
 * can pick the address they are rate-limited as.
 */
function parseTrustedProxies(spec = '') {
  const ranges = new net.BlockList();
  for (const raw of String(spec).split(',').map((s) => s.trim()).filter(Boolean)) {
    const [address, bits, extra] = raw.split('/');
    const family = net.isIPv4(address) ? 'ipv4' : net.isIPv6(address) ? 'ipv6' : null;
    if (!family || extra !== undefined) {
      throw new Error(`TRUSTED_PROXIES: "${raw}" is not an IP address or a CIDR range`);
    }
    if (bits === undefined) {
      ranges.addAddress(address, family);
    } else {
      const n = Number(bits);
      if (!/^\d{1,3}$/.test(bits) || n > (family === 'ipv4' ? 32 : 128)) {
        throw new Error(`TRUSTED_PROXIES: "${raw}" has an invalid prefix length`);
      }
      ranges.addSubnet(address, n, family);
    }
  }
  return (address) => {
    if (isLoopback(address)) return true;
    const a = normalizeAddress(address);
    const family = net.isIPv4(a) ? 'ipv4' : net.isIPv6(a) ? 'ipv6' : null;
    return family !== null && ranges.check(a, family);
  };
}

/**
 * The rate-limiter key for a request: the caller's address, as best it can be known.
 *
 * The socket address alone is wrong once a reverse proxy is in front: every proxied
 * request reports the proxy's address and the whole internet shares a single bucket, so
 * one abuser locks out everybody, which is worse than no limit at all.
 *
 * X-Forwarded-For carries the real address, but only a hop the operator trusts can vouch
 * for it, so it is read only when the connection itself arrived from loopback or from a
 * listed proxy (parseTrustedProxies). A request from anywhere else keeps its socket
 * address and cannot win a fresh bucket by sending the header itself.
 *
 * Read from the right. Each proxy appends the address it received the request from, so
 * the leading entries are whatever the client wrote and only the trailing ones were put
 * there by hops we control. Hops that are trusted proxies are skipped, and the first
 * address that is not one is the client. Reading the first entry instead would let anyone
 * mint unlimited buckets. An entry that is not an IP address is never used as a key: it
 * would let a client choose arbitrary strings to fill the table with.
 */
function clientKey(req, isTrusted = isLoopback) {
  const socketAddr = req?.socket?.remoteAddress || 'unknown';
  if (!isTrusted(socketAddr)) return socketAddr;
  const fwd = req?.headers?.['x-forwarded-for'];
  if (!fwd) return socketAddr;
  const hops = String(fwd).split(',').map((h) => h.trim()).filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    if (isTrusted(hops[i])) continue;
    return net.isIP(hops[i]) ? normalizeAddress(hops[i]) : socketAddr;
  }
  return socketAddr;
}

/**
 * The URL for a request target, or null when this service should not answer it.
 *
 * Only a path-form target passes, and only one whose path is already in canonical form.
 *
 * `new URL(target, base)` is not safe to feed a raw request line. A target that starts
 * with two slashes is read as a scheme-relative URL whose first segment is a host, so
 * "//evidence/metrics" yields the path "/metrics" on the host "evidence". A reverse proxy
 * that merges slashes before matching its allowlist sees "/evidence/metrics", allows it,
 * and forwards the raw "//evidence/metrics", which then reached /metrics here. The same
 * parser also collapses "/evidence/../metrics", and it throws on a target like "http://[",
 * which with no handler for the error ended the process.
 *
 * So the host must come out as ours, and the path the parser produces must equal the path
 * that was sent. Anything the parser had to rewrite is refused rather than answered under
 * a different name than the one the proxy checked.
 *
 * @param {string} target the raw request target (req.url)
 * @param {string} origin e.g. "http://localhost:3030"
 */
function parseRequestTarget(target, origin) {
  if (typeof target !== 'string' || target[0] !== '/') return null;
  let url;
  try {
    url = new URL(target, origin);
  } catch {
    return null;
  }
  if (url.origin !== new URL(origin).origin) return null;
  return url.pathname === target.split(/[?#]/, 1)[0] ? url : null;
}

/**
 * What each credential may do.
 *
 * Every credential used to be able to do everything a credential can: run an epoch (a
 * chain write paid from the oracle wallet), raise or clear flags, link an identity, record
 * outcomes. CounterAudit needs one of those. A leaked CounterAudit token should not be
 * able to run the other three.
 *
 * Set ORACLE_SCOPES_<NAME>=attest,flag to restrict the credential ORACLE_TOKEN_<NAME>. A
 * credential with no such variable may do everything, as before, so nothing changes until
 * this is used. `admin` is never restricted. Unset or blank means unrestricted, so to cut a
 * credential off, delete its token.
 *
 * Throws on a scope it does not know and on a restriction naming a credential that does not
 * exist: a typo in either would otherwise leave a credential with more power than the
 * operator meant to give it, and a startup failure is the only place that shows.
 */
const SCOPES = ['attest', 'flag', 'link', 'epoch'];

function readScopes(env = process.env, credentials = new Map()) {
  const scopes = new Map();
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith('ORACLE_SCOPES_') || !value || !value.trim()) continue;
    const name = key.slice('ORACLE_SCOPES_'.length).toLowerCase();
    const list = value.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const unknown = list.filter((s) => !SCOPES.includes(s));
    if (unknown.length) {
      throw new Error(`${key}: unknown scope ${unknown.join(', ')} (known: ${SCOPES.join(', ')})`);
    }
    if (name === 'admin') continue;
    if (!credentials.has(name)) {
      throw new Error(`${key} restricts a credential that does not exist (check the spelling of ORACLE_TOKEN_${name.toUpperCase()})`);
    }
    scopes.set(name, new Set(list));
  }
  return scopes;
}

/** Whether the named caller may use a scope. Callers with no restriction may use all. */
function mayUse(scopes, caller, scope) {
  const allowed = scopes && scopes.get(caller);
  return !allowed || allowed.has(scope);
}

/** Names of credentials whose token is shorter than a random 128-bit value written in hex. */
const MIN_TOKEN_LENGTH = 32;
function weakCredentials(credentials) {
  return [...credentials].filter(([, token]) => token.length < MIN_TOKEN_LENGTH).map(([name]) => name);
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

/**
 * A didHash in its one stored spelling, or null when it is not a 32-byte hex string.
 *
 * Every store key is lowercase, while the chain reads a hash case-insensitively. A
 * mixed-case hash therefore passed the agent and payment checks and was then filed
 * under a key that nothing scores, and the receipt it spent was marked used.
 */
function parseDidHash(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) return null;
  return value.toLowerCase();
}

module.exports = {
  adminTokenPolicyError,
  parseDidHash,
  clientKey,
  parseTrustedProxies,
  parseRequestTarget,
  readScopes,
  mayUse,
  weakCredentials,
  SCOPES,
  MIN_TOKEN_LENGTH,
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
