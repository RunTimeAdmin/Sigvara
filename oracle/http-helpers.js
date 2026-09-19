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

// Takes the raw headers object and the configured admin token directly
// (rather than the whole request/config) so it's trivial to unit test.
function isAuthorized(headers, adminToken) {
  if (!adminToken) return true; // auth disabled if no token configured
  const header = headers['authorization'] || '';
  const expected = `Bearer ${adminToken}`;
  // Constant-time compare to avoid leaking the token via response timing.
  // timingSafeEqual requires equal-length buffers, so length-mismatch fails first.
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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

function rateLimited(key, now = Date.now(), max = RATE_MAX, windowMs = RATE_WINDOW_MS) {
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

// Loopback binds may run without an admin token (local testing). Anything else
// must have one, or /attest, /flag and /epoch are open to the network. Returns
// null when the configuration is acceptable, otherwise the reason to refuse startup.
function adminTokenPolicyError(host, adminToken) {
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (adminToken || loopback) return null;
  return `ORACLE_ADMIN_TOKEN is unset but HOST=${host} is not loopback; refusing to expose unauthenticated write endpoints. Set ORACLE_ADMIN_TOKEN (openssl rand -hex 32) or bind to 127.0.0.1.`;
}

module.exports = {
  adminTokenPolicyError,
  clientKey,
  MAX_BODY_SIZE,
  RATE_WINDOW_MS,
  RATE_MAX,
  json,
  readBody,
  isAuthorized,
  parseScorePath,
  rateLimited,
};
