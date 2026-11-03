'use strict';

// Authentication between the ERC-8004 publisher and its remote signer (signer.js), which run on
// different hosts and talk over the internet. Each request carries `x-sigvara-auth: <ts>.<mac>`, an
// HMAC-SHA256 under a secret both hosts hold, over the time and the exact body. Someone on the path
// can read a request, but cannot change it, make a new one, or send the same one again.

const crypto = require('crypto');

const HEADER = 'x-sigvara-auth';
const MAX_SKEW_SECONDS = 60;

const mac = (secret, ts, body) => crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');

/** The header value for `body`, sent at `nowSec`. */
function authHeader(secret, body, nowSec = Math.floor(Date.now() / 1000)) {
  return `${nowSec}.${mac(secret, nowSec, body)}`;
}

/**
 * Why a request's header does not authenticate its body, or null when it does. `seen` (a Map of
 * MAC to the time it may be forgotten) remembers the MACs accepted inside the window, so each is
 * accepted once.
 */
function authProblem(secret, header, body, nowSec, seen) {
  const m = /^(\d{1,12})\.([0-9a-f]{64})$/.exec(String(header || ''));
  if (!m) return 'no or malformed authentication';
  const ts = Number(m[1]);
  if (Math.abs(nowSec - ts) > MAX_SKEW_SECONDS) return 'authentication too old or ahead of this clock';
  const want = Buffer.from(mac(secret, ts, body), 'hex');
  const got = Buffer.from(m[2], 'hex');
  if (!crypto.timingSafeEqual(want, got)) return 'authentication does not match';
  for (const [k, until] of seen) if (until < nowSec) seen.delete(k);
  if (seen.has(m[2])) return 'request already seen';
  seen.set(m[2], ts + MAX_SKEW_SECONDS);
  return null;
}

/** A secret from a file, as hex. Refused when it is short. */
function readSecret(file, fs = require('fs')) {
  const s = fs.readFileSync(file, 'utf8').trim();
  if (!/^[0-9a-f]{64,}$/i.test(s)) throw new Error(`${file} must hold at least 32 bytes of hex`);
  return s;
}

module.exports = { HEADER, MAX_SKEW_SECONDS, authHeader, authProblem, readSecret };
